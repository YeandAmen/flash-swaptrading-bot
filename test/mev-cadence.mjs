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
  const { MEV } = await import('../dist/config.js');
  const { FLASH_ARB_V3_ABI } = await import('../dist/mev/artifact-v3.js');
  const { MevSearcher } = await import('../dist/mev/searcher.js');
  const { routeInputSizes } = await import('../dist/mev/sizing.js');
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

  const testId = 'cadence-gas-test';
  async function scan({ age, profit, finalProfit = coversGas, paper = false, staleHead = false, historical = false,
    maximumTestGasUsd }) {
    const simulated = new Set();
    const signed = [];
    const submitted = [];
    const seenAtSign = [];
    const searcher = newSearcher(async (tx) => {
      signed.push(tx);
      seenAtSign.push(...simulated);
      return '0xc0';
    });
    searcher.file.stats.directScanStartedAt = now - age;
    searcher.file.armedAt = paper ? null : now - age;
    searcher.file.armed = !paper;
    searcher.contractReady = !paper;
    searcher.file.v2Contract = address(2);
    searcher.reconcileWallet = async () => {};
    searcher.writeState = () => {};
    searcher.head = async () => ({ number: staleHead ? 101n : 100n, hash: hash(staleHead ? 101 : 100) });
    searcher.submitSignedDirect = async (pending) => { submitted.push(pending); };
    searcher.simulate = async (token, _buy, _sell, amount, _maxBlock, blockNumber) => {
      assert.equal(blockNumber, 100n);
      assert.ok(amount <= 500n * oneEth, 'every simulated amount stays under the $1m WETH cap');
      simulated.add(token.token.symbol);
      return { ok: true, profit: typeof profit === 'function' ? profit(token.token.symbol) : profit };
    };
    mevReadClient.getFeeHistory = async () => ({ reward: [[100_000_000n]] });
    mevReadClient.estimateGas = async ({ blockNumber }) => {
      assert.equal(blockNumber, 100n);
      return 150_000n;
    };
    mevReadClient.call = async ({ blockNumber }) => {
      assert.equal(blockNumber, 100n);
      return { data: hash(finalProfit) };
    };
    mevReadClient.getBalance = async () => oneEth;

    const previousFunding = MEV.funding;
    try {
      if (maximumTestGasUsd !== undefined) {
        MEV.funding = 'aave';
        searcher.file.proxyContract = address(2);
        searcher.queueGasOnlyTest(testId, maximumTestGasUsd);
      }
      await searcher.onBlock(snapshot(now), historical);
      return { simulated, signed, submitted, seenAtSign, test: searcher.view().gasOnlyTest };
    } finally {
      MEV.funding = previousFunding;
    }
  }

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
  assert.ok(fresh.seenAtSign.length <= baseLimit, 'an executable first-wave route should not wait on scan expansion');

  const late = await scan({
    age: 31 * minute,
    profit: (symbol) => ['TEST0', 'TEST1', 'TEST2'].includes(symbol) ? underGas : coversGas,
  });
  assert.equal(late.signed.length, 1, 'a qualifying route in the additional wave is submitted once');
  assert.equal(late.submitted.length, 1);

  const changedProfit = await scan({ age: 31 * minute, profit: coversGas, finalProfit: underGas });
  assert.equal(changedProfit.signed.length, 0, 'the final simulation must still cover gas and minimum profit');
  assert.equal(changedProfit.submitted.length, 0);

  const stale = await scan({ age: 31 * minute, profit: coversGas, staleHead: true });
  assert.equal(stale.signed.length, 0, 'a newer block invalidates the old live candidate');
  assert.equal(stale.submitted.length, 0);

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

  console.log('PASS: direct cadence, loan cap, extra routes, profit and freshness gates, and confirmed-fill persistence');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
