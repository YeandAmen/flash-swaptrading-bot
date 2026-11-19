// Usage: npm run build && npm run backtest
// Builds the token universe (or reuses today's cache), backfills on-chain hourly history and replays the strategy with real costs.
import { CONFIG, STRATEGY, TOKENS } from './config.js';
import { runBacktest } from './backtest.js';
import { discoverMarkets, History, loadMarketCache, saveMarketCache, snapshot } from './market.js';
import { analyze, ANALYSIS_WINDOW, marketRegime } from './strategy.js';
import { loadCandidates } from './tokens.js';

const log = (m: string) => console.log(m);
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
log(`Eligible now: ${analyses.filter((a) => a.eligible).map((a) => a.symbol).join(', ') || 'none'}`);
log('Top 15 by score:');
for (const a of [...analyses].sort((x, y) => y.score - x.score).slice(0, 15)) {
  log(`  ${a.symbol.padEnd(14)} bars ${String(a.bars).padStart(4)} trend ${a.trend.padEnd(4)} mom ${a.momentum.toFixed(2)}σ RSI ${a.rsi.toFixed(0)} dVol ${(a.dailyVol * 100).toFixed(1)}% ${a.eligible ? 'ELIGIBLE' : '- ' + a.reasons.slice(0, 2).join('; ')}`);
}

const t0 = Date.now();
const r = runBacktest(h, market, CONFIG.paperStartUsd, snap.baseFeeGwei + snap.tipGwei, snap.ethUsd);
log(`\nBacktest ${new Date(r.from).toISOString().slice(0, 10)} -> ${new Date(r.to).toISOString().slice(0, 10)} (${r.hours}h, ${market.tokens.length} tokens, ran in ${Date.now() - t0}ms)`);
log(`  $${r.startUsd} -> $${r.endUsd.toFixed(2)} (${(r.returnPct * 100).toFixed(2)}%), ETH hold ${(r.ethHoldPct * 100).toFixed(2)}%`);
log(`  trades ${r.trades}, win rate ${(r.winRate * 100).toFixed(0)}%, max DD ${(r.maxDrawdownPct * 100).toFixed(2)}%, gas $${r.gasPaidUsd.toFixed(2)}`);
for (const t of r.tradeList) log(`  ${new Date(t.t).toISOString().slice(0, 16)} ${t.side.padEnd(4)} ${t.symbol.padEnd(14)} @ ${t.price.toPrecision(6)} $${t.usd.toFixed(2)} ${t.pnlUsd !== undefined ? 'pnl $' + t.pnlUsd.toFixed(2) : ''} ${t.reason}`);
