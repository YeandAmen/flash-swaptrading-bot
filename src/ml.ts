/**
 * ML signal layer, inspired by asavinov/intelligent-trading-bot:
 *   engineered features (same code offline & online) -> labels from the future (offline only)
 *   -> model (L2 logistic regression) -> probability "trade reaches +1R before -1R within the horizon"
 *   -> walk-forward (rolling re-train) evaluation so every backtest prediction is out-of-sample.
 * Pure TypeScript, no native dependencies.
 */
import { ML, STRATEGY as S } from './config.js';

export const FEATURE_NAMES = [
  'ret_1h', 'ret_4h', 'ret_12h', 'ret_24h', 'ret_72h', 'ret_168h',
  'vol_24h', 'vol_168h', 'vol_ratio',
  'dist_ema20', 'dist_ema50', 'dist_ema200',
  'rsi14',
  'from_high_72h', 'from_low_72h', 'from_high_168h',
  'vs_eth_24h', 'vs_eth_72h',
  'eth_dist_ema200', 'eth_ret_24h', 'eth_ema200_slope',
] as const;
export const NF = FEATURE_NAMES.length;
const WARMUP = 220; // bars of history before features are valid

/** Indicator arrays for one aligned hourly close series (NaN before the token existed). */
export class SeriesBase {
  readonly n: number;
  readonly first: number;
  readonly c: Float64Array;
  readonly ema20: Float64Array;
  readonly ema50: Float64Array;
  readonly ema200: Float64Array;
  readonly rsi: Float64Array;
  readonly v24: Float64Array;
  readonly v168: Float64Array;
  readonly max72: Float64Array;
  readonly min72: Float64Array;
  readonly max168: Float64Array;

  constructor(closes: ArrayLike<number>) {
    const n = closes.length;
    this.n = n;
    let first = -1;
    for (let i = 0; i < n; i++) if (Number.isFinite(closes[i]) && closes[i] > 0) { first = i; break; }
    this.first = first;
    const c = (this.c = new Float64Array(n).fill(NaN));
    this.ema20 = new Float64Array(n).fill(NaN);
    this.ema50 = new Float64Array(n).fill(NaN);
    this.ema200 = new Float64Array(n).fill(NaN);
    this.rsi = new Float64Array(n).fill(NaN);
    this.v24 = new Float64Array(n).fill(NaN);
    this.v168 = new Float64Array(n).fill(NaN);
    this.max72 = new Float64Array(n).fill(NaN);
    this.min72 = new Float64Array(n).fill(NaN);
    this.max168 = new Float64Array(n).fill(NaN);
    if (first < 0) return;
    let last = closes[first];
    for (let i = first; i < n; i++) {
      const v = closes[i];
      if (Number.isFinite(v) && v > 0) last = v;
      c[i] = last;
    }
    const ema = (out: Float64Array, p: number) => {
      const k = 2 / (p + 1);
      let e = c[first];
      for (let i = first; i < n; i++) { e = c[i] * k + e * (1 - k); out[i] = e; }
    };
    ema(this.ema20, 20);
    ema(this.ema50, 50);
    ema(this.ema200, 200);
    // Wilder RSI(14)
    let g = 0;
    let l = 0;
    for (let i = first + 1; i < n; i++) {
      const d = c[i] - c[i - 1];
      const up = Math.max(d, 0);
      const dn = Math.max(-d, 0);
      const k = i - first;
      if (k <= S.rsiPeriod) {
        g += up / S.rsiPeriod;
        l += dn / S.rsiPeriod;
      } else {
        g = (g * (S.rsiPeriod - 1) + up) / S.rsiPeriod;
        l = (l * (S.rsiPeriod - 1) + dn) / S.rsiPeriod;
      }
      if (k >= S.rsiPeriod) this.rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
    // rolling std of log returns via prefix sums
    const s1 = new Float64Array(n + 1);
    const s2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const r = i > first ? Math.log(c[i] / c[i - 1]) : 0;
      s1[i + 1] = s1[i] + r;
      s2[i + 1] = s2[i] + r * r;
    }
    const rollStd = (out: Float64Array, w: number) => {
      for (let i = first + w; i < n; i++) {
        const a = s1[i + 1] - s1[i + 1 - w];
        const b = s2[i + 1] - s2[i + 1 - w];
        const m = a / w;
        out[i] = Math.sqrt(Math.max(b / w - m * m, 0) * (w / (w - 1)));
      }
    };
    rollStd(this.v24, 24);
    rollStd(this.v168, 168);
    const roll = (out: Float64Array, w: number, f: (a: number, b: number) => number) => {
      for (let i = first + w; i < n; i++) {
        let m = c[i];
        for (let k = i - w; k < i; k++) m = f(m, c[k]);
        out[i] = m;
      }
    };
    roll(this.max72, 72, Math.max);
    roll(this.min72, 72, Math.min);
    roll(this.max168, 168, Math.max);
  }

  valid(i: number): boolean {
    return this.first >= 0 && i - this.first >= WARMUP && i < this.n;
  }

  hourlyVol(i: number): number {
    return Math.max(this.v168[i], 0.0008);
  }
}

/** Feature row for series `s` at index `i`, market context from `eth`. Returns false if not computable. */
export function featureRow(s: SeriesBase, eth: SeriesBase, i: number, out: Float64Array): boolean {
  if (!s.valid(i) || !eth.valid(i)) return false;
  const c = s.c;
  const hv = s.hourlyVol(i);
  const dv = hv * Math.sqrt(24);
  const ret = (h: number) => Math.log(c[i] / c[i - h]) / (hv * Math.sqrt(h));
  const ehv = eth.hourlyVol(i);
  const edv = ehv * Math.sqrt(24);
  const e = eth.c;
  let k = 0;
  out[k++] = ret(1);
  out[k++] = ret(4);
  out[k++] = ret(12);
  out[k++] = ret(24);
  out[k++] = ret(72);
  out[k++] = ret(168);
  out[k++] = Math.log(Math.max(s.v24[i], 1e-5));
  out[k++] = Math.log(hv);
  out[k++] = Math.log(Math.max(s.v24[i], 1e-5) / hv);
  out[k++] = (c[i] / s.ema20[i] - 1) / dv;
  out[k++] = (c[i] / s.ema50[i] - 1) / dv;
  out[k++] = (c[i] / s.ema200[i] - 1) / dv;
  out[k++] = (s.rsi[i] - 50) / 50;
  out[k++] = (c[i] / s.max72[i] - 1) / dv;
  out[k++] = (c[i] / s.min72[i] - 1) / dv;
  out[k++] = (c[i] / s.max168[i] - 1) / dv;
  out[k++] = (Math.log(c[i] / c[i - 24]) - Math.log(e[i] / e[i - 24])) / (hv * Math.sqrt(24));
  out[k++] = (Math.log(c[i] / c[i - 72]) - Math.log(e[i] / e[i - 72])) / (hv * Math.sqrt(72));
  out[k++] = (e[i] / eth.ema200[i] - 1) / edv;
  out[k++] = Math.log(e[i] / e[i - 24]) / (ehv * Math.sqrt(24));
  out[k++] = ((eth.ema200[i] / eth.ema200[i - 24] - 1) / edv) * 10;
  for (let j = 0; j < NF; j++) if (!Number.isFinite(out[j])) return false;
  return true;
}

const clampStop = (x: number) => Math.min(S.maxStopPct, Math.max(S.minStopPct, x));

/** Label: does price reach +1R before -1R within the horizon? (R = the strategy's own vol-based stop). -1 = unknown yet. */
export function label(s: SeriesBase, i: number, horizon = ML.horizonHours): number {
  if (i + horizon >= s.n) return -1;
  const stop = clampStop(S.stopVolMult * s.hourlyVol(i) * Math.sqrt(24));
  const up = s.c[i] * (1 + stop);
  const dn = s.c[i] * (1 - stop);
  for (let k = 1; k <= horizon; k++) {
    const p = s.c[i + k];
    if (p >= up) return 1;
    if (p <= dn) return 0;
  }
  return 0;
}

// ------------------------------------------------------------------ model
export interface LogitModel {
  mean: number[];
  std: number[];
  w: number[];
  b: number;
  samples: number;
  baseRate: number;
}

export function predict(m: LogitModel, x: ArrayLike<number>): number {
  let z = m.b;
  for (let j = 0; j < NF; j++) {
    const v = Math.max(-5, Math.min(5, (x[j] - m.mean[j]) / m.std[j]));
    z += m.w[j] * v;
  }
  return 1 / (1 + Math.exp(-z));
}

/** L2-regularised logistic regression, full-batch gradient descent with momentum on standardised features. */
export function fitLogit(X: Float64Array, y: Uint8Array, rows: number, warm?: LogitModel, iters = 120): LogitModel {
  const mean = new Array(NF).fill(0);
  const std = new Array(NF).fill(0);
  for (let r = 0; r < rows; r++) for (let j = 0; j < NF; j++) mean[j] += X[r * NF + j];
  for (let j = 0; j < NF; j++) mean[j] /= Math.max(rows, 1);
  for (let r = 0; r < rows; r++) for (let j = 0; j < NF; j++) std[j] += (X[r * NF + j] - mean[j]) ** 2;
  for (let j = 0; j < NF; j++) std[j] = Math.sqrt(std[j] / Math.max(rows - 1, 1)) || 1;
  const Z = new Float64Array(rows * NF);
  let pos = 0;
  for (let r = 0; r < rows; r++) {
    pos += y[r];
    for (let j = 0; j < NF; j++) Z[r * NF + j] = Math.max(-5, Math.min(5, (X[r * NF + j] - mean[j]) / std[j]));
  }
  const baseRate = rows ? pos / rows : 0.5;
  const w = warm ? [...warm.w] : new Array(NF).fill(0);
  let b = warm ? warm.b : Math.log((baseRate + 1e-6) / (1 - baseRate + 1e-6));
  const vw = new Array(NF).fill(0);
  let vb = 0;
  const lr = 0.3;
  const mom = 0.85;
  const grad = new Float64Array(NF);
  for (let it = 0; it < iters; it++) {
    grad.fill(0);
    let gb = 0;
    for (let r = 0; r < rows; r++) {
      let z = b;
      const o = r * NF;
      for (let j = 0; j < NF; j++) z += w[j] * Z[o + j];
      const err = 1 / (1 + Math.exp(-z)) - y[r];
      gb += err;
      for (let j = 0; j < NF; j++) grad[j] += err * Z[o + j];
    }
    for (let j = 0; j < NF; j++) {
      const g = grad[j] / rows + ML.l2 * w[j];
      vw[j] = mom * vw[j] - lr * g;
      w[j] += vw[j];
    }
    vb = mom * vb - lr * (gb / rows);
    b += vb;
  }
  return { mean, std, w, b, samples: rows, baseRate };
}

/** Area under the ROC curve (probability a random winner is scored above a random loser). */
export function auc(scores: number[], labels: number[]): number | null {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let nPos = 0;
  let rankSum = 0;
  for (let r = 0; r < idx.length; r++) if (labels[idx[r]] === 1) { nPos++; rankSum += r + 1; }
  const nNeg = idx.length - nPos;
  if (nPos === 0 || nNeg === 0) return null;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Live probability for the latest bar of `s` (aligned with `eth`). null if the token lacks history. */
export function scoreLatest(model: LogitModel, s: SeriesBase, eth: SeriesBase): number | null {
  const out = new Float64Array(NF);
  return featureRow(s, eth, s.n - 1, out) ? predict(model, out) : null;
}

// ------------------------------------------------------------------ walk-forward research
export interface WalkForwardResult {
  auc: number | null;
  oosStart: number; // master index where out-of-sample predictions begin
  oosRows: number;
  positives: number;
  folds: number;
  /** out-of-sample probability per token per master index (NaN = none) */
  preds: Map<string, Float32Array>;
  live: LogitModel | null;
  importance: { name: string; weight: number }[];
}

const yieldLoop = () => new Promise((r) => setImmediate(r));

/**
 * Rolling walk-forward: every `retrainEveryHours`, fit on rows whose labels were already known at that time
 * (index <= t - horizon), predict the next block. Finally fit the live model on all labelled rows.
 */
export async function walkForward(series: Map<string, SeriesBase>, eth: SeriesBase, N: number): Promise<WalkForwardResult> {
  const H = ML.horizonHours;
  const step = 3; // sample every 3rd hour for training rows (consecutive hours are highly correlated)
  const rowsX: number[] = [];
  const rowsY: number[] = [];
  const rowsT: number[] = [];
  const tmp = new Float64Array(NF);
  for (const s of series.values()) {
    for (let i = 0; i < N; i += step) {
      const yv = label(s, i, H);
      if (yv < 0 || !featureRow(s, eth, i, tmp)) continue;
      for (let j = 0; j < NF; j++) rowsX.push(tmp[j]);
      rowsY.push(yv);
      rowsT.push(i);
    }
  }
  // order rows by time so "rows known at t" is a prefix
  const order = rowsT.map((_, k) => k).sort((a, b) => rowsT[a] - rowsT[b]);
  const R = order.length;
  const X = new Float64Array(R * NF);
  const Y = new Uint8Array(R);
  const T = new Int32Array(R);
  order.forEach((k, r) => {
    for (let j = 0; j < NF; j++) X[r * NF + j] = rowsX[k * NF + j];
    Y[r] = rowsY[k];
    T[r] = rowsT[k];
  });

  const preds = new Map<string, Float32Array>();
  for (const k of series.keys()) preds.set(k, new Float32Array(N).fill(NaN));
  const firstValid = Math.min(...[...series.values()].map((s) => (s.first >= 0 ? s.first + WARMUP : N)));
  const oosStart = Math.min(N, Math.max(eth.first + WARMUP, firstValid) + ML.minTrainDays * 24 + H);
  let folds = 0;
  let model: LogitModel | undefined;
  for (let t = oosStart; t < N; t += ML.retrainEveryHours) {
    let rows = 0;
    while (rows < R && T[rows] <= t - H) rows++;
    if (rows < 500) continue;
    model = fitLogit(X, Y, rows, model);
    folds++;
    const end = Math.min(N, t + ML.retrainEveryHours);
    for (const [k, s] of series) {
      const out = preds.get(k)!;
      for (let i = t; i < end; i++) if (featureRow(s, eth, i, tmp)) out[i] = predict(model, tmp);
    }
    await yieldLoop();
  }

  // out-of-sample AUC on hourly predictions that have a known label
  const sc: number[] = [];
  const lb: number[] = [];
  for (const [k, s] of series) {
    const p = preds.get(k)!;
    for (let i = oosStart; i < N; i++) {
      if (!Number.isFinite(p[i])) continue;
      const yv = label(s, i, H);
      if (yv < 0) continue;
      sc.push(p[i]);
      lb.push(yv);
    }
  }
  const live = R >= 500 ? fitLogit(X, Y, R, model, 160) : null;
  const importance = live
    ? FEATURE_NAMES.map((name, j) => ({ name, weight: live.w[j] })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    : [];
  return { auc: auc(sc, lb), oosStart, oosRows: sc.length, positives: lb.filter((v) => v === 1).length, folds, preds, live, importance };
}
