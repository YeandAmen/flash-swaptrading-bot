import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseError, HttpRequestError, keccak256, RpcRequestError, TimeoutError, type Hex } from 'viem';
import { broadcastArbitrum } from './broadcast.js';

const transaction = '0x1234';
const hash = keccak256(transaction);
const differentHash = keccak256('0x5678');
const url = 'https://arb1.arbitrum.io/rpc';
const body = { method: 'eth_sendRawTransaction' };
const quotaError = new RpcRequestError({
  url, body, error: { code: -32000, message: 'Public RPC Rate Limit Hit, limit will reset in 60 seconds' },
});

test('Arbitrum alternate broadcasts the same bytes after an explicit write quota rejection', async () => {
  const errors = [quotaError, new HttpRequestError({ url, status: 429 })];
  for (const error of errors) {
    const sent: Hex[] = [];
    const result = await broadcastArbitrum(async (bytes) => {
      sent.push(bytes);
      throw new BaseError('Submission failed', { cause: error });
    }, transaction, hash, {
      canSend: () => true,
      verifyFresh: async () => true,
      send: async (bytes) => { sent.push(bytes); return hash; },
    });
    assert.deepEqual(sent, [transaction, transaction]);
    assert.deepEqual(result, { status: 'acknowledged', via: 'alternate' });
  }
});

test('Arbitrum leaves timeouts and mismatching primary acknowledgements for reconciliation', async () => {
  const alternate = {
    canSend: () => true,
    verifyFresh: async () => { throw new Error('Unexpected alternate verification'); },
    send: async () => { throw new Error('Unexpected alternate send'); },
  };
  const timeout = await broadcastArbitrum(async () => { throw new TimeoutError({ url, body }); }, transaction, hash, alternate);
  assert.deepEqual(timeout, { status: 'unknown', via: 'primary' });
  assert.deepEqual(await broadcastArbitrum(async () => differentHash, transaction, hash, alternate),
    { status: 'hash-mismatch', via: 'primary' });
});

test('Arbitrum skips the alternate send if verification fails or the worker disarms', async () => {
  const primary = async () => { throw quotaError; };
  let live = true;
  let attempts = 0;
  const send = async () => { attempts++; return hash; };
  const expired = await broadcastArbitrum(primary, transaction, hash, {
    canSend: () => live, verifyFresh: async () => false, send,
  });
  assert.deepEqual(expired, { status: 'quota-rejected', via: 'primary' });
  const disarmed = await broadcastArbitrum(primary, transaction, hash, {
    canSend: () => live, verifyFresh: async () => { live = false; return true; }, send,
  });
  assert.deepEqual(disarmed, { status: 'quota-rejected', via: 'primary' });
  assert.equal(attempts, 0);
});

test('Arbitrum treats a different hash from the alternate as an uncertain outcome', async () => {
  const reply = await broadcastArbitrum(async () => { throw quotaError; }, transaction, hash, {
    canSend: () => true, verifyFresh: async () => true, send: async () => differentHash,
  });
  assert.deepEqual(reply, { status: 'hash-mismatch', via: 'alternate' });
});
