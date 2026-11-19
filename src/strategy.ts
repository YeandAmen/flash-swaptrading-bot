import { STRATEGY as S } from './config.js';
import type { Position } from './types.js';

// ---------------------------------------------------------------- indicators
/** Plain arrays or typed-array views (the backtest passes zero-copy Float64Array windows). */
export type Closes = ArrayLike<number> & { slice(start?: number, end?: number): ArrayLike<number> };

export function emaLast(values: ArrayLike<number>, period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsiLast(values: ArrayLike<number>, period: number): number {
  if (values.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function stdev(arr: ArrayLike<number>): number {
  const n = arr.length;
  if (n < 2) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += arr[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (arr[i] - m) ** 2;
  return Math.sqrt(v / (n - 1));
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------- analysis
export interface Analysis {
  symbol: string;
  bars: number;
  price: number;
  change24h: number;
  emaFast: number;
  emaSlow: number;
  emaLong: number;
  emaLongSlope: number;
  rsi: number;
  dailyVol: number;
  momentum: number; // 3-day return in units of its own volatility
  trend: 'up' | 'down' | 'flat';
  stopPct: number;
  targetPct: number;
  score: number;
  eligible: boolean;
  reasons: string[];
}

/** How many trailing hourly bars `analyze` actually reads (callers may pass just this window). */
export const ANALYSIS_WINDOW = S.emaLong * 3 + 30;

/**
 * `closes` = hourly closes, last element = latest price.
 * `minBars`: history required before the token may be bought (longer for non-core tokens).
 * `totalBars`: full history length when `closes` is only the trailing window.
 */
export function analyze(symbol: string, closes: Closes, minBars: number = S.minBars, totalBars?: number): Analysis {
  const n = closes.length;
  const have = totalBars ?? n;
  const price = closes[n - 1] ?? 0;
  const base: Analysis = {
    symbol, bars: have, price, change24h: 0, emaFast: price, emaSlow: price, emaLong: price, emaLongSlope: 0, rsi: 50, dailyVol: 0,
    momentum: 0, trend: 'flat', stopPct: S.minStopPct, targetPct: S.minStopPct * S.rewardRisk,
    score: -Infinity, eligible: false, reasons: [],
  };
  if (n < S.minBars) {
    base.reasons.push(`warming up (${have}/${minBars} hourly bars)`);
    return base;
  }
  const tail = closes.slice(-Math.max(S.volLookback + 1, S.emaSlow * 4));
  const emaFast = emaLast(tail, S.emaFast);
  const emaSlow = emaLast(tail, S.emaSlow);
  const emaLong = emaLast(closes.slice(-S.emaLong * 3), S.emaLong);
  const emaLongPrev = emaLast(closes.slice(-S.emaLong * 3 - 24, -24), S.emaLong);
  const emaLongSlope = emaLong / emaLongPrev - 1; // 24h change of the long-term EMA
  const rsi = rsiLast(closes.slice(-(S.rsiPeriod * 6)), S.rsiPeriod);
  const volWin = closes.slice(-(S.volLookback + 1));
  const rets: number[] = [];
  for (let i = 1; i < volWin.length; i++) rets.push(Math.log(volWin[i] / volWin[i - 1]));
  const hourlyVol = Math.max(stdev(rets), 0.0008);
  const dailyVol = hourlyVol * Math.sqrt(24);
  const lb = Math.min(S.momLookback, n - 1);
  const momentum = Math.log(price / closes[n - 1 - lb]) / (hourlyVol * Math.sqrt(lb));
  const change24h = price / closes[n - 1 - Math.min(24, n - 1)] - 1;
  const trend: Analysis['trend'] =
    price > emaSlow && emaFast > emaSlow ? 'up' : price < emaSlow && emaFast < emaSlow ? 'down' : 'flat';
  const stopPct = clamp(S.stopVolMult * dailyVol, S.minStopPct, S.maxStopPct);
  const targetPct = stopPct * S.rewardRisk;
  const trendStrength = (emaFast / emaSlow - 1) / dailyVol;

  const reasons: string[] = [];
  if (trend !== 'up') reasons.push(`trend ${trend} (needs price & EMA${S.emaFast} above EMA${S.emaSlow})`);
  if (price < emaLong) reasons.push(`below EMA${S.emaLong} (long-term downtrend)`);
  if (momentum < S.minMomentumSigma) reasons.push(`momentum ${momentum.toFixed(2)}σ < ${S.minMomentumSigma}σ`);
  if (rsi > S.rsiMax) reasons.push(`RSI ${rsi.toFixed(0)} overbought (> ${S.rsiMax})`);
  if (rsi < S.rsiMin) reasons.push(`RSI ${rsi.toFixed(0)} weak (< ${S.rsiMin})`);
  if (change24h < S.max24hDrop) reasons.push(`falling ${(change24h * 100).toFixed(1)}% in 24h`);
  if (dailyVol < S.minDailyVol) reasons.push(`too stable (daily vol ${(dailyVol * 100).toFixed(2)}% — pegged asset?)`);
  if (have < minBars) reasons.push(`too new: ${(have / 24).toFixed(0)}/${(minBars / 24).toFixed(0)} days of history`);

  return {
    symbol, bars: have, price, change24h, emaFast, emaSlow, emaLong, emaLongSlope, rsi, dailyVol, momentum, trend, stopPct, targetPct,
    score: momentum + trendStrength, eligible: reasons.length === 0, reasons,
  };
}

export interface Regime { riskOn: boolean; reason: string }

/** Market filter: ETH leads the whole ERC-20 market. No new buys while ETH is in a downtrend or crashing. */
export function marketRegime(eth: Analysis | undefined): Regime {
  if (!eth || eth.bars < S.minBars) return { riskOn: false, reason: 'ETH history warming up' };
  if (eth.price < eth.emaLong) return { riskOn: false, reason: `ETH below its ${S.emaLong}h EMA (long-term downtrend)` };
  if (eth.emaLongSlope <= 0) return { riskOn: false, reason: `ETH ${S.emaLong}h EMA still falling (bear market bounce)` };
  if (eth.trend === 'down') return { riskOn: false, reason: 'ETH in short-term downtrend (EMA20 < EMA50)' };
  if (eth.change24h < -0.06) return { riskOn: false, reason: `ETH crashed ${(eth.change24h * 100).toFixed(1)}% in 24h` };
  return { riskOn: true, reason: eth.trend === 'up' ? 'ETH uptrend' : 'ETH neutral, above long-term EMA' };
}

export function pickEntry(analyses: Analysis[], cooldowns: Record<string, number>, nowMs: number): Analysis | null {
  const c = analyses
    .filter((a) => a.eligible && !((cooldowns[a.symbol] ?? 0) > nowMs))
    .sort((x, y) => y.score - x.score);
  return c[0] ?? null;
}

export interface ExitCheck { exit: boolean; reason: string }

/** Mutates trailing fields on `pos`; returns whether to exit now. */
export function checkExit(pos: Position, a: Analysis | undefined, price: number, regime: Regime, nowMs: number): ExitCheck {
  pos.peakPrice = Math.max(pos.peakPrice, price);
  const stopDist = pos.entryMid * pos.stopPct;
  if (!pos.trailActive && price >= pos.entryMid + stopDist * S.trailActivateR) pos.trailActive = true;
  if (pos.trailActive) {
    const trail = pos.peakPrice - stopDist * S.trailFactor;
    pos.stopPrice = Math.max(pos.stopPrice, trail, pos.breakevenPrice);
  }
  if (!regime.riskOn) pos.stopPrice = Math.max(pos.stopPrice, price * (1 - pos.stopPct / 2));

  if (price <= pos.stopPrice) return { exit: true, reason: pos.trailActive ? 'trailing stop hit' : 'stop-loss hit' };
  if (price >= pos.targetPrice) return { exit: true, reason: 'take-profit hit' };
  if (a && a.bars >= S.minBars && a.trend === 'down') return { exit: true, reason: 'trend broke down' };
  const heldH = (nowMs - pos.entryTime) / 3_600_000;
  if (heldH >= S.timeStopHours && price / pos.breakevenPrice - 1 < S.timeStopMinPnl) {
    return { exit: true, reason: `time stop (${heldH.toFixed(0)}h without progress)` };
  }
  return { exit: false, reason: '' };
}
