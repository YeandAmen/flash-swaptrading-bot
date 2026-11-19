import { createClient, createPublicClient, http, parseAbi, parseGwei } from 'viem';
import { mainnet } from 'viem/chains';
import { CONFIG } from './config.js';

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(CONFIG.rpcUrl, {
    batch: { batchSize: 25, wait: 10 }, retryCount: 3, retryDelay: 400, timeout: 25_000,
    fetchOptions: CONFIG.forkMode ? { redirect: 'error' } : undefined,
  }),
});

/** Client used only to broadcast signed transactions (Flashbots Protect by default). */
export const sendClient = createClient({
  chain: mainnet,
  transport: http(CONFIG.sendRpcUrl, { retryCount: 1, timeout: 20_000, fetchOptions: { redirect: 'error' } }),
});

export const MIN_PRIORITY_FEE_WEI = parseGwei('0.03');

/** Median priority fee of the last 10 blocks. */
export async function suggestTipWei(): Promise<bigint> {
  const hi = parseGwei('1.5');
  try {
    const fh = await publicClient.getFeeHistory({ blockCount: 10, rewardPercentiles: [50] });
    const tips = (fh.reward ?? []).map((r) => r[0]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const med = tips[Math.floor(tips.length / 2)] ?? parseGwei('0.1');
    return med < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI : med > hi ? hi : med;
  } catch {
    return parseGwei('0.1');
  }
}

/** EIP-1559 computes the target block's base fee from its parent header. */
export function nextBaseFee(parent: { baseFeePerGas: bigint | null; gasUsed: bigint; gasLimit: bigint }): bigint {
  const baseFee = parent.baseFeePerGas;
  const targetGas = parent.gasLimit / 2n;
  if (baseFee === null || targetGas === 0n) throw new Error('missing EIP-1559 base-fee data');
  if (parent.gasUsed > targetGas) {
    const increase = baseFee * (parent.gasUsed - targetGas) / targetGas / 8n;
    return baseFee + (increase > 0n ? increase : 1n);
  }
  return baseFee - (baseFee * (targetGas - parent.gasUsed) / targetGas / 8n);
}

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export const factoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
]);

export const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
]);

export const v2FactoryAbi = parseAbi(['function getPair(address tokenA, address tokenB) view returns (address)']);

export const v2PairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

export const multicall3Abi = parseAbi([
  'function getBlockNumber() view returns (uint256)',
  'function getEthBalance(address addr) view returns (uint256)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
  'function getBasefee() view returns (uint256)',
]);

export const quoterV2Abi = parseAbi([
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]);

export const swapRouter02Abi = parseAbi([
  'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
  'function exactInput(ExactInputParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
]);
