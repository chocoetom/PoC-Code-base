const crypto = require('crypto');
const ZERO_HASH = '0'.repeat(64);

const DEFAULT_HASHES_PER_TICK = 12500000;
const DEFAULT_TICKS_PER_BLOCK = 60;

function pohStep(previousHash, message) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(String(previousHash), 'hex'));
  if (message !== undefined && message !== null) {
    h.update(Buffer.from(String(message), 'utf8'));
  }
  return h.digest('hex');
}

function pohSequence(initialHash, numHashes, stepFn) {
  if (!Number.isInteger(numHashes) || numHashes < 0) return initialHash;
  let h = String(initialHash);
  for (let i = 0; i < numHashes; i++) {
    h = pohStep(h, stepFn ? stepFn(i) : undefined);
  }
  return h;
}

function pohVerify(initialHash, claimedFinalHash, numHashes, stepFn) {
  if (!Number.isInteger(numHashes) || numHashes < 0) return false;
  if (!claimedFinalHash || typeof claimedFinalHash !== 'string') return false;
  return pohSequence(initialHash, numHashes, stepFn) === String(claimedFinalHash);
}

function pohTicks(initialHash, numTicks, hashesPerTick) {
  const hpt = hashesPerTick || DEFAULT_HASHES_PER_TICK;
  const ticks = [];
  let h = String(initialHash);
  for (let t = 0; t < numTicks; t++) {
    h = pohSequence(h, hpt, undefined);
    ticks.push({ tick_index: t, hash: h });
  }
  return ticks;
}

function hashesForTicks(numTicks, hashesPerTick) {
  return (numTicks || 0) * (hashesPerTick || DEFAULT_HASHES_PER_TICK);
}

function ticksForHashes(numHashes, hashesPerTick) {
  const hpt = hashesPerTick || DEFAULT_HASHES_PER_TICK;
  return Math.floor((numHashes || 0) / hpt);
}

const TEST_HASHES_PER_TICK = 1000;

module.exports = {
  ZERO_HASH,
  DEFAULT_HASHES_PER_TICK,
  DEFAULT_TICKS_PER_BLOCK,
  TEST_HASHES_PER_TICK,
  pohStep,
  pohSequence,
  pohVerify,
  pohTicks,
  hashesForTicks,
  ticksForHashes,
};
