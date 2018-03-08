// NOTE: this solution assumes that the requested parsing (through the parseNow API end point) is
//    done on the same process as the API server, even if the automatic parsing is done in a separate
//    process. In the future, it might be worth modifying it so the parsing is done on the same
//    process where the automatic parsing in done.
function ParseControl(loggingOn = false) {
  this.loggingOn = loggingOn;
  this.isDoingParse = false;
  this.pendingParses = [];
  this.pendingProcs = [];
}

ParseControl.prototype.doParse = function (parseFunc) {
  log.call(this, '>>>>>> ParseControl: doParse() method called');
  if (this.isDoingParse) {
    log.call(this, '>>>>>> ParseControl: already doing parse; postpone new parsing');
    this.pendingParses.push({
      timestamp: Date.now(),
      parseFunc: parseFunc
    });
  }
  else {
    this.isDoingParse = true;

    try {
      log.call(this, '>>>>>> ParseControl: starting parsing');
      parseFunc(finalizeParsing.bind(this));
    }
    catch (err) {
      finalizeParsing.bind(this);
    }
  }
};

ParseControl.prototype.doProcess = function (procFunc) {
  log.call(this, '>>>>>> ParseControl: doProcess() method called');
  if (this.isDoingParse) {
    log.call(this, '>>>>>> ParseControl: doing parsing; postpone new processing');
    this.pendingProcs.push({
      timestamp: Date.now(),
      procFunc: procFunc
    })
  }
  else {
    log.call(this, '>>>>>> ParseControl: do processing');
    procFunc();
  }
};

function finalizeParsing() {
  log.call(this, '>>>>>> ParseControl: finalizing parsing');
  this.isDoingParse = false;

  let parseEntry = undefined;

  if (this.pendingParses.length > 0) {
    parseEntry = this.pendingParses.shift();
  }

  if (this.pendingProcs.length > 0) {
    const processNowProcs = [];
    const newPendingProcs = [];

    this.pendingProcs.forEach((procEntry) => {
      if (parseEntry === undefined || procEntry.timestamp < parseEntry.timestamp) {
        processNowProcs.push(procEntry);
      }
      else {
        newPendingProcs.push(procEntry);
      }
    });

    if (processNowProcs.length > 0) {
      this.pendingProcs = newPendingProcs;

      processNowProcs.forEach((procEntry) => {
        log.call(this, '>>>>>> ParseControl: do pending processing');
        procEntry.procFunc()
      });
    }
  }

  if (parseEntry !== undefined) {
    log.call(this, '>>>>>> ParseControl: prepare to do pending parsing');
    this.doParse(parseEntry.parseFunc);
  }
}

function log() {
  if (this.loggingOn) {
    const logArgs = [new Date().toISOString()].concat(Array.from(arguments));

    console.log.apply(undefined, logArgs);
  }
}

module.exports = ParseControl;