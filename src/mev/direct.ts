import { parseGwei, type Address, type Hex } from 'viem';
import { MIN_PRIORITY_FEE_WEI, mevReadClient } from '../chain.js';

const PRIORITY_CACHE_MS = 24_000;
const DEFAULT_PRIORITY_FEE = parseGwei('0.1');
let cachedTip: { fee: bigint; fasterFee: bigint; expiresAt: number; observed: boolean } | undefined;
let readingTip: Promise<void> | undefined;

/** Use recent Ethereum tips and cap the recommendation at the operator's limit. */
export async function directPriorityQuote(maximumWei: bigint, faster = false) {
  if (maximumWei <= 0n) throw new RangeError('Direct priority fee cap must be positive');
  if (!cachedTip || Date.now() >= cachedTip.expiresAt) {
    readingTip ??= mevReadClient.getFeeHistory({ blockCount: 10, rewardPercentiles: [50, 90] })
      .then(({ reward }) => {
        const [ordinary, expedited] = [0, 1].map((index) => {
          const samples = (reward ?? []).flatMap((row) => row[index] === undefined ? [] : [row[index]])
            .sort((a, b) => a === b ? 0 : a < b ? -1 : 1);
          return samples[Math.floor(samples.length / 2)];
        });
        const fee = ordinary ?? DEFAULT_PRIORITY_FEE;
        const fasterFee = expedited !== undefined && expedited > fee ? expedited : fee;
        cachedTip = { fee, fasterFee, expiresAt: Date.now() + PRIORITY_CACHE_MS,
          observed: ordinary !== undefined && expedited !== undefined && ordinary >= 0n && expedited >= 0n };
      })
      .catch(() => {
        cachedTip = { fee: DEFAULT_PRIORITY_FEE, fasterFee: DEFAULT_PRIORITY_FEE, expiresAt: Date.now() + PRIORITY_CACHE_MS, observed: false };
      })
      .finally(() => { readingTip = undefined; });
    await readingTip;
  }

  const estimate = (faster ? cachedTip?.fasterFee : cachedTip?.fee) ?? DEFAULT_PRIORITY_FEE;
  const priority = estimate < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI : estimate;
  return { priority: priority > maximumWei ? maximumWei : priority, observedUntil: cachedTip?.observed ? cachedTip.expiresAt : undefined };
}

export async function directPriorityFee(maximumWei: bigint, faster = false): Promise<bigint> {
  return (await directPriorityQuote(maximumWei, faster)).priority;
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

/** Preserve payout margin for movement before inclusion, rounding up to wei. */
export function directExecutionReserve(proceeds: bigint): bigint {
  return proceeds > 0n ? (proceeds + 9n) / 10n : 0n;
}

/** Clamp a fee to what the order can pay at its full gas limit over the target horizon. */
export function affordableDirectFees(nextBaseWei: bigint, gas: bigint, desiredTip: bigint,
  minimumTip: bigint, availableWei: bigint, horizon = 1) {
  if (gas <= 0n || availableWei < 0n) return null;
  const baseCeiling = horizon === 1 ? nextBaseWei : directFees(nextBaseWei, 0n, horizon).maxFeePerGas;
  const affordableTip = availableWei / gas - baseCeiling;
  const tip = affordableTip < desiredTip ? affordableTip : desiredTip;
  return tip >= minimumTip ? directFees(nextBaseWei, tip, horizon) : null;
}

/**
 * Locate a confirmed nonce consumer. An unused nonce, null receipt or empty
 * mempool view is insufficient evidence that a direct signature is gone.
 */
type NonceConsumer = { status: 'included'; hash: Hex } | { status: 'unused' | 'unknown' };

export async function findNonceConsumer(address: Address, nonce: number, confirmedBlock: bigint, firstBlock: bigint): Promise<NonceConsumer> {
  if (firstBlock < 0n || confirmedBlock < firstBlock) return { status: 'unknown' };
  const countAt = (blockNumber: bigint) => mevReadClient.getTransactionCount({ address, blockNumber });
  if (await countAt(confirmedBlock) <= nonce) return { status: 'unused' };

  let start = firstBlock;
  let end = confirmedBlock;
  while (start < end) {
    const middle = (start + end) / 2n;
    if (await countAt(middle) > nonce) end = middle;
    else start = middle + 1n;
  }

  const block = await mevReadClient.getBlock({ blockNumber: start, includeTransactions: true });
  const match = block.transactions.find((tx) => tx.nonce === nonce && tx.from.toLowerCase() === address.toLowerCase());
  if (!match) return { status: 'unknown' };
  const canonical = await mevReadClient.getBlock({ blockNumber: start });
  return canonical.hash === block.hash ? { status: 'included', hash: match.hash } : { status: 'unknown' };
}
