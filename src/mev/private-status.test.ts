import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeErrorResult, parseAbi, type Hex } from 'viem';
import { requestPrivateRelayStatus } from './private-status.js';

const hash: Hex = `0x${'ab'.repeat(32)}`;
const reply = (fields: Record<string, unknown>) => new Response(JSON.stringify({ hash, status: 'FAILED', ...fields }));

test('Protect status binds its reply to the requested hash and retains known simulation reasons', async () => {
  for (const reason of ['expired', 'deadline or floor', 'unprofitable']) {
    const encoded = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: [reason] });
    for (const revertReason of [reason, encoded]) {
      const result = await requestPrivateRelayStatus(hash, async (url, init) => {
        assert.equal(url, `https://protect.flashbots.net/tx/${hash}`);
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal);
        return reply({ maxBlockNumber: 103, simError: 'ExecutionReverted', revertReason, transaction: { value: 'ignored' } });
      });
      assert.deepEqual(result, { status: 'FAILED', maxBlockNumber: 103, simError: 'ExecutionReverted', revertReason: reason });
    }
  }
  assert.deepEqual(await requestPrivateRelayStatus(hash, async () => reply({
    status: 'PENDING', simError: 'MaxFeePerGasTooLow', revertReason: 'expired',
  })), { status: 'PENDING', simError: 'MaxFeePerGasTooLow' });
});

test('Protect status discards unrecognized external data and bounds failed requests', async () => {
  assert.equal(await requestPrivateRelayStatus('0x1234', async () => assert.fail('invalid hash')), null);
  assert.deepEqual(await requestPrivateRelayStatus(hash, async () => reply({
    simError: 'ExecutionReverted', revertReason: 'private arbitrary content', maxBlockNumber: -4,
  })), { status: 'FAILED', simError: 'ExecutionReverted' });
  assert.deepEqual(await requestPrivateRelayStatus(hash, async () => reply({ simError: 'invented code' })), { status: 'FAILED' });
  for (const response of [reply({ hash: `0x${'aa'.repeat(32)}` }), reply({ status: 'unknown status' }),
    reply({ extra: 'x'.repeat(65_536) }), new Response('invalid JSON'), new Response(null, { status: 503 })]) {
    assert.equal(await requestPrivateRelayStatus(hash, async () => response), null);
  }
  assert.equal(await requestPrivateRelayStatus(hash, async () => { throw new Error('network failure'); }), null);
});
