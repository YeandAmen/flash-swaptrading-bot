import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, decodeFunctionData, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseEther, parseEventLogs, parseGwei, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { erc20Abi, nextBaseFee } from './chain.js';
import { ADDR, CONFIG, MEV } from './config.js';
import { LiveExecutor } from './executor.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_BYTECODE, FLASH_ARB_V2_RUNTIME } from './mev/artifact-v2.js';
import { FLASH_ARB_V3_ABI, FLASH_ARB_V3_BYTECODE, FLASH_ARB_V3_RUNTIME } from './mev/artifact-v3.js';
import { FLASH_ARB_LOGIC_BYTECODE, FLASH_ARB_LOGIC_RUNTIME } from './mev/artifact-logic.js';
import { FLASH_ARB_LOGIC_V2_BYTECODE, FLASH_ARB_LOGIC_V2_RUNTIME } from './mev/artifact-logic-v2.js';
import { FLASH_ARB_PROXY_ABI, FLASH_ARB_PROXY_BYTECODE, FLASH_ARB_PROXY_RUNTIME } from './mev/artifact-proxy.js';
import type { RouteFunding } from './mev/flash-arb.js';
import { NextVenueKind } from './mev/next-pools.js';
import { discoverArbPools, poolIdentity, toNextVenue, type ArbPool } from './mev/pools.js';
import { MevSearcher, type MevOpp } from './mev/searcher.js';
import { loadOrCreateWallet } from './wallet.js';

// The harness supplies only a disposable account and the same loopback Anvil read and send RPCs.
await assertForkTestEnvironment();
assert.equal(CONFIG.allowLiveTrading, false);
const useV3 = process.env.MEV_FORK_USE_V3 === '1';
const useProxy = process.env.MEV_FORK_USE_PROXY === '1';
const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const adminSlot = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
let implementationHash = keccak256(FLASH_ARB_V3_RUNTIME);

const transport = http(CONFIG.rpcUrl, { timeout: 120_000, retryCount: 0, fetchOptions: { redirect: 'error' } });
const fork = createTestClient({ chain: mainnet, mode: 'anvil', transport });
const publicClient = createPublicClient({ chain: mainnet, transport });
const walletClient = createWalletClient({ chain: mainnet, transport });
const owner = loadOrCreateWallet().account;
const fixture = privateKeyToAccount(generatePrivateKey());
await fork.setBalance({ address: owner.address, value: parseEther('5') });
await fork.setBalance({ address: fixture.address, value: parseEther('200') });

const uniswapV2Router = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const sushiV2Router = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F';
const fixtureRouterAbi = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const sparkWeth = '0x59cD1C87501baa753d0B5B5Ab5D8416A45cD71DB';
const lenders: Record<number, Address> = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  2: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  3: '0xbA1333333333a1BA1108E8412f11850A5C319bA9',
  4: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987',
};

async function confirmed(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `local transaction ${hash} succeeded`);
  return receipt;
}

const [market] = await discoverArbPools([{ address: ADDR.usdc, symbol: 'USDC', decimals: 6, core: true }], 2,
  { includePancakeV3: true, includeUniswapV4: true, ...(useProxy && { includePancakeV2: true, includeCurve: true }) });
assert.ok(market, 'fork has canonical USDC markets');
function pick(kind: NextVenueKind, fee: number, nativeEth = false) {
  const pool = market.pools.find((p) => p.kind === kind && Math.round(p.fee * 1e6) === fee && Boolean(p.v4?.nativeEth) === nativeEth);
  assert.ok(pool, `canonical fixture pool (${kind}, ${fee}, ${nativeEth})`);
  return pool;
}
const pancake500 = pick(NextVenueKind.PancakeV3, 500);
const pancakeV2 = useProxy ? pick(NextVenueKind.PancakeV2, 2500) : null;
if (pancakeV2) assert.equal(pancakeV2.address.toLowerCase(), '0x2e8135be71230c6b1b4045696d41c09db0414226');
const v4Native500 = pick(NextVenueKind.UniswapV4, 500, true);
const v4Weth500 = pick(NextVenueKind.UniswapV4, 500);
const sushiV2 = pick(NextVenueKind.SushiV2, 3000);
const curve = useProxy ? pick(NextVenueKind.CurveTricrypto, 0) : null;
if (curve) assert.equal(curve.address.toLowerCase(), '0x7f86bf177dd4f3494b841a37e810a34dd56c829b');
assert.notEqual(poolIdentity(v4Native500), poolIdentity(v4Weth500), 'v4 liquidity pools have distinct IDs despite a shared manager');
console.log('✓ canonical Pancake v3, native ETH Uniswap v4, and WETH Uniswap v4 pools discovered');

const bytecode = useV3 ? FLASH_ARB_V3_BYTECODE : FLASH_ARB_V2_BYTECODE;
const runtime = useV3 ? FLASH_ARB_V3_RUNTIME : FLASH_ARB_V2_RUNTIME;
const deployment = await confirmed(await (useProxy ? walletClient.deployContract({
  account: owner, abi: FLASH_ARB_PROXY_ABI, bytecode: FLASH_ARB_PROXY_BYTECODE, args: [FLASH_ARB_V3_BYTECODE, implementationHash],
}) : walletClient.deployContract({ account: owner, abi: FLASH_ARB_V2_ABI, bytecode })));
assert.ok(deployment.contractAddress);
const contract = deployment.contractAddress;
assert.equal(await publicClient.getCode({ address: contract }), useProxy ? FLASH_ARB_PROXY_RUNTIME : runtime);
assert.equal(await publicClient.readContract({ address: contract, abi: FLASH_ARB_V2_ABI, functionName: 'owner' }), owner.address);
if (useV3) {
  await assert.rejects(publicClient.simulateContract({
    address: contract, abi: FLASH_ARB_V3_ABI, functionName: 'onBalancerV3Loan', args: ['0x'], account: fixture.address,
  }), /callback context/);
}

async function slotAddress(slot: Hex) {
  const value = await publicClient.getStorageAt({ address: contract, slot, blockNumber: await publicClient.getBlockNumber({ cacheTime: 0 }) });
  assert.ok(value && /^0x0{24}[0-9a-f]{40}$/i.test(value));
  return getAddress(`0x${value.slice(-40)}`);
}

async function verifyUpgrade() {
  const previous = await slotAddress(implementationSlot);
  assert.equal(await publicClient.getCode({ address: previous }), FLASH_ARB_V3_RUNTIME);
  assert.equal(await slotAddress(adminSlot), owner.address);
  const nextHash = keccak256(FLASH_ARB_LOGIC_RUNTIME);
  const upgrade = { address: contract, abi: FLASH_ARB_PROXY_ABI, functionName: 'upgradeRelease' } as const;

  await assert.rejects(publicClient.simulateContract({
    ...upgrade, account: fixture.address, args: [FLASH_ARB_LOGIC_BYTECODE, implementationHash, nextHash],
  }), /Unauthorized/);
  await assert.rejects(publicClient.simulateContract({
    ...upgrade, account: owner.address, args: [FLASH_ARB_LOGIC_BYTECODE, nextHash, implementationHash],
  }), /WrongImplementation/);
  await assert.rejects(publicClient.simulateContract({
    ...upgrade, account: owner.address, args: [FLASH_ARB_V3_BYTECODE, implementationHash, nextHash],
  }), /WrongImplementation/);
  const badOwnerRuntime = '0x600060005260206000f3';
  const badOwnerBytecode = '0x600a600c600039600a6000f3600060005260206000f3';
  await assert.rejects(publicClient.simulateContract({
    ...upgrade, account: owner.address, args: [badOwnerBytecode, implementationHash, keccak256(badOwnerRuntime)],
  }), /IncompatibleOwner/);
  assert.equal(await slotAddress(implementationSlot), previous);

  const receipt = await confirmed(await walletClient.writeContract({
    ...upgrade, account: owner, args: [FLASH_ARB_LOGIC_BYTECODE, implementationHash, nextHash],
  }));
  const newImplementation = await slotAddress(implementationSlot);
  assert.notEqual(newImplementation, previous);
  assert.equal(await publicClient.getCode({ address: newImplementation }), FLASH_ARB_LOGIC_RUNTIME);
  assert.equal(await publicClient.getCode({ address: contract }), FLASH_ARB_PROXY_RUNTIME);
  assert.equal(await slotAddress(adminSlot), owner.address);
  assert.equal(await publicClient.readContract({ address: contract, abi: FLASH_ARB_V3_ABI, functionName: 'owner' }), owner.address);
  const [upgraded] = parseEventLogs({ abi: FLASH_ARB_PROXY_ABI, eventName: 'Upgraded', logs: receipt.logs });
  assert.equal(upgraded?.args.implementation, newImplementation);

  // A previously signed order remains rejected even when its route value would otherwise decode.
  const staleOrder = {
    funding: 0, token: ADDR.usdc, buy: toNextVenue(pancake500), sell: toNextVenue(sushiV2),
    amountIn: parseEther('1'), minProfit: 1n, tip: 0n, maxBlock: 0n,
  };
  const staleData = encodeOrder(staleOrder);
  const execute = { address: contract, abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned' } as const;
  await assert.rejects(publicClient.simulateContract({
    ...execute, account: owner.address, args: [implementationHash, staleData],
  }), /WrongImplementation/);
  await assert.rejects(publicClient.simulateContract({
    ...execute, account: fixture.address, args: [nextHash, staleData],
  }), /Unauthorized/);
  await assert.rejects(publicClient.simulateContract({
    ...execute, account: owner.address, args: [nextHash, '0x8da5cb5b'],
  }), /InvalidExecution/);
  await assert.rejects(publicClient.simulateContract({
    address: contract, account: owner.address, abi: [...FLASH_ARB_V3_ABI, ...FLASH_ARB_PROXY_ABI],
    functionName: 'execute', args: [staleOrder],
  }), /InvalidExecution/);
  implementationHash = nextHash;
  console.log('✓ upgrade preserved the proxy address and owner, and blocked old, arbitrary, and unauthorized execution');
}

async function verifyCurveUpgrade(curve: ArbPool) {
  const previous = await slotAddress(implementationSlot);
  assert.equal(await publicClient.getCode({ address: previous }), FLASH_ARB_LOGIC_RUNTIME);
  const nextHash = keccak256(FLASH_ARB_LOGIC_V2_RUNTIME);
  const receipt = await confirmed(await walletClient.writeContract({
    address: contract, abi: FLASH_ARB_PROXY_ABI, functionName: 'upgradeRelease', account: owner,
    args: [FLASH_ARB_LOGIC_V2_BYTECODE, implementationHash, nextHash],
  }));
  const current = await slotAddress(implementationSlot);
  assert.notEqual(current, previous);
  assert.equal(await publicClient.getCode({ address: current }), FLASH_ARB_LOGIC_V2_RUNTIME);
  assert.equal(await publicClient.getCode({ address: contract }), FLASH_ARB_PROXY_RUNTIME);
  assert.equal(await slotAddress(adminSlot), owner.address);
  assert.equal((parseEventLogs({ abi: FLASH_ARB_PROXY_ABI, eventName: 'Upgraded', logs: receipt.logs }))[0]?.args.implementation, current);
  assert.equal(await publicClient.readContract({ address: contract, abi: FLASH_ARB_V3_ABI, functionName: 'owner' }), owner.address);

  const order = { funding: 0, token: ADDR.usdc, buy: toNextVenue(curve), sell: toNextVenue(sushiV2),
    amountIn: parseEther('0.1'), minProfit: 1n, tip: 0n, maxBlock: (await publicClient.getBlockNumber({ cacheTime: 0 })) + 2n };
  const execute = { address: contract, abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned', account: owner.address } as const;
  await assert.rejects(publicClient.simulateContract({ ...execute, args: [implementationHash, encodeOrder(order)] }), /WrongImplementation/);
  await assert.rejects(publicClient.simulateContract({ ...execute, args: [nextHash, encodeOrder(order)] }), /curve requires lender/);
  await assert.rejects(publicClient.simulateContract({
    ...execute, args: [nextHash, encodeOrder({ ...order, funding: 4, buy: { ...order.buy, pool: sushiV2.address } })],
  }), /curve pool/);

  implementationHash = nextHash;
  console.log('✓ Curve upgrade preserved proxy address, owner, admin and blocked unapproved pools and self-funding');
}

function orderData(order: Parameters<typeof encodeOrder>[0]) {
  const data = encodeOrder(order);
  return useProxy ? encodeFunctionData({
    abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned', args: [implementationHash, data],
  }) : data;
}

function encodeOrder(order: {
  funding: number; token: Address; buy: ReturnType<typeof toNextVenue>; sell: ReturnType<typeof toNextVenue>;
  amountIn: bigint; minProfit: bigint; tip: bigint; maxBlock: bigint;
}) {
  return encodeFunctionData({ abi: FLASH_ARB_V3_ABI, functionName: 'execute', args: [order] });
}

async function balanceOf(token: Address, account: Address) {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
}

async function buyFixtureTokens(router: Address, amount: bigint) {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  await confirmed(await walletClient.writeContract({ account: fixture, address: router, abi: fixtureRouterAbi, functionName: 'swapExactETHForTokens', gas: 1_000_000n, value: amount,
    args: [1n, [ADDR.weth, ADDR.usdc], fixture.address, block.timestamp + 600n],
  }));
}

async function sellFixtureTokensOnSushi() {
  const amount = await balanceOf(ADDR.usdc, fixture.address);
  assert.ok(amount > 0n);
  await confirmed(await walletClient.writeContract({ account: fixture, address: ADDR.usdc, abi: erc20Abi, functionName: 'approve', args: [sushiV2Router, amount] }));
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  await confirmed(await walletClient.writeContract({ account: fixture, address: sushiV2Router, abi: fixtureRouterAbi, functionName: 'swapExactTokensForETH', gas: 1_000_000n,
    args: [amount, 1n, [ADDR.usdc, ADDR.weth], fixture.address, block.timestamp + 600n],
  }));
}

type DirectTestMode = 'gas-only' | 'private-gas-only' | 'public-functional' | 'break-even' | 'private-profit' | 'premium';

async function sendWithSearcher(buy: ArbPool, sell: ArbPool, amount: bigint, profit: bigint, funding: RouteFunding, mode?: DirectTestMode) {
  const privateGasOnly = mode === 'private-gas-only';
  const publicFunctional = mode === 'public-functional';
  const gasOnly = mode === 'gas-only' || privateGasOnly || publicFunctional;
  const breakEven = mode === 'break-even';
  const privateProfit = mode === 'private-profit';
  const requireGasCoverage = breakEven || privateProfit;
  const privateSubmission = requireGasCoverage || privateGasOnly;
  const minimumNetUsd = privateProfit ? 0.04 : undefined;
  const oneShot = gasOnly || requireGasCoverage;
  const premium = mode === 'premium';
  const saved = { submission: MEV.submission, directMinNetUsd: MEV.directMinNetUsd,
    directMaxGasUsd: MEV.directMaxGasUsd, directDailyGasUsd: MEV.directDailyGasUsd, directPremiumMaxGasUsd: MEV.directPremiumMaxGasUsd };
  const maximumTestGasUsd = privateProfit ? 10 : publicFunctional ? 5 : 1.5;
  Object.assign(MEV, {
    submission: 'direct', directMinNetUsd: privateProfit ? 0.05 : breakEven ? 2_000 : 0.01,
    directMaxGasUsd: gasOnly || premium || privateProfit ? 1.5 : 100,
    directDailyGasUsd: gasOnly || premium || privateProfit ? 4 : 100, directPremiumMaxGasUsd: premium ? 20 : 0,
  });
  const ethUsd = premium ? 4_000 : 2_000;
  const logs: string[] = [];
  const searcher = new MevSearcher({
    account: owner, exec: new LiveExecutor(owner), ethUsd: () => ethUsd, tradePending: () => false,
    baseFeeGwei: () => null, tokens: () => [], log: (message) => { logs.push(message); },
  });
  const previousDirectGas = searcher.file.directGas;
  try {
    searcher.file.proxyContract = contract;
    searcher.file.proxyImplementation = await slotAddress(implementationSlot);
    searcher.file.proxyRelease = implementationHash;
    searcher.arm();
    const verifiedBy = Date.now() + 30_000;
    while (searcher.view().mode === 'arming' && Date.now() < verifiedBy) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    const initial = searcher.view();
    assert.equal(initial.mode, 'live', logs.join(' | '));
    const { bundles, directAttempts = 0, directLanded = 0 } = initial.stats;
    const initialGasUsd = initial.settings.direct.spentGasUsd;
    const head = await searcher['head']();
    // Model a substantially higher base fee without changing other fixtures' fork state.
    const quoteBaseFee = privateProfit ? parseGwei('4') : nextBaseFee(head);
    const point = { blockNumber: head.number, timestamp: Number(head.timestamp), nextBaseFee: quoteBaseFee,
      hash: head.hash, tokens: [market], at: [], results: [], readMs: 0, failedChunks: 0 };
    const sizeEth = Number(amount) / 1e18;
    const grossEth = Number(profit) / 1e18;
    const opp: MevOpp = { t: Date.now(), block: Number(head.number), symbol: 'USDC', buy: buy.venue, sell: sell.venue,
      sizeEth, grossEth, gasEth: 0, tipEth: 0, netEth: grossEth, netUsd: grossEth * ethUsd, status: 'would send' };
    const offer = { candidate: { t: market, A: buy, B: sell, dx: sizeEth, est: grossEth, estimatedNet: grossEth, gasUnits: 0 },
      amount, profit, funding, score: profit, opp };
    const policy = searcher['profitPolicy'](Date.now());
    const testId = mode ? `${mode}-fixture` : 'regular-fixture';
    if (gasOnly) {
      assert.equal(await searcher['prepareLive'](offer, point, policy), null,
        'the ordinary trading policy must reject the gas-only fixture');
      assert.throws(() => searcher.queueGasOnlyTest(testId, maximumTestGasUsd + 0.01, false, privateGasOnly, publicFunctional), /gas cap/);
      searcher.queueGasOnlyTest('uncovered-gas-test', Math.min(maximumTestGasUsd, 1.5), true);
      const uncovered = searcher['queuedTest'];
      assert.ok(uncovered);
      assert.equal(await searcher['prepareLive'](offer, point, policy, uncovered), null);
      assert.equal(opp.note, 'test payout does not cover padded gas');
      assert.equal(searcher.view().stats.directAttempts, directAttempts);
      uncovered.expiresAt = Date.now() - 1;
      searcher.queueGasOnlyTest('low-budget-test', 0.001, false, privateGasOnly, publicFunctional);
      const lowBudget = searcher['queuedTest'];
      assert.ok(lowBudget);
      assert.equal(await searcher['prepareLive'](offer, point, policy, lowBudget), null,
        'a test must reject even a valid route when its padded gas quote exceeds the one-shot budget');
      lowBudget.expiresAt = Date.now() - 1;
      assert.equal(searcher.view().gasOnlyTest?.status, 'expired');
      searcher.queueGasOnlyTest(testId, maximumTestGasUsd, false, privateGasOnly, publicFunctional);
      assert.equal(searcher.view().gasOnlyTest?.id, testId);
      assert.equal(searcher.view().gasOnlyTest?.status, 'queued');
    }
    if (breakEven) {
      assert.equal(await searcher['prepareLive'](offer, point, policy), null,
        'the ordinary profit floor remains in effect for normal orders');
      searcher.queueGasOnlyTest(testId, maximumTestGasUsd, true, true);
    }
    if (privateProfit) {
      assert.equal(await searcher['prepareLive'](offer, point, policy), null, 'ordinary trades retain their $1.50 gas ceiling');
      assert.throws(() => searcher.queueGasOnlyTest(testId, 10.01, true, true, false, minimumNetUsd), /gas cap/);
      assert.throws(() => searcher.queueGasOnlyTest(testId, 10, false, true, false, minimumNetUsd), /minimum net profit/i);
      searcher.queueGasOnlyTest(testId, 10, true, true, false, minimumNetUsd);
      assert.equal(searcher['queuedTest']?.minimumNetUsd, 0.05);
    }
    const prepared = await searcher['prepareLive'](offer, point, policy, oneShot ? searcher['queuedTest'] ?? undefined : undefined);
    assert.ok(prepared, opp.note);
    if (premium) {
      assert.equal(prepared.premium, true);
      assert.ok(prepared.fees.maxPriorityFeePerGas > BigInt(Math.round(MEV.directMaxPriorityGwei * 1e9)));
      assert.ok(prepared.minimumProfit >= 2n * prepared.gasBudget);
      assert.ok(prepared.minimumProfit - prepared.gasBudget >= parseEther('0.00125'));
      assert.ok(Number(prepared.gasBudget) * ethUsd / 1e18 <= MEV.directPremiumMaxGasUsd);
    }
    if (oneShot) {
      const pinned = decodeFunctionData({ abi: FLASH_ARB_PROXY_ABI, data: prepared.data });
      assert.equal(pinned.functionName, 'executePinned');
      assert.equal(pinned.args[0], implementationHash);
      const execution = decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: pinned.args[1] });
      assert.equal(execution.functionName, 'execute');
      const minimumProfit = privateProfit ? prepared.gasBudget + parseEther('0.000025') : breakEven ? prepared.gasBudget : 1n;
      assert.equal(execution.args[0].minProfit, minimumProfit, 'the contract must enforce the approved minimum payout');
      assert.equal(execution.args[0].tip, 0n);
      assert.equal(execution.args[0].funding, funding);
      if (privateProfit) {
        assert.equal(prepared.privateSubmission, true);
        assert.equal(execution.args[0].maxBlock, prepared.target);
        assert.ok([head.number + 2n, head.number + 5n].includes(prepared.target), 'profit test has a bounded private window');
        assert.ok(Number(prepared.gasBudget) / 1e18 * ethUsd > 1.5, 'the approved test can exceed the ordinary gas ceiling');
      } else {
        assert.equal(execution.args[0].maxBlock, head.number + (publicFunctional ? 8n : privateGasOnly ? 5n : breakEven ? 2n : 1n));
      }
      if (breakEven) {
        assert.equal(prepared.privateSubmission, true);
        assert.ok(profit - prepared.minimumProfit >= (profit + 9n) / 10n);
        const growth = point.nextBaseFee / 8n;
        assert.equal(prepared.fees.maxFeePerGas - prepared.fees.maxPriorityFeePerGas,
          point.nextBaseFee + (growth > 0n ? growth : 1n), 'private bid must cover both eligible blocks');
      }
      assert.ok(Number(prepared.gasBudget) / 1e18 * ethUsd <= maximumTestGasUsd);
    }
    await searcher['sendLive'](prepared, point, searcher['armGeneration']);
    const submitted = searcher.view();
    assert.ok(submitted.pending?.hash, opp.note);
    assert.equal(submitted.recent[0]?.submission?.kind, 'direct');
    assert.deepEqual(submitted.recent[0]?.submission?.builders, []);
    assert.equal(submitted.stats.bundles, bundles);
    assert.equal(submitted.stats.directAttempts, directAttempts + 1);
    if (oneShot) {
      assert.equal(submitted.recent[0]?.submission?.privateSubmission ?? false, privateSubmission);
      assert.equal(submitted.gasOnlyTest?.status, 'submitted');
      assert.equal(submitted.gasOnlyTest?.hash, submitted.pending.hash);
    }
    assert.ok(logs.some((line) => line.includes('Direct transaction') && line.includes('submitted.')), logs.join(' | '));

    const receipt = await confirmed(submitted.pending.hash);
    await searcher.reconcileWallet(receipt.blockNumber);
    const settled = searcher.view();
    assert.equal(settled.pending, null);
    assert.equal(settled.stats.directLanded, directLanded + 1);
    assert.equal(settled.recent[0]?.status, 'landed');
    assert.equal(settled.recent[0]?.hash, receipt.transactionHash);
    assert.equal(settled.recent[0]?.tipEth, 0);
    const gasUsd = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18 * ethUsd;
    assert.ok(Math.abs(settled.settings.direct.spentGasUsd - initialGasUsd - gasUsd) < 1e-9);
    const netUsd = settled.recent[0]?.netUsd ?? 0;
    if (gasOnly) {
      assert.ok(netUsd < 0 && netUsd >= -gasUsd, 'the completed test can lose at most its actual gas cost');
    } else {
      assert.ok(netUsd > 0, 'settled direct route covered actual gas');
    }
    if (oneShot) {
      if (privateProfit) assert.ok(netUsd >= 0.05, 'settled private test retained the ordinary net profit floor');
      assert.equal(settled.gasOnlyTest?.status, 'landed');
      assert.equal(settled.gasOnlyTest?.hash, receipt.transactionHash);
      const sent = await publicClient.getTransaction({ hash: receipt.transactionHash });
      assert.equal(sent.value, 0n, 'test attaches no funds to the call');
      assert.ok(gasUsd <= maximumTestGasUsd);

      const next = await searcher['head']();
      const nextPoint = { ...point, blockNumber: next.number, timestamp: Number(next.timestamp), hash: next.hash };
      const retry = { ...prepared, offer: { ...offer, opp: { ...opp, hash: undefined, submission: undefined } } };
      await searcher['sendLive'](retry, nextPoint, searcher['armGeneration']);
      assert.equal(searcher.view().pending, null);
      assert.equal(searcher.view().stats.directAttempts, directAttempts + 1,
        'a consumed test cannot submit on the next head');
      const restarted = new MevSearcher(searcher['host']);
      restarted.queueGasOnlyTest(testId, maximumTestGasUsd, requireGasCoverage, privateSubmission, publicFunctional, minimumNetUsd);
      assert.equal(restarted.view().gasOnlyTest?.status, 'landed');
      assert.equal(restarted.view().gasOnlyTest?.hash, receipt.transactionHash,
        'replaying the same test ID after restart must leave the settled receipt in place');
    }
    return receipt.transactionHash;
  } finally {
    // The enclosing fixture will revert the local transaction and its gas charge.
    if (privateProfit) searcher.file.directGas = previousDirectGas;
    searcher.stop();
    Object.assign(MEV, saved);
  }
}

async function testRoute(label: string, buy: ArbPool, sell: ArbPool, funding: RouteFunding, direct: boolean | DirectTestMode = false) {
  const point = await fork.snapshot();
  try {
    if (direct === 'public-functional') await fork.mine({ blocks: 2 });
    const maxBlock = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 3n;
    const prepare = { funding, token: ADDR.usdc, buy: toNextVenue(buy), sell: toNextVenue(sell), minProfit: 1n, tip: useV3 ? 0n : 1n, maxBlock };
    let profitable: { args: typeof prepare & { amountIn: bigint }; profit: bigint } | undefined;
    const errors: string[] = [];
    const gasOnly = direct === 'gas-only' || direct === 'private-gas-only' || direct === 'public-functional';
    const sizes = gasOnly ? ['0.0000001', '0.000001', '0.00001'] : ['0.5', '0.15', '0.05', '1'];
    for (const size of sizes) {
      const amountIn = parseEther(size);
      const args = { ...prepare, amountIn };
      try {
        const simulated = useProxy ? await publicClient.simulateContract({
          address: contract, abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned', account: owner.address,
          args: [implementationHash, encodeOrder(args)],
        }) : await publicClient.simulateContract({
          address: contract, abi: FLASH_ARB_V2_ABI, functionName: 'execute', account: owner.address, args: [args],
        });
        if (simulated.result > (gasOnly ? 0n : parseEther('0.002'))) {
          profitable = { args, profit: simulated.result };
          break;
        }
      } catch (error) {
        errors.push((error as { shortMessage?: string }).shortMessage ?? (error as Error).message);
      }
    }
    assert.ok(profitable, `${label} must simulate a profit: ${errors.join(' | ')}`);
    const order = { ...profitable.args, minProfit: profitable.profit };
    const ethBefore = await publicClient.getBalance({ address: owner.address });
    const custody = funding === 3 ? lenders[3] : funding === 4 ? sparkWeth : null;
    const custodyBalance = custody ? await balanceOf(ADDR.weth, custody) : 0n;
    let hash: Hex;
    if (direct) {
      hash = await sendWithSearcher(buy, sell, order.amountIn, profitable.profit, funding, typeof direct === 'string' ? direct : undefined);
    } else if (useV3) {
      const fees = await publicClient.estimateFeesPerGas();
      const nonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: 'pending' });
      const signed = await owner.signTransaction({
        type: 'eip1559', chainId: mainnet.id, to: contract!, nonce, gas: 3_000_000n,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        data: orderData(order),
      });
      hash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
    } else {
      hash = await walletClient.writeContract({ account: owner, address: contract!, abi: FLASH_ARB_V2_ABI, functionName: 'execute', args: [order], gas: 3_000_000n });
    }
    const receipt = await confirmed(hash);
    const [payout] = parseEventLogs({ abi: FLASH_ARB_V2_ABI, eventName: 'Arbitrage', logs: receipt.logs });
    assert.ok(payout, `${label} emitted payout receipt`);
    assert.equal(payout.args.profit, profitable.profit, `${label} simulation matched settlement`);
    if (funding > 0) {
      const [funded] = parseEventLogs({ abi: FLASH_ARB_V2_ABI, eventName: 'FundedBy', logs: receipt.logs });
      assert.ok(funded);
      assert.equal(funded.args.funding, funding);
      assert.equal(funded.args.premium > 0n, funding === 1, 'the tested reserve premiums match the protocol at this block');
      assert.equal(await publicClient.readContract({ address: ADDR.weth, abi: erc20Abi, functionName: 'allowance', args: [contract!, lenders[funding]] }), 0n, 'flash lender left no usable allowance');
      if (custody) assert.equal(await balanceOf(ADDR.weth, custody), custodyBalance, 'flash principal returned in full');
    }
    if (buy.curve || sell.curve) {
      for (const [token, pool] of [[ADDR.weth, buy], [ADDR.usdc, sell]] as const) {
        if (pool.curve) assert.equal(await publicClient.readContract({
          address: token, abi: erc20Abi, functionName: 'allowance', args: [contract!, pool.address],
        }), 0n, 'Curve exchange leaves no usable allowance');
      }
    }
    const expected = payout.args.profit - payout.args.tip - receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await publicClient.getBalance({ address: owner.address });
    if (gasOnly) {
      assert.ok(expected < 0n, 'the fork fixture should exercise a trade with a gas-only loss');
      assert.ok(expected >= -(receipt.gasUsed * receipt.effectiveGasPrice));
    } else {
      assert.ok(expected > 0n, `${label} covers even test gas and builder payment`);
    }
    assert.equal(ethAfter - ethBefore, expected, `${label} accrued exact proceeds to the deploying wallet`);
    assert.equal(await publicClient.getBalance({ address: contract! }), 0n);
    assert.equal(await balanceOf(ADDR.weth, contract!), 0n);
    assert.equal(await balanceOf(ADDR.usdc, contract!), 0n);
    console.log(`✓ ${label}: exact wallet payout and no contract balance after settlement`);
  } finally {
    await fork.revert({ id: point });
  }
}

// Ordinary swaps funded entirely by Anvil create price fixtures only on the guarded local fork.
const baseline = await fork.snapshot();
await buyFixtureTokens(sushiV2Router, parseEther('18'));
console.log('✓ fork-local Sushi v2 buy fixture prepared');
await testRoute('Pancake v3 buy-pool flash swap', pancake500, sushiV2, 0);
await testRoute('native ETH v4 flash settlement', v4Native500, sushiV2, 0, useProxy ? 'break-even' : false);
if (useProxy) {
  await testRoute('Private flash swap with a $10 gas cap and $0.05 net floor', v4Native500, sushiV2, 0, 'private-profit');
  await testRoute('Private pool flash swap under the approved gas cap', v4Native500, sushiV2, 0, 'private-gas-only');
  await testRoute('Public functional flash swap with stable prices and a $5 gas cap', v4Native500, sushiV2, 0, 'public-functional');
}
await testRoute('WETH v4 flash settlement', v4Weth500, sushiV2, 0);
await testRoute('Aave v3 funding with native ETH v4', v4Native500, sushiV2, 1);
await testRoute('Morpho Blue funding with WETH v4', v4Weth500, sushiV2, 2);
if (useV3) await testRoute('Balancer V3 funding with WETH v4', v4Weth500, sushiV2, 3);
await fork.revert({ id: baseline });

if (useProxy) {
  await verifyUpgrade();
  const beforeSpark = await fork.snapshot();
  await buyFixtureTokens(sushiV2Router, parseEther('18'));
  await testRoute('SparkLend funding after the proxy upgrade', v4Weth500, sushiV2, 4);
  if (pancakeV2) await testRoute('Pancake v2 buy-pool flash swap after upgrade', pancakeV2, sushiV2, 0);
  await fork.revert({ id: beforeSpark });
  if (curve) {
    await verifyCurveUpgrade(curve);
    const beforeCurve = await fork.snapshot();
    await buyFixtureTokens(sushiV2Router, parseEther('18'));
    await testRoute('Curve Tricrypto buy with SparkLend through the premium direct searcher', curve, sushiV2, 4, 'premium');
    await testRoute('One-shot direct SparkLend test under the gas cap', curve, sushiV2, 4, 'gas-only');
    await fork.revert({ id: beforeCurve });
  }
}
await buyFixtureTokens(uniswapV2Router, parseEther('30'));
await sellFixtureTokensOnSushi();
console.log('✓ fork-local Sushi v2 sell fixture prepared');
await testRoute('Pancake v3 callback on the sell leg', sushiV2, pancake500, 0);
if (pancakeV2) await testRoute('Pancake v2 settlement on the sell leg', sushiV2, pancakeV2, 0);
if (curve) await testRoute('Curve Tricrypto sell with Sushi flash-swap funding', sushiV2, curve, 0);
await testRoute('native ETH v4 settlement on the sell leg', sushiV2, v4Native500, 0);
console.log(useProxy ? 'ALL FLASHARB PROXY FORK TESTS PASSED'
  : useV3 ? 'ALL FLASHARB V3 DIRECT RPC FORK TESTS PASSED' : 'ALL FLASHARB V2 FORK TESTS PASSED');
