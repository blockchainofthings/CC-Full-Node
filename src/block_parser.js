var async = require('async')
var CCTransaction = require('cc-transaction')
var getAssetsOutputs = require('cc-get-assets-outputs')
var bitcoinjs = require('bitcoinjs-lib')
var bufferReverse = require('buffer-reverse')
var _ = require('lodash')
var toposort = require('toposort')
var redisClient = require('redis')
var bitcoinRpc = require('bitcoin-async')
var events = require('events')

var mainnetFirstColoredBlock = 364548
var testnetFirstColoredBlock = 462320

var blockStates = {
  NOT_EXISTS: 0,
  GOOD: 1,
  FORKED: 2
}

var label = 'cc-full-node'

module.exports = function (args) {
  args = args || {}
  var network = args.network || 'testnet'
  var bitcoinNetwork = (network === 'mainnet') ? bitcoinjs.networks.bitcoin : bitcoinjs.networks.testnet
  var redisOptions = {
    host: args.redisHost || 'localhost',
    port: args.redisPort || '6379',
    prefix: 'ccfullnode:' + network + ':'
  }
  var redis = redisClient.createClient(redisOptions)

  var bitcoinOptions = {
    host: args.bitcoinHost || 'localhost',
    port: args.bitcoinPort || '18332',
    user: args.bitcoinUser || 'rpcuser',
    pass: args.bitcoinPass || 'rpcpass',
    path: args.bitcoinPath || '/',
    timeout: args.bitcoinTimeout || 30000
  }
  var bitcoin = new bitcoinRpc.Client(bitcoinOptions)

  var emitter = new events.EventEmitter()

  var info = {
    bitcoindbusy: true
  }

  var waitForBitcoind = function (cb) {
    if (!info.bitcoindbusy) return cb()
    return setTimeout(function() {
      console.log('Waiting for bitcoind...')
      bitcoin.cmd('getinfo', [], function (err) {
        if (err) {
          info.error = {}
          if (err.code) {
            info.error.code = err.code
          }
          if (err.message) {
            info.error.message = err.message
          }
          if (!err.code && !err.message) {
            info.error = err
          }
          return waitForBitcoind(cb)
        }
        delete info.error
        info.bitcoindbusy = false
        cb()
      })
    }, 5000)
  }

  var getNextBlockHeight = function (cb) {
    redis.hget('blocks', 'lastBlockHeight', function (err, lastBlockHeight) {
      if (err) return cb(err)
      lastBlockHeight = lastBlockHeight || ((network === 'mainnet' ? mainnetFirstColoredBlock : testnetFirstColoredBlock) - 1)
      lastBlockHeight = parseInt(lastBlockHeight)
      cb(null, lastBlockHeight + 1)
    })
  }

  var getNextBlock = function (height, cb) {
    bitcoin.cmd('getblockhash', [height], function (err, hash) {
      if (err) {
        if (err.code && err.code === -8) {
          return cb(null, null)
        }
        return cb(err)
      }
      bitcoin.cmd('getblock', [hash, false], function (err, rawBlock) {
        if (err) return cb(err)
        var block = bitcoinjs.Block.fromHex(rawBlock)
        block.height = height
        block.hash = hash
        block.previousblockhash = bufferReverse(block.prevHash).toString('hex')
        block.transactions = block.transactions.map(function (transaction) {
          return decodeRawTransaction(transaction)
        })
        cb(null, block)
      })
    })
  }

  var checkNextBlock = function (block, cb) {
    if (!block) return cb(null, blockStates.NOT_EXISTS, block)
    redis.hget('blocks', block.height - 1, function (err, hash) {
      if (!hash || hash === block.previousblockhash) return cb(null, blockStates.GOOD, block)
      cb(null, blockStates.FORKED, block)
    })
  }

  var revertBlock = function (blockHeight, cb) {
    console.log('forking block', blockHeight)
    updateLastBlock(blockHeight - 1, cb)
  }

  var conditionalParseNextBlock = function (state, block, cb) {
    if (state === blockStates.NOT_EXISTS) {
      return mempoolParse(cb)
    }
    // console.log('block', block.hash, block.height, 'txs:', block.transactions.length, 'state', state)
    if (state === blockStates.GOOD) {
      return parseNewBlock(block, cb)
    }
    if (state === blockStates.FORKED) {
      return revertBlock(block.height - 1, cb)
    }
    cb('Unknown block state')
  }

  var checkVersion = function (hex) {
    var version = hex.toString('hex').substring(0, 4)
    return (version.toLowerCase() === '4343')
  }

  var getColoredData = function (transaction) {
    var coloredData = null
    transaction.vout.some(function (vout) {
      if (!vout.scriptPubKey || !vout.scriptPubKey.type === 'nulldata') return null
      var hex = vout.scriptPubKey.asm.substring('OP_RETURN '.length)
      if (checkVersion(hex)) {
        try {
          coloredData = CCTransaction.fromHex(hex).toJson()
        } catch (e) {
          console.log('Invalid CC transaction.')
        }
      }
      return coloredData
    })
    return coloredData
  }

  var getPreviousOutputs = function(transaction, cb) {
    var prevTxs = []

    transaction.vin.forEach(function(vin) {
      prevTxs.push(vin)
    })

    var prevOutsBatch = prevTxs.map(function(vin) { return { 'method': 'getrawtransaction', 'params': [vin.txid] } })
    bitcoin.cmd(prevOutsBatch, function (rawTransaction, cb) {
      var prevTx = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
      var txid = prevTx.id
      prevTxs.forEach(function(vin) {
        vin.previousOutput = prevTx.vout[vin.vout]
        if(vin.previousOutput && vin.previousOutput.scriptPubKey && vin.previousOutput.scriptPubKey.addresses) {
          vin.previousOutput.addresses = vin.previousOutput.scriptPubKey.addresses
        }
      })
      cb()
    }, function(err) {
      if (err) return cb(err)
      transaction.fee = transaction.vin.reduce(function(sum, vin) {
        if (vin.previousOutput) {
          return sum + vin.previousOutput.value
        }
        return sum
      }, 0) - transaction.vout.reduce(function(sum, vout) { return sum + vout.value }, 0)
      transaction.totalsent = transaction.vin.reduce(function(sum, vin) {
        if (vin.previousOutput) {
          return sum + vin.previousOutput.value
        }
        return sum
      }, 0)
      cb(null, transaction)
    })
  }

  var parseTransaction = function (transaction, utxosChanges, blockHeight, cb) {
    async.each(transaction.vin, function (input, cb) {
      var previousOutput = input.txid + ':' + input.vout
      if (utxosChanges.unused[previousOutput]) {
        input.assets = JSON.parse(utxosChanges.unused[previousOutput])
        return process.nextTick(cb)
      }
      redis.hget('utxos', previousOutput, function (err, assets) {
        if (err) return cb(err)
        input.assets = assets && JSON.parse(assets) || []
        if (input.assets.length) {
          utxosChanges.used[previousOutput] = assets
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      var outputsAssets = getAssetsOutputs(transaction)
      outputsAssets.forEach(function (assets, outputIndex) {
        if (assets && assets.length) {
          utxosChanges.unused[transaction.txid + ':' + outputIndex] = JSON.stringify(assets)
        }
      })
      emitter.emit('newcctransaction', transaction)
      emitter.emit('newtransaction', transaction)
      cb()
    })
  }

  var setTxos = function (utxos, cb) {
    async.each(Object.keys(utxos), function (utxo, cb) {
      var assets = utxos[utxo]
      redis.hmset('utxos', utxo, assets, cb)
    }, cb)
  }

  var updateLastBlock = function (blockHeight, blockHash, timestamp, cb) {
    if (typeof blockHash === 'function') {
      return redis.hmset('blocks', 'lastBlockHeight', blockHeight, blockHash)
    }
    redis.hmset('blocks', blockHeight, blockHash, 'lastBlockHeight', blockHeight, 'lastTimestamp', timestamp, function (err) {
      cb(err)
    })
  }

  var updateUtxosChanges = function (block, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        setTxos(utxosChanges.unused, cb)
      },
      function (cb) {
        updateLastBlock(block.height, block.hash, block.timestamp, cb)
      }
    ], cb)
  }

  var updateParsedMempoolTxids = function (txids, cb) {
    async.waterfall([
      function (cb) {
        redis.hget('mempool', 'parsed', cb)
      },
      function (parsedMempool, cb) {
        parsedMempool = JSON.parse(parsedMempool || '[]')
        parsedMempool = parsedMempool.concat(txids)
        parsedMempool = _.uniq(parsedMempool)
        redis.hmset('mempool', 'parsed', JSON.stringify(parsedMempool), cb)
      }
    ], function (err) {
      cb(err)
    })
  }

  var updateMempoolTransactionUtxosChanges = function (txid, utxosChanges, cb) {
    async.waterfall([
      function (cb) {
        setTxos(utxosChanges.unused, cb)
      },
      function (cb) {
        updateParsedMempoolTxids([txid], cb)
      }
    ], cb)
  }

  var decodeRawTransaction = function (tx) {
    var r = {}
    r['txid'] = tx.getId()
    r['version'] = tx.version
    r['locktime'] = tx.lock_time
    r['hex'] = tx.toHex()
    r['vin'] = []
    r['vout'] = []

    tx.ins.forEach(function (txin) {
        var txid = txin.hash.reverse().toString('hex')
        var n = txin.index
        var seq = txin.sequence
        var hex = txin.script.toString('hex')
        if (n == 4294967295) {
          r['vin'].push({'txid': txid, 'vout': n, 'coinbase' : hex, 'sequence' : seq})
        } else {
          var asm = bitcoinjs.script.toASM(txin.script)
          r['vin'].push({'txid': txid, 'vout': n, 'scriptSig' : {'asm': asm, 'hex': hex}, 'sequence':seq})
        }
    })

    tx.outs.forEach(function (txout, i) {
        var value = txout.value
        var hex = txout.script.toString('hex')
        var asm = bitcoinjs.script.toASM(txout.script)
        var type = bitcoinjs.script.classifyOutput(txout.script)
        var addresses = []
        if (~['pubkeyhash', 'scripthash'].indexOf(type)) {
          addresses.push(bitcoinjs.address.fromOutputScript(bitcoinjs.script.decompile(txout.script), bitcoinNetwork))
        }
        var answer = {'value' : value, 'n': i, 'scriptPubKey': {'asm': asm, 'hex': hex, 'addresses': addresses, 'type': type}}

        r['vout'].push(answer)
    })

    var ccdata = getColoredData(r)
    if (ccdata) {
      r['ccdata'] = [ccdata]
      r['colored'] = true
    }
    return r
  }

  var parseNewBlock = function (block, cb) {
    info.cctimestamp = block.timestamp
    info.ccheight = block.height
    var utxosChanges = {
      used: {},
      unused: {},
      txids: []
    }
    async.eachSeries(block.transactions, function (transaction, cb) {
      utxosChanges.txids.push(transaction.txid)
      var coloredData = getColoredData(transaction)
      if (!coloredData) {
        emitter.emit('newtransaction', transaction)
        return process.nextTick(cb)
      }
      transaction.ccdata = [coloredData]
      parseTransaction(transaction, utxosChanges, block.height, cb)
    }, function (err) {
      if (err) return cb(err)
      updateUtxosChanges(block, utxosChanges, function (err) {
        if (err) return cb(err)
        block.transactions = block.transactions.map(transaction => transaction.txid)
        emitter.emit('newblock', block)
        cb()
      })
    })
  }

  var getMempoolTxids = function (cb) {
    bitcoin.cmd('getrawmempool', [], cb)
  }

  var getNewMempoolTxids = function (mempoolTxids, cb) {
    redis.hget('mempool', 'parsed', function (err, mempool) {
      if (err) return cb(err)
      mempool = mempool || '[]'
      var parsedMempoolTxids = JSON.parse(mempool)
      newMempoolTxids = _.difference(mempoolTxids, parsedMempoolTxids)
      cb(null, newMempoolTxids)
    })
  }

  var getNewMempoolTransaction = function (newMempoolTxids, cb) {
    var commandsArr = newMempoolTxids.map(function (txid) {
      return { method: 'getrawtransaction', params: [txid, 0]}
    })
    var newMempoolTransactions = []
    bitcoin.cmd(commandsArr, function (rawTransaction, cb) {
      var newMempoolTransaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
      newMempoolTransactions.push(newMempoolTransaction)
      cb()
    },
    function (err) {
      cb(err, newMempoolTransactions)
    })
  }

  var orderByDependencies = function (transactions) {
    var txids = {}
    transactions.forEach(function (transaction) {
      txids[transaction.txid] = transaction
    })
    var edges = []
    transactions.forEach(function (transaction) {
      transaction.vin.forEach(function (input) {
        if (txids[input.txid]) {
          edges.push([input.txid, transaction.txid])
        }
      })
    })
    var sortedTxids = toposort.array(Object.keys(txids), edges)
    return sortedTxids.map(function (txid) { return txids[txid] } )
  }

  var parseNewMempoolTransactions = function (newMempoolTransactions, cb) {
    newMempoolTransactions = orderByDependencies(newMempoolTransactions)
    var nonColoredTxids  = []
    async.eachSeries(newMempoolTransactions, function (newMempoolTransaction, cb) {
      var utxosChanges = {
        used: {},
        unused: {}
      }
      var coloredData = getColoredData(newMempoolTransaction)
      if (!coloredData) {
        nonColoredTxids.push(newMempoolTransaction.txid)
        emitter.emit('newtransaction', newMempoolTransaction)
        return process.nextTick(cb)
      }
      newMempoolTransaction.ccdata = [coloredData]
      parseTransaction(newMempoolTransaction, utxosChanges, -1, function (err) {
        if (err) return cb(err)
        updateMempoolTransactionUtxosChanges(newMempoolTransaction.txid, utxosChanges, cb)
      })
    }, function (err) {
      if (err) return cb(err)
      updateParsedMempoolTxids(nonColoredTxids, cb)
    })
  }

  var updateInfo = function (cb) {
    if (info.ccheight && info.cctimestamp) {
      return process.nextTick(cb)
    }
    redis.hmget('blocks', 'lastBlockHeight', 'lastTimestamp', function (err, arr) {
      if (err) return cb(err)
      if (!arr || arr.length < 2) return process.nextTick(cb)
      info.ccheight = arr[0]
      info.cctimestamp = arr[1]
      cb()
    })
  }

  var mempoolParse = function (cb) {
    // console.log('parsing mempool')
    async.waterfall([
      updateInfo,
      getMempoolTxids,
      getNewMempoolTxids,
      getNewMempoolTransaction,
      parseNewMempoolTransactions
    ], cb)
  }

  var finishParsing = function (err)  {
    if (err) console.error(err)
    parseProcedure()
  }

  var importAddresses = function (args, cb) {
    var addresses = args.addresses
    var reindex = args.reindex === 'true' || args.reindex === true
    var newAddresses
    var importedAddresses
    var ended = false

    var endFunc = function () {
      if (!ended) {
        ended = true
        return cb(null, {
          addresses: addresses,
          reindex: reindex,
        })
      }
    }
    async.waterfall([
      function (cb) {
        redis.hget('addresses', 'imported', cb)
      },
      function (_importedAddresses, cb) {
        importedAddresses = _importedAddresses || '[]'
        importedAddresses = JSON.parse(importedAddresses)
        newAddresses = _.difference(addresses, importedAddresses)
        if (reindex && newAddresses.length < 2 || !newAddresses.length) return process.nextTick(cb)
        var commandsArr = newAddresses.splice(0, newAddresses.length - (reindex ? 1 : 0)).map(function (address) {
          return {
            method: 'importaddress',
            params: [address, label, false]
          }
        })
        bitcoin.cmd(commandsArr, function (ans, cb) { return process.nextTick(cb)}, cb)
      },
      function (cb) {
        reindex = false
        if (!newAddresses.length) return process.nextTick(cb)
        reindex = true
        info.bitcoindbusy = true
        bitcoin.cmd('importaddress', [newAddresses[0], label, true], function (err) {
          waitForBitcoind(cb)
        })
        endFunc()
      },
      function (cb) {
        newAddresses = _.difference(addresses, importedAddresses)
        if (!newAddresses.length) return process.nextTick(cb)
        importedAddresses = importedAddresses.concat(newAddresses)
        redis.hmset('addresses', 'imported', JSON.stringify(importedAddresses), function (err) {
          cb(err)
        })
      }
    ], function (err) {
      if (err) return cb(err)
      endFunc()
    })
  }

  var parse = function (addresses, progressCallback) {
    if (typeof addresses === 'function') {
      progressCallback = addresses
      addresses = null
    }
    setInterval(function () {
      emitter.emit('info', info)
      if (progressCallback) {
        progressCallback(info)
      }
    }, 5000);
    if (!addresses || !Array.isArray(addresses)) return parseProcedure()
    importAddresses({addresses: addresses, reindex: true}, parseProcedure)
  }

  var infoPopulate = function (cb) {
    getBitcoindInfo(function (err, newInfo) {
      if (err) return cb(err)
      info = newInfo
      cb()
    })
  }

  var parseProcedure = function (cb) {
    async.waterfall([
      waitForBitcoind,
      infoPopulate,
      getNextBlockHeight,
      getNextBlock,
      checkNextBlock,
      conditionalParseNextBlock
    ], cb !== undefined ? cb : finishParsing)
  }

  var getAddressesUtxos = function (args, cb) {
    var addresses = args.addresses
    var numOfConfirmations = args.numOfConfirmations || 0

    if (args.parseNow) {
      parseProcedure(doProcessing);
    }
    else {
      doProcessing();
    }

    function doProcessing () {
      bitcoin.cmd('getblockcount', [], function (err, count) {
        if (err) return cb(err)
        bitcoin.cmd('listunspent', [numOfConfirmations, 99999999, addresses], function (err, utxos) {
          if (err) return cb(err)
          async.each(utxos, function (utxo, cb) {
            redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, assets) {
              if (err) return cb(err)
              utxo.assets = assets && JSON.parse(assets) || []
              if (utxo.confirmations) {
                utxo.blockheight = count - utxo.confirmations + 1
              } else {
                utxo.blockheight = -1
              }
              cb()
            })
          }, function (err) {
            if (err) return cb(err)
            cb(null, utxos)
          })
        })
      })
    }
  }

  var getUtxos = function (args, cb) {
    var reqUtxos = args.utxos
    var numOfConfirmations = args.numOfConfirmations || 0
    bitcoin.cmd('getblockcount', [], function(err, count) {
      if (err) return cb(err)
      bitcoin.cmd('listunspent', [numOfConfirmations, 99999999], function (err, utxos) {
        if (err) return cb(err)
        utxos = utxos.filter(utxo => reqUtxos.findIndex(reqUtxo => reqUtxo.txid === utxo.txid && reqUtxo.index === utxo.vout) !== -1)
        async.each(utxos, function (utxo, cb) {
          redis.hget('utxos', utxo.txid + ':' + utxo.vout, function (err, assets) {
            if (err) return cb(err)
            utxo.assets = assets && JSON.parse(assets) || []
            if (utxo.confirmations) {
              utxo.blockheight = count - utxo.confirmations + 1
            } else {
              utxo.blockheight = -1
            }
            cb()
          })
        }, function (err) {
          if (err) return cb(err)
          cb(null, utxos)
        })
      })
    })
  }

  var getTxouts = function (args, cb) {
    var txouts = _.cloneDeep(args.txouts)
    async.each(txouts, function (txout, cb) {
      redis.hget('utxos', txout.txid + ':' + txout.vout, function (err, assets) {
        if (err) return cb(err)
        txout.assets = assets && JSON.parse(assets) || []
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, txouts)
    })
  }

  var transmit = function (args, cb) {
    var txHex = args.txHex
    bitcoin.cmd('sendrawtransaction', [txHex], function(err, res) {
      if (err) {
        return cb(err)
      }
      var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(txHex))

      var txsToParse = [transaction]

      var txsToCheck = [transaction]

      async.whilst(
        function() { return txsToCheck.length > 0 },
        function(callback) {
          var txids = txsToCheck.map(function(tx) { return tx.vin.map(function(vin) { return vin.txid}) })
          txids = [].concat.apply([], txids)
          txids = [...new Set(txids)]
          txsToCheck = []
          getNewMempoolTxids(txids, function(err, txids) {
            if (err) return callback(err)
            if (txids.length == 0) return callback()
            var batch = txids.map(function(txid) { return { 'method': 'getrawtransaction', 'params': [txid] } })
            bitcoin.cmd(
              batch,
              function (rawTransaction, cb) {
                var tx = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
                txsToCheck.push(tx)
                txsToParse.unshift(tx)
              },
              function(err) {
                if (err) return callback(err)
                return callback()
              }
            )
          })
        },
        function (err) {
          if (err) return cb(null, '{ "txid": "' +  res + '" }')
          parseNewMempoolTransactions(txsToParse, function(err) {
            if (err) return cb(null, '{ "txid": "' +  res + '" }')
            return cb(null, '{ "txid": "' +  res + '" }')
          })
        }
      )
    })
  }

  var addColoredInputs = function (transaction, cb) {
    async.each(transaction.vin, function (input, cb) {
      redis.hget('utxos', input.txid + ':' + input.vout, function (err, assets) {
        if (err) return cb(err)
        assets = assets && JSON.parse(assets) || []
        input.assets = assets
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, transaction)
    })
  }

  var addColoredOutputs = function (transaction, cb) {
    async.each(transaction.vout, function (output, cb) {
      redis.hget('utxos', transaction.txid + ':' + output.n, function (err, assets) {
        if (err) return cb(err)
        assets = assets && JSON.parse(assets) || []
        output.assets = assets
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      cb(null, transaction)
    })
  }

  var addColoredIOs = function (transaction, cb) {
    async.waterfall([
      function (cb) {
        addColoredInputs(transaction, cb)
      },
      function (transaction, cb) {
        addColoredOutputs(transaction, cb)
      }
    ], cb)
  }

  var getAddressesTransactions = function (args, cb) {
    var addresses = args.addresses
    var next = true
    var txs = {}
    var txids = []
    var skip = 0
    var count = 10
    var transactions = {}

    async.whilst(function () { return next }, function (cb) {
      bitcoin.cmd('listtransactions', [label, count, skip, true], function (err, transactions) {
        if (err) return cb(err)
        skip+=count
        transactions.forEach(function (transaction) {
          if (~addresses.indexOf(transaction.address) && !~txids.indexOf(transaction.txid)) {
            txs[transaction.txid] = transaction
            txids.push(transaction.txid)
          }
        })
        if (transactions.length < count) {
          next = false
        }
        cb()
      })
    }, function (err) {
      if (err) return cb(err)
      var batch = txids.map(function(txid) { return { 'method': 'getrawtransaction', 'params': [txid] } })
      bitcoin.cmd('getblockcount', [], function(err, count) {
        if (err) return cb(err)
        bitcoin.cmd(batch, function (rawTransaction, cb) {
          var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
          var tx = txs[transaction.txid]
          addColoredIOs(transaction, function(err) {
            transaction.confirmations = tx.confirmations
            if (transaction.confirmations) {
              transaction.blockheight = count - transaction.confirmations + 1
              transaction.blocktime = tx.blocktime * 1000
            } else {
              transaction.blockheight = -1
              transaction.blocktime = tx.timereceived * 1000
            }
            transactions[transaction.txid] = transaction
            cb()
          })
        }, function(err) {
          if (err) return cb(err)

          var prevOutputIndex = {}

          Object.values(transactions).forEach(function(tx) {
            tx.vin.forEach(function(vin) {
              prevOutputIndex[vin.txid] = prevOutputIndex[vin.txid] || []
              prevOutputIndex[vin.txid].push(vin)
            })
          })

          var prevOutsBatch = Object.keys(prevOutputIndex).map(function(txid) { return { 'method': 'getrawtransaction', 'params': [txid] } })
          bitcoin.cmd(prevOutsBatch, function (rawTransaction, cb) {
            var transaction = decodeRawTransaction(bitcoinjs.Transaction.fromHex(rawTransaction))
            var txid = transaction.id
            prevOutputIndex[transaction.txid].forEach(function(vin) {
              vin.previousOutput = transaction.vout[vin.vout]
              if(vin.previousOutput.scriptPubKey && vin.previousOutput.scriptPubKey.addresses) {
                vin.previousOutput.addresses = vin.previousOutput.scriptPubKey.addresses
              }
            })
            cb()
          }, function(err) {
            if (err) return cb(err)

            Object.values(transactions).forEach(function(tx) {
              tx.fee = tx.vin.reduce(function(sum, vin) { return sum + vin.previousOutput.value }, 0) - tx.vout.reduce(function(sum, vout) { return sum+ vout.value }, 0)
              tx.totalsent = tx.vin.reduce(function(sum, vin) { return sum + vin.previousOutput.value }, 0)
            })
            cb(null, Object.values(transactions))
          })
        })
      })
    })
  }

  var getBitcoindInfo = function (cb) {
    var btcInfo
    async.waterfall([
      function (cb) {
        bitcoin.cmd('getinfo', [], cb)
      },
      function (_btcInfo, cb) {
        if (typeof _btcInfo === 'function') {
          cb = _btcInfo
          _btcInfo = null
        }
        if (!_btcInfo) return cb('No reply from getinfo')
        btcInfo = _btcInfo
        bitcoin.cmd('getblockhash', [btcInfo.blocks], cb)
      },
      function (lastBlockHash, cb) {
        bitcoin.cmd('getblock', [lastBlockHash], cb)
      }
    ],
    function (err, lastBlockInfo) {
      if (err) return cb(err)
      btcInfo.timestamp = lastBlockInfo.time
      btcInfo.cctimestamp = info.cctimestamp
      btcInfo.ccheight = info.ccheight
      cb(null, btcInfo)
    })
  }

  var getInfo = function (args, cb) {
    if (typeof args === 'function') {
      cb = args
      args = null
    }
    cb(null, info)
  }

  var injectColoredUtxos = function (method, params, ans, cb) {
    // TODO
    cb(null, ans)
  }

  var proxyBitcoinD = function (method, params, cb) {
    bitcoin.cmd(method, params, function (err, ans) {
      if (err) return cb(err)
      injectColoredUtxos(method, params, ans, cb)
    })
  }

  return {
    parse: parse,
    importAddresses: importAddresses,
    getAddressesUtxos: getAddressesUtxos,
    getUtxos: getUtxos,
    getTxouts: getTxouts,
    getAddressesTransactions: getAddressesTransactions,
    transmit: transmit,
    getInfo: getInfo,
    proxyBitcoinD: proxyBitcoinD,
    emitter: emitter
  }
}
