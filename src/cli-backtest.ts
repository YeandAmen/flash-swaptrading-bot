// Usage: npm run build && npm run backtest
// Builds the token universe (or reuses today's cache), backfills on-chain hourly history, backtests the rules and
// trains + walk-forward-evaluates the ML model exactly like the live bot does.
import { CONFIG, STRATEGY, TOKENS } from './config.js';
import { runResearch, type BacktestResult } from './backtest.js';
import { discoverMarkets, History, loadMarketCache, saveMarketCache, snapshot } from './market.js';
import { analyze, ANALYSIS_WINDOW, marketRegime } from './strategy.js';
import { loadCandidates } from './tokens.js';

const log = (m: string) => console.log(m);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
let market = loadMarketCache(TOKENS.refreshHours * 3_600_000);
if (market) log(`Using cached token universe (${market.tokens.length} tokens)`);
else {
  market = await discoverMarkets(log, await loadCandidates(log));
  saveMarketCache(market);
}
const snap = await snapshot(market);
log(`Block ${snap.blockNumber} | ETH $${snap.ethUsd.toFixed(2)} | base fee ${snap.baseFeeGwei.toPrecision(3)} gwei + tip ${snap.tipGwei.toPrecision(2)}`);

const h = new History();
h.load();
await h.backfill(market, CONFIG.historyDays, log);
const fresh = market.tokens.map((t) => t.token.symbol).filter((s) => (h.bars[s]?.size ?? 0) < 48);
if (fresh.length) await h.backfill(market, CONFIG.historyDays, log, fresh);
h.record(snap);
h.save(CONFIG.historyDays, new Set(market.tokens.map((t) => t.token.symbol)));

const analyses = market.tokens.map((t) => {
  const closes = h.series(t.token.symbol).closes;
  const minBars = t.token.core ? STRATEGY.minBars : TOKENS.minHistoryDays * 24;
  return analyze(t.token.symbol, closes.slice(-ANALYSIS_WINDOW), minBars, closes.length);
});
const regime = marketRegime(analyses.find((a) => a.symbol === 'WETH'));
log(`\nRegime: ${regime.riskOn ? 'RISK-ON' : 'RISK-OFF'} (${regime.reason})`);
log(`Rule signals now: ${analyses.filter((a) => a.eligible).map((a) => a.symbol).join(', ') || 'none'}`);

const t0 = Date.now();
const gasNow = snap.baseFeeGwei + snap.tipGwei;
const show = (b: BacktestResult | null) => {
  if (!b) return;
  log(`  ${b.label.padEnd(22)} $${b.startUsd} -> $${b.endUsd.toFixed(2)} (${pct(b.returnPct)}) | ETH ${pct(b.ethHoldPct)} | trades ${b.trades}, win ${(b.winRate * 100).toFixed(0)}%, max DD ${pct(b.maxDrawdownPct)}, gas $${b.gasPaidUsd.toFixed(2)}`);
};
for (const g of [gasNow, 0.3]) {
  const r = await runResearch(h, market, g, snap.ethUsd, CONFIG.paperStartUsd);
  log(`\n=== gas ${g.toPrecision(2)} gwei (${g === gasNow ? 'now' : 'cheap-gas scenario'}) — ${((Date.now() - t0) / 1000).toFixed(0)}s ===`);
  show(r.rules);
  const m = r.ml;
  const holdoutFrom = m.oosFrom ? new Date(m.oosFrom).toISOString().slice(0, 10) : 'n/a';
  log(`  ML final holdout: AUC ${m.auc === null ? 'n/a' : m.auc.toFixed(3)} on ${m.oosRows} labelled token-hours (base rate ${m.baseRate === null ? 'n/a' : pct(m.baseRate)}), ${m.folds} walk-forward re-trains, holdout from ${holdoutFrom}`);
  show(m.rulesOos);
  show(m.mlOos);
  for (const x of m.thresholds) log(`  Calibration ${x.threshold}x base rate`.padEnd(31) + `${pct(x.returnPct)} | trades ${x.trades} | max DD ${pct(x.maxDrawdownPct)}`);
  log(`  → ${m.active ? 'ML ACTIVE' : 'rules stay in charge'}: ${m.reason}`);
  if (g === gasNow) {
    log(`  Top features: ${m.importance.map((f) => `${f.name} ${f.weight >= 0 ? '+' : ''}${f.weight.toFixed(2)}`).join(', ')}`);
    for (const t of (m.active ? m.mlOos : r.rules)?.tradeList.slice(-12) ?? []) {
      log(`    ${new Date(t.t).toISOString().slice(0, 16)} ${t.side.padEnd(4)} ${t.symbol.padEnd(14)} @ ${t.price.toPrecision(6)} $${t.usd.toFixed(2)} ${t.pnlUsd !== undefined ? 'pnl $' + t.pnlUsd.toFixed(2) : ''} ${t.reason}`);
    }
  }
}
