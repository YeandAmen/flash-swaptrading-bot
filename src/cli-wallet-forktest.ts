// Signing and recovery checks with fake funds on an isolated Anvil chain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestClient, http, parseEther } from 'viem';
import { mainnet } from 'viem/chains';
import { publicClient } from './chain.js';
import { CONFIG, DATA_DIR, MEV } from './config.js';
import { Engine } from './engine.js';
import { LiveExecutor, LiveSendBlocked } from './executor.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_ABI, FLASH_ARB_BYTECODE, FLASH_ARB_RUNTIME } from './mev/artifact.js';
import { MevSearcher } from './mev/searcher.js';
import { loadOrCreateWallet } from './wallet.js';

await assertForkTestEnvironment();
assert.equal(CONFIG.allowLiveTrading, false, 'mainnet signing must be disabled during the test');

const test = createTestClient({ chain: mainnet, mode: 'anvil', transport: http(CONFIG.rpcUrl) });
const wallet = loadOrCreateWallet();
const { account } = wallet;
await test.setBalance({ address: account.address, value: parseEther('1') });
const exec = new LiveExecutor(account);
const nonce = () => publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
const balance = () => publicClient.getBalance({ address: account.address, blockTag: 'latest' });
const log = () => {};
const emptyContract = '0x6001600c60003960016000f300';

const stateFile = path.join(DATA_DIR, 'state.json');
const first = new Engine();
fs.writeFileSync(stateFile, JSON.stringify({ ...first.state, armed: true, armedAt: Date.now() }));
const restartedEngine = new Engine();
assert.equal(restartedEngine.state.armed, false, 'a previous live arm must expire on restart');
console.log('✓ Spot restarts disarmed');

const mevHost = {
  log, account, exec, ethUsd: () => null, gasPriceGwei: () => null, baseFeeGwei: () => null,
  tokens: () => [], tradePending: () => false,
};
const mev = new MevSearcher(mevHost);
const before = await nonce();
const initialBalance = await balance();
CONFIG.forkMode = false;
try {
  assert.throws(() => restartedEngine.arm(), /disabled/);
  assert.throws(() => mev.arm(), /disabled/);
  await assert.rejects(exec.deployContract(emptyContract, log), LiveSendBlocked);
} finally {
  CONFIG.forkMode = true;
}
assert.equal(await nonce(), before, 'disabled signing must not consume a nonce');
console.log('✓ Mainnet opt-out blocked signing outside fork mode');

restartedEngine.wallet = wallet;
(restartedEngine as any).liveExec = exec;
restartedEngine.mev = mev;
mev.file.armed = true; // represent independently armed MEV with no outstanding transaction
restartedEngine.busy = true;
let tickFinished = false;
const finishTick = setTimeout(() => { tickFinished = true; restartedEngine.busy = false; }, 100);
try {
  await restartedEngine.panic('live');
  assert.ok(tickFinished, 'Panic must wait for an active tick, even with no open positions');
  assert.equal(mev.file.armed, false, 'Panic disarms independently armed MEV');
  assert.equal(await nonce(), before, 'Panic on an empty wallet must not send');
} finally {
  clearTimeout(finishTick);
}
console.log('✓ Panic waited for the active tick and disarmed MEV on an empty portfolio');

const walletJournal = path.join(DATA_DIR, 'wallet-transaction.json');
fs.mkdirSync(walletJournal);
try {
  await assert.rejects(exec.deployContract(emptyContract, log));
  assert.equal(await nonce(), before, 'an unavailable wallet journal must not consume a nonce');
  assert.equal(await balance(), initialBalance, 'an unavailable wallet journal must not spend gas');
} finally {
  fs.rmdirSync(walletJournal);
}
const blockedJournal = path.join(DATA_DIR, 'blocked-journal');
fs.mkdirSync(blockedJournal);
await assert.rejects(
  exec.deployContract(emptyContract, log, (hash) => { fs.writeFileSync(blockedJournal, hash); }),
  'the signed journal callback must succeed before broadcast',
);
assert.equal(await nonce(), before, 'failed persistence must not consume a nonce');
assert.equal(await balance(), initialBalance, 'failed persistence must not spend gas');
console.log('✓ Journal write failure prevented a local broadcast');

let canSend = true;
let reachedJournal = false;
await assert.rejects(
  exec.deployContract(emptyContract, log, () => { reachedJournal = true; canSend = false; }, () => canSend),
  LiveSendBlocked,
  'cancellation after signing must prevent broadcast',
);
assert.ok(reachedJournal, 'test flipped the send gate in the signed journal callback');
assert.equal(await nonce(), before, 'a canceled operation must not consume a nonce');
assert.equal(await balance(), initialBalance, 'a canceled operation must not spend gas');
console.log('✓ Final send gate honored cancellation during signing');

const [flashArb, example] = await Promise.all([
  exec.deployContract(FLASH_ARB_BYTECODE, log),
  exec.deployContract(emptyContract, log),
]);
const [flashTx, exampleTx] = await Promise.all([
  publicClient.getTransaction({ hash: flashArb.hash }),
  publicClient.getTransaction({ hash: example.hash }),
]);
assert.equal(flashTx.nonce, before);
assert.equal(exampleTx.nonce, before + 1);
assert.equal(await nonce(), before + 2);
assert.equal(await publicClient.getCode({ address: flashArb.address }), FLASH_ARB_RUNTIME);
assert.equal(
  await publicClient.readContract({ address: flashArb.address, abi: FLASH_ARB_ABI, functionName: 'owner' }),
  account.address,
);
console.log('✓ Concurrent wallet operations used consecutive nonces; verified FlashArb runtime and owner');

const waitForPreparation = async (searcher: MevSearcher) => {
  for (let i = 0; i < 100 && searcher.deploying; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(searcher.deploying, false, 'contract verification finished');
};
const originalAddress = MEV.contractAddress;
try {
  MEV.contractAddress = example.address;
  const wrongCode = new MevSearcher(mevHost);
  wrongCode.arm();
  await waitForPreparation(wrongCode);
  assert.equal(wrongCode.file.armed, false, 'wrong configured runtime must leave MEV disarmed');
  assert.equal(await nonce(), before + 2, 'invalid configured address must never fall back to deployment');

  MEV.contractAddress = flashArb.address;
  const adopted = new MevSearcher(mevHost);
  assert.equal(adopted.view().contract, null, 'test starts with no saved deployment');
  adopted.arm();
  await waitForPreparation(adopted);
  assert.equal(adopted.view().mode, 'live');
  assert.equal(adopted.file.contract?.toLowerCase(), flashArb.address.toLowerCase());
  assert.equal(await nonce(), before + 2, 'configured verified deployment must be reused without spending gas');
  adopted.disarm();

  MEV.contractAddress = example.address;
  const conflict = new MevSearcher(mevHost);
  assert.throws(() => conflict.arm(), /conflicts with the saved deployment/);
  assert.equal(conflict.file.contract?.toLowerCase(), flashArb.address.toLowerCase());
  assert.equal(conflict.file.armed, false);
  assert.equal(await nonce(), before + 2);
} finally {
  MEV.contractAddress = originalAddress;
}
console.log('✓ Existing FlashArb reused after runtime and owner verification; invalid and conflicting addresses blocked');

const restored = new LiveExecutor(account);
const intent = { owner: account.address, hash: example.hash, nonce: exampleTx.nonce, signedAt: Date.now() };
fs.writeFileSync(walletJournal, JSON.stringify(intent));
assert.equal(await restored.reconcileWallet(), true, 'a recorded receipt must recover after restart');
assert.equal(fs.existsSync(walletJournal), false);

fs.writeFileSync(walletJournal, JSON.stringify({ ...intent, hash: `0x${'11'.repeat(32)}`, nonce: before + 2 }));
assert.equal(await restored.reconcileWallet(), false, 'a missing receipt must stay pending');
await assert.rejects(restored.deployContract(emptyContract, log), /still settling/);
assert.equal(await nonce(), before + 2, 'an unresolved intent blocks new sends');
assert.ok(fs.existsSync(walletJournal), 'an unresolved intent survives reconciliation');
console.log('✓ Restart reconciled a known receipt and preserved an unresolved wallet intent');
console.log('ALL WALLET TESTS PASSED');
