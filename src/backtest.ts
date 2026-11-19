import { ML, RISK, STRATEGY, TOKENS } from './config.js';
import { gasUsd, swapGasUnits } from './executor.js';
import type { History, MarketInfo, TokenMarket } from './market.js';
import { SeriesBase, walkForward, type LogitModel } from './ml.js';
import { analyze, ANALYSIS_WINDOW, checkExit, marketRegime, type Analysis } from './strategy.js';
import type { Position } from './types.js';

export interface BacktestTrade { t: number; side: 'BUY' | 'SELL'; symbol: string; price: number; usd: number; pnlUsd?: number; reason: string }

export interface BacktestResult {
  label: string;
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

/** Per-token precomputed signals over the whole history (computed once, reused by every simulation). */
interface Track {
  sym: string;
  tm: TokenMarket;
  closes: Float64Array;
  first: number;
  eligible: Uint8Array; // rule-based entry signal (excluding the market filter)
  score: Float32Array;
  stopPct: Float32Array;
  targetPct: Float32Array;
  trendDown: Uint8Array;
  mlOk: Uint8Array; // history + volatility filters for ML entries
}

export interface SimContext {
  buckets: number[];
  N: number;
  tracks: Track[];
  riskOn: Uint8Array;
  ethCrash: Uint8Array;
  gasPriceGwei: number;
  ethUsd: number;
  series: Map<string, SeriesBase>;
  eth: SeriesBase;
}

const yieldLoop = () => new Promise((r) => setImmediate(r));

export async function buildContext(history: History, market: MarketInfo, gasPriceGwei: number, ethUsd: number): Promise<SimContext> {
  const master = history.series('WETH');
  const N = master.buckets.length;
  const tracks: Track[] = [];
  const series = new Map<string, SeriesBase>();
  for (const tm of market.tokens) {
    const sym = tm.token.symbol;
    const ser = history.series(sym, master.buckets[N - 1]);
    const map = new Map(ser.buckets.map((b, i) => [b, ser.closes[i]]));
    const closes = new Float64Array(N).fill(NaN);
    let last = NaN;
    master.buckets.forEach((b, i) => {
      const v = map.get(b);
      if (v !== undefined) last = v;
      closes[i] = last;
    });
    const first = closes.findIndex(Number.isFinite);
    if (first < 0) continue;
    const minBars = tm.token.core ? STRATEGY.minBars : TOKENS.minHistoryDays * 24;
    const t: Track = {
      sym, tm, closes, first,
      eligible: new Uint8Array(N), score: new Float32Array(N).fill(-Infinity),
      stopPct: new Float32Array(N).fill(STRATEGY.minStopPct), targetPct: new Float32Array(N).fill(STRATEGY.minStopPct * STRATEGY.rewardRisk),
      trendDown: new Uint8Array(N), mlOk: new Uint8Array(N),
    };
    for (let j = first; j < N; j++) {
      const win = closes.subarray(Math.max(first, j + 1 - ANALYSIS_WINDOW), j + 1); // zero-copy view
      const a = analyze(sym, win, minBars, j + 1 - first);
      t.eligible[j] = a.eligible ? 1 : 0;
      t.score[j] = a.score;
      t.stopPct[j] = a.stopPct;
      t.targetPct[j] = a.targetPct;
      t.trendDown[j] = a.bars >= STRATEGY.minBars && a.trend === 'down' ? 1 : 0;
      t.mlOk[j] = a.bars >= minBars && a.dailyVol >= STRATEGY.minDailyVol ? 1 : 0;
    }
    tracks.push(t);
    series.set(sym, new SeriesBase(closes));
    await yieldLoop();
  }
  const ethTrack = tracks.find((t) => t.sym === 'WETH');
  if (!ethTrack) throw new Error('no WETH history');
  const riskOn = new Uint8Array(N);
  const ethCrash = new Uint8Array(N);
  for (let j = ethTrack.first; j < N; j++) {
    const win = ethTrack.closes.subarray(Math.max(ethTrack.first, j + 1 - ANALYSIS_WINDOW), j + 1);
    const a = analyze('WETH', win, STRATEGY.minBars, j + 1 - ethTrack.first);
    riskOn[j] = marketRegime(a).riskOn ? 1 : 0;
    ethCrash[j] = a.change24h < -0.06 ? 1 : 0;
  }
  return { buckets: master.buckets, N, tracks, riskOn, ethCrash, gasPriceGwei, ethUsd, series, eth: series.get('WETH')! };
}

interface SimPos extends Position { hops: number; fee: number; core: boolean }

export interface SimOptions {
  label: string;
  mode: 'rules' | 'ml';
  from?: number;
  threshold?: number;
  preds?: Map<string, Float32Array>;
  startUsd: number;
}

/**
 * Replays the strategy over hourly on-chain history with up to MAX_POSITIONS positions, charging pool fees,
 * 0.1% slippage and gas (approve + swap each trade) at today's gas price. Stops are evaluated on hourly closes.
 */
export function simulate(ctx: SimContext, o: SimOptions): BacktestResult {
  const slip = 0.001;
  const start = Math.max(o.from ?? 0, STRATEGY.minBars);
  let cash = o.startUsd;
  const positions: SimPos[] = [];
  const cooldown = new Map<string, number>();
  const equity: [number, number][] = [];
  const tradeList: BacktestTrade[] = [];
  let peak = o.startUsd;
  let maxDD = 0;
  let wins = 0;
  let sells = 0;
  let gasPaid = 0;
  const bySym = new Map(ctx.tracks.map((t) => [t.sym, t]));
  const gas = (hops: number) => gasUsd(swapGasUnits(hops, true), ctx.gasPriceGwei, ctx.ethUsd);

  for (let j = start; j < ctx.N; j++) {
    const now = ctx.buckets[j] * 3_600_000;
    const regime = { riskOn: !!ctx.riskOn[j], reason: '' };
    // exits
    for (const pos of [...positions]) {
      const t = bySym.get(pos.symbol)!;
      const price = t.closes[j];
      const a = { trend: t.trendDown[j] ? 'down' : 'flat', bars: 1e9 } as Analysis;
      const ex = checkExit(pos, a, price, regime, now);
      if (!ex.exit) continue;
      const g = gas(pos.hops);
      const usd = pos.qty * price * (1 - pos.fee - slip);
      const pnl = usd - g - pos.costUsd - pos.entryGasUsd;
      cash += usd - g;
      gasPaid += g;
      sells++;
      if (pnl > 0) wins++;
      tradeList.push({ t: now, side: 'SELL', symbol: pos.symbol, price, usd, pnlUsd: pnl, reason: ex.reason });
      cooldown.set(pos.symbol, now + (ex.reason.includes('stop-loss') ? RISK.cooldownHoursAfterStop : RISK.cooldownHoursAfterExit) * 3_600_000);
      positions.splice(positions.indexOf(pos), 1);
    }
    // one entry per hour
    if (positions.length < RISK.maxPositions) {
      const held = new Set(positions.map((p) => p.symbol));
      let best: Track | null = null;
      let bestScore = -Infinity;
      for (const t of ctx.tracks) {
        if (held.has(t.sym) || (cooldown.get(t.sym) ?? 0) > now || !(t.closes[j] > 0)) continue;
        let s: number;
        if (o.mode === 'rules') {
          if (!ctx.riskOn[j] || !t.eligible[j]) continue;
          s = t.score[j];
        } else {
          if (ctx.ethCrash[j] || !t.mlOk[j]) continue;
          const p = o.preds?.get(t.sym)?.[j];
          if (p === undefined || !Number.isFinite(p) || p < (o.threshold ?? 0.6)) continue;
          s = p;
        }
        if (s > bestScore) { bestScore = s; best = t; }
      }
      if (best) {
        const price = best.closes[j];
        const eq = cash + positions.reduce((s, p) => s + p.qty * bySym.get(p.symbol)!.closes[j], 0);
        const stopPct = best.stopPct[j];
        const cap = Math.min(
          cash * RISK.maxAllocPct,
          eq * RISK.maxPositionPct,
          best.tm.token.core ? Infinity : eq * TOKENS.maxAllocPct,
        );
        const size = Math.min(cap, (eq * RISK.riskPerTradePct) / stopPct);
        const g = gas(best.tm.hops);
        const costPct = 2 * (best.tm.poolFeePct + slip) + (2 * g) / size;
        if (size >= RISK.minTradeUsd && costPct <= RISK.maxRoundTripCostPct && best.targetPct[j] >= RISK.costHurdleMult * costPct) {
          const qty = (size * (1 - best.tm.poolFeePct - slip)) / price;
          cash -= size + g;
          gasPaid += g;
          positions.push({
            symbol: best.sym, qty, qtyRaw: '0', entryPrice: size / qty, entryMid: price, entryTime: now,
            costUsd: size, entryGasUsd: g, stopPct, targetPct: best.targetPct[j],
            stopPrice: price * (1 - stopPct), targetPrice: price * (1 + best.targetPct[j]),
            trailActive: false, peakPrice: price,
            breakevenPrice: (size + 2 * g) / (qty * (1 - best.tm.poolFeePct - slip)),
            hops: best.tm.hops, fee: best.tm.poolFeePct, core: best.tm.token.core,
          });
          tradeList.push({ t: now, side: 'BUY', symbol: best.sym, price, usd: size, reason: o.mode === 'ml' ? `ML p=${bestScore.toFixed(2)}` : `score ${bestScore.toFixed(2)}` });
        }
      }
    }
    const eq = cash + positions.reduce((s, p) => s + p.qty * bySym.get(p.symbol)!.closes[j], 0);
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
    equity.push([now, eq]);
  }

  const endUsd = equity.length ? equity[equity.length - 1][1] : o.startUsd;
  const ethT = bySym.get('WETH')!;
  const ethStart = ethT.closes[start];
  const ethEnd = ethT.closes[ctx.N - 1];
  const step = Math.max(1, Math.ceil(equity.length / 300));
  return {
    label: o.label,
    ranAt: Date.now(),
    from: equity[0]?.[0] ?? 0,
    to: equity[equity.length - 1]?.[0] ?? 0,
    hours: equity.length,
    startUsd: o.startUsd,
    endUsd,
    returnPct: endUsd / o.startUsd - 1,
    maxDrawdownPct: maxDD,
    trades: sells,
    wins,
    winRate: sells ? wins / sells : 0,
    gasPaidUsd: gasPaid,
    ethHoldPct: ethStart && ethEnd ? ethEnd / ethStart - 1 : 0,
    assumptions: `$${o.startUsd} start, up to ${RISK.maxPositions} positions, ${ctx.tracks.length} tokens from today's universe (survivorship bias), pool fees + 0.1% slippage per swap, gas at ${ctx.gasPriceGwei.toPrecision(2)} gwei (approve + swap each trade), stops checked on hourly closes`,
    equity: equity.filter((_, i) => i % step === 0 || i === equity.length - 1),
    tradeList: tradeList.slice(-40),
  };
}

export interface MlReport {
  enabled: boolean;
  active: boolean;
  reason: string;
  auc: number | null;
  folds: number;
  oosRows: number;
  baseRate: number | null;
  oosFrom: number;
  threshold: number | null;
  thresholds: { threshold: number; returnPct: number; trades: number; maxDrawdownPct: number }[];
  rulesOos: BacktestResult | null;
  mlOos: BacktestResult | null;
  importance: { name: string; weight: number }[];
}

export interface Research {
  ranAt: number;
  rules: BacktestResult; // rule-based strategy over the whole history
  ml: MlReport;
  model: LogitModel | null;
}

/**
 * Full research pass (like ITB's predict_rolling + simulate): rule-based backtest, walk-forward ML,
 * simulations of ML entries at several probability thresholds on the out-of-sample period, and the gate that
 * decides whether ML drives live entries.
 */
export async function runResearch(history: History, market: MarketInfo, gasPriceGwei: number, ethUsd: number, startUsd: number): Promise<Research> {
  const ctx = await buildContext(history, market, gasPriceGwei, ethUsd);
  const rules = simulate(ctx, { label: 'Rules', mode: 'rules', startUsd });
  const report: MlReport = {
    enabled: ML.mode !== 'off', active: false, reason: '', auc: null, folds: 0, oosRows: 0, baseRate: null, oosFrom: 0,
    threshold: null, thresholds: [], rulesOos: null, mlOos: null, importance: [],
  };
  if (ML.mode === 'off') {
    report.reason = 'ML disabled (ML_MODE=off)';
    return { ranAt: Date.now(), rules, ml: report, model: null };
  }
  const wf = await walkForward(ctx.series, ctx.eth, ctx.N);
  report.auc = wf.auc;
  report.folds = wf.folds;
  report.oosRows = wf.oosRows;
  report.baseRate = wf.oosRows ? wf.positives / wf.oosRows : null;
  report.oosFrom = ctx.buckets[Math.min(wf.oosStart, ctx.N - 1)] * 3_600_000;
  report.importance = wf.importance.slice(0, 8);
  if (!wf.live || wf.folds === 0) {
    report.reason = 'not enough history to train yet';
    return { ranAt: Date.now(), rules, ml: report, model: wf.live };
  }
  report.rulesOos = simulate(ctx, { label: 'Rules (same period)', mode: 'rules', from: wf.oosStart, startUsd });
  let best: BacktestResult | null = null;
  for (const thr of ML.thresholds) {
    const r = simulate(ctx, { label: `ML p≥${thr}`, mode: 'ml', from: wf.oosStart, threshold: thr, preds: wf.preds, startUsd });
    report.thresholds.push({ threshold: thr, returnPct: r.returnPct, trades: r.trades, maxDrawdownPct: r.maxDrawdownPct });
    if (!best || r.returnPct > best.returnPct) { best = r; report.threshold = thr; }
  }
  report.mlOos = best;
  // ML must beat BOTH the rules and simply holding USDC (0%) on data it never saw
  const beatsRules = !!best && best.returnPct > Math.max(0, report.rulesOos.returnPct) && best.trades >= 3;
  const goodAuc = (wf.auc ?? 0) >= ML.minAuc;
  if (ML.mode === 'on') {
    report.active = true;
    report.reason = 'forced on (ML_MODE=on)';
  } else {
    report.active = goodAuc && beatsRules;
    report.reason = report.active
      ? `out-of-sample AUC ${wf.auc!.toFixed(3)} >= ${ML.minAuc} and ML beat both the rules and holding USDC on unseen data`
      : !goodAuc
        ? `out-of-sample AUC ${wf.auc === null ? 'n/a' : wf.auc.toFixed(3)} < ${ML.minAuc}: no reliable edge yet, rules stay in charge`
        : 'ML did not beat both the rules and holding USDC out of sample: rules stay in charge';
  }
  return { ranAt: Date.now(), rules, ml: report, model: wf.live };
}
