
const { parentPort } = require('worker_threads');
const { pohStep, pohSequence, pohVerify } = require('./poh');

let hash = null;
let sequenceCount = 0;
let tickCount = 0;
let hashesPerTick = 12500000;
let running = false;
let message = undefined;
const BATCH = 65536;

function runLoop() {
  if (!running) return;
  const target = sequenceCount + BATCH;
  while (sequenceCount < target) {
    hash = pohStep(hash, message);
    sequenceCount++;
    if (sequenceCount % hashesPerTick === 0) tickCount++;
  }
  setImmediate(() => {
    if (!running) return;
    runLoop();
  });
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'start':
      hash = msg.initialHash;
      sequenceCount = 0;
      tickCount = 0;
      hashesPerTick = msg.hashesPerTick || 12500000;
      message = msg.message;
      running = true;
      runLoop();
      parentPort.postMessage({ type: 'started' });
      break;
    case 'sample':
      parentPort.postMessage({ id: msg.id, result: { poh_hash: hash, poh_sequence_count: sequenceCount, poh_tick_count: tickCount } });
      break;
    case 'stop':
      running = false;
      parentPort.postMessage({ id: msg.id, result: { poh_hash: hash, poh_sequence_count: sequenceCount, poh_tick_count: tickCount } });
      break;
    case 'seq': {
      let r;
      try { r = pohSequence(msg.initialHash, msg.numHashes, undefined); }
      catch (e) { parentPort.postMessage({ id: msg.id, error: e.message }); return; }
      parentPort.postMessage({ id: msg.id, result: r });
      break;
    }
    case 'verify': {
      const ok = pohVerify(msg.initialHash, msg.finalHash, msg.numHashes, undefined);
      parentPort.postMessage({ id: msg.id, result: ok });
      break;
    }
    default:
      break;
  }
});
