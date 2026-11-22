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
  let incompletePrices: boolean | 'error' = false;
  let gasLimited = false;
  const rpcError = (functionName: string, details: string) => ({ status: 'failure',
    error: new ContractFunctionExecutionError(new BaseError('RPC failed', { details }), { abi: [], functionName }) });
  const client = {
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber: bigint }) => {
      assert.equal(blockNumber, 100n);
      switch (functionName) {
        case 'FLASHLOAN_PREMIUM_TOTAL': return 5n;
        case 'getConfiguration': return (1n << 56n) | (1n << 63n);
        case 'balanceOf': return parseEther('500');
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
