import { createClient, createPublicClient, http, parseAbi, parseGwei } from 'viem';
import { mainnet } from 'viem/chains';
import { CONFIG } from './config.js';

export const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(CONFIG.rpcUrl, { batch: { batchSize: 25, wait: 10 }, retryCount: 3, retryDelay: 400, timeout: 25_000 }),
});

/** Client used only to broadcast signed transactions (Flashbots Protect by default). */
export const sendClient = createClient({
  chain: mainnet,
  transport: http(CONFIG.sendRpcUrl, { retryCount: 1, timeout: 20_000 }),
});

/** Median priority fee of the last 10 blocks, clamped to a sane range. */
export async function suggestTipWei(): Promise<bigint> {
  const lo = parseGwei('0.03');
  const hi = parseGwei('1.5');
  try {
    const fh = await publicClient.getFeeHistory({ blockCount: 10, rewardPercentiles: [50] });
    const tips = (fh.reward ?? []).map((r) => r[0]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const med = tips[Math.floor(tips.length / 2)] ?? parseGwei('0.1');
    return med < lo ? lo : med > hi ? hi : med;
  } catch {
    return parseGwei('0.1');
  }
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

export const multicall3Abi = parseAbi([
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
