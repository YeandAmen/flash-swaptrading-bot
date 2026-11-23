import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHeadWake } from './head-wake.js';

const subscription = '0x1234';
const rpc = 'https://eth-mainnet.g.alchemy.com/v2/offline-fixture';
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function socketFixture(t: TestContext) {
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    readonly sent: string[] = [];
    constructor() { super(); sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() { this.dispatchEvent(new Event('close')); }
    receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data })); }
    ack() { this.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, result: subscription })); }
    head(value: unknown, sub = subscription, method = 'eth_subscription') {
      this.receive(JSON.stringify({ jsonrpc: '2.0', method, params: { subscription: sub, result: { hash: value } } }));
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: Socket });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
  });
  const hints: { hash: string; at: number; monotonic: number }[] = [];
  const wake = createHeadWake(rpc, (hint) => { hints.push(hint); });
  assert.ok(wake);
  t.after(() => wake.stop());
  assert.equal(sockets.length, 1);
  const [socket] = sockets;
  socket.dispatchEvent(new Event('open'));
  assert.deepEqual(socket.sent.map((body) => JSON.parse(body)),
    [{ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }]);
  return { wake, socket, hints };
}

test('only subscribed newHeads notifications with a full hash can wake a waiting poll', async (t) => {
  const { wake, socket, hints } = socketFixture(t);
  const first = hash(1);
  socket.head(first);
  socket.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, result: subscription }));
  socket.head(first);
  socket.ack();
  socket.receive('{');
  socket.receive(123);
  socket.head(first, '0x5678');
  socket.head(first, subscription, 'eth_other');
  for (const invalid of [null, 123, '0x1234', first + 'a', first.slice(0, -1) + 'g']) socket.head(invalid);
  assert.deepEqual(hints, []);
  assert.equal(wake.hintFor(first), undefined);
  assert.deepEqual(await wake.wait(0), { source: 'timer' });
  const waiting = wake.wait(1000);
  socket.head(first);
  assert.deepEqual(await waiting, { source: 'notification', hash: first });
  assert.equal(hints.length, 1);
  assert.equal(wake.hintFor(first)?.hash, first);
  assert.deepEqual(await wake.wait(0), { source: 'timer' });
});

test('a buffered notification keeps each recent hash’s first wall and monotonic arrival', async (t) => {
  const { wake, socket, hints } = socketFixture(t);
  socket.ack();
  let clock = 1000;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(performance, 'now', () => clock / 2);
  const first = hash(10), next = hash(11), unrelated = hash(12);
  socket.head(first);
  clock += 10;
  socket.head(first);
  clock += 10;
  socket.head(next);
  clock += 20;
  socket.head(first);
  assert.deepEqual(hints, [
    { hash: first, at: 1000, monotonic: 500 },
    { hash: next, at: 1020, monotonic: 510 },
  ]);
  assert.deepEqual(wake.hintFor(first.toUpperCase()), hints[0]);
  assert.deepEqual(wake.hintFor(next), hints[1]);
  assert.equal(wake.hintFor(unrelated), undefined);
  assert.deepEqual(await wake.wait(0), { source: 'buffered', hash: first });
  assert.deepEqual(await wake.wait(0), { source: 'timer' });

  for (let i = 100; i < 132; i++) socket.head(hash(i));
  assert.equal(wake.hintFor(first), undefined);
  assert.equal(wake.hintFor(unrelated), undefined);
  assert.deepEqual(wake.hintFor(hash(131)), hints.at(-1));
});

test('stopping resolves a pending wait and ignores later socket messages', async (t) => {
  const { wake, socket, hints } = socketFixture(t);
  socket.ack();
  const waiting = wake.wait(1000);
  wake.stop();
  assert.deepEqual(await waiting, { source: 'stopped' });
  socket.head(hash(2));
  assert.deepEqual(hints, []);
  assert.equal(wake.hintFor(hash(2)), undefined);
  assert.deepEqual(await wake.wait(0), { source: 'stopped' });
});
