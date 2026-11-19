import { ML, RISK, STRATEGY, TOKENS } from './config.js';
import { gasUsd, swapGasUnits } from './executor.js';
import type { History, MarketInfo, TokenMarket } from './market.js';
import { auc, label, SeriesBase, walkForward, type LogitModel } from './ml.js';
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
  observed: Uint8Array;
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
    const recorded = history.bars[sym];
    const closes = new Float64Array(N).fill(NaN);
    const observed = new Uint8Array(N);
    let last = NaN;
    master.buckets.forEach((b, i) => {
      const v = recorded?.get(b);
      if (v !== undefined && Number.isFinite(v) && v > 0) { last = v; observed[i] = 1; }
      closes[i] = last;
    });
    const first = closes.findIndex(Number.isFinite);
    if (first < 0) continue;
    const minBars = tm.token.core ? STRATEGY.minBars : TOKENS.minHistoryDays * 24;
    const t: Track = {
      sym, tm, closes, observed, first,
      eligible: new Uint8Array(N), score: new Float32Array(N).fill(-Infinity),
      stopPct: new Float32Array(N).fill(STRATEGY.minStopPct), targetPct: new Float32Array(N).fill(STRATEGY.minStopPct * STRATEGY.rewardRisk),
      trendDown: new Uint8Array(N), mlOk: new Uint8Array(N),
    };
    let samples = 0;
    for (let j = first; j < N; j++) {
      samples += observed[j];
      const win = closes.subarray(Math.max(first, j + 1 - ANALYSIS_WINDOW), j + 1); // zero-copy view
      const a = analyze(sym, win, minBars, samples);
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
  let ethSamples = 0;
  for (let j = ethTrack.first; j < N; j++) {
    ethSamples += ethTrack.observed[j];
    const win = ethTrack.closes.subarray(Math.max(ethTrack.first, j + 1 - ANALYSIS_WINDOW), j + 1);
    const a = analyze('WETH', win, STRATEGY.minBars, ethSamples);
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
  to?: number; // exclusive execution bar
  threshold?: number;
  preds?: Map<string, Float32Array>;
  startUsd: number;
}

/**
 * Replays the strategy over hourly on-chain history with up to MAX_POSITIONS positions, charging pool fees,
 * 0.1% slippage and gas (approve + swap each trade) at today's gas price.
 * An observed close can trigger a trade at the next observed hourly close only.
 */
export function simulate(ctx: SimContext, o: SimOptions): BacktestResult {
  const slip = 0.001;
  const start = Math.max(o.from ?? 0, STRATEGY.minBars);
  const end = Math.min(o.to ?? ctx.N, ctx.N);
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
  let day = -Infinity;
  let dayStartEquity = o.startUsd;
  let dailyPaused = false;
  let halted = false;
  const bySym = new Map(ctx.tracks.map((t) => [t.sym, t]));
  const eth = bySym.get('WETH')!;
  const gas = (hops: number) => gasUsd(swapGasUnits(hops, true), ctx.gasPriceGwei, ctx.ethUsd);
  const markEquity = (index: number) => cash + positions.reduce((total, pos) => total + pos.qty * bySym.get(pos.symbol)!.closes[index], 0);

  for (let j = start; j < end; j++) {
    const signal = j - 1;
    const now = ctx.buckets[j] * 3_600_000;
    const signalTime = ctx.buckets[signal] * 3_600_000;
    const regime = { riskOn: Boolean(ctx.riskOn[signal]), reason: '' };
    const priorEquity = markEquity(signal);
    const signalDay = Math.floor(ctx.buckets[signal] / 24);
    if (signalDay !== day) {
      day = signalDay;
      dayStartEquity = priorEquity;
      dailyPaused = false;
    }
    if (priorEquity < dayStartEquity * (1 - RISK.dailyLossLimitPct)) dailyPaused = true;
    if (priorEquity < peak * (1 - RISK.maxDrawdownPct)) halted = true;

    // exits
    let sold = false;
    for (const pos of [...positions]) {
      const t = bySym.get(pos.symbol)!;
      if (!t.observed[signal] || !t.observed[j]) continue;
      const price = t.closes[j];
      const a = { trend: t.trendDown[signal] ? 'down' : 'flat', bars: 1e9 } as Analysis;
      const ex = checkExit(pos, a, t.closes[signal], regime, signalTime);
      if (!ex.exit) continue;
      sold = true;
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
    if (!sold && !dailyPaused && !halted && eth.observed[signal] && positions.length < RISK.maxPositions) {
      const held = new Set(positions.map((p) => p.symbol));
      let best: Track | null = null;
      let bestScore = -Infinity;
      for (const t of ctx.tracks) {
        if (held.has(t.sym) || (cooldown.get(t.sym) ?? 0) > signalTime || !t.observed[signal]) continue;
        let s: number;
        if (o.mode === 'rules') {
          if (!regime.riskOn || !t.eligible[signal]) continue;
          s = t.score[signal];
        } else {
          if (ctx.ethCrash[signal] || !t.mlOk[signal]) continue;
          const p = o.preds?.get(t.sym)?.[signal];
          if (p === undefined || !Number.isFinite(p) || p < (o.threshold ?? 2)) continue; // p = lift over base rate
          s = p;
        }
        if (s > bestScore) { bestScore = s; best = t; }
      }
      if (best?.observed[j]) {
        const price = best.closes[j];
        const stopPct = best.stopPct[signal];
        const targetPct = best.targetPct[signal];
        const g = gas(best.tm.hops);
        const longTail = positions.reduce((total, pos) => pos.core ? total : total + pos.qty * bySym.get(pos.symbol)!.closes[signal], 0);
        const cap = Math.min(
          cash * RISK.maxAllocPct,
          cash - g,
          priorEquity * RISK.maxPositionPct,
          best.tm.token.core ? Infinity : priorEquity * TOKENS.maxAllocPct - longTail,
        );
        const size = Math.floor(Math.min(cap, (priorEquity * RISK.riskPerTradePct) / stopPct) * 100) / 100;
        const costPct = 2 * (best.tm.poolFeePct + slip) + (2 * g) / size;
        if (size >= RISK.minTradeUsd && costPct <= RISK.maxRoundTripCostPct && targetPct >= RISK.costHurdleMult * costPct) {
          const qty = (size * (1 - best.tm.poolFeePct - slip)) / price;
          cash -= size + g;
          gasPaid += g;
          positions.push({
            symbol: best.sym, qty, qtyRaw: '0', entryPrice: size / qty, entryMid: price, entryTime: now,
            costUsd: size, entryGasUsd: g, stopPct, targetPct,
            stopPrice: price * (1 - stopPct), targetPrice: price * (1 + targetPct),
            trailActive: false, peakPrice: price,
            breakevenPrice: (size + 2 * g) / (qty * (1 - best.tm.poolFeePct - slip)),
            hops: best.tm.hops, fee: best.tm.poolFeePct, core: best.tm.token.core,
          });
          tradeList.push({ t: now, side: 'BUY', symbol: best.sym, price, usd: size, reason: o.mode === 'ml' ? `ML lift ${bestScore.toFixed(1)}x` : `score ${bestScore.toFixed(2)}` });
        }
      }
    }
    const eq = markEquity(j);
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, 1 - eq / peak);
    equity.push([now, eq]);
  }

  const endUsd = equity.length ? equity[equity.length - 1][1] : o.startUsd;
  const ethStart = eth.closes[start];
  const ethEnd = eth.closes[end - 1];
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
    ethHoldPct: equity.length && ethStart > 0 && ethEnd > 0 ? ethEnd / ethStart - 1 : 0,
    assumptions: `$${o.startUsd} start, up to ${RISK.maxPositions} positions, ${ctx.tracks.length} tokens from today's universe (survivorship bias), today's pool fees and gas at ${ctx.gasPriceGwei.toPrecision(2)} gwei, 0.1% assumed slippage, signals and stops filled one hourly close later when both closes are observed`,
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
  oosFrom: number; // first signal timestamp in the final holdout
  threshold: number | null; // chosen lift (x base rate)
  thresholds: { threshold: number; returnPct: number; trades: number; maxDrawdownPct: number }[]; // calibration only
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

function holdoutLabels(ctx: SimContext, predictions: Map<string, Float32Array>, start: number) {
  const scores: number[] = [];
  const labels: number[] = [];
  for (const track of ctx.tracks) {
    const p = predictions.get(track.sym);
    const series = ctx.series.get(track.sym);
    if (!p || !series) continue;
    // Labels need a measured close at each step: an imputed gap may conceal a barrier touch.
    let missing = 0;
    for (let j = start; j < Math.min(ctx.N, start + ML.horizonHours); j++) missing += 1 - track.observed[j];
    for (let j = start; j + ML.horizonHours < ctx.N; j++) {
      missing += 1 - track.observed[j + ML.horizonHours];
      if (missing === 0 && Number.isFinite(p[j])) {
        const outcome = label(series, j);
        if (outcome >= 0) { scores.push(p[j]); labels.push(outcome); }
      }
      missing -= 1 - track.observed[j];
    }
  }
  return { auc: auc(scores, labels), rows: labels.length, positives: labels.filter((outcome) => outcome === 1).length };
}

/**
 * Calibrate a threshold on earlier walk-forward predictions, then freeze it before evaluating the final holdout.
 * Each prediction still comes from a model fit only on older, horizon-purged labels.
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
  report.folds = wf.folds;
  report.importance = wf.importance.slice(0, 8);
  if (!wf.live || wf.folds === 0) {
    report.reason = 'not enough history to train yet';
    return { ranAt: Date.now(), rules, ml: report, model: wf.live };
  }
  const minWindowHours = 7 * 24;
  const predictionHours = ctx.N - wf.oosStart;
  const holdoutStart = ctx.N - Math.max(minWindowHours, Math.floor(predictionHours * 0.4));
  if (holdoutStart - wf.oosStart <= minWindowHours) {
    report.active = ML.mode === 'on';
    report.reason = report.active
      ? 'forced on with default threshold: not enough history for calibration and final holdout'
      : 'need at least one week each for threshold calibration and final holdout';
    return { ranAt: Date.now(), rules, ml: report, model: wf.live };
  }

  report.oosFrom = ctx.buckets[holdoutStart] * 3_600_000;
  const holdout = holdoutLabels(ctx, wf.preds, holdoutStart);
  report.auc = holdout.auc;
  report.oosRows = holdout.rows;
  report.baseRate = holdout.rows ? holdout.positives / holdout.rows : null;
  report.rulesOos = simulate(ctx, { label: 'Rules (final holdout)', mode: 'rules', from: holdoutStart + 1, startUsd });
  let best: BacktestResult | null = null;
  for (const thr of ML.liftThresholds) {
    const r = simulate(ctx, {
      label: `ML ${thr}x (calibration)`, mode: 'ml', from: wf.oosStart + 1, to: holdoutStart,
      threshold: thr, preds: wf.preds, startUsd,
    });
    report.thresholds.push({ threshold: thr, returnPct: r.returnPct, trades: r.trades, maxDrawdownPct: r.maxDrawdownPct });
    if (r.trades >= 3 && (!best || r.returnPct > best.returnPct)) { best = r; report.threshold = thr; }
  }
  const chosen = report.threshold ?? (ML.mode === 'on' ? 2 : null);
  if (chosen === null) {
    report.reason = 'no threshold closed at least three trades during calibration';
    return { ranAt: Date.now(), rules, ml: report, model: wf.live };
  }
  report.threshold = chosen;
  report.mlOos = simulate(ctx, {
    label: `ML ${chosen}x (final holdout)`, mode: 'ml', from: holdoutStart + 1,
    threshold: chosen, preds: wf.preds, startUsd,
  });
  const beatsRules = report.mlOos.returnPct > Math.max(0, report.rulesOos.returnPct) && report.mlOos.trades >= 3;
  const goodAuc = holdout.auc !== null && holdout.auc >= ML.minAuc;
  if (ML.mode === 'on') {
    report.active = true;
    report.reason = 'forced on (ML_MODE=on)';
  } else {
    report.active = goodAuc && beatsRules;
    report.reason = report.active
      ? `final holdout AUC ${holdout.auc!.toFixed(3)} >= ${ML.minAuc} and ML beat both the rules and holding USDC`
      : !goodAuc
        ? `final holdout AUC ${holdout.auc === null ? 'unavailable' : `${holdout.auc.toFixed(3)} < ${ML.minAuc}`}: rules stay in charge`
        : 'ML must beat both the rules and holding USDC and close at least three trades on the final holdout';
  }
  return { ranAt: Date.now(), rules, ml: report, model: wf.live };
}
