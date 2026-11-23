import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BaseError, ContractFunctionExecutionError, decodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters,
  parseEther, zeroAddress, type Address, type Hex } from 'viem';
import { ARBITRUM_FLASH_ARB_LOGIC_V2_ABI } from './artifact-logic-v2.js';
import type { ArbPathQuote } from './paths.js';

process.env.RPC_URL ??= 'http://127.0.0.1:8545';
const { ArbitrumWorker } = await import('./worker.js');
const { arbitrumReleaseHash, arbitrumPinnedCall } = await import('./proxy.js');
const token = '0x0000000000000000000000000000000000000001';
const contract = '0x0000000000000000000000000000000000000002';
const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const middleToken = '0x0000000000000000000000000000000000000003';
const head = 100n;
const noRefinement = { tried: 0, quoted: 0, bestPayoutUsd: null, baselineBestPayoutUsd: null };
const quote: ArbPathQuote = { asset: token, symbol: 'USDC', decimals: 6, assetUsd: 1, amountIn: 50_000_000n,
  payout: 1_000_000n, payoutUsd: 1, loanUsd: 50, block: head, label: 'USDC cycle',
  legs: [
    { kind: 2, pool: '0x0000000000000000000000000000000000000011', tokenOut: weth, tickSpacing: 0 },
    { kind: 6, pool: '0x0000000000000000000000000000000000000012', tokenOut: middleToken, tickSpacing: 50 },
    { kind: 2, pool: '0x0000000000000000000000000000000000000013', tokenOut: token, tickSpacing: 0 },
  ] };

test('partial pool discovery preserves verified pools, includes new ones and retries after 30 seconds', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const usdce = '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8';
  const v3 = new Map([[100, token], [500, contract], [3000, '0x0000000000000000000000000000000000000003']]);
  const key = (fee: number) => keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),
    [zeroAddress, usdce, fee, 1, zeroAddress]));
  const stablePool = key(8), newStablePool = key(100);
  let block = 100n;
  const factoryBlocks: bigint[] = [];
  const worker = new ArbitrumWorker(async () => ({
    opportunities: [], best: null, pools: 0, paths: 0, quotedRoutes: 0, unavailableLegs: 0, refinement: noRefinement,
  }));
  const client = {
    getBlockNumber: async () => block,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'latestRoundData') return [1n, 2000n * 10n ** 8n, 0n, BigInt(Math.floor(Date.now() / 1000)), 1n];
      if (functionName === 'getConfiguration') return 1n << 56n | 1n << 63n;
      if (functionName === 'FLASHLOAN_PREMIUM_TOTAL' || functionName === 'balanceOf') return 0n;
      throw new Error('Unexpected read');
    },
    multicall: async ({ blockNumber, contracts }: { blockNumber: bigint; contracts: {
      address: Address; functionName: string; args?: readonly unknown[];
    }[] }) => {
      assert.equal(blockNumber, block);
      if (contracts[0]?.functionName === 'getPool') factoryBlocks.push(block);
      return contracts.map(({ address, functionName, args = [] }) => {
        const ok = (result: unknown) => ({ status: 'success', result });
        const missing = { status: 'failure', error: new Error('unavailable') };
        if (functionName === 'getPool') {
          const fee = Number(args[2]);
          if (args[1] !== usdc) return ok(zeroAddress);
          if (block === 101n && fee === 100) return missing;
          return ok(fee === 3000 && block === 100n ? zeroAddress : v3.get(fee) ?? zeroAddress);
        }
        if (functionName === 'liquidity') {
          if (address === token && block === 101n) return missing;
          return ok(address === token && block >= 103n ? 0n : 1n);
        }
        if (functionName === 'getLiquidity') {
          if (args[0] === stablePool) return block === 101n ? missing : ok(block < 103n ? 1n : 0n);
          return ok(args[0] === newStablePool && block > 100n ? 1n : 0n);
        }
        assert.ok(functionName === 'slot0' || functionName === 'getSlot0');
        return ok([1n << 96n, 0, 0, 0]);
      });
    },
  };
  Object.assign(worker, { verified: true, owner: '', client, quoteReaders: undefined });
  await worker.scan();
  assert.equal(worker.summary.pools, 2, 'the first USDC.e pool alone cannot form a round trip');
  block = 101n;
  now += 5 * 60_000;
  await worker.scan();
  assert.equal(worker.summary.pools, 5, 'new pools combine with previously verified v3 and singleton v4 pools');
  block = 102n;
  now += 29_999;
  await worker.scan();
  assert.deepEqual(factoryBlocks, [100n, 101n]);
  block = 103n;
  now++;
  await worker.scan();
  assert.deepEqual(factoryBlocks, [100n, 101n, 103n]);
  assert.equal(worker.summary.pools, 2, 'successful zero liquidity removes the dry v3 pool and breaks the USDC.e cycle');
  now += 30_000;
  await worker.scan();
  assert.deepEqual(factoryBlocks, [100n, 101n, 103n], 'a complete refresh returns to the normal five-minute cadence');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function fixture(options: { simulate?: boolean; unavailable?: boolean } = {}) {
  const foundPaths = deferred(), twoSwapReads = deferred(), releasePreparation = deferred();
  const preparations: string[] = [];
  let parallel = 0, peak = 0, observations = 0;
  const worker = new ArbitrumWorker(async () => {
    observations++;
    await foundPaths.promise;
    return { opportunities: observations === 1 ? [quote] : [], best: null, pools: 4, paths: 1, quotedRoutes: 1,
      unavailableLegs: 0, refinement: noRefinement };
  });
  const journal: { pending: object | null; recent: never[]; test?: object } = { pending: null, recent: [] };
  const deployment = { releaseHash: arbitrumReleaseHash, kind: 'proxy', verified: true };
  const client = {
    getBlock: async () => ({ number: head, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => head,
    getBalance: async () => 10n ** 18n,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'latestRoundData') return [1n, 2_000n * 10n ** 8n, 0n, BigInt(Math.floor(Date.now() / 1000)), 1n];
      if (functionName === 'getConfiguration') return 1n << 56n | 1n << 63n;
      if (functionName === 'balanceOf') return parseEther('0.05');
      assert.equal(functionName, 'FLASHLOAN_PREMIUM_TOTAL');
      await twoSwapReads.promise;
      return 0n;
    },
    multicall: async ({ contracts }: { contracts: { args: [{ amountIn: bigint }] }[] }) => contracts.map(c => {
      if (options.unavailable) return { status: 'failure', error: new ContractFunctionExecutionError(
        new BaseError('RPC failed', { details: 'timeout' }), { abi: [], functionName: 'aggregate3' }) };
      return { status: 'success', result: [2n * c.args[0].amountIn, 1n << 96n, 0, 0n] };
    }),
    call: async () => ({ data: encodeAbiParameters([{ type: 'uint256' }], [quote.payout]) }),
    estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    estimateGas: async ({ data }: { data: Hex }) => {
      const twoSwap = data.slice(0, 10) === arbitrumPinnedCall('0x12345678', arbitrumReleaseHash).slice(0, 10);
      if (!twoSwap) assert.equal(decodeFunctionData({ abi: ARBITRUM_FLASH_ARB_LOGIC_V2_ABI, data }).functionName, 'executePath');
      preparations.push(twoSwap ? 'two-swap' : 'path');
      peak = Math.max(peak, ++parallel);
      try { await releasePreparation.promise; } finally { parallel--; }
      if (options.simulate) return 100_000n;
      throw new Error('fixture stops before signing');
    },
  };
  const markets = [{ symbol: 'A', token, pools: [token, contract].map((pool, i) =>
    ({ kind: 2, pool, fee: i === 0 ? 100 : 500, tickSpacing: 0, nativeEth: false })) }];
  Object.assign(worker, { client, contract, owner: token, journal, deployment, markets, quoteReaders: undefined,
    verified: true, halted: false, refreshAfter: Infinity, executorCheckAt: Infinity });
  Object.assign(worker.summary, { executor: contract, mode: 'live' });
  return { worker, client, foundPaths, twoSwapReads, releasePreparation, preparations, journal, deployment,
    peak: () => peak, observations: () => observations };
}

test('pending and failed display balance reads allow receipt checks and market scans to continue', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ unavailable: true });
  const releaseBalance = deferred();
  let balanceReads = 0, receiptChecks = 0;
  f.journal.pending = { hash: `0x${'ab'.repeat(32)}`, nonce: 0 };
  f.worker.summary.balanceEth = '0.25';
  Object.assign(f.client, {
    getBalance: async () => {
      if (++balanceReads === 1) {
        await releaseBalance.promise;
        throw new Error('Balance RPC unavailable');
      }
      return 0n;
    },
    getTransactionReceipt: async () => { receiptChecks++; throw new Error('Receipt RPC unavailable'); },
  });
  f.twoSwapReads.resolve();
  const scan = f.worker.scan();
  await nextTurn();
  assert.equal(receiptChecks, 1);
  assert.equal(f.worker.summary.quoteRecoveryTotals.scans, 1);
  await scan;
  now += 60_000;
  await f.worker.scan();
  assert.equal(balanceReads, 1);
  assert.equal(receiptChecks, 2);
  releaseBalance.resolve();
  await nextTurn();
  assert.equal(f.worker.summary.balanceEth, null);
  now += 29_999;
  await f.worker.scan();
  assert.equal(balanceReads, 1);
  now++;
  await f.worker.scan();
  assert.equal(balanceReads, 2);
  assert.equal(f.worker.summary.balanceEth, '0');
  assert.equal(receiptChecks, 4);
  assert.equal(f.worker.summary.quoteRecoveryTotals.scans, 4);
});

test('a balance read completing after stop and restart cannot update the new generation', async () => {
  const f = fixture({ unavailable: true });
  const releaseBalance = deferred();
  let balanceReads = 0;
  f.client.getBalance = async () => {
    if (++balanceReads === 1) {
      await releaseBalance.promise;
      return parseEther('2');
    }
    return parseEther('3');
  };
  f.twoSwapReads.resolve();
  await f.worker.scan();
  f.worker.stop();
  await f.worker.scan();
  assert.equal(balanceReads, 1);
  releaseBalance.resolve();
  await nextTurn();
  assert.equal(f.worker.summary.balanceEth, null);
  await f.worker.scan();
  assert.equal(balanceReads, 2);
  assert.equal(f.worker.summary.balanceEth, '3');
  f.worker.stop();
  f.foundPaths.resolve();
});

test('a truncated Arbitrum activity entry retains the numeric count of unavailable quote legs', async () => {
  const f = fixture({ unavailable: true });
  f.worker.summary.pathStatus = 'Long path status. '.repeat(30);
  f.twoSwapReads.resolve();
  await f.worker.scan();
  const { logs, unavailableLegs } = f.worker.view();
  assert.equal(unavailableLegs, 2);
  assert.equal(f.worker.view().quoteRecovery.before, 2);
  assert.equal(f.worker.view().quoteRecovery.recovered, 0);
  assert.equal(f.worker.view().quoteRecovery.remaining, unavailableLegs);
  assert.equal(f.worker.view().quoteRecovery.untriedNoReader, unavailableLegs);
  assert.equal(logs[0].message.length, 280);
  assert.match(logs[0].message, /^Block 100: 0 two-swap quotes across 2 pools, 2 unavailable quote legs\./);
  await f.worker.scan();
  const latest = f.worker.view();
  assert.equal(latest.quoteRecoveryTotals.scans, 2);
  assert.equal(latest.quoteRecoveryTotals.before, 2 + latest.quoteRecovery.before);
  assert.equal(latest.quoteRecoveryTotals.remaining, 2 + latest.quoteRecovery.remaining);
  assert.equal(latest.quoteRecoveryTotals.untriedNoReader, 2 + latest.quoteRecovery.untriedNoReader);
  assert.equal(latest.quoteRecoveryTotals.retryTimeout, 0);
  f.worker.stop();
  f.foundPaths.resolve();
});

test('the last live stale quote identifies its candidate and head while the two scan producers overlap', async t => {
  const f = fixture();
  // Both hook-free v4 pools share one manager and the same market token.
  const manager = '0x360e68faccca8ca495c1b759fd9eee466db9fb32';
  const buy = { kind: 5, pool: manager, fee: 8, tickSpacing: 1, nativeEth: true };
  const sell = { kind: 5, pool: manager, fee: 500, tickSpacing: 10, nativeEth: false };
  Object.assign(f.worker, { markets: [{ symbol: 'A', token, pools: [sell, buy] }] });
  Object.assign(f.client, { multicall: async ({ contracts }: { contracts: {
    functionName: string; args: [{ zeroForOne: boolean; exactAmount: bigint }];
  }[] }) => contracts.map(({ functionName, args }) => {
    if (functionName === 'getSlot0') return { status: 'success', result: [0n, 0, 0, 0] };
    assert.equal(functionName, 'quoteExactInputSingle');
    const { exactAmount, zeroForOne } = args[0];
    // Native ETH sorts before the market token, and wrapped ETH sorts after it.
    return { status: 'success', result: [zeroForOne ? exactAmount * 2n : exactAmount / 2n, 50_000n] };
  }) });
  let now = 1_800_000_000_125, sampledHead = 160n, sampledTime = 1_800_000_000n, headReads = 0;
  t.mock.method(Date, 'now', () => now);
  f.client.getBlock = async () => {
    headReads++;
    Object.assign(f.worker.summary, { block: 900, pathBlock: 901 });
    return { number: sampledHead, timestamp: sampledTime };
  };
  const scan = f.worker.scan();
  assert.equal(f.worker.view().lastStaleQuote, null);
  f.foundPaths.resolve();
  await nextTurn();
  const path = f.worker.view().lastStaleQuote;
  assert.ok(path);
  assert.deepEqual(path, { at: now, sourceBlock: Number(quote.block), headBlock: 160,
    headTimestamp: Number(sampledTime), headAgeMs: 125, reason: 'quote-too-old', kind: 'multi-hop',
    amountIn: quote.amountIn.toString(), asset: quote.asset, symbol: 'USDC', decimals: 6,
    route: quote.label, funding: 'Morpho', payoutUsd: quote.payoutUsd, legs: quote.legs });
  assert.equal(headReads, 1);

  now += 1_000;
  sampledHead = 103n;
  sampledTime += 10n;
  f.twoSwapReads.resolve();
  await scan;
  const cycle = f.worker.view().lastStaleQuote;
  assert.ok(cycle);
  assert.equal(cycle.kind, 'two-swap');
  assert.equal(cycle.reason, 'head-clock-ahead');
  assert.equal(cycle.at, now);
  assert.equal(cycle.sourceBlock, 100);
  assert.equal(cycle.headBlock, 103);
  assert.equal(cycle.headTimestamp, Number(sampledTime));
  assert.equal(cycle.headAgeMs, -8_875);
  assert.equal(cycle.asset.toLowerCase(), weth);
  assert.equal(cycle.amountIn, parseEther('0.05').toString());
  assert.equal(cycle.route, 'WETH → A → WETH');
  assert.equal(cycle.symbol, 'WETH');
  assert.equal(cycle.decimals, 18);
  assert.equal(cycle.funding, 'Aave V3');
  assert.equal(cycle.payoutUsd, 300);
  assert.deepEqual(cycle.legs, [{ ...buy, tokenOut: token }, { ...sell, tokenOut: weth }]);
  assert.equal(f.preparations.length, 0, 'a stale head never reaches gas estimation');

  // A clock correction can make an otherwise valid later response older than the last observation.
  now -= 500;
  sampledHead = 200n;
  await f.worker.scan();
  assert.deepEqual(f.worker.view().lastStaleQuote, cycle, 'an older observation cannot replace a newer one');
  const reads = headReads;
  Object.assign(f.worker, { markets: [] });
  f.client.getBlockNumber = async () => 300n;
  now += 12_000;
  await f.worker.scan();
  await nextTurn();
  assert.equal(f.worker.summary.block, 300);
  assert.equal(f.worker.summary.pathBlock, 300);
  assert.deepEqual(f.worker.view().lastStaleQuote, cycle);
  assert.equal(headReads, reads, 'empty observations need no evidence-specific RPC');
  assert.equal(new ArbitrumWorker().view().lastStaleQuote, null, 'a new process derives no evidence from the journal');
});

test('manual and paper stale preparations never become ordinary live evidence', async () => {
  for (const mode of ['manual', 'paper'] as const) {
    const f = fixture();
    if (mode === 'paper') f.worker.summary.mode = 'paper';
    else f.journal.test = { id: 'stale-test', status: 'queued', queuedAt: Date.now(), expiresAt: Date.now() + 60_000,
      checked: 0, minimumNetUsd: 0.05, hash: null };
    let heads = 0;
    f.client.getBlock = async () => {
      heads++;
      return { number: 500n, timestamp: BigInt(Math.floor(Date.now() / 1_000)) };
    };
    f.twoSwapReads.resolve();
    f.foundPaths.resolve();
    await f.worker.scan();
    await nextTurn();
    assert.ok(heads > 0, mode + ' ran the actual freshness check');
    assert.ok((f.worker.summary.preparationRejections['stale-quote'] ?? 0) > 0);
    assert.equal(f.worker.view().lastStaleQuote, null, mode);
    assert.equal(f.preparations.length, 0);
  }
});

test('a delayed ordinary head read cannot publish stale evidence after its live eligibility is revoked', async () => {
  for (const invalidate of ['stop', 'new pending', 'new manual test'] as const) {
    const f = fixture();
    Object.assign(f.worker, { markets: [] });
    const started = deferred(), unblock = deferred();
    f.client.getBlock = async () => {
      started.resolve();
      await unblock.promise;
      return { number: 151n, timestamp: BigInt(Math.floor(Date.now() / 1_000)) };
    };
    f.foundPaths.resolve();
    f.twoSwapReads.resolve();
    await f.worker.scan();
    await started.promise;
    if (invalidate === 'stop') f.worker.stop();
    if (invalidate === 'new pending') f.journal.pending = {};
    if (invalidate === 'new manual test') f.journal.test = { status: 'queued', expiresAt: Date.now() + 60_000 };
    unblock.resolve();
    await nextTurn();
    assert.equal(f.worker.view().lastStaleQuote, null, invalidate);
    assert.deepEqual(f.preparations, []);
  }
});

test('a profitable path starts preparation while the two-swap scan waits, and both producers use one lane', async () => {
  const f = fixture();
  const scan = f.worker.scan();
  f.foundPaths.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['path']);
  f.twoSwapReads.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['path']);
  f.releasePreparation.resolve();
  await scan;
  assert.ok(f.preparations.includes('two-swap'));
  assert.equal(f.peak(), 1);
  assert.deepEqual(f.worker.view().pathRefinement, noRefinement);
});

test('when the two-swap batch is already preparing, the later positive path is consumed exactly once', async () => {
  const f = fixture();
  const scan = f.worker.scan();
  f.twoSwapReads.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['two-swap']);
  f.foundPaths.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['two-swap']);
  f.releasePreparation.resolve();
  await scan;
  await nextTurn();
  assert.equal(f.preparations.filter(k => k === 'path').length, 1);
  assert.equal(f.peak(), 1);
});

test('a qualified path from an invalidated observation never starts preparation', async () => {
  for (const gate of ['stop and restart', 'unverified release', 'new test', 'pending intent'] as const) {
    const f = fixture();
    const scan = f.worker.scan();
    await nextTurn();
    assert.equal(f.observations(), 1);
    if (gate === 'stop and restart') { f.worker.stop(); Object.assign(f.worker, { active: true }); }
    if (gate === 'unverified release') f.deployment.verified = false;
    if (gate === 'new test') f.journal.test = { status: 'queued', expiresAt: Date.now() + 60_000 };
    if (gate === 'pending intent') f.journal.pending = {};
    f.foundPaths.resolve();
    f.twoSwapReads.resolve();
    f.releasePreparation.resolve();
    await scan;
    await nextTurn();
    assert.deepEqual(f.preparations, [], gate);
  }
});


test('paper worker simulates a path that arrives between polls and a later empty observation cannot erase it', async () => {
  const f = fixture({ simulate: true });
  Object.assign(f.worker, { markets: [], journal: null });
  f.worker.summary.mode = 'paper';
  f.twoSwapReads.resolve();
  await f.worker.scan();
  assert.deepEqual(f.preparations, []);
  f.foundPaths.resolve();
  f.releasePreparation.resolve();
  await nextTurn();
  assert.deepEqual(f.preparations, ['path', 'path']); // Initial and exact gas estimates for one preparation.
  assert.ok(f.worker.summary.netEstimateUsd && f.worker.summary.netEstimateUsd > 0);
  await f.worker.scan();
  await nextTurn();
  assert.equal(f.observations(), 2);
  assert.deepEqual(f.preparations, ['path', 'path']);
  assert.equal(f.worker.summary.pending, null);
});

// Hold only the factory reads. Empty discovered markets keep these tests focused on the poll handoff.
function holdPoolRefresh(f: ReturnType<typeof fixture>, failOracle = false) {
  const discovery = deferred(), oracleBlocks: bigint[] = [];
  let factoryReads = 0;
  const readContract = f.client.readContract;
  Object.assign(f.client, {
    readContract: async (request: { functionName: string; blockNumber: bigint }) => {
      if (request.functionName === 'latestRoundData') {
        oracleBlocks.push(request.blockNumber);
        if (failOracle) throw new Error('Oracle unavailable in fixture');
      }
      return readContract(request);
    },
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) => {
      if (contracts[0]?.functionName === 'getPool') {
        factoryReads++;
        await discovery.promise;
        return contracts.map(() => ({ status: 'success', result: zeroAddress }));
      }
      assert.ok(contracts.every(row => row.functionName === 'getLiquidity'));
      return contracts.map(() => ({ status: 'success', result: 0n }));
    },
  });
  Object.assign(f.worker, { refreshAfter: 0, knownPools: new Map() });
  f.twoSwapReads.resolve();
  return { discovery, oracleBlocks, factoryReads: () => factoryReads };
}

test('a fast path rejection survives the periodic pool refresh and the two-swap scan shares the oracle read', async t => {
  let now = 1_000;
  t.mock.method(performance, 'now', () => now);
  const f = fixture(), gate = holdPoolRefresh(f);
  f.client.getBlock = async () => ({ number: head + 60n, timestamp: BigInt(Math.floor(Date.now() / 1_000)) });
  f.worker.summary.preparationRejections = { 'stale-quote': 5 };
  f.foundPaths.resolve();
  const scan = f.worker.scan();
  await nextTurn();
  assert.equal(gate.factoryReads(), 1);
  assert.equal(f.observations(), 1);
  assert.deepEqual(gate.oracleBlocks, [head]);
  assert.equal(f.worker.summary.lastPoolRefresh, null);
  assert.equal(f.worker.summary.pathBlock, Number(head));
  assert.equal(f.worker.summary.preparationRejections['stale-quote'], 1);
  now += 371;
  gate.discovery.resolve();
  await scan;
  await nextTurn();
  assert.equal(f.observations(), 1, 'the completed path must not start again for the same poll');
  assert.equal(f.worker.summary.simulated, 1);
  assert.equal(f.worker.summary.preparationRejections['stale-quote'], 1);
  assert.equal(f.worker.summary.lastStaleQuote?.sourceBlock, Number(head));
  assert.deepEqual(gate.oracleBlocks, [head]);
  assert.deepEqual(f.worker.view().lastPoolRefresh, {
    block: Number(head), durationMs: 371, pathStartedBeforeRefreshCompleted: true,
  });
});

test('a previous path finishing during discovery leaves one chance for the new snapshot after refresh', async () => {
  const f = fixture();
  Object.assign(f.worker, { markets: [] });
  f.client.getBlock = async () => ({ number: 300n, timestamp: BigInt(Math.floor(Date.now() / 1_000)) });
  f.twoSwapReads.resolve();
  await f.worker.scan();
  assert.equal(f.observations(), 1);
  const gate = holdPoolRefresh(f);
  f.client.getBlockNumber = async () => head + 1n;
  const next = f.worker.scan();
  await nextTurn();
  assert.equal(gate.factoryReads(), 1);
  assert.equal(f.observations(), 1);
  assert.deepEqual(gate.oracleBlocks, []);
  f.foundPaths.resolve();
  await nextTurn();
  gate.discovery.resolve();
  await next;
  await nextTurn();
  assert.equal(f.observations(), 2);
  assert.equal(f.worker.summary.pathBlock, Number(head + 1n));
  assert.equal(f.worker.summary.lastPoolRefresh?.pathStartedBeforeRefreshCompleted, false);
  assert.deepEqual(gate.oracleBlocks, [head + 1n]);
});

test('manual requests and pending transactions take precedence before and during a refresh', async () => {
  for (const timing of ['before', 'during']) for (const state of ['manual', 'pending']) {
    const f = fixture(), gate = holdPoolRefresh(f);
    Object.assign(f.worker, { reconcile: async () => {} });
    const setState = () => {
      if (state === 'pending') f.journal.pending = { hash: '0x1234' };
      else f.journal.test = { id: 'manual-test', status: 'queued', expiresAt: Date.now() + 60_000,
        checked: 0, minimumNetUsd: 0.05 };
    };
    if (timing === 'before') setState();
    const scan = f.worker.scan();
    await nextTurn();
    assert.equal(gate.factoryReads(), 1);
    assert.equal(f.observations(), timing === 'before' ? 0 : 1);
    if (timing === 'during') setState();
    f.foundPaths.resolve();
    await nextTurn();
    gate.discovery.resolve();
    await scan;
    await nextTurn();
    assert.equal(f.observations(), timing === 'before' ? 0 : 1);
    assert.deepEqual(f.preparations, []);
    assert.equal(f.worker.summary.simulated, 0);
    assert.equal(f.worker.summary.lastPoolRefresh?.pathStartedBeforeRefreshCompleted, timing === 'during');
    assert.deepEqual(gate.oracleBlocks, [head]);
    if (state === 'manual') assert.equal(Reflect.get(f.worker, 'regularScans'), 0, 'manual selection preserves ordinary sizing rotation');
  }
});

test('unreviewed paper observations keep their one-in-ten cadence through a due refresh', async () => {
  for (const index of [0, 1, 2, 10, 11]) {
    const f = fixture(), gate = holdPoolRefresh(f);
    Object.assign(f.worker, { regularScans: index, journal: null });
    Object.assign(f.deployment, { releaseHash: null, verified: false });
    f.worker.summary.mode = 'paper';
    f.foundPaths.resolve();
    const scan = f.worker.scan();
    await nextTurn();
    const scheduled = index % 10 === 1;
    assert.equal(f.observations(), Number(scheduled), 'regular scan index ' + index);
    assert.deepEqual(gate.oracleBlocks, scheduled ? [head] : []);
    gate.discovery.resolve();
    await scan;
    await nextTurn();
    assert.equal(f.observations(), Number(scheduled));
    assert.deepEqual(f.preparations, []);
    assert.deepEqual(gate.oracleBlocks, [head]);
    assert.equal(f.worker.summary.lastPoolRefresh?.pathStartedBeforeRefreshCompleted, scheduled);
  }
});

test('a stopped generation cannot publish a delayed path or refresh after restart', async () => {
  const f = fixture(), gate = holdPoolRefresh(f);
  const scan = f.worker.scan();
  await nextTurn();
  assert.equal(f.observations(), 1);
  f.worker.stop();
  Object.assign(f.worker, { active: true });
  f.foundPaths.resolve();
  gate.discovery.resolve();
  await scan;
  await nextTurn();
  assert.equal(f.worker.summary.pathBlock, 0);
  assert.equal(f.worker.summary.lastPoolRefresh, null);
  assert.equal(f.worker.summary.block, 0);
  assert.deepEqual(f.preparations, []);
});

test('a rejected shared price is observed during discovery and remains the two-swap poll error', async () => {
  const f = fixture(), gate = holdPoolRefresh(f, true);
  f.foundPaths.resolve();
  const rejection = assert.rejects(f.worker.scan(), /Oracle unavailable in fixture/);
  await nextTurn();
  assert.match(f.worker.summary.pathStatus, /quotes unavailable/);
  assert.deepEqual(gate.oracleBlocks, [head]);
  gate.discovery.resolve();
  await rejection;
  assert.deepEqual(gate.oracleBlocks, [head]);
  assert.equal(f.observations(), 1);
  assert.deepEqual(f.preparations, []);
});
