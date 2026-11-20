// Signing and recovery checks with fake funds on an isolated Anvil chain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestClient, encodeDeployData, http, keccak256, parseEther, parseGwei, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { publicClient } from './chain.js';
import { ADDR, CONFIG, DATA_DIR, MEV } from './config.js';
import { Engine } from './engine.js';
import { DeploymentGasError, LiveExecutor, LiveSendBlocked } from './executor.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_PROXY_ABI, FLASH_ARB_PROXY_BYTECODE, FLASH_ARB_PROXY_RUNTIME } from './mev/artifact-proxy.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_BYTECODE, FLASH_ARB_V2_RUNTIME } from './mev/artifact-v2.js';
import { FLASH_ARB_V3_BYTECODE, FLASH_ARB_V3_RUNTIME } from './mev/artifact-v3.js';
import { submitDirect } from './mev/direct-broadcast.js';
import { encodeArbitrage } from './mev/flash-arb.js';
import { NextVenueKind } from './mev/next-pools.js';
import { pinnedArbitrage, proxyCreationData, proxyReleaseHash, verifyFlashProxy } from './mev/proxy.js';
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
const originalDirectSettings = {
  submission: MEV.submission, directMaxGasUsd: MEV.directMaxGasUsd, directDailyGasUsd: MEV.directDailyGasUsd,
};
try {
  MEV.v2ContractAddress = null;
  MEV.v3ContractAddress = null;
  const beforeLegacyDeploy = await nonce();
  // Old installations have a saved V1 address even when no V2 has been deployed.
  fs.writeFileSync(mevStateFile, JSON.stringify({ ...mev.file, contract: otherExample.address }));
  const paper = new MevSearcher(mevHost);
  assert.equal(paper.view().mode, 'paper');
  assert.equal(paper.view().contract, null);
  assert.equal(paper.view().canDeployProxy, true);
  assert.throws(() => paper.arm(), /deploy|contract/i);
  assert.equal(await nonce(), beforeLegacyDeploy, 'arming cannot deploy a contract');

  MEV.v2ContractAddress = example.address;
  const wrongCode = new MevSearcher(mevHost);
  wrongCode.arm();
  await waitForPreparation(wrongCode);
  assert.equal(wrongCode.view().mode, 'paper', 'wrong configured runtime leaves MEV disarmed');
  assert.equal(await nonce(), beforeLegacyDeploy, 'invalid configured address cannot trigger deployment');

  // Seed an existing installation independently of the dashboard, which now deploys the proxy.
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
  const deploymentSearcher = new MevSearcher(mevHost);
  restartedEngine.mev = deploymentSearcher;
  const disarmSpot = () => restartedEngine.disarm();
  assert.equal(deploymentSearcher.view().contract, v2);
  assert.equal(deploymentSearcher.view().contractVersion, 'v2');
  assert.equal(deploymentSearcher.view().canDeployProxy, true, 'an installed V2 can migrate to the proxy');
  MEV.funding = 'balancer';
  assert.throws(() => deploymentSearcher.arm(), /Balancer V3 funding requires FlashArbV3/);
  MEV.funding = originalFundingMode;

  const baseFee = parseGwei('0.05');
  await test.setNextBlockBaseFeePerGas({ baseFeePerGas: baseFee });
  await test.mine({ blocks: 1 });
  const head = await publicClient.getBlock({ blockTag: 'latest' });
  assert.equal(head.baseFeePerGas, baseFee);
  assert.equal(head.gasUsed, 0n, 'an empty head makes the latest base fee the higher one');
  const creationData = proxyCreationData();
  const estimatedGas = await publicClient.estimateGas({ account: account.address, data: creationData });
  const gasLimit = (estimatedGas * 105n + 99n) / 100n;
  const required = gasLimit * (baseFee + parseGwei('0.03'));

  restartedEngine.arm();
  deploymentSearcher.arm();
  await waitForPreparation(deploymentSearcher);
  assert.equal(deploymentSearcher.view().mode, 'live');
  const mevBeforeRejection = fs.readFileSync(mevStateFile, 'utf8');
  await test.setBalance({ address: account.address, value: required - 1n });
  await assert.rejects(deploymentSearcher.deployFromDashboard(required, disarmSpot), DeploymentGasError);
  assert.equal(await nonce(), beforeDeploy, 'an unaffordable deploy does not consume a nonce');
  assert.equal(await balance(), required - 1n, 'an unaffordable deploy does not spend gas');
  assert.equal(fs.existsSync(walletJournal), false, 'the affordability error occurs before journaling');
  assert.equal(fs.readFileSync(mevStateFile, 'utf8'), mevBeforeRejection, 'the MEV journal remains unchanged');
  assert.equal(deploymentSearcher.view().deploymentPending, null);
  assert.equal(deploymentSearcher.view().mode, 'live');
  assert.equal(restartedEngine.state.armed, true);

  const limitedBalance = required + required / 100n;
  const oldRequirement = (estimatedGas * 13n / 10n) * (baseFee * 2n + parseGwei('1.5'));
  assert.ok(limitedBalance < oldRequirement / 10n, 'the old fixed-tip preflight would deny this balance');
  await test.setBalance({ address: account.address, value: limitedBalance });
  const quote = await exec.quoteDeployment(creationData);
  assert.equal(quote.balance, limitedBalance);
  assert.equal(quote.minimumWei, required);
  assert.equal(quote.gas, gasLimit);
  assert.ok(quote.gas * quote.maxFeePerGas <= limitedBalance, 'the quoted fee cap fits available funds');
  assert.equal(await nonce(), beforeDeploy, 'quoting does not consume a nonce');
  await assert.rejects(deploymentSearcher.deployFromDashboard(required - 1n, disarmSpot), /Review the refreshed quote/);
  assert.equal(await nonce(), beforeDeploy, 'a fee cap below the minimum does not consume a nonce');
  assert.equal(await balance(), limitedBalance);
  assert.equal(deploymentSearcher.view().mode, 'live', 'a rejected fee cap leaves MEV armed');
  assert.equal(restartedEngine.state.armed, true, 'a rejected fee cap leaves spot armed');
  assert.equal(fs.existsSync(walletJournal), false);
  assert.equal(fs.readFileSync(mevStateFile, 'utf8'), mevBeforeRejection);

  const dashboardQuote = await deploymentSearcher.deploymentQuote();
  assert.ok(dashboardQuote.maximumWei);
  assert.equal(dashboardQuote.version, 'proxy');
  assert.equal(dashboardQuote.release, proxyReleaseHash);
  const quotedMaximum = BigInt(dashboardQuote.maximumWei);
  assert.equal(quotedMaximum, quote.gas * quote.maxFeePerGas);
  const approved = required + (quotedMaximum - required) / 2n;
  assert.ok(approved < quotedMaximum, 'exercise the cap when a confirmed quote is lower than the fresh quote');
  await assert.rejects(deploymentSearcher.deployFromDashboard(approved, disarmSpot, 'deploy', keccak256(FLASH_ARB_V3_RUNTIME)), /unavailable/);
  assert.equal(await nonce(), beforeDeploy, 'a stale release approval must not consume a nonce');
  assert.equal(restartedEngine.state.armed, true, 'a stale release approval leaves spot armed');
  const [deployment, duplicate] = await Promise.allSettled([
    deploymentSearcher.deployFromDashboard(approved, disarmSpot), deploymentSearcher.deployFromDashboard(approved, disarmSpot),
  ]);
  assert.equal(deployment.status, 'fulfilled', 'a balance just above the minimum can deploy the proxy');
  assert.equal(duplicate.status, 'rejected', 'a duplicate deployment request is blocked while the first is pending');
  const proxy = deployment.value;
  assert.equal(deploymentSearcher.view().contract, proxy);
  assert.equal(deploymentSearcher.view().contractVersion, 'proxy');
  assert.equal(deploymentSearcher.view().canDeployProxy, false);
  assert.equal(deploymentSearcher.view().canUpgradeProxy, false, 'the current release does not offer a redundant upgrade');
  assert.equal(deploymentSearcher.view().mode, 'paper', 'deployment leaves MEV in paper mode');
  assert.equal(restartedEngine.state.armed, false, 'deployment leaves spot trading off');
  assert.equal(deploymentSearcher.file.contract, otherExample.address, 'legacy address remains a historical record');
  assert.equal(deploymentSearcher.file.v2Contract, v2, 'previous V2 remains a historical record');
  assert.equal(await publicClient.getCode({ address: v2 }), FLASH_ARB_V2_RUNTIME);
  assert.equal(await publicClient.getCode({ address: proxy }), FLASH_ARB_PROXY_RUNTIME);
  const implementation = await verifyFlashProxy(proxy, account.address, proxyReleaseHash);
  assert.ok(implementation);
  assert.equal(deploymentSearcher.view().proxyImplementation, implementation);
  assert.equal(await verifyFlashProxy(proxy, zeroAddress, proxyReleaseHash), null, 'an unrelated wallet cannot adopt the proxy');
  await assert.rejects(deploymentSearcher.deployFromDashboard(approved, disarmSpot));
  await assert.rejects(deploymentSearcher.deploymentQuote('upgrade'), /unavailable/);
  assert.equal(await nonce(), beforeDeploy + 1, 'repeated deployment does not spend gas');

  // Stale V2 configuration remains compatible with the verified proxy selected by the dashboard.
  MEV.funding = 'balancer';
  const adopted = new MevSearcher(mevHost);
  assert.equal(adopted.view().mode, 'paper');
  assert.equal(adopted.view().contract, proxy);
  assert.equal(adopted.view().canDeployProxy, false);
  adopted.arm();
  await waitForPreparation(adopted);
  assert.equal(adopted.view().mode, 'live');
  assert.equal(await nonce(), beforeDeploy + 1, 'arming reuses the verified proxy without spending gas');
  adopted.disarm();
  assert.equal(new MevSearcher(mevHost).view().mode, 'paper');
  console.log('✓ Dashboard migrated FlashArbV2 to a verified proxy in one transaction and left both live modes off');

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
  const recoveryState = {
    ...adopted.file, proxyContract: undefined, proxyImplementation: undefined, proxyRelease: undefined,
  };
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...recoveryState,
    deployVersion: 'proxy', deployRelease: proxyReleaseHash,
    deployTx: creation.hash, deployNonce: creation.nonce, deployStartedAt: Date.now(),
  }));
  const recoverProxy = new MevSearcher(mevHost);
  assert.equal(recoverProxy.view().deploymentPending, creation.hash);
  assert.equal(recoverProxy.view().contract, v2, 'V2 remains selected until the proxy receipt is verified');
  await recoverProxy.reconcileWallet();
  const afterProxyRecovery = new MevSearcher(mevHost);
  assert.equal(afterProxyRecovery.view().deploymentPending, null);
  assert.equal(afterProxyRecovery.view().mode, 'paper');
  assert.equal(afterProxyRecovery.view().contract, proxy);
  assert.equal(afterProxyRecovery.view().proxyImplementation, implementation);
  assert.equal(await nonce(), beforeDeploy + 1, 'proxy deployment recovery requires no new sends');
  assert.equal(await balance(), afterDeployBalance, 'proxy deployment recovery spends no gas');

  // Replay persisted journals for previous deployed versions while preserving the current proxy.
  await test.setBalance({ address: account.address, value: parseEther('1') });
  const v3 = await exec.deployContract(FLASH_ARB_V3_BYTECODE, log);
  const v3Transaction = await publicClient.getTransaction({ hash: v3.hash });
  const legacyBaselineNonce = await nonce();
  const legacyBaselineBalance = await balance();
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...afterProxyRecovery.file, deployVersion: 'v3', deployTx: legacyV2.hash,
    deployNonce: legacyV2Transaction.nonce, deployStartedAt: Date.now(),
  }));
  const unexpectedRuntime = new MevSearcher(mevHost);
  await unexpectedRuntime.reconcileWallet();
  assert.equal(unexpectedRuntime.view().deploymentPending, legacyV2.hash, 'an unverified receipt is retained');
  assert.equal(unexpectedRuntime.view().contract, proxy, 'a mislabeled receipt leaves the proxy selected');
  assert.equal(unexpectedRuntime.file.v3Contract, undefined, 'a V2 receipt cannot take the V3 slot');

  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...afterProxyRecovery.file, deployVersion: 'v3', deployTx: v3.hash,
    deployNonce: v3Transaction.nonce, deployStartedAt: Date.now(),
  }));
  const recoverV3 = new MevSearcher(mevHost);
  await recoverV3.reconcileWallet();
  const afterV3Recovery = new MevSearcher(mevHost);
  assert.equal(afterV3Recovery.view().deploymentPending, null);
  assert.equal(afterV3Recovery.view().mode, 'paper');
  assert.equal(afterV3Recovery.view().contract, proxy);
  assert.equal(afterV3Recovery.file.v3Contract, v3.address);
  assert.equal(afterV3Recovery.file.v2Contract, v2);

  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...afterV3Recovery.file, v2Contract: null,
    deployVersion: 'v2', deployTx: legacyV2.hash, deployNonce: legacyV2Transaction.nonce, deployStartedAt: Date.now(),
  }));
  const recoverV2 = new MevSearcher(mevHost);
  await recoverV2.reconcileWallet();
  const afterV2Recovery = new MevSearcher(mevHost);
  assert.equal(afterV2Recovery.view().deploymentPending, null);
  assert.equal(afterV2Recovery.view().contract, proxy);
  assert.equal(afterV2Recovery.file.v2Contract, v2);

  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...afterV2Recovery.file, deployVersion: undefined,
    deployTx: example.hash, deployNonce: exampleTx.nonce, deployStartedAt: Date.now(),
  }));
  const recoverLegacy = new MevSearcher(mevHost);
  await recoverLegacy.reconcileWallet();
  const afterLegacyRecovery = new MevSearcher(mevHost);
  assert.equal(afterLegacyRecovery.view().deploymentPending, null);
  assert.equal(afterLegacyRecovery.view().mode, 'paper');
  assert.equal(afterLegacyRecovery.view().contract, proxy);
  assert.equal(afterLegacyRecovery.file.contract, example.address);
  assert.equal(await nonce(), legacyBaselineNonce, 'legacy receipt recovery requires no new sends');
  assert.equal(await balance(), legacyBaselineBalance, 'legacy receipt recovery spends no gas');
  console.log('✓ Proxy deployment and V3, V2 and legacy journals recover without additional transactions');

  const oldRelease = keccak256(FLASH_ARB_V3_RUNTIME);
  const oldProxyData = encodeDeployData({
    abi: FLASH_ARB_PROXY_ABI, bytecode: FLASH_ARB_PROXY_BYTECODE, args: [FLASH_ARB_V3_BYTECODE, oldRelease],
  });
  const { address: oldProxy } = await exec.deployContract(oldProxyData, log);
  const oldImplementation = await verifyFlashProxy(oldProxy, account.address, oldRelease);
  assert.ok(oldImplementation);
  const oldProxyState = {
    ...afterLegacyRecovery.file,
    proxyContract: oldProxy, proxyImplementation: oldImplementation, proxyRelease: oldRelease,
  };
  fs.writeFileSync(mevStateFile, JSON.stringify(oldProxyState));
  const upgrade = new MevSearcher(mevHost);
  restartedEngine.mev = upgrade;
  MEV.funding = 'spark';
  assert.throws(() => upgrade.arm(), /SparkLend funding requires a compatible FlashArb Proxy release/);
  MEV.funding = 'balancer';
  restartedEngine.arm();
  upgrade.arm();
  await waitForPreparation(upgrade);
  assert.equal(upgrade.view().mode, 'live', 'previous reviewed releases can still arm');
  assert.equal(upgrade.view().canUpgradeProxy, true);

  const beforeUpgrade = await nonce();
  const upgradeQuote = await upgrade.deploymentQuote('upgrade');
  assert.ok(upgradeQuote.maximumWei);
  assert.equal(upgradeQuote.release, proxyReleaseHash);
  const upgradeMaximum = BigInt(upgradeQuote.maximumWei);
  await assert.rejects(upgrade.deployFromDashboard(upgradeMaximum, disarmSpot, 'upgrade', oldRelease), /unavailable/);
  assert.equal(await nonce(), beforeUpgrade, 'an old release approval must not send an upgrade');
  assert.equal(await upgrade.deployFromDashboard(upgradeMaximum, disarmSpot, 'upgrade', upgradeQuote.release), oldProxy);
  assert.equal(upgrade.view().contract, oldProxy, 'the upgrade preserves the configured trading address');
  assert.equal(upgrade.view().mode, 'paper');
  assert.equal(restartedEngine.state.armed, false);
  assert.equal(upgrade.view().canUpgradeProxy, false);
  assert.equal(await publicClient.getCode({ address: oldProxy }), FLASH_ARB_PROXY_RUNTIME);
  const newImplementation = await verifyFlashProxy(oldProxy, account.address, proxyReleaseHash);
  assert.ok(newImplementation);
  assert.notEqual(newImplementation, oldImplementation);
  assert.equal(upgrade.view().proxyImplementation, newImplementation);
  assert.equal(await verifyFlashProxy(oldProxy, account.address, oldRelease), null);
  const { transactions: upgradeTransactions } = await publicClient.getBlock({ blockTag: 'latest', includeTransactions: true });
  const upgradeTransaction = upgradeTransactions.find((tx) => tx.from.toLowerCase() === account.address.toLowerCase()
    && tx.nonce === beforeUpgrade && tx.to?.toLowerCase() === oldProxy.toLowerCase());
  assert.ok(upgradeTransaction);
  assert.equal(upgradeTransaction.type, 'eip1559');
  assert.ok(upgradeTransaction.gas * upgradeTransaction.maxFeePerGas <= upgradeMaximum, 'upgrade stays within the approved gas cap');
  assert.equal(await nonce(), beforeUpgrade + 1, 'installation and activation cost one transaction');

  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...oldProxyState, deployVersion: 'proxy-upgrade', deployRelease: proxyReleaseHash,
    deployTx: upgradeTransaction.hash, deployNonce: upgradeTransaction.nonce, deployStartedAt: Date.now(),
  }));
  const recoverUpgrade = new MevSearcher(mevHost);
  assert.equal(recoverUpgrade.view().contract, oldProxy);
  assert.equal(recoverUpgrade.view().proxyImplementation, oldImplementation);
  await recoverUpgrade.reconcileWallet();
  const afterUpgradeRecovery = new MevSearcher(mevHost);
  assert.equal(afterUpgradeRecovery.view().upgradePending, null);
  assert.equal(afterUpgradeRecovery.view().contract, oldProxy);
  assert.equal(afterUpgradeRecovery.view().proxyImplementation, newImplementation);
  assert.equal(afterUpgradeRecovery.view().mode, 'paper');
  assert.equal(await nonce(), beforeUpgrade + 1, 'upgrade recovery does not send another transaction');
  MEV.funding = 'spark';
  afterUpgradeRecovery.arm();
  await waitForPreparation(afterUpgradeRecovery);
  assert.equal(afterUpgradeRecovery.view().mode, 'live', 'new release permits SparkLend funding after verification');
  afterUpgradeRecovery.disarm();
  console.log('✓ Dashboard installed and recovered a new implementation at the same address with one approved upgrade transaction');

  // Direct signatures remain usable after an arbitrage deadline. After restart,
  // keep the nonce reserved and charge the gas if the transaction mines late.
  MEV.submission = 'direct';
  MEV.directMaxGasUsd = 0;
  MEV.directDailyGasUsd = 0;
  const noDirectBudget = new MevSearcher(mevHost);
  const directNonce = await nonce();
  assert.equal(noDirectBudget.view().settings.direct.enabled, false);
  assert.throws(() => noDirectBudget.arm(), /gas limits/i);
  assert.equal(await nonce(), directNonce, 'direct arming without a gas budget does not consume a nonce');
  MEV.directMaxGasUsd = 2;
  MEV.directDailyGasUsd = 4;

  const source = await publicClient.getBlockNumber({ cacheTime: 0 });
  const target = source + 2n;
  const data = pinnedArbitrage(encodeArbitrage(0, {
    token: ADDR.usdc, amountIn: 1n, minProfit: 1n, tip: 0n, maxBlock: target,
    buy: { kind: NextVenueKind.UniswapV2, address: otherExample.address, venue: 'Uniswap v2', v2: true, fee: 0.003 },
    sell: { kind: NextVenueKind.SushiV2, address: example.address, venue: 'SushiSwap v2', v2: true, fee: 0.003 },
  }), proxyReleaseHash);
  const serialized = await account.signTransaction({
    chainId: 1, type: 'eip1559', nonce: directNonce, to: oldProxy, data, gas: 200_000n,
    maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('0.05'), value: 0n,
  });
  const directHash = keccak256(serialized);
  const startedAt = Date.now();
  const ethUsd = 2_000;
  const pendingGasEth = 0.0002;
  const directOpportunity = {
    t: startedAt, block: Number(source), symbol: 'USDC', buy: 'Uniswap v2', sell: 'SushiSwap v2',
    sizeEth: 0.1, grossEth: 0.001, gasEth: pendingGasEth, tipEth: 0, netEth: 0.0008, netUsd: 1.6,
    status: 'sent', hash: directHash, submission: {
      kind: 'direct', target: Number(target), startedAt, leadMs: 8_000, gasEth: pendingGasEth,
      tipEth: 0, netUsd: 1.6, builders: [],
    },
  };
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...noDirectBudget.file, pending: {
      kind: 'direct', nonce: directNonce, target: target.toString(), contract: oldProxy,
      ethUsd, hash: directHash, opp: directOpportunity,
    },
  }));
  await test.mine({ blocks: 5 });
  const confirmedHead = await publicClient.getBlockNumber({ cacheTime: 0 });
  assert.ok(confirmedHead > target);
  assert.equal(await nonce(), directNonce, 'no competing wallet transaction has used the nonce');

  const directExecutor = new LiveExecutor(account);
  const recoveredDirect = new MevSearcher({ ...mevHost, exec: directExecutor, ethUsd: () => ethUsd });
  assert.equal(recoveredDirect.view().mode, 'paper', 'direct restart starts disarmed');
  assert.equal(recoveredDirect.view().pending?.hash, directHash);
  await recoveredDirect.reconcileWallet(confirmedHead);
  assert.equal(recoveredDirect.view().pending?.hash, directHash, 'a deadline cannot abandon a signed direct transaction');
  assert.ok(recoveredDirect.walletPending());

  await assert.rejects(publicClient.call({ account: account.address, to: oldProxy, data }), /expired/i);
  const balanceBeforeLateSend = await balance();
  assert.equal(await submitDirect(serialized), directHash, 'the fixture submits exclusively to the local Ethereum RPC');
  const lateReceipt = await publicClient.waitForTransactionReceipt({ hash: directHash, pollingInterval: 100, timeout: 10_000 });
  assert.equal(lateReceipt.status, 'reverted');
  assert.ok(lateReceipt.blockNumber > target);
  await recoveredDirect.reconcileWallet(lateReceipt.blockNumber);

  const failure = recoveredDirect.view().recent.find((opportunity) => opportunity.hash === directHash);
  const gasWei = lateReceipt.gasUsed * lateReceipt.effectiveGasPrice;
  const gasEth = Number(gasWei) / 1e18;
  assert.ok(gasWei > 0n);
  assert.equal(await balance(), balanceBeforeLateSend - gasWei, 'expiration still costs wallet gas');
  assert.equal(recoveredDirect.view().pending, null, 'the receipt releases the nonce');
  assert.equal(recoveredDirect.walletPending(), false);
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.gasEth, gasEth);
  assert.equal(failure?.netUsd, -gasEth * ethUsd);
  assert.equal(recoveredDirect.view().settings.direct.spentGasUsd, gasEth * ethUsd);
  const finalDirect = new MevSearcher(mevHost);
  assert.equal(finalDirect.view().settings.direct.spentGasUsd, gasEth * ethUsd, 'a second restart retains confirmed revert gas');
  assert.equal(await nonce(), directNonce + 1);
  assert.equal(await directExecutor.bundleNonce(), directNonce + 1, 'the next wallet action uses the next nonce');
  console.log('✓ Confirmed late direct MEV reverted after restart, accounted for wallet gas, and released the nonce');

  const privateSource = lateReceipt.blockNumber;
  const privateTarget = privateSource + 1n;
  const privateHash = keccak256('0x1234');
  const privateNonce = directNonce + 1;
  const privateOpportunity = {
    ...directOpportunity, hash: privateHash, block: Number(privateSource),
    submission: { ...directOpportunity.submission, target: Number(privateTarget), privateSubmission: true },
  };
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...finalDirect.file, pending: {
      kind: 'direct', privateSubmission: true, nonce: privateNonce, target: privateTarget.toString(),
      contract: oldProxy, ethUsd, hash: privateHash, opp: privateOpportunity,
    },
  }));
  const recoveredPrivate = new MevSearcher(mevHost);
  assert.equal(recoveredPrivate.view().pending?.hash, privateHash);
  await recoveredPrivate.reconcileWallet(privateSource);
  assert.equal(recoveredPrivate.view().pending?.hash, privateHash, 'the nonce stays reserved before the private deadline');
  await test.mine({ blocks: 2 });
  await recoveredPrivate.reconcileWallet(await publicClient.getBlockNumber({ cacheTime: 0 }));
  assert.equal(recoveredPrivate.view().pending, null);
  assert.equal(recoveredPrivate.view().recent.find((opportunity) => opportunity.hash === privateHash)?.status, 'not included');
  assert.equal(recoveredPrivate.view().settings.direct.spentGasUsd, gasEth * ethUsd);
  assert.equal(await nonce(), privateNonce, 'an expired private submission spends no gas and leaves the nonce unused');
  console.log('✓ Expired private one-shot reconciled after restart without spending gas or consuming a nonce');

  const replacementSource = await publicClient.getBlockNumber({ cacheTime: 0 });
  const replacementDeadline = replacementSource + 2n;
  const replacedHash = keccak256('0x2345');
  fs.writeFileSync(mevStateFile, JSON.stringify({
    ...recoveredPrivate.file, pending: {
      kind: 'direct', privateSubmission: true, nonce: privateNonce, target: replacementDeadline.toString(),
      contract: oldProxy, ethUsd, hash: replacedHash, opp: {
        ...privateOpportunity, hash: replacedHash, block: Number(replacementSource),
        submission: { ...privateOpportunity.submission, target: Number(replacementDeadline) },
      },
    },
  }));
  const replacementExecutor = new LiveExecutor(account);
  const recoveredReplacement = new MevSearcher({ ...mevHost, exec: replacementExecutor });
  assert.equal(recoveredReplacement.view().pending?.hash, replacedHash);

  const replacement = await account.signTransaction({
    chainId: 1, type: 'eip1559', nonce: privateNonce, to: account.address, gas: 21_000n,
    maxFeePerGas: parseGwei('1'), maxPriorityFeePerGas: parseGwei('0.05'), value: 0n,
  });
  const replacementReceipt = await publicClient.waitForTransactionReceipt({
    hash: await submitDirect(replacement), pollingInterval: 100, timeout: 10_000,
  });
  assert.equal(replacementReceipt.status, 'success');
  assert.equal(replacementReceipt.blockNumber, replacementSource + 1n, 'the replacement mined in the first eligible block');
  await recoveredReplacement.reconcileWallet(replacementReceipt.blockNumber);
  assert.equal(recoveredReplacement.view().pending?.hash, replacedHash, 'the private nonce remains reserved before the deadline');
  await test.mine({ blocks: 2 });
  await recoveredReplacement.reconcileWallet(await publicClient.getBlockNumber({ cacheTime: 0 }));
  assert.equal(recoveredReplacement.view().pending, null);
  assert.equal(recoveredReplacement.walletPending(), false);
  const replaced = recoveredReplacement.view().recent.find((opportunity) => opportunity.hash === replacedHash);
  assert.equal(replaced?.status, 'not included');
  assert.match(replaced?.note ?? '', /different confirmed transaction used the nonce/);
  assert.equal(replaced?.gasEth, 0);
  assert.equal(recoveredReplacement.view().settings.direct.spentGasUsd, gasEth * ethUsd);
  assert.equal(await replacementExecutor.bundleNonce(), privateNonce + 1, 'wallet uses the next nonce after recovering a replacement');
  console.log('✓ Two-block private recovery found a nonce replacement in the first block without charging MEV gas');

} finally {
  MEV.v2ContractAddress = originalV2Address;
  MEV.v3ContractAddress = originalV3Address;
  MEV.funding = originalFundingMode;
  Object.assign(MEV, originalDirectSettings);
}
console.log('ALL WALLET TESTS PASSED');
