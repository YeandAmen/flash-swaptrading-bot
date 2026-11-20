import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EthereumIntent } from './ethereum-intent.js';

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ethereum-intent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let spot = false;
  let mev = 'paper';
  return {
    file: path.join(directory, 'intent.json'),
    modes: () => ({ spot, mev }),
    actions: {
      ready: () => true,
      spotArmed: () => spot,
      mevMode: () => mev,
      armSpot: () => { spot = true; },
      armMev: () => { mev = 'live'; },
    },
  };
}

test('restores only the explicitly opted-in modes after restart', (t) => {
  const { file, modes, actions } = fixture(t);
  const initial = new EthereumIntent(file, true, assert.fail);
  initial.restore(actions);
  assert.deepEqual(modes(), { spot: false, mev: 'paper' });
  initial.set('both', true);
  initial.set('mev', false);

  new EthereumIntent(file, false, assert.fail).restore(actions);
  assert.deepEqual(modes(), { spot: false, mev: 'paper' });
  new EthereumIntent(file, true, assert.fail).restore(actions);
  assert.deepEqual(modes(), { spot: true, mev: 'paper' });

  initial.set('both', false);
  const restarted = fixture(t);
  new EthereumIntent(file, true, assert.fail).restore(restarted.actions);
  assert.deepEqual(restarted.modes(), { spot: false, mev: 'paper' });
});

test('waits for readiness and honors a disarm during startup', async (t) => {
  const { file, modes, actions } = fixture(t);
  const initial = new EthereumIntent(file, false, assert.fail);
  initial.set('both', true);
  const restarted = new EthereumIntent(file, true, assert.fail);
  t.after(() => restarted.stop());

  let ready = false;
  restarted.restore({ ...actions, ready: () => ready });
  assert.deepEqual(modes(), { spot: false, mev: 'paper' });
  restarted.set('spot', false);
  ready = true;
  await sleep(5_100);
  assert.deepEqual(modes(), { spot: false, mev: 'live' });
});

test('preserves invalid intent without arming either mode', (t) => {
  const { file, modes, actions } = fixture(t);
  const invalid = '{"version":1,"spot":true}';
  fs.writeFileSync(file, invalid, { mode: 0o600 });
  const reported: string[] = [];
  const restart = new EthereumIntent(file, true, (message) => reported.push(message));
  restart.restore(actions);
  assert.deepEqual(modes(), { spot: false, mev: 'paper' });
  assert.match(reported[0], /Automatic arming is disabled/);
  assert.throws(() => restart.set('spot', true), /could not be read/);
  restart.set('both', false);
  assert.equal(fs.readFileSync(file, 'utf8'), invalid);
});
