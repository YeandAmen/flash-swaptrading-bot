import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseError, ContractFunctionExecutionError, encodeAbiParameters, keccak256, parseAbiParameters, parseEther,
  zeroAddress, type Address, type Hex } from 'viem';
import { arbitrumProbeSize, discoverArbitrumPools, mayProfitAtArbitrumSpot, scanArbitrum, type ArbitrumClient } from './market.js';

test('Arbitrum discovers liquid static v4 keys independently of v3 factory fees', async () => {
  const token = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
  const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const poolId = (base: Address, fee: number, spacing: number) => keccak256(encodeAbiParameters(
    parseAbiParameters('address,address,uint24,int24,address'), [base, token, fee, spacing, zeroAddress],
  ));
  const liquid = new Set([poolId(zeroAddress, 8, 1), poolId(zeroAddress, 250, 5), poolId(weth, 1000, 20)]);
  const client = {
    multicall: async ({ blockNumber, contracts }: {
      blockNumber: bigint; contracts: { functionName: string; args: (Address | Hex | number)[] }[];
    }) => {
      assert.equal(blockNumber, 123n);
      if (contracts[0].functionName === 'getPool') {
        assert.deepEqual([...new Set(contracts.map(({ args }) => args[2]))], [100, 500, 3000, 10000]);
        return contracts.map(() => ({ status: 'success', result: zeroAddress }));
      }
      return contracts.map(({ functionName, args }) => {
        assert.equal(functionName, 'getLiquidity');
        return { status: 'success', result: liquid.has(args[0] as Hex) ? 1n : 0n };
      });
    },
  } as unknown as ArbitrumClient;
  const markets = await discoverArbitrumPools(client, 123n);
  assert.deepEqual(markets.map(({ symbol }) => symbol), ['USDT']);
  assert.deepEqual(markets[0].pools.map(({ fee, tickSpacing, nativeEth }) => [fee, tickSpacing, nativeEth]),
    [[8, 1, true], [250, 5, true], [1000, 20, false]]);
});

test('Arbitrum uses one extra quote size every other scan and keeps large probes in the rotation', () => {
  const now = 100_000;
  const lead = { amount: parseEther('4'), at: now };
  assert.equal(arbitrumProbeSize(0, lead, now), undefined);
  assert.equal(arbitrumProbeSize(1, lead, now), parseEther('6'));
  assert.equal(arbitrumProbeSize(1, lead, now + 30_001), parseEther('0.01'));
  assert.equal(arbitrumProbeSize(1, { ...lead, amount: parseEther('64') }, now), parseEther('0.01'));
  assert.equal(arbitrumProbeSize(23, lead, now), parseEther('32'));
  assert.equal(arbitrumProbeSize(27, lead, now), parseEther('64'));
  assert.equal(arbitrumProbeSize(27, lead, now, 2_000_000), parseEther('64'));
  assert.deepEqual(arbitrumProbeSize(55, lead, now, 2_000_000), { fundedDepth: 0 });
  assert.deepEqual(arbitrumProbeSize(111, lead, now, Infinity), { fundedDepth: 1 });
  assert.equal(arbitrumProbeSize(55, lead, now), parseEther('64'));
  for (let scan = 0; scan < 30; scan++) {
    assert.equal(arbitrumProbeSize(scan, lead, now) === undefined, scan % 2 === 0);
  }
});

test('the marginal repayment bound uses lender half-up rounding and rounds both legs up in atomic units', () => {
  const unit = { tokenOut: 1n, baseIn: 1n, lpFee: 0n };
  const higherRate = { ...unit, tokenOut: 1001n, baseIn: 1000n };
  assert.equal(mayProfitAtArbitrumSpot(999n, 5n, higherRate, unit), true);
  assert.equal(mayProfitAtArbitrumSpot(1000n, 5n, higherRate, unit), false);
  const half = { ...unit, baseIn: 2n };
  assert.equal(mayProfitAtArbitrumSpot(5n, 5n, half, half), true);
  const buy = { tokenOut: 10_006n, baseIn: 10_000n, lpFee: 100n };
  assert.equal(mayProfitAtArbitrumSpot(1_000_000n, 5n, buy, { ...unit, lpFee: 100n }), false);
  assert.equal(mayProfitAtArbitrumSpot(1_000_000n, 5n, undefined, unit), true);
});

test('Arbitrum uses pinned slot0 rates and fails open for missing prices', async () => {
  const token = '0x0000000000000000000000000000000000000001';
  const markets: Parameters<typeof scanArbitrum>[2] = [{
    token, symbol: 'TEST', pools: [
      { kind: 2, pool: '0x0000000000000000000000000000000000000002', fee: 100, tickSpacing: 0, nativeEth: false },
      { kind: 5, pool: '0x0000000000000000000000000000000000000003', fee: 500, tickSpacing: 10, nativeEth: true },
    ],
  }];
  const requestedSizes: bigint[][] = [];
  let availableWeth = parseEther('500');
  let virtualWeth: bigint | 'unavailable' | undefined;
  let virtualReads = 0;
  let incompletePrices: boolean | 'error' = false;
  let gasLimited = false;
  const rpcError = (functionName: string, details: string) => ({ status: 'failure',
    error: new ContractFunctionExecutionError(new BaseError('RPC failed', { details }), { abi: [], functionName }) });
  const client = {
    readContract: async ({ address, functionName, args, blockNumber }: { address: Address; functionName: string; args?: Address[]; blockNumber: bigint }) => {
      assert.equal(blockNumber, 100n);
      switch (functionName) {
        case 'FLASHLOAN_PREMIUM_TOTAL': return 5n;
        case 'getConfiguration': return (1n << 56n) | (1n << 63n);
        case 'balanceOf': return availableWeth;
        case 'getVirtualUnderlyingBalance':
          virtualReads++;
          assert.equal(address, '0x794a61358d6845594f94dc1db02a252b5b4814ad');
          assert.deepEqual(args, ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1']);
          if (virtualWeth === 'unavailable') throw new Error('unsupported or unavailable reserve getter');
          return virtualWeth ?? availableWeth;
        case 'latestRoundData': return [0n, 200_000_000_000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n];
        default: throw new Error('Unexpected read');
      }
    },
    multicall: async ({ contracts, blockNumber, batchSize }: { contracts: {
      functionName: string; args: [{ amountIn?: bigint; exactAmount?: bigint }];
    }[]; blockNumber: bigint; batchSize?: number }) => {
      assert.equal(blockNumber, 100n);
      if (contracts[0].functionName === 'slot0') {
        assert.deepEqual(contracts.map(({ functionName }) => functionName), ['slot0', 'getSlot0']);
        if (incompletePrices === 'error') throw new Error('Pool state RPC unavailable');
        return [
          { status: 'success', result: [2n ** 96n] },
          incompletePrices ? { status: 'failure' } : { status: 'success', result: [2n ** 96n, 0, 10, 500] },
        ];
      }
      const sizes = contracts.map(({ args }) => args[0].amountIn ?? args[0].exactAmount!);
      requestedSizes.push(sizes);
      if (gasLimited && requestedSizes.length === 1) {
        return [rpcError('aggregate3', 'out of gas'), rpcError('quoteExactInputSingle', 'out of gas'),
          rpcError('aggregate3', 'rate limited'), { status: 'success', result: [sizes[3]] }];
      }
      if (gasLimited) {
        assert.equal(batchSize, requestedSizes.length === 2 ? 1400 : 6000);
        return sizes.map((amount) => ({ status: 'success', result: [amount] }));
      }
      return sizes.map((amount) => ({ status: 'success', result: [
        requestedSizes.length === 1 ? amount : amount + amount / 2_500n,
      ] }));
    },
  } as unknown as ArbitrumClient;
  const result = await scanArbitrum(client, 100n, markets, false, parseEther('64'), 500);
  const sizes = [parseEther('0.05'), parseEther('0.25')];
  assert.deepEqual(requestedSizes, [[...sizes, ...sizes], [...sizes, ...sizes]]);
  assert.equal(result.quotedRoutes, 4);
  assert.equal(result.prunedRoutes, 0);
  assert.deepEqual(result.opportunities, []);
  assert.equal(result.best, null);
  assert.equal(result.bestQuote?.loanUsd, 100);
  assert.equal(result.bestQuote?.payoutUsd.toFixed(4), '-0.0100');
  assert.equal(result.largestQuote?.loanUsd, 500);
  assert.equal(result.largestQuote?.payoutUsd.toFixed(4), '-0.0500');
  assert.equal(result.sizingAmount, parseEther('0.25'));
  assert.equal(virtualReads, 0, 'ordinary fixed-size scans reuse the existing reads');

  requestedSizes.length = 0;
  const limitedByAave = await scanArbitrum(client, 100n, markets, false, { fundedDepth: 0 }, 2_000_000);
  assert.equal(limitedByAave.largestQuote?.loanUsd, 1_000_000);
  availableWeth = parseEther('3000');
  requestedSizes.length = 0;
  const limitedByUsd = await scanArbitrum(client, 100n, markets, false, { fundedDepth: 0 }, 2_000_000);
  assert.equal(limitedByUsd.largestQuote?.loanUsd, 2_000_000);
  assert.equal(limitedByUsd.quotedRoutes, 12);
  for (const [phase, weth] of [3000, 256, 1024, 3000].entries()) {
    requestedSizes.length = 0;
    const unrestricted = await scanArbitrum(client, 100n, markets, false, { fundedDepth: phase }, Infinity);
    assert.equal(unrestricted.largestQuote?.loanUsd, weth * 2000);
    assert.equal(unrestricted.quotedRoutes, 12);
  }
  // Finalized Arbitrum block 526967626: the aToken held more WETH than Aave could debit.
  availableWeth = 16_270_082_822_845_485_180_882n;
  virtualWeth = 16_270_082_821_814_885_180_882n;
  requestedSizes.length = 0;
  await scanArbitrum(client, 100n, markets, false, { fundedDepth: 0 }, Infinity);
  assert.ok(requestedSizes[0].includes(virtualWeth));
  assert.ok(!requestedSizes[0].includes(availableWeth));
  virtualWeth = availableWeth + 1n;
  requestedSizes.length = 0;
  await scanArbitrum(client, 100n, markets, false, { fundedDepth: 0 }, Infinity);
  assert.ok(requestedSizes[0].includes(availableWeth), 'aToken custody is also binding');
  virtualWeth = 0n;
  requestedSizes.length = 0;
  const empty = await scanArbitrum(client, 100n, markets, false, { fundedDepth: 0 }, Infinity);
  assert.equal(empty.quotedRoutes, 0);
  assert.equal(requestedSizes.length, 0);
  virtualWeth = 'unavailable';
  const fixedOnly = await scanArbitrum(client, 100n, markets, false, { fundedDepth: 0 }, Infinity);
  assert.equal(fixedOnly.quotedRoutes, 10, 'the fixed ladder survives an unavailable optional getter');
  assert.ok(requestedSizes[0].every(amount => amount <= parseEther('16')));
  virtualWeth = undefined;
  availableWeth = parseEther('500');

  requestedSizes.length = 0;
  const screened = await scanArbitrum(client, 100n, markets, false, parseEther('64'), 500, true);
  assert.equal(screened.prunedRoutes, 4);
  assert.equal(screened.quotedRoutes, 0);
  assert.deepEqual(requestedSizes, []);

  incompletePrices = true;
  const partial = await scanArbitrum(client, 100n, markets, false, parseEther('64'), 500, true);
  assert.equal(partial.prunedRoutes, 0);
  assert.equal(partial.quotedRoutes, 4);
  assert.deepEqual(partial.opportunities, []);

  incompletePrices = 'error';
  requestedSizes.length = 0;
  const missing = await scanArbitrum(client, 100n, markets, false, parseEther('64'), 500, true);
  assert.equal(missing.prunedRoutes, 0);
  assert.equal(missing.quotedRoutes, 4);

  requestedSizes.length = 0;
  gasLimited = true;
  const recovered = await scanArbitrum(client, 100n, markets, false, undefined, 500, true);
  assert.deepEqual(requestedSizes, [[...sizes, ...sizes], [sizes[0]], sizes]);
  assert.equal(recovered.quotedRoutes, 2);
  assert.equal(recovered.unavailableLegs, 1);
  assert.deepEqual(recovered.opportunities, []);
});

test('Arbitrum distributes the full audit without delaying eligible or unknown-price quotes', async (t) => {
  const addr = (value: number) => `0x${value.toString(16).padStart(40, '0')}` as Address;
  const markets: Parameters<typeof scanArbitrum>[2] = [13, 10, 9, 8, 7, 6, 4, 4, 4].map((count, market) => ({
    token: addr(market + 1), symbol: `T${market}`,
    pools: Array.from({ length: count }, (_, pool) => ({
      kind: 2 as const, pool: addr(1_000 + market * 100 + pool), fee: 100 + market * 100 + pool,
      tickSpacing: 0, nativeEth: false,
    })),
  }));
  const watched = markets.at(-1)!;
  const [high, low, , unknown] = watched.pools;
  const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const key = (token: Address, buy: number, sell: number, size: bigint) => [token, buy, sell, size].join('/');
  let legs = 0;
  let spotReads = 0;
  let combinations = new Set<string>();
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'FLASHLOAN_PREMIUM_TOTAL') return 5n;
      if (functionName === 'getConfiguration') return (1n << 56n) | (1n << 63n);
      if (functionName === 'balanceOf') return parseEther('500');
      throw new Error('Unexpected contract read');
    },
    multicall: async ({ blockNumber, batchSize, contracts }: {
      blockNumber: bigint; batchSize?: number; contracts: {
        address: Address; functionName: string;
        args: [{ tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint }];
      }[];
    }) => {
      assert.equal(blockNumber, 100n);
      if (contracts[0].functionName === 'slot0') {
        spotReads++;
        return contracts.map(({ address }) => address === unknown.pool ? { status: 'failure' }
          : { status: 'success', result: [address === high.pool ? 2n ** 97n : 2n ** 96n] });
      }
      assert.equal(batchSize, 6000);
      legs += contracts.length;
      return contracts.map(({ args: [{ tokenIn, fee, amountIn }] }) => {
        // The tag on the mock buy output identifies its pool in the mock sell request.
        if (tokenIn === weth) return { status: 'success', result: [amountIn + BigInt(fee)] };
        const buy = amountIn % 10_000n;
        const size = amountIn - buy;
        combinations.add(key(tokenIn, Number(buy), fee, size));
        return { status: 'success', result: [size] };
      });
    },
  } as unknown as ArbitrumClient;
  const run = async (screen: Parameters<typeof scanArbitrum>[6], scan = 0, manual = false) => {
    legs = spotReads = 0;
    combinations = new Set();
    const extra = scan % 2 === 1 ? parseEther('0.1') : undefined;
    const order = scan % 2 === 1 ? [...markets].reverse().map((market) => ({ ...market, pools: [...market.pools].reverse() })) : markets;
    const result = await scanArbitrum(client, 100n, order, manual, extra, 1_000_000, screen, Promise.resolve(2_000));
    assert.equal(result.quotedRoutes, combinations.size);
    return { quotes: combinations, legs, spotReads };
  };
  const full = await run(false);
  const regular = await run(true);
  assert.equal(full.spotReads, 0);
  assert.equal(regular.spotReads, 1);
  const baseSize = parseEther('0.05');
  assert.ok(regular.quotes.has(key(watched.token, low.fee, high.fee, baseSize)), 'the known favorable direction stays eligible');
  assert.ok(regular.quotes.has(key(watched.token, high.fee, unknown.fee, baseSize)), 'unknown prices stay eligible');
  const auditCounts = new Map([...full.quotes].filter((quote) => !regular.quotes.has(quote)).map((quote) => [quote, 0]));
  assert.ok(auditCounts.size > 2_000);

  let oldPeak = full.legs;
  let newPeak = 0;
  let oldTotal = 0;
  let newTotal = 0;
  for (let scan = 0; scan < 10; scan++) {
    const old = scan === 0 ? full : await run(true, scan);
    const spread = await run({ auditScan: scan }, scan);
    for (const quote of scan === 0 ? regular.quotes : old.quotes) assert.ok(spread.quotes.has(quote));
    for (const quote of spread.quotes) {
      if (auditCounts.has(quote)) auditCounts.set(quote, auditCounts.get(quote)! + 1);
      else assert.ok(regular.quotes.has(quote) || (scan % 2 === 1 && old.quotes.has(quote)));
    }
    oldPeak = Math.max(oldPeak, old.legs);
    newPeak = Math.max(newPeak, spread.legs);
    oldTotal += old.legs;
    newTotal += spread.legs;
  }
  assert.ok([...auditCounts.values()].every((count) => count === 1));
  assert.equal(newTotal, oldTotal);
  assert.ok(newPeak < oldPeak / 4);
  t.diagnostic(`Planned quote legs per pass peaked at ${oldPeak} before and ${newPeak} after, with ${newTotal} legs per full cycle in both cases`);

  const manual = await run({ auditScan: 1 }, 1, true);
  assert.equal(manual.spotReads, 0);
  assert.equal(manual.quotes.size, full.quotes.size / 5 * 11);
});

test('Arbitrum screens returns after the actual buy while retaining sizing leads, winners, and audit coverage', async () => {
  const token = '0x0000000000000000000000000000000000000001';
  const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const markets: Parameters<typeof scanArbitrum>[2] = [{
    symbol: 'TEST', token, pools: [2, 3, 4, 5, 6].map((i) => ({
      kind: 2, pool: `0x${String(i).padStart(40, '0')}` as Address, fee: 100 + i,
      tickSpacing: 0, nativeEth: false,
    })),
  }];
  const [buy, poor, near, winner, unknown] = markets[0].pools;
  const size = parseEther('0.05');
  const debt = size + size / 2_000n;
  // The buy's slot0 price implies enough output for every known return, but its exact quote is much smaller.
  const actualBuy = size * 1_000_500n / 9_000_000n;
  const quotes = new Map([
    [poor.fee, size / 3n], [near.fee, debt - size * 15n / 100_000n],
    [winner.fee, debt + size / 1_000n], [unknown.fee, debt - size / 1_000n],
  ]);
  const returnFees: number[] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'FLASHLOAN_PREMIUM_TOTAL') return 5n;
      if (functionName === 'getConfiguration') return (1n << 56n) | (1n << 63n);
      if (functionName === 'balanceOf') return size;
      throw new Error('Unexpected contract read');
    },
    multicall: async ({ blockNumber, contracts }: { blockNumber: bigint; contracts: {
      functionName: string; address: Address; args: [{ tokenIn: Address; fee: number; amountIn: bigint }];
    }[] }) => {
      assert.equal(blockNumber, 100n);
      if (contracts[0].functionName === 'slot0') {
        return contracts.map(({ address }) => address === unknown.pool ? { status: 'failure' } :
          { status: 'success', result: [BigInt(markets[0].pools.findIndex((pool) => pool.pool === address) + 1) * 2n ** 96n] });
      }
      return contracts.map(({ args: [{ tokenIn, fee, amountIn }] }) => {
        if (tokenIn === weth) return { status: 'success', result: [fee === buy.fee && amountIn === size ? actualBuy : 0n] };
        assert.equal(amountIn, actualBuy);
        returnFees.push(fee);
        return { status: 'success', result: [quotes.get(fee)] };
      });
    },
  } as unknown as ArbitrumClient;
  const run = async (screen: Parameters<typeof scanArbitrum>[6], testMode = false) => {
    returnFees.length = 0;
    return scanArbitrum(client, 100n, markets, testMode, undefined, 100, screen, Promise.resolve(2_000));
  };

  const screened = await run({ auditScan: 1 });
  assert.equal(screened.prunedAfterBuy, 1);
  assert.deepEqual(returnFees, [near.fee, winner.fee, unknown.fee]);
  assert.equal(screened.quotedRoutes, 3);
  assert.deepEqual(screened.opportunities.map(({ order }) => order.sell.fee), [winner.fee]);

  // A near miss remains available to size the next scan if the larger-spread sell stops winning.
  quotes.set(winner.fee, size);
  const sizing = await run(true);
  assert.equal(sizing.sizingAmount, size);
  assert.equal(sizing.opportunities.length, 0);

  for (const [screen, testMode] of [[{ auditScan: 0 }, false], [false, false], [{ auditScan: 1 }, true]] as const) {
    const full = await run(screen, testMode);
    assert.equal(full.prunedAfterBuy, 0);
    assert.deepEqual(returnFees, [poor.fee, near.fee, winner.fee, unknown.fee]);
    assert.equal(full.quotedRoutes, 4);
  }
});
