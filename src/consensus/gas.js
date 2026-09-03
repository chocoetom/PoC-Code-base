const GAS_PARAMS = {
  simpleTransferGas: 21000,
  gasPerByteZero: 4,
  gasPerByteNonZero: 16,
  initialBaseFee: 10 ** 9,
  blockGasLimit: 120000000,         
  targetBlockGasLimit: 60000000,       
  maxGasPerTx: 10000000,            
  initialSmartContractGasLimit: 10000000,
  initialSmartContractGasPrice: 10 ** 9,
};

function estimateIntrinsicGas(tx) {
  let gas = GAS_PARAMS.simpleTransferGas;
  let dataHex = '';
  if (tx.data) {
    dataHex = tx.data.startsWith('0x') ? tx.data.slice(2) : tx.data;
  }
  const data = dataHex ? Buffer.from(dataHex, 'hex') : Buffer.alloc(0);
  for (const byte of data) {
    gas += byte === 0 ? GAS_PARAMS.gasPerByteZero : GAS_PARAMS.gasPerByteNonZero;
  }
  return gas;
}

function capTxGasLimit(tx) {
  const intrinsic = estimateIntrinsicGas(tx);
  const requested = safeInt(tx.gas_limit, intrinsic);
  const limit = Math.min(GAS_PARAMS.maxGasPerTx, Math.max(intrinsic, requested));
  return { gasLimit: limit, capped: requested > GAS_PARAMS.maxGasPerTx };
}

function minimumFee(tx, baseFee) {
  const intrinsic = estimateIntrinsicGas(tx);
  return BigInt(intrinsic) * BigInt(baseFee || 1);
}

function safeInt(v, def) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : def; }

function nextBaseFee(parentBaseFee, parentGasUsed, targetGas, minGasPrice, mempoolPendingCount = 0) {
  if (parentGasUsed === targetGas) return parentBaseFee;
  const delta = parentGasUsed > targetGas
    ? (parentBaseFee * BigInt(parentGasUsed - targetGas)) / BigInt(targetGas) / 8n
    : -(parentBaseFee * BigInt(targetGas - parentGasUsed)) / BigInt(targetGas) / 8n;
  let next = parentBaseFee + delta;

  if (mempoolPendingCount < targetGas / GAS_PARAMS.simpleTransferGas / 4) {
    next = (next * 95n) / 100n;
  }

  if (next < BigInt(minGasPrice)) next = BigInt(minGasPrice);
  return next;
}

module.exports = {
  GAS_PARAMS,
  estimateIntrinsicGas,
  nextBaseFee,
  capTxGasLimit,
  minimumFee,
};