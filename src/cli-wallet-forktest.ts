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
import { FLASH_ARB_V3_ABI, FLASH_ARB_V3_BYTECODE, FLASH_ARB_V3_RUNTIME } from './mev/artifact-v3.js';
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
  await assert.rejects(mev.deployFromDashboard(parseEther('1')), /disabled/);
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
const originalV3Address = MEV.v3ContractAddress;
const originalFundingMode = MEV.funding;
try {
  MEV.v2ContractAddress = null;
  MEV.v3ContractAddress = null;
  const beforeLegacyDeploy = await nonce();
  // Old installations have a saved V1 address even when no V2 has been deployed.
  fs.writeFileSync(mevStateFile, JSON.stringify({ ...mev.file, contract: otherExample.address }));
  const paper = new MevSearcher(mevHost);
  assert.equal(paper.view().mode, 'paper');
  assert.equal(paper.view().contract, null);
  assert.equal(paper.view().canDeployV3, true);
  assert.throws(() => paper.arm(), /deploy|contract/i);
  assert.equal(await nonce(), beforeLegacyDeploy, 'arming cannot deploy a contract');

  MEV.v2ContractAddress = example.address;
  const wrongCode = new MevSearcher(mevHost);
  wrongCode.arm();
  await waitForPreparation(wrongCode);
  assert.equal(wrongCode.view().mode, 'paper', 'wrong configured runtime leaves MEV disarmed');
  assert.equal(await nonce(), beforeLegacyDeploy, 'invalid configured address cannot trigger deployment');

  // Seed an existing installation independently of the dashboard, which now deploys V3.
  const legacyV2 = await exec.deployContract(FLASH_ARB_V2_BYTECODE, log);
  const v2 = legacyV2.address;
  assert.equal(await publicClient.getCode({ address: v2 }), FLASH_ARB_V2_RUNTIME);
  assert.equal(await publicClient.readContract({ address: v2, abi: FLASH_ARB_V2_ABI, functionName: 'owner' }), account.address);
  fs.writeFileSync(mevStateFile, JSON.stringify({ ...paper.file, v2Contract: v2, v2DeployedAt: Date.now() }));
  const conflict = new MevSearcher(mevHost);
  assert.throws(() => conflict.arm(), /conflicts with the saved deployment/);
  assert.equal(conflict.view().contract, v2);
  assert.equal(conflict.view().mode, 'paper');
  MEV.v2ContractAddress = v2;
  const beforeDeploy = await nonce();
  const upgrade = new MevSearcher(mevHost);
  restartedEngine.mev = upgrade;
  const disarmSpot = () => restartedEngine.disarm();
  assert.equal(upgrade.view().contract, v2);
  assert.equal(upgrade.view().contractVersion, 'v2');
  assert.equal(upgrade.view().canDeployV3, true, 'an installed V2 can be upgraded');
  MEV.funding = 'balancer';
  assert.throws(() => upgrade.arm(), /Balancer V3 funding requires FlashArbV3/);
  MEV.funding = originalFundingMode;

  const baseFee = parseGwei('0.05');
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: baseFee });
  await test.mine({ blocks: 1 });
  const head = await publicClient.getBlock({ blockTag: 'latest' });
  assert.equal(head.baseFeePerGas, baseFee);
  assert.equal(head.gasUsed, 0n, 'an empty head makes the latest base fee the higher one');
  const estimatedGas = await publicClient.estimateGas({ account: account.address, data: FLASH_ARB_V3_BYTECODE });
  const gasLimit = (estimatedGas * 105n + 99n) / 100n;
  const required = gasLimit * (baseFee + parseGwei('0.03'));

  restartedEngine.arm();
  upgrade.arm();
  await waitForPreparation(upgrade);
  assert.equal(upgrade.view().mode, 'live');
  const mevBeforeRejection = fs.readFileSync(mevStateFile, 'utf8');
  await test.setBalance({ address: account.address, value: required - 1n });
  await assert.rejects(upgrade.deployFromDashboard(required, disarmSpot), DeploymentGasError);
  assert.equal(await nonce(), beforeDeploy, 'an unaffordable deploy does not consume a nonce');
  assert.equal(await balance(), required - 1n, 'an unaffordable deploy does not spend gas');
  assert.equal(fs.existsSync(walletJournal), false, 'the affordability error occurs before journaling');
  assert.equal(fs.readFileSync(mevStateFile, 'utf8'), mevBeforeRejection, 'the MEV journal remains unchanged');
  assert.equal(upgrade.view().deploymentPending, null);
  assert.equal(upgrade.view().mode, 'live');
  assert.equal(restartedEngine.state.armed, true);

  const limitedBalance = required + required / 100n;
  const oldRequirement = (estimatedGas * 13n / 10n) * (baseFee * 2n + parseGwei('1.5'));
  assert.ok(limitedBalance < oldRequirement / 10n, 'the old fixed-tip preflight would deny this balance');
  await test.setBalance({ address: account.address, value: limitedBalance });
  const quote = await exec.quoteDeployment(FLASH_ARB_V3_BYTECODE);
  assert.equal(quote.balance, limitedBalance);
  assert.equal(quote.minimumWei, required);
  assert.equal(quote.gas, gasLimit);
  assert.ok(quote.gas * quote.maxFeePerGas <= limitedBalance, 'the quoted fee cap fits available funds');
  assert.equal(await nonce(), beforeDeploy, 'quoting does not consume a nonce');
  await assert.rejects(upgrade.deployFromDashboard(required - 1n, disarmSpot), /Review the refreshed quote/);
  assert.equal(await nonce(), beforeDeploy, 'a fee cap below the minimum does not consume a nonce');
  assert.equal(await balance(), limitedBalance);
  assert.equal(upgrade.view().mode, 'live', 'a rejected fee cap leaves MEV armed');
  assert.equal(restartedEngine.state.armed, true, 'a rejected fee cap leaves spot armed');
  assert.equal(fs.existsSync(walletJournal), false);
  assert.equal(fs.readFileSync(mevStateFile, 'utf8'), mevBeforeRejection);

  const dashboardQuote = await upgrade.deploymentQuote();
  assert.ok(dashboardQuote.maximumWei);
  const quotedMaximum = BigInt(dashboardQuote.maximumWei);
  assert.equal(quotedMaximum, quote.gas * quote.maxFeePerGas);
  const approved = required + (quotedMaximum - required) / 2n;
  assert.ok(approved < quotedMaximum, 'exercise the cap when a confirmed quote is lower than the fresh quote');
  const [deployment, duplicate] = await Promise.allSettled([
    upgrade.deployFromDashboard(approved, disarmSpot), upgrade.deployFromDashboard(approved, disarmSpot),
  ]);
  assert.equal(deployment.status, 'fulfilled', 'a balance just above the minimum can upgrade to V3');
  assert.equal(duplicate.status, 'rejected', 'a duplicate deployment request is blocked while the first is pending');
  const v3 = deployment.value;
  assert.equal(upgrade.view().contract, v3);
  assert.equal(upgrade.view().contractVersion, 'v3');
  assert.equal(upgrade.view().canDeployV3, false);
  assert.equal(upgrade.view().mode, 'paper', 'deployment leaves MEV in paper mode');
  assert.equal(restartedEngine.state.armed, false, 'deployment leaves spot trading off');
  assert.equal(upgrade.file.contract, otherExample.address, 'legacy address remains a historical record');
  assert.equal(upgrade.file.v2Contract, v2, 'previous V2 remains a historical record');
  assert.equal(await publicClient.getCode({ address: v2 }), FLASH_ARB_V2_RUNTIME);
  assert.equal(await publicClient.getCode({ address: v3 }), FLASH_ARB_V3_RUNTIME);
  assert.equal(await publicClient.readContract({ address: v3, abi: FLASH_ARB_V3_ABI, functionName: 'owner' }), account.address);
  await assert.rejects(upgrade.deployFromDashboard(approved, disarmSpot));
  assert.equal(await nonce(), beforeDeploy + 1, 'repeated deployment does not spend gas');

  // Stale V2 configuration remains compatible with the verified V3 selected by the dashboard.
  MEV.funding = 'balancer';
  const adopted = new MevSearcher(mevHost);
  assert.equal(adopted.view().mode, 'paper');
  assert.equal(adopted.view().contract, v3);
  assert.equal(adopted.view().canDeployV3, false);
  adopted.arm();
  await waitForPreparation(adopted);
  assert.equal(adopted.view().mode, 'live');
  assert.equal(await nonce(), beforeDeploy + 1, 'arming reuses the verified V3 without spending gas');
  adopted.disarm();
  assert.equal(new MevSearcher(mevHost).view().mode, 'paper');
  console.log('✓ Dashboard upgraded FlashArbV2 to V3 once, verified wallet ownership and left both live modes off');

  const afterDeployBalance = await balance();
  const { transactions } = await publicClient.getBlock({ blockTag: 'latest', includeTransactions: true });
  const creation = transactions.find((tx) => tx.from.toLowerCase() === account.address.toLowerCase()
    && tx.nonce === beforeDeploy && tx.to === null);
  assert.ok(creation, 'find the mined dashboard deployment');
  assert.equal(creation.type, 'eip1559');
  assert.equal(creation.gas, gasLimit);
  assert.equal(creation.maxFeePerGas, approved / gasLimit, 'the signed gas price is limited by the confirmed amount');
  console.log('✓ Deployment rejects insufficient funds and fee caps before journaling, then signs within the confirmed cap');

  const legacyV2Transaction = await publicClient.getTransaction({ hash: legacyV2.hash });
  const recoveryState = { ...adopted.file, v3Contract: null, v3DeployedAt: null };
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...recoveryState, deployVersion: 'v3', deployTx: legacyV2.hash,
    deployNonce: legacyV2Transaction.nonce, deployStartedAt: Date.now(),
  }));
  const unexpectedRuntime = new MevSearcher(mevHost);
  await unexpectedRuntime.reconcileWallet();
  assert.equal(unexpectedRuntime.view().deploymentPending, legacyV2.hash, 'an unverified receipt is retained for recovery');
  assert.equal(unexpectedRuntime.view().contract, v2, 'a V2 receipt cannot take the V3 slot');

  // Replay persisted intents from each contract generation without broadcasting again.
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...recoveryState,
    deployVersion: 'v3', deployTx: creation.hash, deployNonce: creation.nonce, deployStartedAt: Date.now(),
  }));
  const recoverV3 = new MevSearcher(mevHost);
  assert.equal(recoverV3.view().deploymentPending, creation.hash);
  assert.equal(recoverV3.view().contract, v2, 'V2 remains active until the V3 receipt is verified');
  await recoverV3.reconcileWallet();
  const afterV3Recovery = new MevSearcher(mevHost);
  assert.equal(afterV3Recovery.view().deploymentPending, null);
  assert.equal(afterV3Recovery.view().mode, 'paper');
  assert.equal(afterV3Recovery.view().contract, v3);
  assert.equal(afterV3Recovery.file.v2Contract, v2);
  assert.equal(afterV3Recovery.file.contract, otherExample.address);

  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...afterV3Recovery.file, v2Contract: null,
    deployVersion: 'v2', deployTx: legacyV2.hash, deployNonce: legacyV2Transaction.nonce, deployStartedAt: Date.now(),
  }));
  const recoverV2 = new MevSearcher(mevHost);
  assert.equal(recoverV2.view().deploymentPending, legacyV2.hash);
  await recoverV2.reconcileWallet();
  const afterV2Recovery = new MevSearcher(mevHost);
  assert.equal(afterV2Recovery.view().deploymentPending, null);
  assert.equal(afterV2Recovery.view().contract, v3);
  assert.equal(afterV2Recovery.file.v2Contract, v2);

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
  assert.equal(afterLegacyRecovery.view().contract, v3);
  assert.equal(afterLegacyRecovery.file.v2Contract, v2);
  assert.equal(afterLegacyRecovery.file.contract, example.address);
  assert.equal(await nonce(), beforeDeploy + 1, 'receipt recovery requires no new sends');
  assert.equal(await balance(), afterDeployBalance, 'receipt recovery spends no gas');
  console.log('✓ Deployment journal recovery kept V3, V2 and legacy receipts separate without spending gas');
} finally {
  MEV.v2ContractAddress = originalV2Address;
  MEV.v3ContractAddress = originalV3Address;
  MEV.funding = originalFundingMode;
}
console.log('ALL WALLET TESTS PASSED');
