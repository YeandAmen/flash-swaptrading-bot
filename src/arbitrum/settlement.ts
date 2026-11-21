import { TransactionReceiptNotFoundError, type Address, type Hash } from 'viem';
import type { ArbitrumBroadcast } from './broadcast.js';
import type { ArbitrumClient } from './market.js';

const confirmations = 2n;
const headMaxAgeMs = 30_000;

export type ArbitrumIntent = {
  hash: Hash;
  nonce: number;
  signedAtBlock?: string;
  deadline?: string;
  broadcast?: ArbitrumBroadcast;
};

type ReceiptClient = Pick<ArbitrumClient, 'getTransactionReceipt' | 'getBlock' | 'getBlockNumber' | 'getTransactionCount'>;
type Receipt = Awaited<ReturnType<ReceiptClient['getTransactionReceipt']>>;
type Reconciliation = { status: 'pending' | 'expired' } | { status: 'receipt'; receipt: Receipt }
  | { status: 'replaced'; replacementHash: Hash };

function parseBlock(value: string | undefined): bigint | undefined {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? BigInt(value) : undefined;
}

/** Resolve only confirmed receipts, proven same-nonce replacements, or definitely rejected sends. */
export async function reconcileArbitrumIntent(
  client: ReceiptClient, pending: ArbitrumIntent, owner: Address, executor: Address, now = Date.now(),
): Promise<Reconciliation> {
  let receipt: Receipt | null = null;
  try {
    receipt = await client.getTransactionReceipt({ hash: pending.hash });
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) return { status: 'pending' };
  }
  if (receipt) {
    if (receipt.transactionHash.toLowerCase() !== pending.hash.toLowerCase()
      || receipt.from.toLowerCase() !== owner.toLowerCase() || receipt.to?.toLowerCase() !== executor.toLowerCase()) {
      return { status: 'pending' };
    }
    const [canonical, head] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }), client.getBlockNumber({ cacheTime: 0 }),
    ]);
    return canonical.hash === receipt.blockHash && head >= receipt.blockNumber + confirmations
      ? { status: 'receipt', receipt } : { status: 'pending' };
  }

  const signed = parseBlock(pending.signedAtBlock);
  if (signed === undefined || signed === 0n) return { status: 'pending' };
  const head = await client.getBlock({ blockTag: 'latest' });
  if (!head.hash || head.number < signed + confirmations || typeof head.timestamp !== 'bigint'
    || Math.abs(now - Number(head.timestamp) * 1000) > headMaxAgeMs) {
    return { status: 'pending' };
  }
  const confirmed = head.number - confirmations;
  const block = await client.getBlock({ blockNumber: confirmed });
  if (!block.hash) return { status: 'pending' };
  const nonceAt = (blockNumber: bigint) => client.getTransactionCount({ address: owner, blockNumber });
  const canonical = async () => (await client.getBlock({ blockNumber: confirmed })).hash === block.hash;
  const confirmedNonce = await nonceAt(confirmed);
  if (confirmedNonce <= pending.nonce) {
    const deadline = parseBlock(pending.deadline);
    if (confirmedNonce !== pending.nonce || pending.broadcast?.status !== 'quota-rejected'
      || deadline === undefined || deadline <= signed || confirmed <= deadline) {
      return { status: 'pending' };
    }
    const nextPending = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
    return nextPending === pending.nonce && await canonical() ? { status: 'expired' } : { status: 'pending' };
  }

  // The nonce was unused before this range. Find the first canonical block where it was consumed.
  if (await nonceAt(signed - 1n) > pending.nonce) return { status: 'pending' };
  let first = signed;
  let last = confirmed;
  while (first < last) {
    const middle = (first + last) / 2n;
    if (await nonceAt(middle) > pending.nonce) last = middle;
    else first = middle + 1n;
  }
  const consumer = await client.getBlock({ blockNumber: first, includeTransactions: true });
  const transaction = consumer.transactions.find((tx) => tx.nonce === pending.nonce && tx.from.toLowerCase() === owner.toLowerCase());
  if (!transaction || transaction.hash.toLowerCase() === pending.hash.toLowerCase()
    || !consumer.hash || (await client.getBlock({ blockNumber: first })).hash !== consumer.hash || !await canonical()) {
    return { status: 'pending' };
  }
  return { status: 'replaced', replacementHash: transaction.hash };
}
