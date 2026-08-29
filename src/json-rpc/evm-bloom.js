// Minimal Ethereum bloom-filter + log helpers for the JSON-RPC layer.
// A 2048-bit (256 byte) bloom filter as used by Ethereum logs. Used to give
// eth_getTransactionReceipt / eth_getBlock* real, non-zero logsBloom values
// and to compute a receipts root for blocks.
const { keccak256 } = require('ethers');

function keccakBytes(buf) {
  if (buf instanceof Uint8Array) {
    const hex = '0x' + Buffer.from(buf).toString('hex');
    return Buffer.from(keccak256(hex).replace(/^0x/i, ''), 'hex');
  }
  // string input: hash its UTF-8 bytes
  const hex = '0x' + Buffer.from(String(buf)).toString('hex');
  return Buffer.from(keccak256(hex).replace(/^0x/i, ''), 'hex');
}

function addByteToBloom(bloom, byte) {
  const bit = byte & 0x07;
  const byteIdx = (31 - (byte >> 3)) * 8 + (7 - bit);
  const bytePos = byteIdx >> 3;
  const bitPos = byteIdx & 7;
  bloom[bytePos] |= (1 << bitPos);
}

// Insert the triple hash (low/mid/high bits 0-10) of a 32-byte value.
function addToBloom(bloom, value) {
  const h = keccakBytes(value);
  for (let i = 0; i < 3; i++) {
    addByteToBloom(bloom, h[2 + i * 2]);
  }
}

// Build the 256-byte bloom for a set of logs. Each log contributes its
// (emitter address + each topic) to the bloom.
function logsToBloom(logs) {
  const bloom = Buffer.alloc(256, 0);
  for (const lg of logs || []) {
    const addr = lg.address && !/^0x/.test(lg.address) ? '0x' + lg.address : lg.address;
    addToBloom(bloom, Buffer.from(String(addr).replace(/^0x/i, ''), 'hex'));
    for (const topic of lg.topics || []) {
      addToBloom(bloom, Buffer.from(String(topic).replace(/^0x/i, ''), 'hex'));
    }
  }
  return '0x' + bloom.toString('hex');
}

// Deterministic merkle root of the receipts (uses the transactionsRoot-style
// pairing merkle over keccak of each receipt string). Provides a stable,
// recomputable receiptsRoot placeholder that changes when receipts change.
function receiptsRoot(receiptStrings) {
  if (!receiptStrings || !receiptStrings.length) return '0x' + '0'.repeat(64);
  let level = receiptStrings.map(s => keccakBytes(s));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] || a;
      next.push(keccakBytes(Buffer.concat([a, b])));
    }
    level = next;
  }
  return '0x' + level[0].toString('hex');
}

module.exports = { logsToBloom, receiptsRoot, keccakBytes };
