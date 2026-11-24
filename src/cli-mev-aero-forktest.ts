import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, formatEther, getAddress, http, keccak256, parseAbi, parseEther, parseEventLogs, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { ADDR, CONFIG } from './config.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { MIN_PRIORITY_FEE_WEI, nextBaseFee } from './chain.js';
import { FLASH_ARB_LOGIC_V3_ABI, FLASH_ARB_LOGIC_V3_RUNTIME } from './mev/artifact-logic-v3.js';
import { FLASH_ARB_PROXY_ABI } from './mev/artifact-proxy.js';
import { affordableDirectFees, directExecutionReserve } from './mev/direct.js';
import { encodePathArbitrage, pinnedArbitrage, proxyReleaseHash, proxyUpgradeData, releaseSupportsPath, verifyFlashProxy } from './mev/proxy.js';

await assertForkTestEnvironment();
assert.equal(CONFIG.allowLiveTrading, false);
assert.equal(new URL(CONFIG.rpcUrl).hostname, '127.0.0.1');
const transport = http(CONFIG.rpcUrl, { timeout: 120_000, retryCount: 0, fetchOptions: { redirect: 'error' } });
const chain = createPublicClient({ chain: mainnet, transport, cacheTime: 0 });
const local = createTestClient({ mode: 'anvil', chain: mainnet, transport });
const tx = createWalletClient({ chain: mainnet, transport });
const source = await chain.getBlock();
assert.equal(await chain.getChainId(), 1);
assert.equal(source.number, 26_481_443n);
assert.equal(source.hash, '0xd09ff935a70b798f0b468625f6b0bf3c6fc2531afff6583225d9170b7f64edf8');
const target = source.number + 1n;
const targetBase = nextBaseFee(source);
assert.equal(targetBase, 2_107_315_504n);
const proxy = getAddress('0x6dfc808e2f678e1df30b2a7c1677331a7cd481b5');
const aeroPool = getAddress('0xd661623947ef2ead12d577b47021c167d163b0c5');
const uniPool = getAddress('0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
const morpho = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
const { usdc, weth } = ADDR;
const owner = await chain.readContract({ address: proxy, abi: FLASH_ARB_LOGIC_V3_ABI, functionName: 'owner' });
const oldRelease = keccak256(FLASH_ARB_LOGIC_V3_RUNTIME);
assert.ok(await verifyFlashProxy(proxy, owner, oldRelease, source.number));
assert.ok(releaseSupportsPath(oldRelease));
assert.ok(releaseSupportsPath(proxyReleaseHash));
assert.notEqual(oldRelease, proxyReleaseHash);
const principal = 12_882_984_512_425_461_760n;
const sourcePayout = 10_801_605_221_861_263n;
const matchedPrincipal = 9_659_884_554_681_831_424n;
const matchedPayout = 10_125_942_190_835_081n;
const buy = { kind: 8, pool: aeroPool, fee: 0, tickSpacing: 50, nativeEth: false };
const sell = { kind: 2, pool: uniPool, fee: 500, tickSpacing: 0, nativeEth: false };
const input = (minProfit: bigint, funding = 2, entry = buy, amountIn = principal) => encodeFunctionData({
  abi: FLASH_ARB_LOGIC_V3_ABI, functionName: 'execute',
  args: [{ funding, token: usdc, buy: entry, sell, amountIn, minProfit, tip: 0n, maxBlock: target }],
});
const order = (floor: bigint) => pinnedArbitrage(input(floor), proxyReleaseHash);
const simulate = (data: Hex) => chain.call({ account: owner, to: proxy, data, blockTag: 'latest' });
const checkPath = (release: Hex) => simulate(encodePathArbitrage([], principal, 1n, target, release));
await assert.rejects(checkPath(oldRelease), /path length/);
const balance = (token: Address, who: Address) => chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
const allowance = (token: Address, spender: Address) => chain.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [proxy, spender] });
const assertEmpty = async () => {
  const router = getAddress('0x9ee35bf1bd69a03c6f0393582030fce8bb93d418');
  const values = await Promise.all([chain.getBalance({ address: proxy }), balance(weth, proxy), balance(usdc, proxy),
    ...[morpho, aeroPool, uniPool, router].flatMap(spender => [allowance(weth, spender), allowance(usdc, spender)])]);
  assert.ok(values.every(v => v === 0n), 'executor retains no tokens, native ETH or spending approvals');
};
// Price from the same ETH/USD feed and block as the replay.
const [, answer] = await chain.readContract({ address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
  abi: parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']), functionName: 'latestRoundData' });
assert.ok(answer > 0n);
const usdWei = (cents: bigint) => cents * 10n ** 24n / answer;
const ownerStart = parseEther('100');
await local.setBalance({ address: owner, value: ownerStart });
await local.impersonateAccount({ address: owner });
const lenderBefore = await balance(weth, morpho);
assert.ok(lenderBefore >= principal);
await assertEmpty();
const checkpoint = await local.snapshot();
const upgrade = { account: owner, to: proxy, data: proxyUpgradeData(oldRelease), gas: 10_000_000n,
  maxFeePerGas: targetBase + MIN_PRIORITY_FEE_WEI, maxPriorityFeePerGas: MIN_PRIORITY_FEE_WEI };
const nextTimestamp = source.timestamp + 12n;
await local.setNextBlockTimestamp({ timestamp: nextTimestamp });
await local.setNextBlockBaseFeePerGas({ baseFeePerGas: targetBase });
const upgradePreview = await chain.waitForTransactionReceipt({ hash: await tx.sendTransaction(upgrade) });
assert.equal(upgradePreview.status, 'success');
assert.equal(upgradePreview.blockNumber, target);
assert.ok(await verifyFlashProxy(proxy, owner, proxyReleaseHash, target));
await assert.rejects(checkPath(oldRelease), /wrong release/);
await assert.rejects(checkPath(proxyReleaseHash), /path length/);
const errorAbi = [...FLASH_ARB_PROXY_ABI, ...parseAbi(['error AeroRequiresMorpho()', 'error InvalidAeroPool()'])] as const;
const guarded = (release: Hex, data: Hex) => chain.simulateContract({ account: owner, address: proxy,
  abi: errorAbi, functionName: 'executePinned', args: [release, data] });
await assert.rejects(guarded(oldRelease, input(1n)), /WrongImplementation/);
for (const funding of [0, 1, 3, 4]) await assert.rejects(guarded(proxyReleaseHash, input(1n, funding)), /AeroRequiresMorpho/);
await assert.rejects(guarded(proxyReleaseHash, input(1n, 2, { ...buy, pool: uniPool })), /InvalidAeroPool/);
const quoted = await simulate(order(1n));
assert.ok(quoted.data);
const gross = BigInt(quoted.data);
assert.equal(gross, sourcePayout);
const matched = await simulate(pinnedArbitrage(input(1n, 2, buy, matchedPrincipal), proxyReleaseHash));
assert.equal(BigInt(matched.data!), matchedPayout);
const gasEstimate = await chain.estimateGas({ account: owner, to: proxy, data: order(1n), blockTag: 'latest' });
const padded = (gasEstimate * 125n + 99n) / 100n;
const spendable = gross - directExecutionReserve(gross);
const min = (...xs: bigint[]) => xs.reduce((a, b) => a < b ? a : b);
const ordinary = affordableDirectFees(targetBase, padded, MIN_PRIORITY_FEE_WEI, MIN_PRIORITY_FEE_WEI,
  min(usdWei(150n), spendable - usdWei(5n) - 1n), 1);
const premiumRoom = min(usdWei(500n), spendable - usdWei(500n) - 1n, spendable / 2n);
const premium = affordableDirectFees(targetBase, padded, 1_000_000_000n, MIN_PRIORITY_FEE_WEI, premiumRoom, 1);
const faster = premium && premium.maxPriorityFeePerGas > (ordinary?.maxPriorityFeePerGas ?? 0n);
const fees = faster ? (affordableDirectFees(targetBase, padded, 1_100_000_000n, MIN_PRIORITY_FEE_WEI, premiumRoom, 1) ?? premium) : ordinary;
assert.ok(fees, 'historical route must retain configured gas and profit budgets');
const feeBudget = padded * fees.maxFeePerGas;
const netFloor = faster ? (feeBudget > usdWei(500n) + 1n ? feeBudget : usdWei(500n) + 1n) : usdWei(5n) + 1n;
assert.ok(spendable >= feeBudget + netFloor);
const payload = order(feeBudget + netFloor);
assert.equal(BigInt((await simulate(payload)).data!), gross);
console.log(`Local preview at ${target}: gross ${formatEther(gross)} ETH, gas ${gasEstimate}, padded ${padded}.`);
// Rewind the preview, then mine upgrade and swap in that order at the actual one-block deadline.
await local.revert({ id: checkpoint });
assert.equal(await chain.getBlockNumber(), source.number);
await local.impersonateAccount({ address: owner });
const startNonce = await chain.getTransactionCount({ address: owner });
await local.setAutomine(false);
await local.setNextBlockTimestamp({ timestamp: nextTimestamp });
// A snapshot rollback can retain Anvil's pending fee from the preview block.
await local.setNextBlockBaseFeePerGas({ baseFeePerGas: targetBase });
const upgradeHash = await tx.sendTransaction({ ...upgrade, nonce: startNonce });
const tradeHash = await tx.sendTransaction({ account: owner, nonce: startNonce + 1, to: proxy, data: payload, gas: padded, ...fees });
await local.mine({ blocks: 1 });
const mined = await chain.getBlock({ blockNumber: target });
assert.deepEqual(mined.transactions, [upgradeHash, tradeHash], 'expected the local upgrade and funded swap in one target block');
const [upgradeReceipt, receipt] = await Promise.all([chain.getTransactionReceipt({ hash: upgradeHash }),
  chain.getTransactionReceipt({ hash: tradeHash })]);
assert.equal(upgradeReceipt.status, 'success');
assert.equal(receipt.status, 'success');
assert.equal(upgradeReceipt.blockNumber, target);
assert.equal(receipt.blockNumber, target);
assert.ok(upgradeReceipt.transactionIndex < receipt.transactionIndex);
assert.equal(mined.baseFeePerGas, targetBase);
assert.equal(mined.timestamp, nextTimestamp);
const logs = receipt.logs.filter(l => l.address.toLowerCase() === proxy.toLowerCase());
const settled = parseEventLogs({ abi: FLASH_ARB_LOGIC_V3_ABI, eventName: 'Arbitrage', logs }).map(l => l.args);
const funded = parseEventLogs({ abi: FLASH_ARB_LOGIC_V3_ABI, eventName: 'FundedBy', logs }).map(l => l.args);
assert.deepEqual(settled, [{ token: usdc, poolA: aeroPool, poolB: uniPool, amountIn: principal, profit: gross, tip: 0n }]);
assert.deepEqual(funded, [{ funding: 2, amount: principal, premium: 0n }]);
const paidGas = receipt.gasUsed * receipt.effectiveGasPrice;
const paidUpgrade = upgradeReceipt.gasUsed * upgradeReceipt.effectiveGasPrice;
assert.equal((await chain.getBalance({ address: owner })) - ownerStart + paidUpgrade, gross - paidGas);
assert.ok(paidGas <= feeBudget && gross - paidGas >= netFloor);
assert.equal(await balance(weth, morpho), lenderBefore);
await assertEmpty();
console.log(JSON.stringify({ block: String(target), sourceVenueQuoteWei: String(sourcePayout), proxyPayoutWei: String(gross),
  gasEstimate: String(gasEstimate), paddedGas: String(padded), gasUsed: String(receipt.gasUsed), ordinaryQualifies: !!ordinary,
  premiumSelected: !!faster, feeBudgetEth: formatEther(feeBudget), actualGasEth: formatEther(paidGas),
  ownerNetEth: formatEther(gross - paidGas), ethUsd: Number(answer) / 1e8 }));
