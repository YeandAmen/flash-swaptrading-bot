import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SolanaScanCadence } from './scan-cadence.js';

const buildUrl = new URL('https://example.invalid/build');
const epoch = Date.UTC(2026, 0, 1);

function fakeClock(t: TestContext) {
  const clock = { elapsed: 0 };
  t.mock.method(performance, 'now', () => clock.elapsed);
  t.mock.method(Date, 'now', () => epoch + clock.elapsed);
  return clock;
}

test('only a healthy ordinary completion shortens the interval for the next ordinary poll', (t) => {
  const clock = fakeClock(t);
  const cadence = new SolanaScanCadence();
  assert.equal(cadence.delay(true), 0);
  assert.equal(cadence.complete(true), 10_500);
  clock.elapsed += 500;
  assert.equal(cadence.delay(true), 10_000);
  assert.equal(cadence.delay(false), 11_500);
  clock.elapsed += 11_500;
  assert.equal(cadence.delay(false), 0);
  assert.equal(cadence.complete(false), 12_000);
  clock.elapsed += 10_500;
  assert.equal(cadence.delay(true), 1_500);
  clock.elapsed += 1_500;
  assert.equal(cadence.delay(true), 0);
});

test('admission reserves six real builds and the dispatch budget rolls off each request at sixty seconds', async (t) => {
  const clock = fakeClock(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    if (clock.elapsed === 700) throw new Error('connection reset');
    return new Response(null);
  });
  const cadence = new SolanaScanCadence();
  const build = () => cadence.fetchBuild(buildUrl, {});
  for (let i = 0; i < 24; i++) {
    clock.elapsed = i * 100;
    if (i === 7) await assert.rejects(build, /connection reset/);
    else await build();
  }
  assert.equal(cadence.delay(true), 0);
  clock.elapsed = 3_000;
  await build();
  assert.equal(cadence.delay(true), 57_000);
  await Promise.all(Array.from({ length: 5 }, build));
  assert.equal(fetch.mock.callCount(), 30);
  assert.equal(cadence.delay(true), 57_500);
  await assert.rejects(build);
  clock.elapsed = 59_999;
  await assert.rejects(build);
  assert.equal(fetch.mock.callCount(), 30);
  clock.elapsed = 60_000;
  assert.equal(cadence.delay(true), 500);
  await build();
  assert.equal(fetch.mock.callCount(), 31);
  await assert.rejects(build);
  clock.elapsed = 60_600;
  assert.equal(cadence.delay(true), 0);
});

test('429 honors the longest advertised reset and bars dispatches until its exact deadline', async (t) => {
  const clock = fakeClock(t);
  const responses = [
    { 'retry-after': '18', 'x-ratelimit-reset': String(epoch / 1_000 + 26) },
    { 'retry-after': new Date(epoch + 75_000).toUTCString(), 'x-ratelimit-reset': 'unavailable' },
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    const headers = responses.shift();
    return headers ? new Response(null, { status: 429, headers }) : new Response(null);
  });
  const cadence = new SolanaScanCadence();
  const build = () => cadence.fetchBuild(buildUrl, {});
  await build();
  assert.equal(cadence.delay(true), 26_000);
  clock.elapsed = 25_999;
  await assert.rejects(build);
  assert.equal(fetch.mock.callCount(), 1);
  clock.elapsed = 26_000;
  await build();
  assert.equal(cadence.delay(true), 49_000);
  clock.elapsed = 74_999;
  await assert.rejects(build);
  assert.equal(fetch.mock.callCount(), 2);
  clock.elapsed = 75_000;
  assert.equal((await build()).status, 200);
  assert.equal(fetch.mock.callCount(), 3);
});

test('an exhausted successful response honors Retry-After seconds and ignores an invalid Unix reset', async (t) => {
  const clock = fakeClock(t);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(null, { headers: {
    'x-ratelimit-remaining': '0', 'retry-after': '19', 'x-ratelimit-reset': String(epoch + 90_000),
  } }));
  const cadence = new SolanaScanCadence();
  const build = () => cadence.fetchBuild(buildUrl, {});
  assert.equal((await build()).status, 200);
  assert.equal(cadence.complete(true), 19_000);
  clock.elapsed = 18_999;
  await assert.rejects(build);
  assert.equal(fetch.mock.callCount(), 1);
  clock.elapsed++;
  assert.equal(cadence.delay(true), 0);
});

test('concurrent rate limits count as one burst, survive a late success, and back off to sixty seconds', async (t) => {
  const clock = fakeClock(t);
  const replies: ((response: Response) => void)[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => replies.push(resolve)));
  const cadence = new SolanaScanCadence();
  const build = () => cadence.fetchBuild(buildUrl, {});
  const first = build();
  const sibling = build();
  const lateSuccess = build();
  replies[0](new Response(null, { status: 429 }));
  await first;
  await assert.rejects(build);
  assert.equal(fetch.mock.callCount(), 3);
  replies[1](new Response(null, { status: 429 }));
  await sibling;
  replies[2](new Response(null));
  await lateSuccess;
  assert.equal(cadence.complete(true), 12_000);
  assert.equal(cadence.delay(true), 12_000);
  clock.elapsed += 12_000;
  for (const ms of [24_000, 48_000, 60_000, 60_000]) {
    const next = build();
    replies.at(-1)!(new Response(null, { status: 429, headers: { 'retry-after': 'invalid' } }));
    await next;
    assert.equal(cadence.complete(false), ms);
    assert.equal(cadence.delay(true), ms);
    clock.elapsed += ms - 1;
    await assert.rejects(build);
    clock.elapsed++;
    assert.equal(cadence.delay(true), 0);
  }
  assert.equal(fetch.mock.callCount(), 7);
});
