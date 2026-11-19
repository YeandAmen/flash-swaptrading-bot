import { RISK, STRATEGY, TOKENS } from './config.js';
import { gasUsd, swapGasUnits } from './executor.js';
import type { History, MarketInfo } from './market.js';
import { analyze, ANALYSIS_WINDOW, checkExit, marketRegime, pickEntry } from './strategy.js';
import type { Position } from './types.js';

export interface BacktestTrade { t: number; side: 'BUY' | 'SELL'; symbol: string; price: number; usd: number; pnlUsd?: number; reason: string }

export interface BacktestResult {
  ranAt: number;
  from: number;
  to: number;
  hours: number;
  startUsd: number;
  endUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  winRate: number;
  gasPaidUsd: number;
  ethHoldPct: number;
  assumptions: string;
  equity: [number, number][];
  tradeList: BacktestTrade[];
}

/**
 * Replays the exact same strategy functions over the stored hourly on-chain price history,
 * charging pool fees, slippage and gas at today's gas price. Stops are evaluated on hourly closes.
 */
export function runBacktest(history: History, market: MarketInfo, startUsd: number, gasPriceGwei: number, ethUsd: number): BacktestResult {
  const syms = market.tokens.map((t) => t.token.symbol);
  const master = history.series('WETH');
  const N = master.buckets.length;
  const aligned: Record<string, number[]> = {};
  for (const s of syms) {
    const ser = history.series(s, master.buckets[N - 1]);
    const map = new Map(ser.buckets.map((b, i) => [b, ser.closes[i]]));
    let last = NaN;
    aligned[s] = master.buckets.map((b) => {
      const v = map.get(b);
      if (v !== undefined) last = v;
      return last;
    });
  }
  const firstIdx: Record<string, number> = {};
  for (const s of syms) firstIdx[s] = aligned[s].findIndex(Number.isFinite);
  const minBarsOf: Record<string, number> = {};
  for (const t of market.tokens) minBarsOf[t.token.symbol] = t.token.core ? STRATEGY.minBars : TOKENS.minHistoryDays * 24;
  const slip = 0.001;
  let cash = startUsd;
  let pos: (Position & { hops: number; fee: number }) | null = null;
  const cooldowns: Record<string, number> = {};
  const equity: [number, number][] = [];
  const tradeList: BacktestTrade[] = [];
  let peak = startUsd;
  let maxDD = 0;
  let wins = 0;
  let sells = 0;
  let gasPaid = 0;

  const startIdx = Math.min(STRATEGY.minBars, N - 1);
  for (let i = startIdx; i < N; i++) {
    const now = master.buckets[i] * 3_600_000;
    const analyses = syms
      .filter((s) => firstIdx[s] >= 0 && firstIdx[s] <= i)
      .map((s) => analyze(s, aligned[s].slice(Math.max(firstIdx[s], i + 1 - ANALYSIS_WINDOW), i + 1), minBarsOf[s], i + 1 - firstIdx[s]));
    const regime = marketRegime(analyses.find((a) => a.symbol === 'WETH'));

    if (pos) {
      const price = aligned[pos.symbol][i];
      const ex = checkExit(pos, analyses.find((a) => a.symbol === pos!.symbol), price, regime, now);
      if (ex.exit) {
        const g = gasUsd(swapGasUnits(pos.hops, true), gasPriceGwei, ethUsd);
        const usd = pos.qty * price * (1 - pos.fee - slip);
        const pnl = usd - g - pos.costUsd - pos.entryGasUsd;
        cash += usd - g;
        gasPaid += g;
        sells++;
        if (pnl > 0) wins++;
        tradeList.push({ t: now, side: 'SELL', symbol: pos.symbol, price, usd, pnlUsd: pnl, reason: ex.reason });
        cooldowns[pos.symbol] = now + (ex.reason.includes('stop-loss') ? RISK.cooldownHoursAfterStop : RISK.cooldownHoursAfterExit) * 3_600_000;
        pos = null;
      }
    } else if (regime.riskOn) {
      const cand = pickEntry(analyses, cooldowns, now);
      if (cand) {
        const tm = market.tokens.find((t) => t.token.symbol === cand.symbol)!;
        const cap = tm.token.core ? cash * RISK.maxAllocPct : Math.min(cash * RISK.maxAllocPct, cash * TOKENS.maxAllocPct);
        const size = Math.min(cap, (cash * RISK.riskPerTradePct) / cand.stopPct);
        const g = gasUsd(swapGasUnits(tm.hops, true), gasPriceGwei, ethUsd);
        const costPct = 2 * (tm.poolFeePct + slip) + (2 * g) / size;
        if (size >= RISK.minTradeUsd && costPct <= RISK.maxRoundTripCostPct && cand.targetPct >= RISK.costHurdleMult * costPct) {
          const qty = (size * (1 - tm.poolFeePct - slip)) / cand.price;
          cash -= size + g;
          gasPaid += g;
          pos = {
            symbol: cand.symbol, qty, qtyRaw: '0', entryPrice: size / qty, entryMid: cand.price, entryTime: now,
            costUsd: size, entryGasUsd: g, stopPct: cand.stopPct, targetPct: cand.targetPct,
            stopPrice: cand.price * (1 - cand.stopPct), targetPrice: cand.price * (1 + cand.targetPct),
            trailActive: false, peakPrice: cand.price,
            breakevenPrice: (size + 2 * g) / (qty * (1 - tm.poolFeePct - slip)),
            hops: tm.hops, fee: tm.poolFeePct,
          };
          tradeList.push({ t: now, side: 'BUY', symbol: cand.symbol, price: cand.price, usd: size, reason: `score ${cand.score.toFixed(2)}` });
        }
      }
    }
    const eq = cash + (pos ? pos.qty * aligned[pos.symbol][i] : 0);
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
    equity.push([now, eq]);
  }

  const endUsd = equity.length ? equity[equity.length - 1][1] : startUsd;
  const ethStart = aligned['WETH'][startIdx];
  const ethEnd = aligned['WETH'][N - 1];
  const step = Math.max(1, Math.ceil(equity.length / 300));
  return {
    ranAt: Date.now(),
    from: equity[0]?.[0] ?? 0,
    to: equity[equity.length - 1]?.[0] ?? 0,
    hours: equity.length,
    startUsd,
    endUsd,
    returnPct: endUsd / startUsd - 1,
    maxDrawdownPct: maxDD,
    trades: sells,
    wins,
    winRate: sells ? wins / sells : 0,
    gasPaidUsd: gasPaid,
    ethHoldPct: ethStart && ethEnd ? ethEnd / ethStart - 1 : 0,
    assumptions: `$${startUsd} start, Uniswap pool fees + 0.1% slippage per swap, gas at ${gasPriceGwei.toPrecision(2)} gwei (approve + swap each trade), stops checked on hourly closes, ${syms.length} tokens from today's universe (survivorship bias)`,
    equity: equity.filter((_, i) => i % step === 0 || i === equity.length - 1),
    tradeList: tradeList.slice(-40),
  };
}
