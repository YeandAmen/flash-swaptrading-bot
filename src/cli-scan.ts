// Usage: npm run build && npm run scan
// Read-only: builds the token universe from public token lists + on-chain checks and prints what passed.
import { discoverMarkets } from './market.js';
import { loadCandidates } from './tokens.js';

const log = (m: string) => console.log(m);
const t0 = Date.now();
const candidates = await loadCandidates(log);
const m = await discoverMarkets(log, candidates);
console.log(`\nScan took ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('\nDeepest 25 tradeable tokens:');
for (const t of [...m.tokens].sort((a, b) => b.wethDepth - a.wethDepth).slice(0, 25)) {
  console.log(`  ${t.token.symbol.padEnd(14)} depth ${t.wethDepth.toFixed(0).padStart(6)} WETH  fee ${(t.pool ? t.pool.fee / 1e4 : 0.05).toString().padEnd(4)}%  ${t.safety ?? ''}`);
}
const reasons = new Map<string, number>();
for (const e of m.excluded) {
  const k = e.reason.replace(/[\d.]+%/g, 'X%').slice(0, 60);
  reasons.set(k, (reasons.get(k) ?? 0) + 1);
}
console.log('\nRejected by safety / sanity checks:');
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(4)} × ${r}`);
console.log('\nExamples:');
for (const e of m.excluded.slice(0, 10)) console.log(`  ${e.symbol.padEnd(14)} ${e.reason}`);
