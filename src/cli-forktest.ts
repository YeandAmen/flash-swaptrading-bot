// End-to-end test of the LIVE trading path against a local anvil mainnet fork (fake money).
// Run via scripts/fork-test.sh — it starts anvil and sets RPC_URL/SEND_RPC_URL/FORK_MODE/WALLET_KEY_FILE/DATA_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestClient, createWalletClient, formatUnits, http, parseEther, parseUnits, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { ADDR, CONFIG, CORE_TOKENS, DATA_DIR, USDC_DECIMALS } from './config.js';
import { erc20Abi, publicClient } from './chain.js';
import { Engine } from './engine.js';
import { LiveExecutor, PaperExecutor } from './executor.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { discoverMarkets } from './market.js';
import { roundTripCheck } from './safety.js';
import type { Analysis } from './strategy.js';
import { newPortfolio } from './types.js';
import { loadOrCreateWallet } from './wallet.js';

await assertForkTestEnvironment();

const test = createTestClient({ chain: mainnet, mode: 'anvil', transport: http(CONFIG.rpcUrl) });
const wc = createWalletClient({ chain: mainnet, transport: http(CONFIG.rpcUrl) });
const bal = (token: Address, who: Address) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

let engine = new Engine();
engine.wallet = loadOrCreateWallet();
const me = engine.wallet.account.address;
(engine as any).liveExec = new LiveExecutor(engine.wallet.account);
engine.market = await discoverMarkets(() => {}, CORE_TOKENS);
const live = () => engine.state.live;
const held = (sym: string) => live().positions.find((p) => p.symbol === sym);
console.log(`Test wallet ${me}`);

// 0. honeypot/tax simulator: a normal token passes with loss ≈ pool fees
//    (the "unsellable route is rejected" case is checked against mainnet: anvil stalls fetching non-existent pools)
{
  const link = engine.market.tokens.find((x) => x.token.symbol === 'LINK')!;
  const good = await roundTripCheck(link, parseEther('0.05'), engine.market.usdcWeth.fee);
  assert.ok(good.ok && good.hiddenCostPct < 0.005, `LINK passes safety sim (${good.reason})`);
  console.log(`✓ safety sim: LINK ${good.reason}`);
}

// --- fund the throwaway wallet on the fork: 0.05 ETH for gas + 50 USDC from the USDC/WETH pool
await test.setBalance({ address: me, value: parseEther('0.05') });
const whale = engine.market.usdcWeth.address;
await test.impersonateAccount({ address: whale });
await test.setBalance({ address: whale, value: parseEther('1') });
await publicClient.waitForTransactionReceipt({
  hash: await wc.writeContract({ account: whale, address: ADDR.usdc, abi: erc20Abi, functionName: 'transfer', args: [me, parseUnits('50', USDC_DECIMALS)] }),
});
await test.stopImpersonatingAccount({ address: whale });

// 1. deposit detection + readiness
engine.arm();
await engine.tick();
assert.equal(Math.round(live().netDepositsUsd), 50, 'deposit of 50 USDC detected');
assert.ok(engine.liveStatus.ready, `live ready: ${engine.liveStatus.reason}`);
console.log('✓ deposit detected, live trading ready:', engine.liveStatus.reason);

const fakeSignal = (symbol: string): Analysis => ({
  symbol, bars: 999, price: engine.snap!.prices[symbol], change24h: 0, emaFast: 0, emaSlow: 0, emaLong: 0, emaLongSlope: 0,
  rsi: 55, dailyVol: 0.04, momentum: 1.2, trend: 'up', stopPct: 0.06, targetPct: 0.15, score: 1.2, eligible: true, reasons: [],
});
const buy = (sym: string, usdAmt: string) => {
  const t = engine.market.tokens.find((x) => x.token.symbol === sym)!;
  return (engine as any).buy(live(), (engine as any).liveExec, engine.snap!, t, fakeSignal(sym), parseUnits(usdAmt, USDC_DECIMALS), 'test');
};

for (const [symbol, amount] of [['LINK', '20'], ['WETH', '15']] as const) {
  engine.arm(); // the preceding case's Panic leaves spot disarmed
  const t = engine.market.tokens.find((x) => x.token.symbol === symbol)!;
  const usdcBefore = await bal(ADDR.usdc, me);
  const ethBefore = await publicClient.getBalance({ address: me });

  // 2. live BUY through the engine (approve exact amount -> quote -> simulate -> send -> confirm)
  await buy(symbol, amount);
  const pos = held(symbol);
  assert.ok(pos, `${symbol} position opened`);
  const tokBal = await bal(t.token.address, me);
  assert.equal(tokBal.toString(), pos!.qtyRaw, 'position qty equals on-chain balance');
  const spent = Number(formatUnits(usdcBefore - (await bal(ADDR.usdc, me)), USDC_DECIMALS));
  assert.ok(Math.abs(spent - Number(amount)) < 1e-6, `spent exactly ${amount} USDC`);
  const allowance = await publicClient.readContract({ address: ADDR.usdc, abi: erc20Abi, functionName: 'allowance', args: [me, ADDR.swapRouter02] });
  assert.equal(allowance, 0n, 'exact approval fully consumed (no leftover allowance)');
  console.log(`✓ BUY ${symbol}: ${pos!.qty.toPrecision(6)} for ${spent} USDC, gas $${live().trades.at(-1)!.gasUsd.toFixed(4)}`);

  // 3. next tick must not mistake the trade for a deposit/withdrawal
  await engine.tick();
  assert.equal(Math.round(live().netDepositsUsd), 50, 'trade not counted as deposit');
  assert.ok(held(symbol), 'position still tracked after tick');

  // 4. live SELL via panic button path
  engine.arm();
  await engine.panic('live');
  assert.equal(live().positions.length, 0, 'position closed');
  assert.equal(await bal(t.token.address, me), 0n, `${symbol} fully sold`);
  const sell = live().trades.at(-1)!;
  const ethAfter = await publicClient.getBalance({ address: me });
  console.log(`✓ SELL ${symbol}: got ${sell.usd.toFixed(4)} USDC, net P&L $${sell.pnlUsd!.toFixed(4)}, total gas ${formatUnits(ethBefore - ethAfter, 18)} ETH`);
  await engine.tick();
  assert.equal(Math.round(live().netDepositsUsd), 50, 'sell not counted as deposit');
}

// 5. multiple positions at once: two tokens held together, both tracked, panic sells both
{
  engine.arm();
  await buy('LINK', '11');
  assert.equal(await buy('UNI', '11'), false, 'the post-fill wallet must be resampled before another order');
  await engine.tick();
  await buy('UNI', '11');
  assert.equal(live().positions.length, 2, 'two positions open');
  await engine.tick();
  assert.equal(live().positions.length, 2, 'both positions tracked after a tick');
  assert.equal(Math.round(live().netDepositsUsd), 50, 'buys not counted as deposits');
  engine.arm();
  await engine.panic('live');
  assert.equal(live().positions.length, 0, 'panic sold every position');
  const linkT = engine.market.tokens.find((x) => x.token.symbol === 'LINK')!;
  const uniT = engine.market.tokens.find((x) => x.token.symbol === 'UNI')!;
  assert.equal(await bal(linkT.token.address, me), 0n, 'LINK sold');
  assert.equal(await bal(uniT.token.address, me), 0n, 'UNI sold');
  await engine.tick();
  assert.equal(Math.round(live().netDepositsUsd), 50, 'sells not counted as deposits');
  console.log('✓ two positions held at once; panic sold both');
}

// 6. Disarm stops automatic sends; a circuit breaker only blocks entries while explicitly armed.
{
  const t = engine.market.tokens.find((x) => x.token.symbol === 'LINK')!;
  engine.arm();
  await buy('LINK', '12');
  assert.ok(held('LINK'), 'position opened for exit test');
  held('LINK')!.stopPrice = engine.snap!.prices['LINK'] * 1.5; // force a stop-loss
  const nonceBeforeDisarm = await publicClient.getTransactionCount({ address: me });
  engine.disarm();
  await engine.tick();
  assert.ok(held('LINK'), 'position stays tracked while disarmed');
  assert.equal(await publicClient.getTransactionCount({ address: me }), nonceBeforeDisarm, 'disarm stops automatic exits');
  engine.arm();
  live().halted = 'test halt';
  await engine.tick();
  assert.equal(live().positions.length, 0, 'stop-loss exit executed while armed + halted');
  assert.equal(await bal(t.token.address, me), 0n, 'LINK sold by stop-loss');
  console.log('✓ Disarm stops automatic sends; a circuit breaker permits exits after explicit rearm');
  engine.resume('live');
}

// 7. crash right after broadcast: the journaled swap is reconciled from chain, not mistaken for a withdrawal
{
  const t = engine.market.tokens.find((x) => x.token.symbol === 'UNI')!;
  const amountIn = parseUnits('11', USDC_DECIMALS);
  await engine.tick();
  const depBefore = live().netDepositsUsd;
  const pending: NonNullable<Engine['state']['pending']> = {
    side: 'BUY', symbol: 'UNI', amountIn: amountIn.toString(), startedAt: Date.now(), hash: null, deadline: null,
    approvalHashes: [], reason: 'crash test', stopPct: 0.06, targetPct: 0.15, mid: engine.snap!.prices['UNI'],
  };
  engine.state.pending = pending;
  engine.saveState(true);
  await new LiveExecutor(engine.wallet.account).swap({
    path: t.buyPath, tokenIn: ADDR.usdc, tokenOut: t.token.address, amountIn, hops: t.hops, slippageBps: 50,
    gasPriceGwei: 1, ethUsd: engine.snap!.ethUsd,
    onApprovalSigned: (hash) => {
      pending.approvalHashes!.push(hash);
      engine.saveState(true);
    },
    onSwapSigned: (hash, deadline) => {
      pending.hash = hash;
      pending.deadline = deadline;
      engine.saveState(true);
    },
  }, () => {});
  assert.equal(live().positions.length, 0, 'engine has not recorded the trade yet');
  const restarted = new Engine();
  restarted.wallet = engine.wallet;
  restarted.market = engine.market;
  (restarted as any).liveExec = new LiveExecutor(restarted.wallet.account);
  engine = restarted;
  assert.equal(engine.state.armed, false, 'spot remains disarmed while reconciling after restart');
  await engine.tick(); // reconcile from chain
  assert.ok(held('UNI'), 'pending swap reconciled into a UNI position');
  assert.equal(engine.state.pending, null, 'journal cleared');
  await engine.tick();
  assert.ok(Math.abs(live().netDepositsUsd - depBefore) < 0.01, 'reconciled buy not counted as deposit/withdrawal');
  engine.arm();
  await engine.panic('live');
  assert.equal(live().positions.length, 0, 'UNI sold');
  await engine.tick();
  assert.ok(Math.abs(live().netDepositsUsd - depBefore) < 0.01, 'sell after reconcile not counted as deposit');
  console.log(`✓ crashed in-flight swap reconciled from chain; net deposits unchanged ($${live().netDepositsUsd.toFixed(2)})`);
}

// 8a. gas top-up does NOT fire while flat and risk-off (nothing to spend gas on: keep the USDC)
{
  engine.arm();
  await test.setBalance({ address: me, value: parseEther('0.001') });
  await engine.tick();
  assert.equal(engine.regime.riskOn, false, 'fork has no price history, so the market filter is risk-off');
  assert.equal(engine.state.topups.length, 0, 'no top-up while flat + risk-off');
  console.log('✓ no gas top-up while flat and risk-off:', engine.liveStatus.reason);
}

// 8b. critical gas top-up: holding a position whose exit we could not afford -> swap a little USDC to native ETH,
//     booked as a transfer to the gas wallet (not a loss, not a withdrawal)
{
  await test.setBalance({ address: me, value: parseEther('0.05') });
  await engine.tick();
  await buy('LINK', '12');
  assert.ok(held('LINK'), 'position opened');
  await engine.tick();
  const exitNeed = (engine as any).ethForSwap(engine.snap, 2) * 1.5;
  const selfNeed = (engine as any).ethForSwap(engine.snap, 1) * 1.2;
  assert.ok(selfNeed < exitNeed, 'test window exists');
  const lowEth = (selfNeed + exitNeed) / 2;
  await test.setBalance({ address: me, value: parseEther(lowEth.toFixed(12)) });
  const depBefore = live().netDepositsUsd;
  await engine.tick(); // exits checked first (none due), then the critical top-up
  const top = engine.state.topups.at(-1);
  assert.ok(top && top.usd > 0 && top.eth > 0, 'a critical gas top-up was recorded');
  const ethAfter = Number(formatUnits(await publicClient.getBalance({ address: me }), 18));
  assert.ok(ethAfter > lowEth, `ETH balance increased (${lowEth.toFixed(5)} -> ${ethAfter.toFixed(5)})`);
  assert.ok(Math.abs(live().netDepositsUsd - (depBefore - top!.usd)) < 0.01, 'top-up booked as a transfer to the gas wallet');
  const depAfterTopup = live().netDepositsUsd;
  await engine.tick();
  assert.ok(Math.abs(live().netDepositsUsd - depAfterTopup) < 0.01, 'top-up not mistaken for a withdrawal on the next tick');
  assert.equal(engine.state.topups.filter((x) => x.usd > 0).length, 1, 'no second top-up within 15 minutes');
  console.log(`✓ critical gas top-up: ${top!.usd.toFixed(2)} USDC -> ${top!.eth.toFixed(5)} ETH; wallet ${lowEth.toFixed(5)} -> ${ethAfter.toFixed(5)} ETH`);
  engine.arm();
  await engine.panic('live');
  assert.equal(live().positions.length, 0, 'LINK sold after top-up test');
  await engine.tick();
  assert.ok(Math.abs(live().netDepositsUsd - depAfterTopup) < 0.01, 'sell not counted as deposit');
}

// 9. outside withdrawal is detected, not treated as a loss
const usdcNow = await bal(ADDR.usdc, me);
await publicClient.waitForTransactionReceipt({
  hash: await wc.writeContract({ account: engine.wallet.account, address: ADDR.usdc, abi: erc20Abi, functionName: 'transfer', args: [whale, usdcNow / 2n] }),
});
await engine.tick();
assert.ok(live().netDepositsUsd < 30, `withdrawal reduces net deposits (${live().netDepositsUsd})`);
console.log(`✓ withdrawal detected, net deposits now $${live().netDepositsUsd.toFixed(2)}`);

// 10. Test the entry rules using the same fork quotes and a paper executor.
{
  const decisionEngine = new Engine();
  decisionEngine.market = engine.market;
  decisionEngine.regime = { riskOn: true, reason: 'test' };
  decisionEngine.analyses = [fakeSignal('WETH')];
  const paper = decisionEngine.state.paper = newPortfolio('paper', 50);
  const exec = new PaperExecutor();
  const current = engine.snap!;
  const incomplete = { ...current, prices: { ...current.prices } };
  delete incomplete.prices.WETH;
  const enter = (snap: typeof current, now = Date.now()) =>
    (decisionEngine as any).tryEntry(paper, snap, exec, now) as Promise<string>;
  await enter(incomplete);
  assert.equal(paper.positions.length, 0, 'missing token prices must not create positions');
  const decision = await enter(current);
  assert.equal(paper.positions.length, 1, `the same signal with a valid price can enter (${decision})`);
  assert.ok(Number.isInteger(paper.lastEntryHour));
  decisionEngine.analyses = [fakeSignal('UNI')];
  assert.match(await enter(current, paper.lastEntryHour! * 3_600_000 + 1), /hour/);
  assert.equal(paper.positions.length, 1, 'another signal in the same hour cannot enter');
  console.log('✓ Missing token price prevented entry; the hourly entry cap held on the next signal');
}

// 11. A real persistence fault in the disposable test data must stop the spot order before approval.
{
  engine.arm();
  const stateFile = path.join(DATA_DIR, 'state.json');
  const backup = path.join(DATA_DIR, 'test-state-backup.json');
  const nonceBefore = await publicClient.getTransactionCount({ address: me });
  const usdcBefore = await bal(ADDR.usdc, me);
  fs.renameSync(stateFile, backup);
  fs.mkdirSync(stateFile);
  try {
    let bought = false;
    try {
      bought = await buy('LINK', '11');
    } catch { /* the spot journal can surface a storage error directly */ }
    assert.equal(bought, false);
    assert.equal(await publicClient.getTransactionCount({ address: me }), nonceBefore);
    assert.equal(await bal(ADDR.usdc, me), usdcBefore);
    assert.equal(live().positions.length, 0);
  } finally {
    fs.rmdirSync(stateFile);
    fs.renameSync(backup, stateFile);
  }
  engine.disarm();
  console.log('✓ Spot journal storage failure blocked approval and swap');
}

console.log('\nALL FORK TESTS PASSED');
process.exit(0);
