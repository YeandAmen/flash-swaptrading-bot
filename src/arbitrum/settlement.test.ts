import assert from 'node:assert/strict';
import test from 'node:test';
import { TransactionReceiptNotFoundError, type Hash } from 'viem';
import { reconcileArbitrumIntent, type ArbitrumIntent } from './settlement.js';

const owner = '0x0000000000000000000000000000000000000001';
const executor = '0x0000000000000000000000000000000000000002';
const hash = (n: bigint): Hash => `0x${n.toString(16).padStart(64, '0')}`;
const signed = { hash: hash(200n), nonce: 7, signedAtBlock: '100', deadline: '110' } satisfies ArbitrumIntent;
const replacement = hash(300n);
const now = 1_800_000_000_000;

function fixture({
  head = 115n, age = 0, minedAt, minedHash = replacement, mempoolNonce, transportError = false, reorg = false,
}: {
  head?: bigint; age?: number; minedAt?: bigint; minedHash?: Hash; mempoolNonce?: number; transportError?: boolean; reorg?: boolean;
} = {}) {
  let nonceReads = 0;
  const client = {
    getTransactionReceipt: async () => {
      if (transportError) throw new Error('upstream timed out');
      throw new TransactionReceiptNotFoundError({ hash: signed.hash });
    },
    getBlock: async ({ blockNumber = head, includeTransactions = false } = {}) => {
      const transactions = blockNumber === minedAt && includeTransactions ? [{ hash: minedHash, nonce: 7, from: owner }] : [];
      return { number: blockNumber, timestamp: BigInt((now - age) / 1000),
        hash: reorg && blockNumber === minedAt && !includeTransactions ? hash(900n) : hash(blockNumber), transactions };
    },
    getTransactionCount: async ({ blockNumber = head, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      nonceReads++;
      if (blockTag === 'pending' && mempoolNonce !== undefined) return mempoolNonce;
      return minedAt !== undefined && blockNumber >= minedAt ? 8 : 7;
    },
  };
  return {
    resolve: (intent: ArbitrumIntent) => reconcileArbitrumIntent(
      client as unknown as Parameters<typeof reconcileArbitrumIntent>[0], intent, owner, executor, now),
    nonceReads: () => nonceReads,
  };
}

test('Arbitrum keeps a pending intent on a transient receipt error despite an advanced nonce', async () => {
  const rpc = fixture({ minedAt: 106n, transportError: true });
  assert.deepEqual(await rpc.resolve(signed), { status: 'pending' });
  assert.equal(rpc.nonceReads(), 0);
});

test('Arbitrum requires a canonical other hash before it records replacement', async () => {
  assert.deepEqual(await fixture({ minedAt: 106n }).resolve(signed), { status: 'replaced', replacementHash: replacement });
  assert.deepEqual(await fixture({ minedAt: 106n, minedHash: signed.hash }).resolve(signed), { status: 'pending' });
  assert.deepEqual(await fixture({ minedAt: 106n, reorg: true }).resolve(signed), { status: 'pending' });
  assert.deepEqual(await fixture({ minedAt: 106n }).resolve({ hash: signed.hash, nonce: signed.nonce }), { status: 'pending' });
});

test('Arbitrum expires only explicit quota rejection past deadline with a fresh confirmed unused nonce', async () => {
  const refused: ArbitrumIntent = { ...signed, broadcast: { status: 'quota-rejected', via: 'alternate' } };
  assert.deepEqual(await fixture().resolve(refused), { status: 'expired' });
  assert.deepEqual(await fixture({ head: 112n }).resolve(refused), { status: 'pending' });
  assert.deepEqual(await fixture({ age: 31_000 }).resolve(refused), { status: 'pending' });
  assert.deepEqual(await fixture({ mempoolNonce: 8 }).resolve(refused), { status: 'pending' });
  assert.deepEqual(await fixture().resolve({ ...refused, broadcast: { status: 'unknown', via: 'primary' } }), { status: 'pending' });
});

test('Arbitrum checks receipt identity, canonical block hash and confirmation depth', async () => {
  const receipt = { blockNumber: 106n, blockHash: hash(106n), transactionHash: signed.hash, from: owner, to: executor };
  const client = (blockHash: Hash, head: bigint, transactionHash: Hash) => ({
    getTransactionReceipt: async () => ({ ...receipt, transactionHash }),
    getBlock: async () => ({ hash: blockHash }),
    getBlockNumber: async () => head,
  }) as unknown as Parameters<typeof reconcileArbitrumIntent>[0];
  assert.deepEqual(await reconcileArbitrumIntent(client(hash(106n), 108n, signed.hash), signed, owner, executor),
    { status: 'receipt', receipt });
  assert.deepEqual(await reconcileArbitrumIntent(client(hash(106n), 107n, signed.hash), signed, owner, executor), { status: 'pending' });
  assert.deepEqual(await reconcileArbitrumIntent(client(hash(999n), 110n, signed.hash), signed, owner, executor), { status: 'pending' });
  assert.deepEqual(await reconcileArbitrumIntent(client(hash(106n), 110n, replacement), signed, owner, executor), { status: 'pending' });
});
