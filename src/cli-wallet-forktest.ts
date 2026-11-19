// Signing and recovery checks with fake funds on an isolated Anvil chain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestClient, http, parseEther, parseGwei } from 'viem';
import { mainnet } from 'viem/chains';
import { publicClient } from './chain.js';
import { CONFIG, DATA_DIR, MEV } from './config.js';
import { Engine } from './engine.js';
import { DeploymentGasError, LiveExecutor, LiveSendBlocked } from './executor.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_BYTECODE, FLASH_ARB_V2_RUNTIME } from './mev/artifact-v2.js';
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
const mevStateFile = path.join(DATA_DIR, 'mev.json');
const first = new Engine();
fs.writeFileSync(stateFile, JSON.stringify({ ...first.state, armed: true, armedAt: Date.now() }));
const restartedEngine = new Engine();
assert.equal(restartedEngine.state.armed, false, 'a previous live arm must expire on restart');
console.log('✓ Spot restarts disarmed');

const mevHost = {
  log, account, exec, ethUsd: () => null, baseFeeGwei: () => null,
  tokens: () => [], tradePending: () => false,
};
const mev = new MevSearcher(mevHost);
const before = await nonce();
const initialBalance = await balance();
CONFIG.forkMode = false;
try {
  assert.throws(() => restartedEngine.arm(), /disabled/);
  assert.throws(() => mev.arm(), /disabled/);
  await assert.rejects(mev.deployFromDashboard(), /disabled/);
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

const [otherExample, example] = await Promise.all([
  exec.deployContract(emptyContract, log),
  exec.deployContract(emptyContract, log),
]);
const [otherExampleTx, exampleTx] = await Promise.all([
  publicClient.getTransaction({ hash: otherExample.hash }),
  publicClient.getTransaction({ hash: example.hash }),
]);
assert.equal(otherExampleTx.nonce, before);
assert.equal(exampleTx.nonce, before + 1);
assert.equal(await nonce(), before + 2);
console.log('✓ Concurrent wallet operations used consecutive nonces');

const waitForPreparation = async (searcher: MevSearcher) => {
  for (let i = 0; i < 100 && searcher.view().mode === 'arming'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notEqual(searcher.view().mode, 'arming', 'contract verification finished');
};

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

// Remove the fake, deliberately unresolved intent above before starting this independent fixture.
fs.unlinkSync(walletJournal);
const originalV2Address = MEV.v2ContractAddress;
try {
  MEV.v2ContractAddress = null;
  const beforeDeploy = await nonce();
  // Old installations have a saved V1 address even when no V2 has been deployed.
  fs.writeFileSync(mevStateFile, JSON.stringify({ ...mev.file, contract: otherExample.address }));
  const paperV2 = new MevSearcher(mevHost);
  assert.equal(paperV2.view().mode, 'paper');
  assert.equal(paperV2.view().contract, null);
  assert.throws(() => paperV2.arm(), /deploy|contract/i);
  assert.equal(await nonce(), beforeDeploy, 'arming cannot deploy a contract');

  MEV.v2ContractAddress = example.address;
  const wrongCode = new MevSearcher(mevHost);
  wrongCode.arm();
  await waitForPreparation(wrongCode);
  assert.equal(wrongCode.view().mode, 'paper', 'wrong configured runtime leaves MEV disarmed');
  assert.equal(await nonce(), beforeDeploy, 'invalid configured address cannot trigger deployment');
  MEV.v2ContractAddress = null;

  const baseFee = parseGwei('0.05');
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: baseFee });
  await test.mine({ blocks: 1 });
  const head = await publicClient.getBlock({ blockTag: 'latest' });
  assert.equal(head.baseFeePerGas, baseFee);
  assert.equal(head.gasUsed, 0n, 'an empty head makes the latest base fee the higher one');
  const estimatedGas = await publicClient.estimateGas({ account: account.address, data: FLASH_ARB_V2_BYTECODE });
  const gasLimit = (estimatedGas * 105n + 99n) / 100n;
  const required = gasLimit * (baseFee + parseGwei('0.03'));
  const mevBeforeRejection = fs.readFileSync(mevStateFile, 'utf8');
  await test.setBalance({ address: account.address, value: required - 1n });
  await assert.rejects(paperV2.deployFromDashboard(), DeploymentGasError);
  assert.equal(await nonce(), beforeDeploy, 'an unaffordable deploy does not consume a nonce');
  assert.equal(await balance(), required - 1n, 'an unaffordable deploy does not spend gas');
  assert.equal(fs.existsSync(walletJournal), false, 'the affordability error occurs before journaling');
  assert.equal(fs.readFileSync(mevStateFile, 'utf8'), mevBeforeRejection, 'the MEV journal remains unchanged');
  assert.equal(paperV2.view().deploymentPending, null);
  assert.equal(paperV2.view().mode, 'paper');

  const limitedBalance = required + required / 100n;
  const oldRequirement = (estimatedGas * 13n / 10n) * (baseFee * 2n + parseGwei('1.5'));
  assert.ok(limitedBalance < oldRequirement / 10n, 'the existing fixed-tip preflight would deny this balance');
  await test.setBalance({ address: account.address, value: limitedBalance });
  const quote = await exec.quoteDeployment(FLASH_ARB_V2_BYTECODE);
  assert.equal(quote.balance, limitedBalance);
  assert.equal(quote.minimumWei, required);
  assert.equal(quote.gas, gasLimit);
  assert.ok(quote.gas * quote.maxFeePerGas <= limitedBalance, 'the quoted fee cap fits available funds');
  assert.equal(await nonce(), beforeDeploy, 'quoting does not consume a nonce');
  const [deployment, duplicate] = await Promise.allSettled([paperV2.deployFromDashboard(), paperV2.deployFromDashboard()]);
  assert.equal(deployment.status, 'fulfilled', 'a balance just above the minimum can deploy');
  assert.equal(duplicate.status, 'rejected', 'a duplicate deployment request is blocked while the first is pending');
  const v2 = deployment.value;
  assert.equal(paperV2.view().contract, v2);
  assert.equal(paperV2.view().mode, 'paper', 'deployment keeps MEV in paper mode');
  assert.equal(restartedEngine.state.armed, false, 'deployment leaves live spot trading off');
  assert.equal(paperV2.file.contract, otherExample.address, 'legacy address remains a historical record');
  assert.equal(await publicClient.getCode({ address: v2 }), FLASH_ARB_V2_RUNTIME);
  assert.equal(await publicClient.readContract({ address: v2, abi: FLASH_ARB_V2_ABI, functionName: 'owner' }), account.address);
  await paperV2.deployFromDashboard().catch(() => undefined);
  assert.equal(await nonce(), beforeDeploy + 1, 'repeated deployment does not spend gas');

  MEV.v2ContractAddress = example.address;
  const conflict = new MevSearcher(mevHost);
  assert.throws(() => conflict.arm(), /conflicts with the saved deployment/);
  assert.equal(conflict.view().contract, v2);
  assert.equal(conflict.view().mode, 'paper');
  MEV.v2ContractAddress = null;

  const adoptedV2 = new MevSearcher(mevHost);
  assert.equal(adoptedV2.view().mode, 'paper');
  assert.equal(adoptedV2.view().contract, v2);
  adoptedV2.arm();
  await waitForPreparation(adoptedV2);
  assert.equal(adoptedV2.view().mode, 'live');
  assert.equal(adoptedV2.file.v2Contract, v2);
  assert.equal(await nonce(), beforeDeploy + 1, 'arming reused the verified V2 deployment without spending gas');
  adoptedV2.disarm();
  assert.equal(new MevSearcher(mevHost).view().mode, 'paper');
  console.log('✓ Dashboard deployed FlashArbV2 once and left both live modes off; restart reused the verified contract on explicit arm');

  const afterDeployBalance = await balance();
  const { transactions } = await publicClient.getBlock({ blockTag: 'latest', includeTransactions: true });
  const creation = transactions.find((tx) => tx.from.toLowerCase() === account.address.toLowerCase()
    && tx.nonce === beforeDeploy && tx.to === null);
  assert.ok(creation, 'find the mined dashboard deployment');
  assert.equal(creation.type, 'eip1559');
  assert.equal(creation.gas, gasLimit);
  assert.ok(creation.gas * creation.maxFeePerGas <= limitedBalance, 'the signed fee cap fits available funds');
  console.log('✓ Deployment rejects a shortfall before journaling and accepts a funded fee cap below the old threshold');

  // Replay the saved intent that would remain if the process stopped before recording the V2 address.
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...adoptedV2.file, v2Contract: null, v2DeployedAt: null,
    deployVersion: 'v2', deployTx: creation.hash, deployNonce: creation.nonce, deployStartedAt: Date.now(),
  }));
  const recoverV2 = new MevSearcher(mevHost);
  assert.equal(recoverV2.view().deploymentPending, creation.hash);
  await recoverV2.reconcileWallet();
  const afterV2Recovery = new MevSearcher(mevHost);
  assert.equal(afterV2Recovery.view().deploymentPending, null);
  assert.equal(afterV2Recovery.view().mode, 'paper');
  assert.equal(afterV2Recovery.view().contract, v2);
  assert.equal(afterV2Recovery.file.contract, otherExample.address);

  // A markerless legacy receipt updates only the historical address.
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...afterV2Recovery.file, deployVersion: undefined,
    deployTx: example.hash, deployNonce: exampleTx.nonce, deployStartedAt: Date.now(),
  }));
  const recoverLegacy = new MevSearcher(mevHost);
  assert.equal(recoverLegacy.view().deploymentPending, example.hash);
  await recoverLegacy.reconcileWallet();
  const afterLegacyRecovery = new MevSearcher(mevHost);
  assert.equal(afterLegacyRecovery.view().deploymentPending, null);
  assert.equal(afterLegacyRecovery.view().mode, 'paper');
  assert.equal(afterLegacyRecovery.view().contract, v2);
  assert.equal(afterLegacyRecovery.file.contract, example.address);
  assert.equal(await nonce(), beforeDeploy + 1, 'receipt recovery requires no new sends');
  assert.equal(await balance(), afterDeployBalance, 'receipt recovery spends no gas');
  console.log('✓ Deployment journal recovery kept V2 and legacy receipts separate without spending gas');
} finally {
  MEV.v2ContractAddress = originalV2Address;
}
console.log('ALL WALLET TESTS PASSED');
