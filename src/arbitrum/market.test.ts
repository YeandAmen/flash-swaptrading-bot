import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEther } from 'viem';
import { arbitrumProbeSize, scanArbitrum, type ArbitrumClient } from './market.js';

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

test('Arbitrum reports a losing quote after the lender fee and keeps it out of execution', async () => {
  const token = '0x0000000000000000000000000000000000000001';
  const markets: Parameters<typeof scanArbitrum>[2] = [{
    token, symbol: 'TEST', pools: [
      { kind: 2, pool: '0x0000000000000000000000000000000000000002', fee: 100, tickSpacing: 0, nativeEth: false },
      { kind: 2, pool: '0x0000000000000000000000000000000000000003', fee: 500, tickSpacing: 0, nativeEth: false },
    ],
  }];
  const requestedSizes: bigint[][] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case 'FLASHLOAN_PREMIUM_TOTAL': return 5n;
        case 'getConfiguration': return (1n << 56n) | (1n << 63n);
        case 'balanceOf': return parseEther('500');
        case 'latestRoundData': return [0n, 200_000_000_000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n];
        default: throw new Error('Unexpected read');
      }
    },
    multicall: async ({ contracts }: { contracts: { args: [{ amountIn: bigint }] }[] }) => {
      const sizes = contracts.map(({ args }) => args[0].amountIn);
      requestedSizes.push(sizes);
      return sizes.map((amount) => ({ status: 'success', result: [
        requestedSizes.length === 1 ? amount : amount + amount / 2_500n,
      ] }));
    },
  } as unknown as ArbitrumClient;
  const result = await scanArbitrum(client, 100n, markets, false, parseEther('64'), 500);
  const sizes = [parseEther('0.05'), parseEther('0.25')];
  assert.deepEqual(requestedSizes, [[...sizes, ...sizes], [...sizes, ...sizes]]);
  assert.equal(result.quotedRoutes, 4);
  assert.deepEqual(result.opportunities, []);
  assert.equal(result.best, null);
  assert.equal(result.bestQuote?.loanUsd, 100);
  assert.equal(result.bestQuote?.payoutUsd.toFixed(4), '-0.0100');
  assert.equal(result.largestQuote?.loanUsd, 500);
  assert.equal(result.largestQuote?.payoutUsd.toFixed(4), '-0.0500');
  assert.equal(result.sizingAmount, parseEther('0.25'));
});
