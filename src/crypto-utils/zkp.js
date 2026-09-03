const crypto = require('crypto');

const ZERO_HASH = '0'.repeat(64);

const LEAF_DOMAIN = Buffer.from('CC-ZKP-LEAF-v1');
const NODE_DOMAIN = Buffer.from('CC-ZKP-NODE-v1');
const LEGACY_ANCHOR_PREFIX = 'genesis';

function sha256hex(data) {
  if (Buffer.isBuffer(data)) return crypto.createHash('sha256').update(data).digest('hex');
  return crypto.createHash('sha256').update(String(data)).digest('hex');
}

function _hstr(v) { return String(v == null ? '' : v); }
function _normalizeHeader(h) {
  return {
    height: parseInt(h.height, 10) || 0,
    hash: _hstr(h.hash),
    parent_hash: _hstr(h.parent_hash),
    poh_hash: _hstr(h.poh_hash),
    poh_sequence_count: parseInt(h.poh_sequence_count, 10) || 0,
    state_root: _hstr(h.state_root),
  };
}

function leafCommitment(header) {
  const h = _normalizeHeader(header);
  const buf = Buffer.concat([
    LEAF_DOMAIN,
    Buffer.from(String(h.height)),
    Buffer.from(h.hash, 'utf8'),
    Buffer.from(h.parent_hash, 'utf8'),
    Buffer.from(h.poh_hash, 'utf8'),
    Buffer.from(String(h.poh_sequence_count)),
    Buffer.from(h.state_root, 'utf8'),
  ]);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function node(parentLeft, parentRight) {
  const l = Buffer.from(parentLeft, 'hex');
  const r = Buffer.from(parentRight, 'hex');
  return crypto.createHash('sha256').update(Buffer.concat([NODE_DOMAIN, l, r])).digest('hex');
}

function buildTree(leaves) {
  const leafBuffers = leaves.map((l) => Buffer.from(l, 'hex'));
  const levels = [leafBuffers];
  let level = leafBuffers;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(Buffer.from(node(left.toString('hex'), right.toString('hex')), 'hex'));
    }
    levels.push(next);
    level = next;
  }
  const root = levels[levels.length - 1][0] || Buffer.from(ZERO_HASH, 'hex');
  return { levels, root: root.toString('hex') };
}

function merklePath(levels, leafIndex) {
  const siblings = [];
  const bits = [];
  let idx = leafIndex;
  for (let l = 0; l + 1 < levels.length; l++) {
    const level = levels[l];
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = siblingIdx < level.length ? level[siblingIdx] : level[idx];
    siblings.push(sibling.toString('hex'));
    bits.push(siblingIdx === idx + 1 ? 1 : 0);
    idx = Math.floor(idx / 2);
  }
  const byteLen = Math.ceil(bits.length / 8);
  const bytes = Buffer.alloc(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= (1 << (i & 7));
  }
  return { siblings, bits: bytes.toString('hex') };
}

function recomputeFromPath(leaf, path) {
  let cur = Buffer.from(leaf, 'hex');
  const bits = Buffer.from((path.bits || '').toString(), 'hex');
  for (let i = 0; i < path.siblings.length; i++) {
    const sib = Buffer.from(path.siblings[i], 'hex');
    const right = bits.length > 0 && (bits[i >> 3] & (1 << (i & 7))) !== 0;
    const parent = right ? Buffer.concat([cur, sib]) : Buffer.concat([sib, cur]);
    cur = crypto.createHash('sha256').update(Buffer.concat([NODE_DOMAIN, parent])).digest();
  }
  return cur.toString('hex');
}

function proveInterval(blocks, opts = {}) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('proveInterval: empty interval');
  }
  const sorted = [...blocks].sort((a, b) => (parseInt(a.height, 10) || 0) - (parseInt(b.height, 10) || 0));
  const startHeader = _normalizeHeader(sorted[0]);
  const endHeader = _normalizeHeader(sorted[sorted.length - 1]);

  const leaves = sorted.map((b) => leafCommitment(b));
  const { levels, root } = buildTree(leaves);

  const startLeaf = leafCommitment(startHeader);
  const endLeaf = leafCommitment(endHeader);

  const startIndex = 0;
  const endIndex = sorted.length - 1;

  const proof = {
    version: 1,
    interval: { start_height: startHeader.height, end_height: endHeader.height, block_count: sorted.length },
    commitment: root,
    start_header: startHeader,
    end_header: endHeader,
    start_path: merklePath(levels, startIndex),
    end_path: merklePath(levels, endIndex),
    start_leaf: startLeaf,
    end_leaf: endLeaf,
    created_at: opts.created_at || Math.floor(Date.now() / 1000),
    domain: 'chococoin.zkp.headerchain.v1',
  };

  proof.size_bytes = Buffer.byteLength(JSON.stringify(proof), 'utf8');
  return proof;
}

function verifyInterval(proof) {
  const bad = (reason) => ({ valid: false, reason });
  if (!proof || typeof proof !== 'object') return bad('missing proof');
  if (proof.version !== 1) return bad('unsupported proof version');
  if (!proof.commitment || !proof.start_header || !proof.end_header) return bad('incomplete proof');
  if (!proof.start_path || !Array.isArray(proof.start_path.siblings) || !proof.end_path || !Array.isArray(proof.end_path.siblings)) return bad('missing merkle paths');

  const startLeaf = leafCommitment(proof.start_header);
  const endLeaf = leafCommitment(proof.end_header);
  if (proof.start_leaf && startLeaf !== proof.start_leaf) return bad('start leaf mismatch');
  if (proof.end_leaf && endLeaf !== proof.end_leaf) return bad('end leaf mismatch');

  const startRoot = recomputeFromPath(startLeaf, proof.start_path);
  const endRoot = recomputeFromPath(endLeaf, proof.end_path);
  if (startRoot !== proof.commitment) return bad('start boundary not in committed interval');
  if (endRoot !== proof.commitment) return bad('end boundary not in committed interval');

  const s = proof.start_header;
  const e = proof.end_header;
  const count = proof.interval && proof.interval.block_count;
  if (e.height - s.height !== (count ? count - 1 : Infinity)) {
    return bad(`height range mismatch (${s.height}..${e.height} count=${count})`);
  }

  if ((e.poh_sequence_count || 0) < (s.poh_sequence_count || 0)) {
    return bad('PoH sequence went backwards across interval');
  }

  if (!s.state_root || !e.state_root) return bad('missing state roots for transition');
  if (s.state_root === e.state_root && count !== 1) {
    return bad('state root unchanged across a multi-block interval');
  }

  return { valid: true, reason: 'ok', commitment: proof.commitment, interval: proof.interval };
}

function assertProofSize(proof) {
  return proof.size_bytes <= 3072;
}

function encodeProof(proof) {
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('hex');
}
function decodeProof(hex) {
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
}

module.exports = {
  ZERO_HASH,
  leafCommitment,
  node,
  buildTree,
  merklePath,
  recomputeFromPath,
  proveInterval,
  verifyInterval,
  assertProofSize,
  encodeProof,
  decodeProof,
};
