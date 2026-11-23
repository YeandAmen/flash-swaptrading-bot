import assert from 'node:assert/strict';
import test from 'node:test';
import { BaseError, ContractFunctionExecutionError, formatEther, parseEther, type Address } from 'viem';
import { scanArbitrum, type ArbitrumClient } from './market.js';

const weth = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const hash = `0x${'ab'.repeat(32)}` as const;
const q96 = 1n << 96n, q192 = q96 * q96;
const depth = parseEther('2000'), feeScale = 1_000_000n;
const tiers = [[2, 100, 0], [2, 500, 0], [2, 3000, 0], [2, 10000, 0],
  [5, 8, 1], [5, 1000, 20], [5, 3000, 60]] as const;
const markets: Parameters<typeof scanArbitrum>[2] = Array.from({ length: 9 }, (_, i) => ({
  symbol: `A${i}`, token: `0xe${(i + 1).toString(16).padStart(39, '0')}`,
  pools: tiers.map(([kind, fee, tickSpacing], j) => ({ kind, fee, tickSpacing, nativeEth: kind === 5,
    pool: `0x${(kind === 2 ? 10 * i + j + 1 : 1000).toString(16).padStart(40, '0')}` })),
}));
const pools = markets.flatMap(market => market.pools.map(pool => ({ market, pool })));
const price = ({ market, pool }: typeof pools[number]) =>
  market === markets[8] && pool.kind === 2 && pool.fee === 100 ? q96 * 10_006n / 10_000n : q96;
const outOfGas = { status: 'failure', error: new ContractFunctionExecutionError(
  new BaseError('RPC failure', { details: 'out of gas' }), { abi: [], functionName: 'aggregate3' }) };
type QuoteArgs = { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; zeroForOne: boolean;
  exactAmount: bigint; poolKey?: { currency1: Address; fee: number } };
type Sell = { key: string; token: Address; payout: bigint };

async function run(maxMisses: number, blockNumber = 215n, unknownToken?: Address) {
  const loans = new Map<string, bigint>();
  const initial: Sell[] = [], missing: Sell[] = [], retried: Sell[] = [];
  const header = async () => ({ hash, number: blockNumber });
  const multicall = async ({ batchSize, contracts, blockHash, requireCanonical }: { batchSize?: number;
    contracts: { args: [QuoteArgs] }[]; blockHash?: string; requireCanonical?: boolean }) => {
    if (!batchSize) return pools.map(pair => pair.market.token === unknownToken ? { status: 'failure' } : {
      status: 'success', result: pair.pool.kind === 5 ? [price(pair), 0, 0, pair.pool.fee] : [price(pair), 0, 0, 1, 1, 0, true],
    });
    assert.equal(blockHash, hash);
    assert.equal(requireCanonical, true);
    return contracts.map(({ args: [a] }) => {
      const buy = a.poolKey ? a.zeroForOne : a.tokenIn === weth;
      const token = a.poolKey?.currency1 ?? (buy ? a.tokenOut : a.tokenIn);
      const fee = a.poolKey?.fee ?? a.fee, kind = a.poolKey ? 5 : 2;
      const pair = pools.find(({ market, pool }) => market.token === token && pool.kind === kind && pool.fee === fee)!;
      const size = a.exactAmount ?? a.amountIn;
      const square = price(pair) ** 2n;
      const [n, d] = buy ? [square, q192] : [q192, square];
      const inputAfterFee = size * (feeScale - BigInt(fee));
      const out = inputAfterFee * n * depth / ((feeScale * depth + inputAfterFee) * d);
      if (buy) loans.set(token + '/' + out, size);
      else {
        const loan = loans.get(token + '/' + size)!;
        const payout = out - loan - (loan * 5n + 5000n) / 10000n;
        const row = { key: [token, kind, fee, size].join('/'), token, payout };
        if (batchSize === 6000) {
          initial.push(row);
          if (missing.length < maxMisses) { missing.push(row); return outOfGas; }
        } else {
          assert.equal(batchSize, 1400);
          retried.push(row);
        }
      }
      return { status: 'success', result: kind === 5 ? [out, 60000n] : [out, price(pair), 0, 60000n] };
    });
  };
  const client = { getBlock: header, multicall, readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === 'getConfiguration') return (1n << 56n) | (1n << 63n);
    if (functionName === 'balanceOf') return depth;
    assert.equal(functionName, 'FLASHLOAN_PREMIUM_TOTAL');
    return 5n;
  } } as unknown as ArbitrumClient;
  const result = await scanArbitrum(client, blockNumber, markets, false, undefined, 1_000_000, { auditScan: 0 },
    Promise.resolve(2000), { blockHash: hash, primary: client, alternate: client });
  return { result, initial, missing, retried };
}

test('crowded sell retries recover repayable trades ahead of known losing audits within the existing budget', async t => {
  const full = await run(0), reduced = await run(Infinity);
  assert.deepEqual(full.initial, reduced.initial);
  assert.equal(reduced.initial.length, 215);
  // At block 215 the former block-modulo rotation started at index zero.
  const priorBest = reduced.initial.slice(0, 96).reduce((best, r) => r.payout > best ? r.payout : best, -depth);
  assert.ok(priorBest < 0n);
  assert.equal(reduced.retried.length, 96);
  assert.equal(reduced.result.quoteRecovery.alternateAttempted, 96);
  assert.equal(reduced.result.quoteRecovery.remaining, 119);
  assert.deepEqual(reduced.result.opportunities, full.result.opportunities, 'both winners preserve their exact route and payout');
  assert.equal(full.result.opportunities.filter(o => Number(formatEther(o.payout)) * 2000 > 0.05).length, 2);
  t.diagnostic(`Previous best $${(Number(formatEther(priorBest)) * 2000).toFixed(6)}; new best $${reduced.result.best?.payoutUsd.toFixed(6)} after lender fee, before gas.`);
});

test('96 or fewer missing sells keep the original request order and exact results', async () => {
  const full = await run(0);
  for (const n of [1, 96]) {
    const retried = await run(n);
    assert.deepEqual(retried.retried, retried.missing);
    assert.equal(retried.result.quoteRecovery.remaining, 0);
    assert.equal(retried.result.quotedRoutes, full.result.quotedRoutes);
    assert.deepEqual(retried.result.opportunities, full.result.opportunities);
  }
});

test('sustained overflow rotates unknown-price sells and leaves one slot for rotating audit routes', async () => {
  const unknown = markets[7].token;
  const first = await run(Infinity, 215n, unknown), next = await run(Infinity, 216n, unknown);
  const audit = (r: Sell) => r.token !== unknown && r.token !== markets[8].token;
  for (const pass of [first, next]) {
    assert.ok(pass.missing.filter(r => r.token === unknown).length > 96);
    assert.equal(pass.retried.length, 96);
    assert.ok(pass.retried.filter(r => r.token === unknown).length > 80);
    assert.equal(pass.retried.filter(audit).length, 1);
  }
  assert.notDeepEqual(first.retried.find(audit), next.retried.find(audit));
  assert.notDeepEqual(first.retried.filter(r => r.token === unknown), next.retried.filter(r => r.token === unknown));
});
