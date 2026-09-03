// ============================================================================
// SNAPSYNC SERVICE — snapshot generation/serving & instant-sync bootstrap (spec 6.2)
// ----------------------------------------------------------------------------
// Orchestrates the SnapSync protocol on top of the pure snapshot module and the
// ZKP service (item 6):
//
//   Generator side (full node):
//     - At each clean ZKP boundary (height % 8192 === 0) extract the whole EVM
//       state into a snapshot, bind it to the ZKP-committed state_root of that
//       boundary, persist it to snapshotsDir/ and record it in the snapshots DB
//       table.
//   Consumer side (new node):
//     - fetchAndApply latest proof + latest snapshot (H-8192) + state_root check;
//       the remaining ~8,192 anchor-window blocks are then replayed by the normal
//       block-sync path (spec 6.2 steps a-c).
//
// This service owns filesystem + DB concerns; the pure snapshot logic lives in
// ./snapshot.js and the ZKP logic in ../crypto-utils/zkp.js.
// ============================================================================
const path = require('path');
const fs = require('fs');
const { log } = require('../../config/config');
const snap = require('./snapshot');
const { safeInt } = require('../crypto-utils/crypto');

const BOUNDARY = 8192;

function _sanitizeName(v) { return String(v || '').replace(/[^0-9a-zA-Z._-]/g, '_'); }

class SnapSyncService {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg || {};
    this.dir = this.cfg.snapshotsDir || path.join(process.cwd(), 'snapshots');
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { log('warn', `[SnapSync] cannot create snapshots dir ${this.dir}: ${e.message}`); }
  }

  get enabled() {
    return this.cfg.snapsyncEnabled !== false;
  }

  // Look up the matching ZKP proof for a boundary height from the chain's ZKP
  // service (item 6). The boundary proof ends at the boundary tip H (covers
  // [H-8191..H]) so its end_header.state_root equals the snapshot's state_root.
  _zkpCommitmentForBoundary(height) {
    try {
      const zkpSvc = this._zkpSvc;
      if (!zkpSvc) return { commitment: '', proof_id: null };
      const row = this.db.prepare('SELECT * FROM zkp_proofs WHERE end_height = ? ORDER BY id DESC LIMIT 1').get(safeInt(height, 0));
      if (!row) return { commitment: '', proof_id: null };
      const v = zkpSvc.verifyStored(row.id);
      if (!v.valid) { log('warn', `[SnapSync] ZKP proof #${row.id} failed verification: ${v.reason}`); return { commitment: '', proof_id: null }; }
      return { commitment: row.commitment, proof_id: row.id };
    } catch (e) { return { commitment: '', proof_id: null }; }
  }

  setZkp(zkpSvc) { this._zkpSvc = zkpSvc; }

  snapshotFilename(height) {
    return `snapshot-${_sanitizeName(height)}.json`;
  }

  // Generate + persist a snapshot at a boundary height. No-op if the height is
  // not a clean 8,192 boundary or a snapshot already exists for it.
  generateAtBoundary(height, opts = {}) {
    height = safeInt(height, 0);
    if (!this.enabled) return null;
    if (height < BOUNDARY || height % BOUNDARY !== 0) return null;
    if (this.getMeta(height)) return this.getMeta(height);
    let zkpBinding = { commitment: '', proof_id: null };
    if (!opts.skipZkp) zkpBinding = this._zkpCommitmentForBoundary(height);
    const block = (() => { try { return opts.block || this.db.prepare('SELECT hash FROM blocks WHERE height = ?').get(height); } catch { return null; } })();
    const snapshot = snap.extractState(this.db, height, {
      zkp_commitment: zkpBinding.commitment,
      zkp_proof_id: zkpBinding.proof_id,
      block_hash: block ? block.hash : '',
    });
    snapshot.digest = snap.snapshotDigest(snapshot);

    const file = this.snapshotFilename(height);
    const now = Math.floor(Date.now() / 1000);
    try {
      fs.writeFileSync(path.join(this.dir, file), JSON.stringify(snapshot));
    } catch (e) {
      log('warn', `[SnapSync] failed to write snapshot file ${file}: ${e.message}`);
      return null;
    }
    this.db.prepare('INSERT OR REPLACE INTO snapshots (height, state_root, zkp_commitment, digest, block_hash, file, verified, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(height, snapshot.state_root, snapshot.zkp_commitment, snapshot.digest, block ? block.hash : '', file, 1, now);
    log('info', `[SnapSync] generated state snapshot at height ${height} (state_root=${snapshot.state_root.slice(0, 12)}…, zkp=${zkpBinding.commitment.slice(0, 12) || 'none'})`);
    return this.getMeta(height);
  }

  getMeta(height) {
    return this.db.prepare('SELECT * FROM snapshots WHERE height = ?').get(safeInt(height, 0));
  }

  getLatestMeta() {
    return this.db.prepare('SELECT * FROM snapshots ORDER BY height DESC LIMIT 1').get();
  }

  // Load a full snapshot object (metadata + data) by height, from disk.
  loadSnapshot(height) {
    const meta = this.getMeta(height);
    if (!meta) return null;
    try {
      const raw = fs.readFileSync(path.join(this.dir, meta.file), 'utf8');
      return { ...JSON.parse(raw), height, state_root: meta.state_root, zkp_commitment: meta.zkp_commitment, digest: meta.digest };
    } catch (e) { return null; }
  }

  loadLatestSnapshot() {
    const meta = this.getLatestMeta();
    if (!meta) return null;
    return this.loadSnapshot(meta.height);
  }

  // Verify a snapshot object's internal digest + (if present) that its
  // state_root matches an available ZKP commitment.
  verifySnapshot(snapshot) {
    const integrity = snap.verifySnapshotIntegrity(snapshot);
    if (!integrity.ok) return { ok: false, motivo: integrity.motivo };
    return { ok: true, state_root: snapshot.state_root };
  }

  // Apply a snapshot onto the local (fresh) state DB. Returns local verified
  // state_root afterwards.
  applySnapshot(snapshot) {
    return snap.applySnapshot(this.db, snapshot);
  }

  listMeta() {
    return this.db.prepare('SELECT height, state_root, zkp_commitment, digest, block_hash, created_at, verified FROM snapshots ORDER BY height DESC').all();
  }
}

module.exports = { SnapSyncService, BOUNDARY };
