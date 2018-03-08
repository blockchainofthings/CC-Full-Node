var routes = [
  {
    path: '/parseNow',
    method: 'get',
    functionName: 'parseNow',
    params: [],
    optionalParams: []
  },
  {
    path: '/getAddressesUtxos',
    method: 'post',
    functionName: 'getAddressesUtxos',
    params: ['addresses'],
    optionalParams: [
      'numOfConfirmations',
      'waitForParsing'
    ]
  },
  {
    path: '/getUtxos',
    method: 'post',
    functionName: 'getUtxos',
    params: ['utxos'],
    optionalParams: [
      'numOfConfirmations',
      'waitForParsing'
    ]
  },
  {
    path: '/getTxouts',
    method: 'post',
    functionName: 'getTxouts',
    params: ['txouts'],
    optionalParams: [
      'waitForParsing'
    ]
  },
  {
    path: '/getAddressesTransactions',
    method: 'post',
    functionName: 'getAddressesTransactions',
    params: ['addresses'],
    optionalParams: [
      'waitForParsing'
    ]
  },
  {
    path: '/transmit',
    method: 'post',
    functionName: 'transmit',
    params: ['txHex'],
    optionalParams: []
  },
  {
    path: '/getInfo',
    method: 'get',
    functionName: 'getInfo',
    params: [],
    optionalParams: []
  },
  {
    path: '/importAddresses',
    method: 'post',
    functionName: 'importAddresses',
    params: ['addresses'],
    optionalParams: ['reindex']
  },
  {
    path: '/getAssetHolders',
    method: 'post',
    functionName: 'getAssetHolders',
    params: ['assetId'],
    optionalParams: [
      'numOfConfirmations',
      'waitForParsing'
    ]
  },
  {
    path: '/getAssetBalance',
    method: 'post',
    functionName: 'getAssetBalance',
    params: ['assetId'],
    optionalParams: [
      'addresses',
      'numOfConfirmations',
      'waitForParsing'
    ]
  },
  {
    path: '/getAssetIssuance',
    method: 'post',
    functionName: 'getAssetIssuance',
    params: ['assetId'],
    optionalParams: [
      'waitForParsing'
    ]
  },
  {
    path: '/getAssetIssuingAddress',
    method: 'post',
    functionName: 'getAssetIssuingAddress',
    params: ['assetId'],
    optionalParams: [
      'waitForParsing'
    ]
  },
  {
    path: '/getOwningAssets',
    method: 'post',
    functionName: 'getOwningAssets',
    params: ['addresses'],
    optionalParams: [
      'numOfConfirmations',
      'waitForParsing'
    ]
  }
]

module.exports = function (app, parser) {

  var handleResponse = function (err, ans, res, next) {
    if (err) return next(err)
    res.send(ans)
  }

  routes.forEach(function (route) {
    app[route.method](route.path, function (req, res, next) {
      var args = {}
      var err
      route.params.some(function (param) {
        args[param] = req.body[param]
        if (!args[param]) {
          err = param + ' is required.'
          return true
        }
      })
      if (err) {
        res.status(400)
        return next(err)
      }
      route.optionalParams.forEach(function (param) {
        args[param] = req.body[param]
      })
      parser[route.functionName](args, function (err, ans) {
        handleResponse(err, ans, res, next)
      })
    })
  })
}