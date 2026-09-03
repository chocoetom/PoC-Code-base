const { Worker } = require('worker_threads');
const path = require('path');
const poh = require('./poh');

const WORKER_PATH = path.join(__dirname, 'poh-worker.js');

class PohEngine {
  constructor(opts = {}) {
    this.hashesPerTick = opts.hashesPerTick || poh.DEFAULT_HASHES_PER_TICK;
    this.message = opts.message;
    this.worker = null;
    this._pending = new Map();
    this._nextId = 0;
    this._verifyPool = [];
    this._started = false;
    this.offset = 0;
  }

  setOffset(offset) {
    this.offset = Math.max(0, parseInt(offset, 10) || 0);
  }

  _spawnWorker() {
    const worker = new Worker(WORKER_PATH);
    worker.on('message', (data) => {
      if (data.id !== undefined) {
        const p = this._pending.get(data.id);
        if (p) {
          this._pending.delete(data.id);
          if (data.error) p.reject(new Error(data.error));
          else p.resolve(data.result);
        }
        return;
      }
      if (data.type === 'sample' && this._onSample) this._onSample(data);
      if (data.type === 'stopped' && this._onStopped) this._onStopped(data);
    });
    worker.on('error', (err) => { this._failAll(err); });
    worker.on('exit', () => { this._failAll(new Error('PoH worker exited')); this.worker = null; this._started = false; });
    return worker;
  }

  _call(type, payload) {
    if (!this.worker) return Promise.reject(new Error('PoH engine not started'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  _failAll(err) {
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  start(initialHash) {
    if (this._started) return Promise.resolve();
    this.worker = this._spawnWorker();
    this._started = true;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('PoH start timeout')), 5000);
      this.worker.once('message', (data) => {
        if (data.type === 'started') { clearTimeout(t); resolve(); }
      });
      this.worker.postMessage({ type: 'start', initialHash, hashesPerTick: this.hashesPerTick, message: this.message });
    });
  }

  async sample() {
    if (!this.worker) return { poh_hash: poh.ZERO_HASH, poh_sequence_count: this.offset, poh_tick_count: 0 };
    const s = await this._call('sample', {});
    return { poh_hash: s.poh_hash, poh_sequence_count: s.poh_sequence_count + this.offset, poh_tick_count: s.poh_tick_count };
  }

  async verify(initialHash, claimedFinalHash, numHashes) {
    if (!this.worker) {
      return poh.pohVerify(initialHash, claimedFinalHash, numHashes);
    }
    return this._call('verify', { initialHash, finalHash: claimedFinalHash, numHashes });
  }

  async verifyParallel(initialHash, checkpointHashes, hashesPerTick) {
    const hpt = hashesPerTick || this.hashesPerTick;
    if (!Array.isArray(checkpointHashes) || checkpointHashes.length === 0) {
      return poh.pohVerify(initialHash, initialHash, 0);
    }
    const buckets = [];
    let prev = initialHash;
    for (const chk of checkpointHashes) {
      buckets.push({ start: prev, expected: String(chk), count: hpt });
      prev = String(chk);
    }
    return this._verifyBucketsParallel(buckets);
  }

  _getVerifyWorker() {
    const worker = new Worker(WORKER_PATH);
    return worker;
  }

  async _verifyBucketsParallel(buckets) {
    const count = buckets.length;
    const poolSize = Math.max(1, Math.min(require('os').cpus().length || 2, count));
    const pool = [];
    for (let i = 0; i < poolSize; i++) pool.push(this._spawnVerifyWorker());

    return new Promise((resolve, reject) => {
      const taskForWorker = new Array(poolSize);
      const results = new Array(count).fill(null);
      let cursor = 0;
      let done = 0;
      const terminate = () => { for (const w of pool) try { w.terminate(); } catch {} };

      const maybeResolve = () => {
        if (done === count) {
          terminate();
          resolve(results.every((r) => r === true));
        }
      };
      const dispatch = (wi) => {
        if (cursor >= count) return;
        const bucket = buckets[cursor];
        const id = cursor;
        cursor++;
        taskForWorker[wi] = { id, bucket };
        pool[wi].postMessage({ id, type: 'seq', initialHash: bucket.start, numHashes: bucket.count });
      };
      for (let i = 0; i < poolSize; i++) dispatch(i);

      pool.forEach((w, wi) => {
        w.on('message', (data) => {
          const task = taskForWorker[wi];
          dispatch(wi); // hand this worker its next bucket
          if (task) {
            const ok = !data.error && data.result === task.bucket.expected;
            if (results[task.id] === null) done++;
            results[task.id] = ok;
            maybeResolve();
          }
        });
        w.on('error', (err) => { terminate(); reject(err); });
      });
    });
  }

  _spawnVerifyWorker() {
    return new Worker(WORKER_PATH);
  }

  stop() {
    if (this.worker) {
      const w = this.worker;
      try { w.postMessage({ type: 'stop' }); } catch {}
      setTimeout(() => { try { w.terminate(); } catch {} }, 50);
      this.worker = null;
      this._started = false;
    }
    this._failAll(new Error('PoH engine stopped'));
  }
}

module.exports = { PohEngine };
