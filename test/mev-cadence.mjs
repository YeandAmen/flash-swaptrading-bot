// Run with node test/mev-cadence.mjs after npm run build.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData } from 'viem';

const temporary = mkdtempSync(join(tmpdir(), 'eth-mev-cadence-'));
const loopback = 'http://127.0.0.1:18647';
Object.assign(process.env, {
  ALLOW_LIVE_TRADING: 'off',
  FORK_MODE: '1',
  DATA_DIR: temporary,
  WALLET_KEY_FILE: join(temporary, 'disposable-wallet.json'),
  RPC_URL: loopback,
  SEND_RPC_URL: loopback,
  MEV: 'on',
  MEV_SUBMISSION: 'direct',
  MEV_FUNDING: 'pool',
  MEV_DIRECT_MAX_GAS_USD: '10',
  MEV_DIRECT_DAILY_GAS_USD: '25',
  MEV_DIRECT_MIN_NET_USD: '0.05',
  MEV_DIRECT_MAX_PRIORITY_GWEI: '0.25',
  MEV_MAX_SIMS_PER_BLOCK: '3',
  MEV_DIRECT_CADENCE_MAX_ROUTES: '8',
  MEV_MAX_LOAN_USD: '1000000',
});

const minute = 60_000;
const baseLimit = 3;
const maxLimit = 8;
const oneEth = 10n ** 18n;
const underGas = 1_000_000_000_000n;
const coversGas = 5_000_000_000_000_000n;
const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
const address = (n) => '0x' + n.toString(16).padStart(40, '0');

function snapshot(now) {
  const tokens = [];
  const at = [];
  const results = [];
  for (let i = 0; i < maxLimit; i++) {
    tokens.push({
      token: { symbol: 'TEST' + i, address: address(100 + i), decimals: 18, core: true },
      wethIs0: true,
      pools: [
        { address: address(200 + i), kind: 0, venue: 'Uniswap v2', v2: true, fee: 0.003 },
        { address: address(300 + i), kind: 1, venue: 'SushiSwap', v2: true, fee: 0.003 },
      ],
    });
    at.push([results.length, results.length + 1]);
    results.push(
      { status: 'success', result: [100n * oneEth, (120n - BigInt(i)) * oneEth, 0] },
      { status: 'success', result: [100n * oneEth, 100n * oneEth, 0] },
    );
  }
  return {
    blockNumber: 100n, timestamp: Math.floor(now / 1000), nextBaseFee: 1_000_000_000n,
    hash: hash(100), tokens, at, results, readMs: 0, failedChunks: 0,
  };
}

try {
  const { directCadence, extraRoutes, loanLimitWei } = await import('../dist/mev/cadence.js');
  const { mevReadClient } = await import('../dist/chain.js');
  const { CONFIG, MEV } = await import('../dist/config.js');
  const { FLASH_ARB_V3_ABI } = await import('../dist/mev/artifact-v3.js');
  const { proxyReleaseHash } = await import('../dist/mev/proxy.js');
  const { FLASH_ARB_LOGIC_V3_ABI } = await import('../dist/mev/artifact-logic-v3.js');
  const { fundingTrials } = await import('../dist/mev/flash-arb.js');
  const { MevSearcher } = await import('../dist/mev/searcher.js');
  const { rankRouteNet, routeInputSizes } = await import('../dist/mev/sizing.js');
  const now = Date.now();
  const cadence = (age, active = true) => directCadence(now, now - age, baseLimit, maxLimit, active);

  assert.equal(directCadence(now, null, baseLimit, maxLimit, true).elapsedMs, null);
  assert.equal(cadence(25 * minute - 1_000).state, 'scanning');
  assert.equal(cadence(25 * minute - 1_000).routeLimit, baseLimit);
  assert.equal(cadence(25 * minute).state, 'expanded');
  assert.equal(cadence(25 * minute).routeLimit, maxLimit);
  assert.equal(cadence(30 * minute - 1).state, 'expanded');
  assert.equal(cadence(30 * minute).state, 'overdue');
  assert.equal(cadence(30 * minute).routeLimit, maxLimit);
  assert.equal(cadence(30 * minute, false).state, 'paper');
  assert.equal(cadence(30 * minute, false).routeLimit, maxLimit);
  assert.equal(loanLimitWei(1_000_000, 2_000), 500n * oneEth);
  assert.equal(loanLimitWei(1_000_000, null), null);
  const loanCap = loanLimitWei(1_000_000, 2_000);
  const cappedSizes = routeInputSizes(1_200, true, 510n * oneEth, loanCap, true);
  assert.ok(cappedSizes.includes(loanCap));
  assert.ok(cappedSizes.every((size) => size <= loanCap));
  assert.ok(routeInputSizes(10, true, undefined, loanCap, true).length
    > routeInputSizes(10, true, undefined, loanCap).length);
  const sample = { at: now, modelProfitEth: 0.004, modelAmountEth: 10, proceedsEth: 0.001, gasUnits: 270_000 };
  const net = (amount, when, quote = sample) => rankRouteNet(0.004, amount, 200_000, 1e-9, quote, when);
  assert.ok(net(10, now + 12_000) < net(10, now, { ...sample, proceedsEth: 0.004 }));
  assert.equal(net(10, now + 100_000), net(20, now + 12_000),
    'stale samples and materially changed pool estimates both return to uncalibrated ranking');
  const prior = { amount: 7n * oneEth, funding: 2 };
  const sizes = routeInputSizes(10, true, prior.amount, loanCap);
  const adaptiveTrials = fundingTrials('auto', sizes, true, true, prior);
  assert.equal(adaptiveTrials.length, fundingTrials('auto', sizes, true, true).length);
  assert.ok(adaptiveTrials.some(({ amount, funding }) => amount === prior.amount && funding === prior.funding));
  assert.ok(fundingTrials('auto', cappedSizes, true, true, { amount: 510n * oneEth, funding: 2 })
    .every(({ amount }) => amount <= loanCap));

  const [primary, repeated, second, third] = ['a', 'a', 'b', 'c'].map((token) => ({ token }));
  assert.deepEqual(extraRoutes([primary, repeated, second, third], [primary], 2, (route) => route.token), [second, third]);
  assert.deepEqual(extraRoutes([primary, repeated, second, third], [primary], 3, (route) => route.token), [second, third, repeated]);

  function newSearcher(sign) {
    return new MevSearcher({
      account: { address: address(1), signTransaction: sign },
      ethUsd: () => 2_000,
      tradePending: () => false,
      exec: { bundleNonce: async () => 7, reserveForBundle: () => true, releaseBundle() {} },
      log() {},
    });
  }

  // A virtual v4 reserve can imply a large trade even when the manager holds only token dust.
  // Both pool states and the optional exit-specific balance are returned by the same pinned call.
  {
    const { buildStateReads, inventoryCanCoverV2Floor } = await import('../dist/mev/pools.js');
    const { mevPoolClient } = await import('../dist/chain.js');
    const { UNISWAP_V4_MANAGER } = await import('../dist/mev/next-pools.js');
    const searcher = newSearcher(() => assert.fail('Inventory checks must never submit'));
    const [subject, other] = snapshot(now).tokens;
    subject.pools[0] = { kind: 5, v2: false, address: UNISWAP_V4_MANAGER, venue: 'Uniswap v4 ETH', fee: 0.0001,
      v4: { id: hash(900), fee: 100, tickSpacing: 1, nativeEth: true, quoteIs0: true } };
    searcher.tokens = [subject, other];
    searcher.reads = buildStateReads(searcher.tokens);
    searcher.reconcileWallet = async () => {};
    searcher.scanShortlist = async () => false;
    const previous = mevPoolClient.multicall;
    const feeHistory = mevReadClient.getFeeHistory;
    let height = 100;
    let balance = 0n;
    let error;
    let calls;
    mevReadClient.getFeeHistory = async () => ({ reward: [[100_000_000n, 300_000_000n]] });
    mevPoolClient.multicall = async ({ contracts, blockNumber }) => {
      assert.equal(blockNumber, BigInt(height));
      const checked = contracts.some((call) => call.functionName === 'balanceOf');
      calls.push(checked);
      if (checked && error === 'aggregate') throw new Error('aggregate rejected');
      return contracts.map((call) => {
        let result;
        switch (call.functionName) {
          case 'getBlockNumber': result = blockNumber; break;
          case 'getCurrentBlockTimestamp': result = BigInt(Math.floor(now / 1000)); break;
          case 'getSlot0': result = [2n ** 96n, 0, 0, 100]; break;
          case 'getLiquidity': result = 100n * oneEth; break;
          case 'getReserves': result = [call.address === other.pools[0].address ? 100n * oneEth : 200n * oneEth, 100n * oneEth, 0]; break;
          case 'balanceOf':
            assert.equal(call.address, subject.token.address);
            assert.deepEqual(call.args, [UNISWAP_V4_MANAGER]);
            if (error === 'balance') return { status: 'failure' };
            result = balance;
            break;
          default: assert.fail('Unexpected snapshot call');
        }
        return { status: 'success', result };
      });
    };
    async function check(checked, pruned) {
      calls = [];
      const head = { number: BigInt(++height), timestamp: BigInt(Math.floor(now / 1000)), hash: hash(height),
        baseFeePerGas: 1_000_000_000n, gasUsed: 15_000_000n, gasLimit: 30_000_000n };
      const row = await searcher.read(head);
      await searcher.onBlock(row);
      assert.deepEqual(calls, checked);
      assert.equal(searcher.lastBlock.inventoryPruned, pruned);
      assert.equal(searcher.lastBlock.candidates, 2 - pruned, 'the unrelated V2-to-V2 route stays eligible');
    }
    try {
      await check([false], 0); // new route is considered immediately
      await check([true], 1); // the manager cannot deliver any token for the sale
      error = 'balance';
      await check([true], 0); // per-call failure must not reuse a previous zero balance
      error = 'aggregate';
      await check([true, false], 0); // recover original pool snapshot if optional read breaks its batch
      error = undefined;
      balance = oneEth / 10n;
      await check([true], 0); // smaller sizes can cover the floor after inventory is replenished
      const reserves = { status: 'success', result: [100n, 1_000n, 0] };
      assert.ok(inventoryCanCoverV2Floor(1n, reserves, false, 10n), 'keep equality at the optimistic upper bound');
      assert.ok(!inventoryCanCoverV2Floor(1n, reserves, true, 10n), 'use the token ordering supplied by the exit pair');
    } finally {
      mevPoolClient.multicall = previous;
      mevReadClient.getFeeHistory = feeHistory;
    }
  }

  const testId = 'cadence-gas-test';
  async function scan({ age, profit, finalProfit = coversGas, pendingProfit = finalProfit, pendingError = false,
    paper = false, staleHead = false, headChangesDuringSigning = false, historical = false, maximumTestGasUsd,
    submission = 'direct', maximumDirectGasUsd = MEV.directMaxGasUsd, nearingNextBlock = false, estimatedGas = 150_000n,
    protectedDirect = false, beforeSimulate, atSign, pendingForToken, pathRelease }) {
    const simulated = new Set();
    const signed = [];
    const submitted = [];
    const journaled = [];
    const seenAtSign = [];
    const finalStates = new Map();
    const block = snapshot(nearingNextBlock ? Math.floor(now / 1_000) * 1_000 - 11_000 : now);
    const searcher = newSearcher(async (tx) => {
      signed.push(tx);
      seenAtSign.push(...simulated);
      atSign?.(tx);
      return '0xc0';
    });
    searcher.file.stats.directScanStartedAt = now - age;
    searcher.file.armedAt = paper ? null : now - age;
    searcher.file.armed = !paper;
    searcher.contractReady = !paper;
    searcher.file.v2Contract = address(2);
    searcher.reconcileWallet = async () => {};
    searcher.writeState = () => { if (searcher.file.pending) journaled.push(searcher.file.pending); };
    searcher.head = async () => {
      const number = staleHead || (headChangesDuringSigning && signed.length) ? 101n : 100n;
      return { number, hash: hash(number), timestamp: BigInt(block.timestamp) };
    };
    if (pathRelease) {
      searcher.file.proxyContract = address(2);
      searcher.file.proxyRelease = pathRelease;
      searcher.pathPlanner.scan = async (input) => {
        assert.equal(input.blockHash, block.hash);
        const hops = [address(10), address(11), address(12)].map((tokenOut, i) => ({
          kind: 2, pool: address(40 + i), fee: 500, tickSpacing: 0, nativeEth: false, tokenOut,
        }));
        return { status: 'scanned', blockNumber: block.blockNumber, pools: 3, cycles: 1, exactQuotes: 1,
          candidates: [{ hops, amountIn: oneEth, amountOut: oneEth + coversGas, grossProfit: coversGas,
            estimatedNet: coversGas, label: 'WETH → A → B → WETH' }] };
      };
    }
    searcher.submitSignedDirect = async (pending) => { submitted.push(pending); };
    searcher.submitSignedBundle = async (pending) => { submitted.push(pending); };
    searcher.simulate = async (token, _buy, _sell, amount, _maxBlock, blockNumber) => {
      assert.equal(blockNumber, 100n);
      assert.ok(amount <= 500n * oneEth, 'every simulated amount stays under the $1m WETH cap');
      await beforeSimulate?.(token.token.symbol);
      simulated.add(token.token.symbol);
      return { ok: true, profit: typeof profit === 'function' ? profit(token.token.symbol) : profit };
    };
    mevReadClient.getFeeHistory = async ({ rewardPercentiles }) => {
      assert.deepEqual(rewardPercentiles, [50, 90]);
      return { reward: [[100_000_000n, 300_000_000n]] };
    };
    mevReadClient.estimateGas = async ({ blockNumber }) => {
      assert.equal(blockNumber, 100n);
      return estimatedGas;
    };
    mevReadClient.call = async ({ blockNumber, blockTag, to, data, gas }) => {
      const call = { to, data, gas };
      if (blockTag === 'pending') {
        assert.equal(blockNumber, undefined);
        finalStates.set('pending', call);
        if (pendingError) throw new Error('Pending state unavailable');
        if (pathRelease) {
          const decoded = decodeFunctionData({ abi: FLASH_ARB_LOGIC_V3_ABI, data });
          assert.equal(decoded.functionName, 'executePath');
          assert.equal(decoded.args[0], pathRelease);
          return { data: hash(pendingProfit) };
        }
        const order = decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data }).args[0];
        return { data: hash(pendingForToken ? pendingForToken(order.token) : pendingProfit) };
      }
      assert.equal(blockNumber, 100n);
      finalStates.set('pinned', call);
      return { data: hash(finalProfit) };
    };
    mevReadClient.getBalance = async () => oneEth;

    const original = { funding: MEV.funding, submission: MEV.submission, directMaxGasUsd: MEV.directMaxGasUsd, directProtected: MEV.directProtected };
    const originalConfig = { allowLiveTrading: CONFIG.allowLiveTrading, forkMode: CONFIG.forkMode };
    const originalNow = Date.now;
    try {
      if (nearingNextBlock) {
        // Exercise the real-time guard while every RPC and signer remains stubbed.
        CONFIG.allowLiveTrading = true;
        CONFIG.forkMode = false;
        Date.now = () => Math.floor(now / 1_000) * 1_000;
      }
      MEV.submission = submission;
      if (pathRelease) MEV.funding = 'morpho';
      MEV.directMaxGasUsd = maximumDirectGasUsd;
      MEV.directProtected = protectedDirect;
      if (maximumTestGasUsd !== undefined) {
        MEV.funding = 'aave';
        searcher.file.proxyContract = address(2);
        searcher.queueGasOnlyTest(testId, maximumTestGasUsd);
      }
      await searcher.onBlock(block, historical);
      return { simulated, signed, submitted, journaled, seenAtSign, finalStates, test: searcher.view().gasOnlyTest };
    } finally {
      Object.assign(MEV, original);
      Object.assign(CONFIG, originalConfig);
      Date.now = originalNow;
    }
  }

  const pathOptions = { age: 31 * minute, profit: underGas, finalProfit: coversGas, pendingProfit: coversGas, pathRelease: proxyReleaseHash };
  const pathRun = await scan(pathOptions);
  assert.equal(pathRun.signed.length, 1, 'the live loop can submit a qualified three-hop candidate');
  assert.equal(pathRun.submitted[0].opp.funding, 'Morpho Blue');
  assert.deepEqual(pathRun.finalStates.get('pending'), pathRun.finalStates.get('pinned'));
  assert.equal(decodeFunctionData({ abi: FLASH_ARB_LOGIC_V3_ABI, data: pathRun.signed[0].data }).functionName, 'executePath');
  assert.equal((await scan({ ...pathOptions, pathRelease: hash(18) })).signed.length, 0, 'old releases are observation only');
  assert.equal((await scan({ ...pathOptions, pendingProfit: 0n })).signed.length, 0, 'multi-hop pending state must cover costs');
  assert.equal((await scan({ ...pathOptions, staleHead: true })).signed.length, 0, 'multi-hop orders use the current head guard');

  const opening = await scan({ age: 24 * minute, profit: underGas });
  assert.equal(opening.simulated.size, baseLimit);
  assert.equal(opening.signed.length, 0);

  const negative = await scan({ age: 31 * minute, profit: underGas });
  assert.ok(negative.simulated.size > baseLimit, 'the overdue search should try additional routes');
  assert.equal(negative.signed.length, 0, 'a losing route cannot be signed to meet cadence');
  assert.equal(negative.submitted.length, 0);

  const fresh = await scan({ age: 31 * minute, profit: coversGas });
  assert.equal(fresh.signed.length, 1);
  assert.equal(fresh.submitted.length, 1);
  assert.equal(fresh.submitted[0].kind, 'direct');
  assert.equal(fresh.submitted[0].target, '101', 'direct execution only targets the next block');
  assert.equal(fresh.signed[0].maxPriorityFeePerGas, 250_000_000n, 'faster priority is clipped to the authorized tip cap');
  assert.equal(fresh.signed[0].maxFeePerGas, 1_250_000_000n, 'the signed fee only budgets for the next block');
  assert.equal(decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: fresh.signed[0].data }).args[0].maxBlock, 101n,
    'the signed contract deadline matches the journal target');
  assert.deepEqual([...fresh.finalStates.keys()].sort(), ['pending', 'pinned'], 'both states are checked before a direct send');
  assert.deepEqual(fresh.finalStates.get('pending'), fresh.finalStates.get('pinned'));
  assert.deepEqual(fresh.finalStates.get('pending'), {
    to: fresh.signed[0].to, data: fresh.signed[0].data, gas: fresh.signed[0].gas,
  }, 'both final checks use the exact transaction sent to the signer');
  assert.ok(fresh.seenAtSign.length <= baseLimit, 'an executable first-wave route should not wait on scan expansion');

  // A slow third route cannot block two exact ready offers. The first fails its pending-state
  // check, so the second must sign once before the unrelated simulation is released.
  const slow = Promise.withResolvers();
  const checked = [];
  const watchdog = setTimeout(slow.resolve, 1_000);
  try {
    const pipelined = await scan({
      age: 24 * minute, protectedDirect: true,
      profit: (symbol) => coversGas * BigInt(symbol === 'TEST1' ? 2 : 1),
      beforeSimulate: (symbol) => symbol === 'TEST2' ? slow.promise : undefined,
      pendingForToken: (token) => {
        checked.push(token.toLowerCase());
        return token.toLowerCase() === address(101) ? underGas : coversGas;
      },
      atSign: () => slow.resolve(),
    });
    assert.deepEqual(checked, [address(101), address(100)], 'choose the best ready exact offer and retry serially after its pending-state rejection');
    assert.ok(!pipelined.seenAtSign.includes('TEST2'), 'an unrelated unfinished quote must not hold the viable order until the RPC deadline');
    assert.equal(pipelined.signed.length, 1);
    assert.equal(pipelined.submitted.length, 1);
    assert.equal(pipelined.journaled.length, 1);
    assert.ok(pipelined.simulated.has('TEST2'), 'finish observing late evaluations without signing twice');
  } finally {
    clearTimeout(watchdog);
    slow.resolve();
  }

  // The round trip pays 170e12 wei. The former 170k-gas model at 1.1 gwei, even with a
  // 20% discount, requires 174.6e12 wei including the floor. Exact padded gas makes it executable.
  const affordableProceeds = 170_000_000_000_000n;
  const affordable = await scan({ age: 24 * minute, profit: affordableProceeds, finalProfit: affordableProceeds, estimatedGas: 90_000n });
  assert.equal(affordable.submitted.length, 1, 'a conservative estimate may reach the exact gas check at the minimum priority');
  assert.deepEqual([...affordable.finalStates.keys()].sort(), ['pending', 'pinned']);
  const affordableTx = affordable.signed[0];
  const order = decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: affordableTx.data }).args[0];
  assert.equal(affordableTx.gas, 112_500n, 'the final gas estimate retains 25% padding');
  assert.equal(order.minProfit, affordableTx.gas * affordableTx.maxFeePerGas + 25_000_000_000_000n);
  const moved = await scan({
    age: 24 * minute, profit: affordableProceeds, finalProfit: affordableProceeds, pendingProfit: underGas, estimatedGas: 90_000n,
  });
  assert.equal(moved.signed.length, 0, 'an admitted alternate must pass the same exact pending-state profit check');

  // At this payout only the next block can cover padded max-fee gas while reserving 10% and retaining $0.05.
  const oneBlockOnly = 250_000_000_000_000n;
  const protectedInput = { age: 24 * minute, profit: oneBlockOnly, finalProfit: oneBlockOnly, protectedDirect: true };
  const protectedTrade = await scan(protectedInput);
  assert.equal(protectedTrade.signed.length, 1);
  assert.equal(protectedTrade.submitted.length, 1);
  assert.equal(protectedTrade.journaled.length, 1);
  assert.equal(protectedTrade.submitted[0], protectedTrade.journaled[0]);
  assert.equal(protectedTrade.journaled[0].privateSubmission, true);
  assert.equal(protectedTrade.journaled[0].target, '101');
  const protectedTx = protectedTrade.signed[0];
  const protectedOrder = decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: protectedTx.data }).args[0];
  assert.equal(protectedOrder.maxBlock, 101n);
  assert.equal(protectedOrder.minProfit, protectedTx.gas * protectedTx.maxFeePerGas + 25_000_000_000_000n);
  assert.deepEqual([...protectedTrade.finalStates.keys()].sort(), ['pending', 'pinned']);
  assert.deepEqual(protectedTrade.finalStates.get('pending'), protectedTrade.finalStates.get('pinned'));
  const lostProtectedSpread = await scan({ ...protectedInput, pendingProfit: underGas });
  assert.ok(lostProtectedSpread.finalStates.has('pending'));
  assert.equal(lostProtectedSpread.signed.length, 0);
  assert.equal(lostProtectedSpread.journaled.length, 0);
  assert.equal(lostProtectedSpread.submitted.length, 0);

  // With 187,500 padded gas, 310e12 wei can pay the full 0.25 gwei tip only for one block.
  // A higher payout first allows the same tip for two blocks and then for all three.
  for (const [proceeds, target] of [[310_000_000_000_000n, 101n], [330_000_000_000_000n, 102n], [coversGas, 103n]]) {
    const ranked = await scan({ ...protectedInput, profit: proceeds, finalProfit: proceeds });
    assert.equal(ranked.signed.length, 1);
    assert.equal(ranked.submitted.length, 1);
    assert.equal(ranked.submitted[0].privateSubmission, true);
    assert.equal(ranked.submitted[0].target, target.toString(), 'keep the longest window that affords the selected tip');
    const transaction = ranked.signed[0];
    const signedOrder = decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: transaction.data }).args[0];
    assert.equal(transaction.maxPriorityFeePerGas, 250_000_000n);
    assert.equal(signedOrder.maxBlock, target);
    assert.equal(signedOrder.minProfit, transaction.gas * transaction.maxFeePerGas + 25_000_000_000_000n);
  }

  const late = await scan({
    age: 31 * minute,
    profit: (symbol) => ['TEST0', 'TEST1', 'TEST2'].includes(symbol) ? underGas : coversGas,
  });
  assert.equal(late.signed.length, 1, 'a qualifying route in the additional wave is submitted once');
  assert.equal(late.submitted.length, 1);

  const changedProfit = await scan({ age: 31 * minute, profit: coversGas, finalProfit: underGas });
  assert.equal(changedProfit.signed.length, 0, 'the final simulation must still cover gas and minimum profit');
  assert.equal(changedProfit.submitted.length, 0);

  const lostPendingProfit = await scan({ age: 31 * minute, profit: coversGas, pendingProfit: underGas });
  assert.ok(lostPendingProfit.finalStates.has('pending'));
  assert.equal(lostPendingProfit.signed.length, 0, 'the transaction is not signed if the pending state loses the spread');
  assert.equal(lostPendingProfit.journaled.length, 0);
  assert.equal(lostPendingProfit.submitted.length, 0);

  const failedPendingRead = await scan({ age: 31 * minute, profit: coversGas, pendingError: true });
  assert.ok(failedPendingRead.finalStates.has('pending'));
  assert.equal(failedPendingRead.signed.length, 0, 'a failed pending read cannot authorize a stale transaction');

  const stale = await scan({ age: 31 * minute, profit: coversGas, staleHead: true });
  assert.equal(stale.signed.length, 0, 'a newer block invalidates the old live candidate');
  assert.equal(stale.submitted.length, 0);

  const staleSignature = await scan({ age: 31 * minute, profit: coversGas, headChangesDuringSigning: true });
  assert.equal(staleSignature.signed.length, 1);
  assert.equal(staleSignature.journaled.length, 0, 'a signature from the old head does not reserve the wallet');
  assert.equal(staleSignature.submitted.length, 0, 'a new head invalidates a direct transaction before broadcast');

  const tooLateForTarget = await scan({ age: 31 * minute, profit: coversGas, nearingNextBlock: true });
  assert.equal(tooLateForTarget.signed.length, 0, 'a direct route needs a minimum lead before the next block');
  assert.equal(tooLateForTarget.journaled.length, 0);

  // At $2,000/ETH, the $0.43 ceiling allows at most 1.146666666 gwei for 187,500 padded gas.
  const standardPriority = await scan({ age: 31 * minute, profit: coversGas, maximumDirectGasUsd: 0.43 });
  assert.equal(standardPriority.submitted.length, 1);
  assert.equal(standardPriority.signed[0].maxPriorityFeePerGas, 146_666_666n);
  assert.equal(standardPriority.signed[0].maxFeePerGas, 1_146_666_666n);

  const thinProfit = 245_000_000_000_000n;
  const protectProfit = await scan({ age: 31 * minute, profit: thinProfit, finalProfit: thinProfit });
  assert.equal(protectProfit.submitted.length, 1);
  assert.equal(protectProfit.signed[0].maxPriorityFeePerGas, 42_666_666n,
    'priority is clipped to preserve both the modeled execution reserve and the configured profit floor');

  const directCapReached = await scan({ age: 31 * minute, profit: coversGas, maximumDirectGasUsd: 0.01 });
  assert.equal(directCapReached.signed.length, 0, 'next-block acceleration still honors the direct gas ceiling');
  assert.equal(directCapReached.submitted.length, 0);

  const bundle = await scan({ age: 24 * minute, profit: coversGas, pendingError: true, submission: 'bundle' });
  assert.equal(bundle.signed.length, 1);
  assert.equal(bundle.submitted.length, 1);
  assert.equal(bundle.submitted[0].kind, undefined);
  assert.equal(bundle.submitted[0].target, '101');
  assert.deepEqual([...bundle.finalStates.keys()], ['pinned'], 'bundle submission does not depend on public pending state');

  const paper = await scan({ age: 31 * minute, profit: coversGas, paper: true });
  assert.ok(paper.simulated.size > baseLimit);
  assert.equal(paper.signed.length, 0);
  assert.equal(paper.submitted.length, 0);

  const backfill = await scan({ age: 31 * minute, profit: coversGas, historical: true });
  assert.equal(backfill.simulated.size, 0, 'backfilled snapshots stop at ranking');
  assert.equal(backfill.signed.length, 0);
  assert.equal(backfill.submitted.length, 0);

  const allowedTest = await scan({ age: 24 * minute, profit: underGas, finalProfit: underGas, maximumTestGasUsd: 2 });
  assert.equal(allowedTest.signed.length, 1, 'the explicit one-shot path can sign a gross-positive route below its gas cost');
  assert.equal(allowedTest.submitted[0].opp.gasOnlyTestId, testId);
  assert.equal(allowedTest.test.status, 'submitted');
  assert.equal(decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: allowedTest.signed[0].data }).args[0].minProfit, 1n);

  const cappedTest = await scan({ age: 24 * minute, profit: underGas, finalProfit: underGas, maximumTestGasUsd: 0.01 });
  assert.equal(cappedTest.signed.length, 0);
  assert.equal(cappedTest.test.status, 'queued');

  const insufficientGross = await scan({ age: 24 * minute, profit: underGas, finalProfit: 0n, maximumTestGasUsd: 2 });
  assert.equal(insufficientGross.signed.length, 0, 'the final simulation must still repay and produce residual proceeds');
  assert.equal(insufficientGross.test.status, 'queued');

  const insufficientPendingGross = await scan({
    age: 24 * minute, profit: underGas, finalProfit: underGas, pendingProfit: 0n, maximumTestGasUsd: 2,
  });
  assert.equal(insufficientPendingGross.signed.length, 0, 'gas-only testing cannot skip pending repayment verification');
  assert.equal(insufficientPendingGross.test.status, 'queued');

  const ordinaryTest = await scan({ age: 24 * minute, profit: coversGas, maximumTestGasUsd: 2 });
  assert.equal(ordinaryTest.signed.length, 1);
  assert.equal(ordinaryTest.submitted[0].opp.gasOnlyTestId, testId);
  assert.equal(ordinaryTest.test.status, 'submitted');
  assert.ok(decodeFunctionData({ abi: FLASH_ARB_V3_ABI, data: ordinaryTest.signed[0].data }).args[0].minProfit > 1n,
    'a normal-level profit opportunity consumes the request without lowering its profit floor');

  const journal = newSearcher(async () => assert.fail('receipt settlement must not sign'));
  const previousFill = now - 31 * minute;
  journal.file.stats.lastDirectLandedAt = previousFill;
  function settle(nonce, kind, status, included) {
    const tx = hash(nonce);
    const opportunity = {
      t: now, block: 100, symbol: 'TEST', buy: 'Uniswap v2', sell: 'SushiSwap',
      sizeEth: 0.1, grossEth: 0, gasEth: 0, tipEth: 0, netEth: 0, netUsd: 0, status, hash: tx,
    };
    journal.file.pending = { kind, hash: tx, nonce, target: '102', contract: address(2), ethUsd: 2_000, opp: opportunity };
    journal.finishBundle(opportunity, included);
  }

  settle(8, 'direct', 'not included', false);
  assert.equal(journal.file.stats.lastDirectLandedAt, previousFill);
  settle(9, 'direct', 'failed', true);
  assert.equal(journal.file.stats.lastDirectLandedAt, previousFill);
  settle(10, undefined, 'landed', true);
  assert.equal(journal.file.stats.lastDirectLandedAt, previousFill);
  settle(11, 'direct', 'landed', true);
  assert.ok(journal.file.stats.lastDirectLandedAt >= now);
  const restarted = newSearcher(async () => assert.fail('journal recovery must not sign'));
  assert.equal(restarted.file.stats.lastDirectLandedAt, journal.file.stats.lastDirectLandedAt);

  console.log('PASS: direct cadence, next-block expiry, pending-state and pre-broadcast checks, gas limits, and confirmed-fill persistence');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
