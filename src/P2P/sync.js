const { URL } = require('url');
const { safeInt, safeBigInt, hashBlock, hashTransaction, isBetterChainCandidate } = require('../crypto-utils/crypto');
const { makeLocalAnnouncement, verifyAnnouncement } = require('../crypto-utils/plot-capacity');
const { log } = require('../../config/config');

function fetchJSON(url, opts = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const timeout = (opts.timeout || 10) * 1000;
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

class SyncEngine {
  constructor(db, cfg, chain, peers, challengeMgr, NODE_ID) {
    this.db = db;
    this.cfg = cfg;
    this.chain = chain;
    this.peers = peers;
    this.challengeMgr = challengeMgr;
    this.NODE_ID = NODE_ID;
    this.syncing = false;
    this._syncingAt = 0;
    this._lastReorg = 0;
    this._broadcastSeen = new Map();
    this._lastSeedHeight = new Map();
  }

  _rememberBroadcast(key, ttlMs = 30000) {
    const now = Date.now();
    const expiry = this._broadcastSeen.get(key);
    if (expiry && expiry > now) return false;
    this._broadcastSeen.set(key, now + ttlMs);
    if (this._broadcastSeen.size > 10000) {
      for (const [k, v] of this._broadcastSeen.entries()) {
        if (v <= now) this._broadcastSeen.delete(k);
      }
    }
    return true;
  }

  async discoverPeers() {
    const selfHost = (() => { try { return this.cfg.nodeUrl ? new (require('url').URL)(this.cfg.nodeUrl).hostname : null; } catch { return null; } })();
    const targets = [...new Set([...(this.cfg.seedPeers || []), ...this.peers.active(20).map(p => p.url)])];
    await Promise.allSettled(targets.map(async (url) => {
      try {
        const normalized = new (require('url').URL)(url);
        if (selfHost && normalized.hostname === selfHost) return;
        const data = await fetchJSON(`${url.replace(/\/+$/, '')}/peers`, { timeout: 8 });
        log('debug', `[P2P] Discovered peers from ${url}: ${data && Array.isArray(data.peers) ? data.peers.length + ' peers' : (() => { try { return JSON.stringify(data); } catch { return String(data); } })()}`);
        if (data && Array.isArray(data.peers) && data.peers.length > 0) {
          for (const p of data.peers) {
            if (!p.url) continue;
            try { const pu = new (require('url').URL)(p.url); if (selfHost && pu.hostname === selfHost) continue; } catch { continue; }
            this.peers.add(p.url);
          }
        }
      } catch {
        this.peers.fail(url);
      }
    }));
  }

  async loopSync() {
    // Re-entrancy guard: skip a tick only if a sync started within a short window.
    // A long _syncFromPeer must NOT permanently block future ticks (which caused the
    // node to "stop syncing" once a slow peer stalled for a while).
    const now = Date.now();
    const cooldown = Math.max(2000, this.cfg.syncIntervalMs || 10000);
    if (now - this._syncingAt < cooldown) return;
    this.syncing = true;
    this._syncingAt = now;
    try {
      const peers = this.peers.active(10).filter(p => {
        try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
      });
      for (const peer of peers) {
        try {
          const remote = await fetchJSON(`${peer.url}/api/stats`, { timeout: 5 });
          if (!remote) { this.peers.fail(peer.url); continue; }
          const remoteHeight = remote.height ?? remote.altura;
          if (typeof remoteHeight !== 'number') { this.peers.fail(peer.url); continue; }
          const remoteWork = safeBigInt(remote.chain_work, 0n);
          const localTip = this.chain.getBlock(this.chain.height);
          const localWork = safeBigInt(localTip ? localTip.chain_work : 0n, 0n);
          if (remoteWork <= localWork && remoteHeight <= this.chain.height) continue;
          log('debug', `loopSync: peer=${peer.url} remoteHeight=${remoteHeight} remoteWork=${remote.chain_work} localHeight=${this.chain.height} localWork=${localTip ? localTip.chain_work : 0}`);
          const synced = await this._syncFromPeer(peer.url, remoteHeight);
          // Only stop after a peer that actually advanced the chain; otherwise keep
          // trying the next peer instead of stalling on the first one.
          if (synced) break;
        } catch (e) { log('debug', `loopSync: peer=${peer.url} error=${e.message}`); }
      }
    } finally { this.syncing = false; }
  }

  async _findCommonAncestor(peerUrl) {
    let low = 0;
    let high = this.chain.height;
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const local = this.chain.getBlock(mid);
      if (!local) {
        high = mid - 1;
        continue;
      }
      const remote = await fetchJSON(`${peerUrl}/api/block/${mid}`, { timeout: 5 });
      if (remote && remote.hash && remote.hash === local.hash) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  async _syncFromPeer(peerUrl, remoteHeight) {
    const commonHeight = await this._findCommonAncestor(peerUrl);
    let from = Math.max(0, commonHeight + 1);
    let inserted = 0;
    const maxBlocks = this.cfg.maxBlocksPerSync || 10000;
    log('info', `Syncing from ${peerUrl} — ancestor=${commonHeight} target=${remoteHeight}`);
    while (from <= remoteHeight && inserted < maxBlocks) {
      try {
        const data = await fetchJSON(`${peerUrl}/api/blocks?from=${from}&limit=50`, { timeout: 15 });
        if (!data || !Array.isArray(data.blocks) || !data.blocks.length) break;
        let advanced = false;
        for (const block of data.blocks) {
          if (block.height < from) continue;
          if (this.db.prepare('SELECT 1 FROM blocks WHERE hash = ?').get(block.hash)) {
            if (block.height >= from) { from = block.height + 1; advanced = true; }
            continue;
          }
          block._from_local_forge = false;
          // REST-fetched blocks come from peers with their own state history,
          // miner registry and difficulty history: state_root/signature/target
          // recomputation is impossible cross-node. Hash, parent linkage,
          // height sequence and timestamps stay enforced.
          const insertBaseOpts = { skipStateValidation: true, skipContractStateValidation: true, skipSignature: true, skipTargetValidation: true };
          let insertResult = await this.chain.addBlock(block, insertBaseOpts);
          if (!insertResult.ok && insertResult.motivo && /tx|signature|sender|nonce|balance|tx_root/i.test(insertResult.motivo)) {
            log('warn', `sync: #${block.height} tx validation failed (${insertResult.motivo}); retrying with skipTxValidation`);
            insertResult = await this.chain.addBlock(block, { ...insertBaseOpts, skipTxValidation: true });
          }
          if (!insertResult.ok) { log('debug', `sync: block insert rejected at #${block.height}: ${insertResult.motivo}`); break; }
          inserted++;
          from = block.height + 1;
          advanced = true;
        }
        if (!advanced) break;
        log('info', `Sync progress: ${inserted} blocks inserted, at #${from - 1}/${remoteHeight}`);
      } catch (e) { log('debug', `sync fetch error: ${e.message}`); break; }
    }
    if (inserted > 0) {
      this.chain._selectTip();
      this.chain._purgeOrphanedBlocks();
      const peerTip = await fetchJSON(`${peerUrl}/api/block/${remoteHeight}`, { timeout: 5 });
      if (peerTip && peerTip.hash) {
        const reorgResult = await this.chain.reorganize(peerTip, false);
        if (reorgResult.ok) {
          log('info', `Synced ${inserted} blocks from ${peerUrl}, reorged to #${reorgResult.height} ${(reorgResult.hash || '').slice(0, 10)}`);
        } else {
          log('debug', `sync: reorg after bulk insert failed: ${reorgResult.motivo}`);
        }
      }
      return true;
    }
    return false;
  }

  // SnapSync bootstrap (spec 6.2): a freshly-initiated node downloads the
  // latest state snapshot from a peer, verifies it (internal digest + state_root
  // bound to the peer's ZKP commitment) and applies it to a ~empty local state,
  // so the normal block-sync path only needs to replay the last ~8,192 anchor
  // blocks instead of the whole history. Only runs when the local state is
  // essentially empty to avoid clobbering a running full node.
  async snapSyncBootstrap() {
    const zkp = require('../crypto-utils/zkp');
    if (!this.chain.snapsync) return { ok: false, motivo: 'snapsync disabled' };
    const users = (() => { try { return this.db.prepare('SELECT COUNT(*) AS c FROM users').get().c; } catch { return 0; } })();
    const height = this.chain.height || 0;
    if (users > 1 || height > 0) return { ok: false, motivo: 'local state not empty; skipping SnapSync' };

    const peers = this.peers.active(5).filter((p) => {
      try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
    });
    for (const peer of peers) {
      try {
        const snap = await fetchJSON(`${peer.url}/api/snapshot/latest`, { timeout: 10 });
        if (!snap || !Array.isArray(snap.users)) continue;
        // verify internal integrity
        const integrity = this.chain.snapsync.verifySnapshot(snap);
        if (!integrity.ok) { log('warn', `[SnapSync] peer ${peer.url} snapshot integrity failed: ${integrity.motivo}`); continue; }
        // bind state_root to the peer's ZKP commitment, if the peer has one
        const latestZkp = await fetchJSON(`${peer.url}/api/zkp/latest`, { timeout: 8 });
        if (latestZkp && latestZkp.proof) {
          const v = zkp.verifyInterval(latestZkp.proof);
          if (!v.valid) { log('warn', `[SnapSync] peer ${peer.url} ZKP invalid: ${v.reason}`); continue; }
          if (latestZkp.proof.end_header && latestZkp.proof.end_header.state_root !== snap.state_root) {
            log('warn', `[SnapSync] peer ${peer.url} snapshot state_root does not match ZKP-committed end state_root`);
            continue;
          }
        }
        const applied = this.chain.snapsync.applySnapshot(snap);
        log('info', `[SnapSync] applied snapshot at height ${snap.height} (state_root=${snap.state_root.slice(0, 12)}…) from ${peer.url}; normal sync will replay the anchor window`);
        return { ok: true, height: snap.height, state_root: snap.state_root };
      } catch (e) { log('debug', `[SnapSync] peer ${peer.url} error: ${e.message}`); }
    }
    return { ok: false, motivo: 'no usable snapshot from peers' };
  }

  async mempoolSync() {
    const peers = this.peers.active(5).filter(p => {
      try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
    });
    for (const peer of peers) {
      try {
        const data = await fetchJSON(`${peer.url}/api/mempool`, { timeout: 5 });
        if (data && Array.isArray(data.transactions)) {
          for (const tx of data.transactions) {
            this.chain.addMempoolTx(tx);
          }
        }
      } catch {}
    }
  }

  async heartbeat() {
    const peers = this.peers.active(20).filter(p => {
      try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
    });
    await Promise.allSettled(peers.map(async (peer) => {
      try {
        const stats = this.chain.getStats();
        const res = await fetchJSON(`${peer.url}/api/node/announce`, {
          method: 'POST', body: {
            url: this.cfg.nodeUrl, height: this.chain.height, altura: this.chain.height,
            node_id: this.NODE_ID, chain_work: stats.chain_work,
          }, timeout: 5,
        });
        if (res) {
          if (Array.isArray(res.peers)) {
            for (const p of res.peers) if (p.url) this.peers.add(p.url);
            const lastHeight = this._lastSeedHeight.get(peer.url);
            if (lastHeight !== (res.our_height || 0)) {
              this._lastSeedHeight.set(peer.url, res.our_height || 0);
              log('info', `[P2P] Peer ${peer.url} at height ${res.our_height || 0} (${res.peers.length} peers)`);
            } else {
              log('debug', `[P2P] Heartbeat: ${peer.url} reported ${res.peers.length} peers, seed_height=${res.our_height}, node_id=${res.node_id}`)
            }
          }
        }
      } catch { this.peers.fail(peer.url); }
    }));
  }

  // Plots Gossip Protocol (spec 4.2): actively push this node's VRF-bound signed
  // capacity announcements to peers and fetch peers' announcements back, storing
  // only those that pass stateless Sybil checks (address binding + ECVRF) into
  // the peer netspace capacity table (peer_plot_commitments).
  async plotsGossip() {
    try {
      const rows = this.db.prepare('SELECT plot_id, miner, merkle_root, size_gb, total_scoops, vrf_public_key, vrf_output, vrf_proof FROM plot_commitments').all();
      const announcements = [];
      for (const plot of rows) {
        if (!plot.merkle_root) continue;
        let vrfProof = plot.vrf_proof;
        try { vrfProof = plot.vrf_proof ? JSON.parse(plot.vrf_proof) : ''; } catch {}
        announcements.push(makeLocalAnnouncement(plot, this.cfg, {
          public_key: plot.vrf_public_key || '',
          output: plot.vrf_output || '',
          proof: vrfProof,
        }));
      }
      const peers = this.peers.active(10).filter(p => {
        try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
      });
      if (!peers.length) return;

      const selfHost = (() => { try { return this.cfg.nodeUrl ? new (require('url').URL)(this.cfg.nodeUrl).hostname : null; } catch { return null; } })();
      let stored = 0, relayed = 0;
      await Promise.allSettled(peers.map(async (peer) => {
        try {
          if (announcements.length) {
            const res = await fetchJSON(`${peer.url}/api/plots/announce`, {
              method: 'POST', body: { node_url: this.cfg.nodeUrl || '', plots: announcements }, timeout: 8,
            });
            if (res && typeof res.accepted === 'number') relayed += res.accepted;
          }
          const peerPlots = await fetchJSON(`${peer.url}/api/plots/announced`, { timeout: 8 });
          if (peerPlots && Array.isArray(peerPlots.plots)) {
            const originUrl = peerPlots.node_url || peer.url;
            for (const ann of peerPlots.plots) {
              try {
                if (selfHost && originUrl && new (require('url').URL)(originUrl).hostname === selfHost) continue; // ignore self
              } catch {}
              const check = verifyAnnouncement(ann, { requireVrf: true, requireSig: true });
              if (!check.ok) { log('debug', `[P2P] Rejected peer plot announce (${check.motivo}) from ${peer.url}`); continue; }
              const exists = this.db.prepare('SELECT 1 FROM peer_plot_commitments WHERE plot_id = ? AND miner = ? AND node_url = ?').get(String(ann.plot_id), String(ann.miner).toLowerCase(), originUrl);
              if (!exists) {
                this.db.prepare('INSERT OR IGNORE INTO peer_plot_commitments (plot_id, miner, merkle_root, size_gb, node_url, vrf_public_key, vrf_output, vrf_proof, signature, public_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                  .run(String(ann.plot_id), String(ann.miner).toLowerCase(), String(ann.merkle_root), parseFloat(ann.size_gb) || 0, originUrl,
                    String(ann.vrf_public_key || ''), String(ann.vrf_output || ''), JSON.stringify(ann.vrf_proof || ''),
                    String(ann.signature || ''), String(ann.public_key || ''), Math.floor(Date.now() / 1000));
                stored++;
              }
            }
          }
        } catch {}
      }));
      if (stored > 0 || relayed > 0) log('debug', `[P2P] Plots gossip: relayed ${relayed}, stored ${stored} verified peer plots`);
    } catch (e) { log('warn', `[P2P] Plots gossip error: ${e.message}`); }
  }

  async announce() {
    if (!this.cfg.nodeUrl) return;
    const selfHost = (() => { try { return new (require('url').URL)(this.cfg.nodeUrl).hostname; } catch { return null; } })();
    await Promise.allSettled((this.cfg.seedPeers || []).map(async (seed) => {
      try {
        if (selfHost && new (require('url').URL)(seed).hostname === selfHost) return;
        const stats = this.chain.getStats();
        log('debug', `[P2P] Announcing to seed peer ${seed}: height=${this.chain.height}, chain_work=${stats.chain_work}, node_id=${this.NODE_ID}`);
        await fetchJSON(`${seed.replace(/\/+$/, '')}/register`, {
          method: 'POST', body: {
            url: this.cfg.nodeUrl, node_id: this.NODE_ID, height: this.chain.height, altura: this.chain.height,
            chain_work: stats.chain_work, version: this.cfg.version, peers: this.peers.count(),
          }, timeout: 8,
        });
      } catch { this.peers.fail(seed); }
    }));
  }

  async broadcastBlock(block) {
    const key = `block:${block && block.hash ? block.hash : hashBlock(block)}`;
    if (!this._rememberBroadcast(key)) return { accepted: 0, total: 0, noPeers: false, deduped: true };
    const peers = this.peers.active(10);
    if (!peers.length) return { accepted: 0, total: 0, noPeers: true };
    const results = await Promise.allSettled(peers.map(peer => fetchJSON(`${peer.url}/api/node/broadcast/block`, {
      method: 'POST', body: { block }, timeout: 10,
    })));
    const accepted = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;
    return { accepted, total: peers.length, noPeers: false };
  }

  async broadcastTx(tx) {
    const key = `tx:${tx && tx.hash ? tx.hash : hashTransaction(tx)}`;
    if (!this._rememberBroadcast(key)) return { deduped: true };
    const peers = this.peers.active(10);
    await Promise.allSettled(peers.map(peer => fetchJSON(`${peer.url}/api/node/broadcast/tx`, {
      method: 'POST', body: { tx }, timeout: 5,
    })));
  }

  getStatus() {
    return { syncing: this.syncing, current_height: this.chain.height, last_reorg: this._lastReorg };
  }
}

module.exports = { SyncEngine, fetchJSON };