import assert from 'node:assert/strict';
import test from 'node:test';
import type { McResult } from '../market.js';
import type { ArbPool } from './pools.js';

process.env.RPC_URL ??= 'http://127.0.0.1:8545';
const { inventoryCanCoverExitFloor: canCover } = await import('./pools.js');
const { describeV4Pool, UNISWAP_V4_MANAGER } = await import('./next-pools.js');
const token = '0x0000000000000000000000000000000000000001';
const v3: ArbPool = { kind: 2, address: token, venue: 'Uniswap v3', fee: 0.003, v2: false };
const q96 = 1n << 96n;
const success = (result: unknown): McResult => ({ status: 'success', result });
const slot = (sqrt: bigint) => success([sqrt, 0, 0, 1, 1, 0, true]);

test('all supported V3 exits apply the spot bound to raw inventory and retain equality', () => {
  const state = slot(2n * q96); // Four units of token1 per unit of token0.
  for (const kind of [2, 3, 4] as const) {
    const exit = { ...v3, kind };
    assert.equal(canCover(1n, exit, state, true, 1n), false, 'nonzero dust cannot produce a wei of WETH');
    assert.equal(canCover(4n, exit, state, true, 1n), true, 'a small trade can still cover the floor');
    assert.equal(canCover(1n, exit, state, false, 4n), true);
    assert.equal(canCover(1n, exit, state, false, 5n), false);
  }
});

test('concentrated bounds preserve one-unit differences across products larger than uint256', () => {
  const state = slot(q96 << 60n); // The squared raw ratio needs 313 bits.
  const small = (1n << 100n) + 1n;
  const large = small << 120n;
  assert.equal(canCover(large, v3, state, true, small), true);
  assert.equal(canCover(large - 1n, v3, state, true, small), false);
  assert.equal(canCover(small, v3, state, false, large), true);
  assert.equal(canCover(small, v3, state, false, large + 1n), false);
});

test('V4 uses the actual ETH or WETH side of its static hook-free pool key', () => {
  for (const nativeEth of [true, false]) {
    const v4 = describeV4Pool({ token, fee: 500, tickSpacing: 10, nativeEth })!;
    const exit: ArbPool = { ...v3, address: UNISWAP_V4_MANAGER, kind: 5, v4 };
    const state = success([2n * q96, 0, 0, 500]);
    assert.equal(v4.quoteIs0, nativeEth);
    assert.equal(canCover(1n, exit, state, !v4.quoteIs0, 1n), !v4.quoteIs0);
    assert.equal(canCover(0n, exit, success([q96, 0, 0, 3000]), true, 1n), true, 'unknown fee state');
  }
});

test('V2 retains its reserve bound and unsupported or invalid snapshots permit exact evaluation', () => {
  const reserves = success([20n, 10n, 0]);
  for (const kind of [0, 1, 6] as const) {
    const exit = { ...v3, v2: true, kind };
    assert.equal(canCover(1n, exit, reserves, true, 2n), true);
    assert.equal(canCover(1n, exit, reserves, false, 2n), false);
  }
  for (const state of [undefined, { status: 'failure' } as const, success(null), success([]),
    success([q96, 0, 0, 1, 1, 0, false]), slot(0n), slot(4295128738n),
    slot(1461446703485210103287273052203988822378723970342n), slot(1n << 160n)]) {
    assert.equal(canCover(0n, v3, state, true, 1n), true);
  }
  for (const kind of [undefined, 5, 7] as const) {
    assert.equal(canCover(0n, { ...v3, kind }, slot(q96), true, 1n), true);
  }
  assert.equal(canCover(undefined, v3, slot(q96), true, 1n), true);
  assert.equal(canCover(-1n, v3, slot(q96), true, 1n), true);
  assert.equal(canCover(0n, v3, slot(q96), true, 0n), true);
});

test('the AMPL entry at Ethereum block 26474123 cannot fund any of its three observed exits', () => {
  // Hash 0x369c3763c8789a8c885099723864f8bf57c6e867ea0369f82c36a81fecaffbcc.
  const ampl = '0xD46bA6D942050d489DBd938a2C909A5d5039A161';
  const v4 = describeV4Pool({ token: ampl, fee: 100, tickSpacing: 1, nativeEth: true })!;
  const cases: [ArbPool, McResult, bigint][] = [
    [{ ...v3, kind: 1, v2: true }, success([10754511053446836602n, 14023454676012n, 0]), 766894n],
    [{ ...v3, kind: 0, v2: true }, success([105064249644464591837n, 137008313741294n, 0]), 766845n],
    [{ ...v3, kind: 5, address: UNISWAP_V4_MANAGER, v4 }, success([116314957521664444736932107n, -130483, 102425, 100]), 463968n],
  ];
  const walletFloor = 29_034_834_484_604n; // $0.05 at the block's Chainlink ETH/USD price.
  for (const [exit, state, maxWholeWei] of cases) {
    assert.equal(canCover(1n, exit, state, true, walletFloor), false);
    assert.equal(canCover(1n, exit, state, true, maxWholeWei), true);
    assert.equal(canCover(1n, exit, state, true, maxWholeWei + 1n), false);
    assert.equal(canCover(100_000_000n, exit, state, true, walletFloor), true);
  }
});
