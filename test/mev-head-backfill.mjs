import assert from 'node:assert/strict';
import { HeadBackfill } from '../dist/mev/head-backfill.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

const queue = new HeadBackfill();
queue.observe(8n, 9n);
assert.equal(queue.pending, 0, 'consecutive heads have no gap');
queue.observe(9n, 13n);
queue.observe(11n, 14n);
assert.equal(queue.pending, 3, 'overlapping observations never queue a previously observed head');

let unblock;
const recovery = [];
const slowRead = async (height) => {
  recovery.push(height);
  await new Promise((resolve) => { unblock = resolve; });
};
queue.run(slowRead);
queue.run(async () => assert.fail('only one backfill read may be in flight'));
queue.observe(14n, 15n);
await flush();
assert.deepEqual(recovery, [10n]);
assert.equal(queue.pending, 3, 'a pending read stays in the count while new heads arrive');
unblock();
await flush();
queue.run(async (height) => { recovery.push(height); });
await flush();
assert.deepEqual(recovery, [10n, 11n]);
assert.equal(queue.caughtUp, 2);
assert.equal(queue.pending, 1);
assert.equal(queue.missed, 0);

const retry = new HeadBackfill();
retry.observe(100n, 102n);
const failedAttempts = [];
const fail = async (height) => {
  failedAttempts.push(height);
  throw new Error('simulated read error');
};
retry.run(fail);
await flush();
retry.run(fail);
await flush();
assert.deepEqual(failedAttempts, [101n], 'a read cannot immediately retry on the same head');
retry.observe(102n, 103n);
retry.run(fail);
await flush();
retry.observe(103n, 104n);
retry.run(fail);
await flush();
assert.deepEqual(failedAttempts, [101n, 101n, 101n]);
assert.equal(retry.pending, 0);
assert.equal(retry.missed, 1, 'exhausted retries are explicitly missed');

const overflow = new HeadBackfill();
overflow.observe(10n, 210n);
assert.equal(overflow.pending, 128);
assert.equal(overflow.missed, 71);
let firstRetained;
overflow.run(async (height) => { firstRetained = height; });
await flush();
assert.equal(firstRetained, 82n, 'overflow keeps the most recent 128 missing heights');

const activeOverflow = new HeadBackfill();
activeOverflow.observe(10n, 12n);
activeOverflow.run(slowRead);
await flush();
activeOverflow.observe(12n, 212n);
assert.equal(activeOverflow.pending, 128, 'the in-flight read counts toward the pending limit');
assert.equal(activeOverflow.missed, 72);
unblock();
await flush();
activeOverflow.run(async (height) => { firstRetained = height; });
await flush();
assert.equal(firstRetained, 85n, 'only the newest heights stay queued alongside the older in-flight read');
assert.equal(activeOverflow.caughtUp, 2);

console.log('PASS: bounded background block backfill, overlapping heads, retry deferral, and overflow accounting');
