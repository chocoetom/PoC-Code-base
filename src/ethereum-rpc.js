// Ethereum-compatible JSON-RPC endpoint for ChocoNode.
// Exposes the standard Ethereum JSON-RPC 2.0 methods expected by popular
// wallets (MetaMask, Trust, Coinbase, Rabby, Frame, WalletConnect, etc.) on
// the SAME HTTP port as the node's existing HTTP API.
const express = require('express');
const { keccak256 } = require('ethers');
const { createCustomCommon, Hardfork, Mainnet } = require('@ethereumjs/common');
const { createTxFromRLP } = require('@ethereumjs/tx');
const { hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { evmTxDigest, evmTxHash, signatureFromHex, recoverTransactionSender, isValidAddress, toChecksumAddress, sha256hex } = require('./crypto');
const { log } = require('./config');

const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const ZERO_HASH = '0'.repeat(64);

function toQuantity(n) {
  const b = (typeof n === 'bigint') ? n : (() => { try { return BigInt(n == null || n === '' ? 0 : n); } catch { return 0n; } })();
  if (b === 0n) return '0x0';
  return '0x' + b.toString(16);
}

function toQuantityNumber(n) {
  return toQuantity((typeof n === 'bigint') ? n : BigInt(n || 0));
}

function parseQuantity(v, label) {
  if (v === undefined || v === null) return 0n;
  let s = String(v);
  if (!/^0x[0-9a-fA-F]+$/.test(s)) throw rpcError(-32602, `invalid ${label || 'quantity'}`);
  return BigInt(s);
}

function normalizeHex(v) {
  let s = String(v);
  if (!s.startsWith('0x')) s = '0x' + s;
  return s.toLowerCase();
}

function rpcError(code, message) {
  const e = new Error(message);
  e.rpcCode = code;
  return e;
}

function hexData(bytesOrHex) {
  if (bytesOrHex == null) return '0x';
  if (Buffer.isBuffer(bytesOrHex)) return '0x' + bytesOrHex.toString('hex');
  if (bytesOrHex instanceof Uint8Array) return bytesToHex(bytesOrHex);
  let h = String(bytesOrHex).replace(/^0x/i, '');
  if (h.length % 2) h = '0' + h;
  return '0x' + h;
}

function normalizeAddr(addr) {
  if (!addr) return '';
  let a = String(addr).toLowerCase();
  if (!a.startsWith('0x')) a = '0x' + a;
  return a;
}

// Resolves a block tag ("latest"/"earliest"/"pending"/hex) to a height
// number. Returns -1 for earliest, or null when the tag resolves to nothing.
function resolveBlockTag(chain, tag) {
  if (tag === undefined || tag === null || tag === 'latest' || tag === 'pending' || tag === '') {
    return chain.height;
  }
  if (tag === 'earliest') return 0;
  if (typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag)) {
    const h = Number(BigInt(tag));
    return h;
  }
  if (typeof tag === 'number') return Math.floor(tag);
  return null;
}

function getBlockFromDatabase(db, heightOrHash) {
  if (typeof heightOrHash === 'number' || /^[0-9]+$/.test(String(heightOrHash).replace(/^0x/i, '')) && !/^[0-9a-fA-F]{64}$/.test(String(heightOrHash).replace(/^0x/i, ''))) {
    const h = Number(BigInt(String(heightOrHash).replace(/^0x/i, '') || 0));
    return db.prepare('SELECT * FROM blocks WHERE height = ?').get(h) || null;
  }
  const hash = String(heightOrHash).replace(/^0x/i, '').toLowerCase();
  return db.prepare('SELECT * FROM blocks WHERE lower(hash) = ?').get(hash) || null;
}

// Extracts a 65-byte recoverable signature [recoveryId, r, s] from a parsed
// @ethereumjs/tx. recoveryId is derived from the EIP-155 `v` value.
function recoverableSignatureFromParsed(parsed) {
  const vn = BigInt(parsed.v || 0n);
  let recovery = 0;
  if (vn === 27n || vn === 28n) recovery = Number(vn - 27n);
  else if (vn >= 35n) recovery = Number((vn - 35n) % 2n);
  const to32 = (b) => Buffer.from(b.toString(16).padStart(64, '0'), 'hex');
  return Buffer.concat([Buffer.from([recovery]), to32(parsed.r), to32(parsed.s)]);
}

// ---------------------------------------------------------------------------

class EthereumRPC {
  constructor(cfg, db, chain, sync, peers, smartContracts, nodeId) {
    this.cfg = cfg;
    this.db = db;
    this.chain = chain;
    this.sync = sync;
    this.peers = peers;
    this.smartContracts = smartContracts;
    this.nodeId = nodeId;
    this._networkChainId = this._resolveChainId(cfg.chainId);
    // Use a Common that matches this node's chainId so createTxFromRLP accepts
    // EIP-155 wallets txs signed for this network (v encodes our chainId).
    try {
      this.common = createCustomCommon({ chainId: this._networkChainId, networkId: this._networkChainId, name: 'ChocoNode' }, Mainnet, { hardfork: Hardfork.Shanghai });
    } catch {
      this.common = new (require('@ethereumjs/common').Common)({ chain: Mainnet, hardfork: Hardfork.Shanghai });
    }
  }

  _resolveChainId(cfgChainId) {
    let n = Number(cfgChainId);
    if (!Number.isInteger(n) || n <= 0) n = 19971971;
    return n;
  }

  _chainId() {
    return this._networkChainId;
  }

  _balanceOf(address) {
    const addr = normalizeAddr(address);
    if (!isValidAddress(addr)) return 0n;
    const u = this.db.prepare('SELECT balance FROM users WHERE lower(address) = lower(?)').get(addr);
    if (u) return (() => { try { return BigInt(u.balance || 0); } catch { return 0n; } })();
    const c = this.db.prepare('SELECT balance FROM smart_contract_accounts WHERE lower(address) = lower(?)').get(addr);
    if (c) return (() => { try { return BigInt(c.balance || 0); } catch { return 0n; } })();
    return 0n;
  }

  _nonceOf(address) {
    const addr = normalizeAddr(address);
    if (!isValidAddress(addr)) return 0;
    const u = this.db.prepare('SELECT nonce FROM users WHERE lower(address) = lower(?)').get(addr);
    return u ? (u.nonce || 0) : 0;
  }

  _codeOf(address) {
    const addr = normalizeAddr(address);
    if (!isValidAddress(addr)) return '0x';
    const c = this.db.prepare('SELECT code FROM smart_contracts WHERE lower(address) = lower(?)').get(addr);
    if (!c || !c.code) return '0x';
    return normalizeHex(c.code);
  }

  _storageAt(address, position) {
    const addr = normalizeAddr(address);
    const slot = normalizeHex(position).replace(/^0x/, '');
    const row = this.db.prepare('SELECT value FROM smart_contract_storage WHERE lower(contract_address) = lower(?) AND slot = ?').get(addr, slot);
    if (!row) return '0x0000000000000000000000000000000000000000000000000000000000000000';
    return normalizeHex(String(row.value)).replace(/^0x/, '').padStart(64, '0');
  }

  async _handleCall(txObj) {
    const to = normalizeAddr(txObj.to);
    const from = normalizeAddr(txObj.from || ZERO_ADDRESS);
    const data = normalizeHex(txObj.data || '0x');
    const value = parseQuantity(txObj.value == null ? 0 : txObj.value, 'value');
    if (!this.smartContracts) return '0x';
    try {
      if (!isValidAddress(to)) return '0x';
      const c = this.db.prepare('SELECT code FROM smart_contracts WHERE lower(address) = lower(?)').get(to);
      if (!c || !c.code) return '0x';
      const result = await this.smartContracts.runSmartContract(to, isValidAddress(from) ? from : ZERO_ADDRESS, data, Number(value));
      return normalizeHex(result.returnValue || '0x');
    } catch {
      return '0x';
    }
  }

  async _handleEstimate(txObj) {
    const to = normalizeAddr(txObj.to);
    const data = normalizeHex(txObj.data || '0x');
    const hasData = data.length > 2 && data !== '0x';
    const gas = 21000n + (hasData ? 2000000n : 0n);
    if (!to && !hasData) return toQuantity(gas);
    if (!this.smartContracts) return toQuantity(gas);
    try {
      const result = await this.smartContracts.runSmartContract(to, normalizeAddr(txObj.from || ZERO_ADDRESS), data, Number(parseQuantity(txObj.value == null ? 0 : txObj.value, 'value')));
      if (result && result.gasUsed) return toQuantity(result.gasUsed);
      return toQuantity(gas);
    } catch (e) {
      throw rpcError(-32000, e.message || 'execution reverted');
    }
  }

  _txToRPC(tx) {
    if (!tx) return null;
    const value = String(tx.value || 0);
    const gasLimit = String(tx.gas_limit || tx.gas || 21000);
    const gasPrice = String(tx.gas_price || '1');
    const v = tx.v != null ? normalizeHex(String(tx.v)) : '0x0';
    const r = tx.r != null ? normalizeHex(String(tx.r)).replace(/^0x/, '').padStart(64, '0') : '0'.repeat(64);
    const s = tx.s != null ? normalizeHex(String(tx.s)).replace(/^0x/, '').padStart(64, '0') : '0'.repeat(64);
    const rpc = {
      hash: normalizeHex(tx.hash || evmTxHash(tx)),
      nonce: toQuantityNumber(tx.nonce || 0),
      blockHash: tx.block_hash ? normalizeHex(tx.block_hash) : null,
      blockNumber: tx.block_height != null ? toQuantityNumber(tx.block_height) : null,
      transactionIndex: tx.block_height != null ? '0x0' : null,
      from: normalizeAddr(tx.from_addr),
      to: tx.to_addr ? normalizeAddr(tx.to_addr) : null,
      value: toQuantity(BigInt(value || 0)),
      gasPrice: toQuantity(BigInt(gasPrice)),
      gas: toQuantity(BigInt(gasLimit)),
      input: normalizeHex(tx.data || '0x'),
      chainId: toQuantityNumber(this._networkChainId || 0),
      v: '0x' + v.replace(/^0x/, ''),
      r: '0x' + r,
      s: '0x' + s,
      type: tx.type != null ? toQuantityNumber(tx.type) : '0x0',
    };
    if (tx.maxFeePerGas != null && tx.maxPriorityFeePerGas != null) {
      rpc.maxFeePerGas = toQuantity(BigInt(tx.maxFeePerGas));
      rpc.maxPriorityFeePerGas = toQuantity(BigInt(tx.maxPriorityFeePerGas));
    }
    return rpc;
  }

  _blockToRPC(blockDbRow, full) {
    if (!blockDbRow) return null;
    const txs = blockDbRow.hash
      ? this.db.prepare('SELECT * FROM transactions WHERE block_hash = ? ORDER BY block_height ASC').all(blockDbRow.hash)
      : [];
    const baseFee = blockDbRow.base_fee || '0';
    const rpc = {
      number: toQuantityNumber(blockDbRow.height || 0),
      hash: normalizeHex(blockDbRow.hash || ''),
      parentHash: normalizeHex(blockDbRow.parent_hash || ZERO_HASH),
      nonce: '0x0000000000000000',
      sha3Uncles: '0x' + '1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347',
      logsBloom: '0x' + '0'.repeat(512),
      transactionsRoot: normalizeHex(blockDbRow.tx_root || ZERO_HASH),
      stateRoot: normalizeHex(blockDbRow.state_root || ZERO_HASH),
      receiptsRoot: '0x' + '0'.repeat(64),
      miner: normalizeAddr(blockDbRow.miner || ZERO_ADDRESS),
      difficulty: '0x0',
      totalDifficulty: toQuantity(blockDbRow.chain_work || '0'),
      extraData: '0x',
      size: '0x0',
      gasLimit: toQuantity(blockDbRow.gas_limit || 30000000),
      gasUsed: toQuantity(blockDbRow.gas_used || 0),
      timestamp: toQuantityNumber(blockDbRow.timestamp || 0),
      baseFeePerGas: toQuantity(BigInt(baseFee)),
      mixHash: '0x' + '0'.repeat(64),
      uncles: [],
      transactions: full ? txs.map(t => this._txToRPC(t)) : txs.map(t => normalizeHex(t.hash || evmTxHash(t))),
    };
    return rpc;
  }

  _receiptToRPC(tx) {
    if (!tx) return null;
    const txHash = normalizeHex(tx.hash || evmTxHash(tx));
    const to = tx.to_addr ? normalizeAddr(tx.to_addr) : null;
    return {
      transactionHash: txHash,
      transactionIndex: '0x0',
      blockHash: tx.block_hash ? normalizeHex(tx.block_hash) : null,
      blockNumber: tx.block_height != null ? toQuantityNumber(tx.block_height) : null,
      from: normalizeAddr(tx.from_addr),
      to,
      contractAddress: null,
      cumulativeGasUsed: '0x0',
      gasUsed: toQuantity(tx.gas_limit || 21000),
      effectiveGasPrice: toQuantity(tx.gas_price || '1'),
      logs: [],
      logsBloom: '0x' + '0'.repeat(512),
      status: '0x1',
      type: '0x0',
    };
  }

  // Handles eth_sendRawTransaction. Parses the raw EVM transaction (RLP),
  // recovers the sender via secp256k1, validates and adds to the mempool.
  async _sendRawTransaction(rawHex) {
    if (!rawHex) throw rpcError(-32602, 'missing raw transaction');
    let rawBytes;
    try {
      const h = String(rawHex).replace(/^0x/i, '');
      if (h.length % 2) throw new Error('odd hex');
      rawBytes = Buffer.from(h, 'hex');
    } catch (e) {
      throw rpcError(-32602, 'invalid raw transaction: ' + e.message);
    }
    let parsed;
    try {
      parsed = createTxFromRLP(Uint8Array.from(rawBytes), { common: this.common });
    } catch (e) {
      throw rpcError(-32602, 'invalid raw transaction encoding: ' + e.message);
    }
    const sender = parsed.getSenderAddress().toString().toLowerCase();
    const to = parsed.to ? normalizeAddr(parsed.to.toString()) : '';
    const chainId = (parsed.common && parsed.common.chainId ? parsed.common.chainId() : 0n).toString();
    const gasPrice = String(parsed.gasPrice || 0n);
    const recoverableSig = recoverableSignatureFromParsed(parsed);
    const dataHex = hexData(parsed.data);
    const gasLimit = Number(parsed.gasLimit || 0n);
    const effectiveGasPrice = parsed.maxFeePerGas != null && parsed.maxFeePerGas > 0n ? parsed.maxFeePerGas : (parsed.gasPrice || 0n);
    const fee = gasLimit * Number(effectiveGasPrice);
    const tx = {
      from_addr: sender,
      to_addr: to,
      value: String(parsed.value || 0n),
      nonce: Number(parsed.nonce || 0n),
      gas_limit: gasLimit,
      gas_price: gasPrice,
      fee,
      chain_id: String(this._networkChainId || chainId),
      priority_fee: parsed.maxPriorityFeePerGas != null ? String((parsed.maxPriorityFeePerGas) || 0n) : '0',
      data: dataHex,
      signature: recoverableSig.toString('base64'),
      rpc_signature: '0x' + rawBytes.toString('hex'),
      raw: '0x' + rawBytes.toString('hex'),
      rpc_type: 'evm',
      type: parsed.type || 0,
      v: parsed.v != null ? String(parsed.v) : undefined,
      r: parsed.r != null ? '0x' + parsed.r.toString(16) : undefined,
      s: parsed.s != null ? '0x' + parsed.s.toString(16) : undefined,
      maxFeePerGas: parsed.maxFeePerGas != null ? String(parsed.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas != null ? String(parsed.maxPriorityFeePerGas) : undefined,
    };
    tx.hash = keccak256('0x' + rawBytes.toString('hex'));
    tx.status = 1;
    const validation = await this.chain.validateTxForMempool(tx);
    if (!validation.ok) throw rpcError(-32000, validation.motivo || 'transaction rejected');
    const result = this.chain.addMempoolTx(tx);
    if (!result.ok) {
      if (result.motivo && /already in (mempool|chain)/i.test(result.motivo)) throw rpcError(-32000, result.motivo);
      throw rpcError(-32000, result.motivo || 'failed to add transaction');
    }
    if (this.sync) setImmediate(() => { try { this.sync.broadcastTx(tx); } catch {} });
    return tx.hash;
  }

  async handle(method, params) {
    params = params || [];
    const [p0, p1, p2] = params;
    switch (method) {
      case 'web3_clientVersion':
        return 'choconode/' + (this.cfg.version || '3.6.0-js');
      case 'web3_sha3': {
        const h = String(p0 || '0x').replace(/^0x/i, '');
        return keccak256('0x' + (h.length % 2 ? '0' + h : h));
      }
      case 'net_version':
        return String(this._networkChainId || 0);
      case 'net_listening':
        return true;
      case 'net_peerCount':
        return toQuantityNumber(this.peers ? this.peers.count() : 0);
      case 'eth_chainId':
        return toQuantityNumber(this._networkChainId || 0);
      case 'eth_protocolVersion':
        return '0x41';
      case 'eth_syncing':
        return false;
      case 'eth_coinbase':
        return this.cfg.minerAddress ? normalizeAddr(this.cfg.minerAddress) : ZERO_ADDRESS;
      case 'eth_mining':
        return false;
      case 'eth_hashrate':
        return '0x0';
      case 'eth_gasPrice':
        return toQuantity(this.chain ? this.chain._baseFeeForHeight(this.chain.height + 1) : 0);
      case 'eth_maxPriorityFeePerGas':
        return toQuantity(0);
      case 'eth_blockNumber':
        return toQuantityNumber(this.chain.height);
      case 'eth_accounts':
        return [];
      case 'eth_getBalance': {
        const addr = normalizeAddr(p0);
        return toQuantity(this._balanceOf(addr));
      }
      case 'eth_getTransactionCount': {
        const addr = normalizeAddr(p0);
        return toQuantityNumber(this._nonceOf(addr));
      }
      case 'eth_getCode':
        return this._codeOf(normalizeAddr(p0));
      case 'eth_getStorageAt': {
        const addr = normalizeAddr(p0);
        const pos = normalizeHex(p1 != null ? p1 : '0x0');
        const val = this._storageAt(addr, pos);
        return normalizeHex(val).replace(/^0x/, '').padStart(64, '0');
      }
      case 'eth_call':
        return await this._handleCall(p0 || {});
      case 'eth_estimateGas':
        return await this._handleEstimate(p0 || {});
      case 'eth_sendRawTransaction':
        return await this._sendRawTransaction(p0);
      case 'eth_sendTransaction': {
        const txObj = p0 || {};
        const from = normalizeAddr(txObj.from);
        const pk = this.cfg.minerPrivateKey;
        if (!pk) throw rpcError(-32000, 'no unlocked account on node');
        const minerAddr = normalizeAddr(this.cfg.minerAddress || '');
        if (from && minerAddr && from !== minerAddr) throw rpcError(-32000, 'can only send from node miner account');
        const to = txObj.to ? normalizeAddr(txObj.to) : '';
        const nonce = txObj.nonce != null ? Number(parseQuantity(txObj.nonce, 'nonce')) : this._nonceOf(from || minerAddr);
        if (!from && minerAddr) return await this._sendTransactionWithKey({ ...txObj, from: minerAddr, to, nonce }, pk);
        const gasLimit = txObj.gas ? Number(parseQuantity(txObj.gas, 'gas')) : (txObj.data ? 3000000 : 21000);
        const internalTx = {
          from_addr: minerAddr,
          to_addr: to,
          value: String(parseQuantity(txObj.value || 0, 'value')),
          nonce,
          gas_limit: gasLimit,
          gas_price: String(this.chain._baseFeeForHeight(this.chain.height + 1)),
          chain_id: String(this._networkChainId || 0),
          priority_fee: '0',
          data: normalizeHex(txObj.data || '0x'),
        };
        const { signTransactionTx } = require('./crypto');
        internalTx.signature = signTransactionTx(internalTx, pk);
        internalTx.hash = evmTxHash(internalTx);
        internalTx.status = 1;
        const validation = await this.chain.validateTxForMempool(internalTx);
        if (!validation.ok) throw rpcError(-32000, validation.motivo || 'transaction rejected');
        const result = this.chain.addMempoolTx(internalTx);
        if (!result.ok) throw rpcError(-32000, result.motivo || 'failed to add transaction');
        if (this.sync) setImmediate(() => { try { this.sync.broadcastTx(internalTx); } catch {} });
        return internalTx.hash;
      }
      case 'eth_getTransactionByHash': {
        const hash = normalizeHex(p0);
        const tx = this.db.prepare('SELECT * FROM transactions WHERE lower(hash) = lower(?)').get(hash)
          || this.db.prepare('SELECT raw FROM mempool WHERE lower(hash) = lower(?)').get(hash);
        if (tx && tx.raw) {
          try { return this._txToRPC(JSON.parse(tx.raw)); } catch { return null; }
        }
        return this._txToRPC(tx);
      }
      case 'eth_getTransactionReceipt': {
        const hash = normalizeHex(p0);
        const tx = this.db.prepare('SELECT * FROM transactions WHERE lower(hash) = lower(?)').get(hash);
        return this._receiptToRPC(tx);
      }
      case 'eth_getBlockByNumber': {
        const height = resolveBlockTag(this.chain, p0);
        if (height == null) return null;
        const full = !!p1;
        return this._blockToRPC(this.db.prepare('SELECT * FROM blocks WHERE height = ?').get(height), full);
      }
      case 'eth_getBlockByHash': {
        const full = !!p1;
        const b = this.db.prepare('SELECT * FROM blocks WHERE lower(hash) = lower(?)').get(String(p0 || '').replace(/^0x/i, ''));
        return this._blockToRPC(b, full);
      }
      case 'eth_getBlockTransactionCountByHash': {
        const b = this.db.prepare('SELECT hash FROM blocks WHERE lower(hash) = lower(?)').get(String(p0 || '').replace(/^0x/i, ''));
        if (!b) return null;
        const c = this.db.prepare('SELECT COUNT(*) as c FROM transactions WHERE block_hash = ?').get(b.hash).c;
        return toQuantityNumber(c);
      }
      case 'eth_getBlockTransactionCountByNumber': {
        const height = resolveBlockTag(this.chain, p0);
        if (height == null) return null;
        const b = this.db.prepare('SELECT hash FROM blocks WHERE height = ?').get(height);
        if (!b) return null;
        const c = this.db.prepare('SELECT COUNT(*) as c FROM transactions WHERE block_hash = ?').get(b.hash).c;
        return toQuantityNumber(c);
      }
      case 'eth_getTransactionByBlockHashAndIndex': {
        const b = this.db.prepare('SELECT hash FROM blocks WHERE lower(hash) = lower(?)').get(String(p0 || '').replace(/^0x/i, ''));
        if (!b) return null;
        const idx = Number(parseQuantity(p1 == null ? 0 : p1, 'index'));
        const txs = this.db.prepare('SELECT * FROM transactions WHERE block_hash = ? ORDER BY rowid ASC').all(b.hash);
        return this._txToRPC(txs[idx] || null);
      }
      case 'eth_getTransactionByBlockNumberAndIndex': {
        const height = resolveBlockTag(this.chain, p0);
        if (height == null) return null;
        const b = this.db.prepare('SELECT hash FROM blocks WHERE height = ?').get(height);
        if (!b) return null;
        const idx = Number(parseQuantity(p1 == null ? 0 : p1, 'index'));
        const txs = this.db.prepare('SELECT * FROM transactions WHERE block_hash = ? ORDER BY rowid ASC').all(b.hash);
        return this._txToRPC(txs[idx] || null);
      }
      case 'eth_getUncleCountByBlockHash':
      case 'eth_getUncleCountByBlockNumber':
        return '0x0';
      case 'eth_getUncleByBlockHashAndIndex':
      case 'eth_getUncleByBlockNumberAndIndex':
        return null;
      case 'eth_getLogs':
        return [];
      case 'eth_getProof':
        throw rpcError(-32601, 'eth_getProof not supported');
      case 'eth_feeHistory': {
        const count = Number(parseQuantity(p0, 'block count'));
        const newest = resolveBlockTag(this.chain, p1);
        const base = this.chain._baseFeeForHeight(this.chain.height + 1);
        return {
          oldestBlock: toQuantityNumber(Math.max(0, newest - Math.max(0, count - 1))),
          baseFeePerGas: Array.from({ length: count }, () => toQuantity(base)),
          gasUsedRatio: Array.from({ length: count }, () => 0),
          reward: Array.from({ length: count }, () => ['0x0']),
        };
      }
      case 'eth_createAccessList':
        return { accessList: [], gasUsed: '0x0' };
      case 'eth_sign':
        throw rpcError(-32601, 'eth_sign not supported');
      case 'personal_ecRecover':
        throw rpcError(-32601, 'personal_ecRecover not supported');
      case 'eth_getCompilers':
        return [];
      case 'eth_compileSolidity':
        throw rpcError(-32601, 'eth_compileSolidity not supported');
      case 'trace_transaction':
      case 'trace_block':
      case 'trace_call':
        throw rpcError(-32601, 'trace not supported');
      case 'eth_getWork':
        return [];
      case 'eth_submitWork':
      case 'eth_submitHashrate':
        return false;
      default:
        throw rpcError(-32601, `the method ${method} does not exist/is not available`);
    }
  }

  router() {
    const router = express.Router();
    router.post('/', async (req, res) => {
      const body = req.body;
      if (Array.isArray(body)) {
        const results = [];
        for (const item of body) {
          results.push(await this._dispatch(item));
        }
        return res.json(results);
      }
      return res.json(await this._dispatch(body));
    });
    return router;
  }

  async _dispatch(reqJson) {
    if (!reqJson || typeof reqJson !== 'object' || reqJson.jsonrpc !== '2.0' || !reqJson.method) {
      return { jsonrpc: '2.0', id: reqJson && reqJson.id != null ? reqJson.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const id = reqJson.id == null ? null : reqJson.id;
    try {
      const result = await this.handle(reqJson.method, reqJson.params);
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      const code = e.rpcCode || -32603;
      return { jsonrpc: '2.0', id, error: { code, message: e.message || 'internal error' } };
    }
  }
}

module.exports = { EthereumRPC };
