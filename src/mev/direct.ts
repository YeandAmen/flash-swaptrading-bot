import { createClient, http, keccak256, parseGwei, type Address, type Hex } from 'viem';
import { sendRawTransaction } from 'viem/actions';
import { mainnet } from 'viem/chains';
import { MIN_PRIORITY_FEE_WEI, mevReadClient } from '../chain.js';
import { CONFIG } from '../config.js';

const directClient = createClient({
  chain: mainnet,
  transport: http(CONFIG.rpcUrl, { retryCount: 0, timeout: 3_500, fetchOptions: { redirect: 'error' } }),
});

const PRIORITY_CACHE_MS = 24_000;
const DEFAULT_PRIORITY_FEE = parseGwei('0.1');
let cachedTip: { fee: bigint; expiresAt: number } | undefined;
let readingTip: Promise<bigint> | undefined;

/** Use recent Ethereum tips and cap the recommendation at the operator's limit. */
export async function directPriorityFee(maximumWei: bigint): Promise<bigint> {
  if (maximumWei <= 0n) throw new RangeError('Direct priority fee cap must be positive');
  if (!cachedTip || Date.now() >= cachedTip.expiresAt) {
    readingTip ??= mevReadClient.getFeeHistory({ blockCount: 10, rewardPercentiles: [50] })
      .then(({ reward }) => {
        const samples = reward?.flat().sort((a, b) => a === b ? 0 : a < b ? -1 : 1) ?? [];
        return samples[Math.floor(samples.length / 2)] ?? DEFAULT_PRIORITY_FEE;
      })
      .catch(() => DEFAULT_PRIORITY_FEE)
      .then((fee) => {
        cachedTip = { fee, expiresAt: Date.now() + PRIORITY_CACHE_MS };
        return fee;
      })
      .finally(() => { readingTip = undefined; });
    await readingTip;
  }

  const estimate = cachedTip?.fee ?? DEFAULT_PRIORITY_FEE;
  const priority = estimate < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI : estimate;
  return priority > maximumWei ? maximumWei : priority;
}

/** Bound the fee even if each intervening block uses its entire gas limit. */
export function directFees(nextBaseWei: bigint, priorityWei: bigint, horizon: number) {
  if (nextBaseWei < 0n || priorityWei < 0n || !Number.isSafeInteger(horizon) || horizon < 1 || horizon > 32) {
    throw new RangeError('Invalid direct fee inputs');
  }
  let ceiling = nextBaseWei;
  for (let blocks = 1; blocks < horizon; blocks++) {
    const increase = ceiling / 8n;
    ceiling += increase > 0n ? increase : 1n;
  }
  return { maxFeePerGas: ceiling + priorityWei, maxPriorityFeePerGas: priorityWei };
}

/** Publish once through Ethereum JSON-RPC. A timeout still leaves the transaction unresolved. */
export async function submitDirect(serialized: Hex): Promise<Hex> {
  if (!CONFIG.allowLiveTrading && !CONFIG.forkMode) throw new Error('Live transaction canceled before broadcast');
  const expected = keccak256(serialized);
  let acknowledged: Hex;
  try {
    acknowledged = await sendRawTransaction(directClient, { serializedTransaction: serialized });
  } catch {
    throw new Error('The Ethereum RPC did not acknowledge the direct MEV transaction');
  }
  if (typeof acknowledged !== 'string' || acknowledged.toLowerCase() !== expected) {
    throw new Error('The Ethereum RPC returned an unexpected transaction hash');
  }
  return expected;
}

/**
 * Locate a confirmed nonce consumer. An unused nonce, null receipt or empty
 * mempool view is insufficient evidence that a direct signature is gone.
 */
export async function findNonceConsumer(address: Address, nonce: number, confirmedBlock: bigint, firstBlock: bigint): Promise<Hex | null> {
  if (firstBlock < 0n || confirmedBlock < firstBlock) return null;
  const countAt = (blockNumber: bigint) => mevReadClient.getTransactionCount({ address, blockNumber });
  if (await countAt(confirmedBlock) <= nonce) return null;

  let start = firstBlock;
  let end = confirmedBlock;
  while (start < end) {
    const middle = (start + end) / 2n;
    if (await countAt(middle) > nonce) end = middle;
    else start = middle + 1n;
  }

  const block = await mevReadClient.getBlock({ blockNumber: start, includeTransactions: true });
  const match = block.transactions.find((tx) => tx.nonce === nonce && tx.from.toLowerCase() === address.toLowerCase());
  if (!match) return null;
  const canonical = await mevReadClient.getBlock({ blockNumber: start });
  return canonical.hash === block.hash ? match.hash : null;
}
