// Read-only MEV scan on mainnet: finds the arbitrage pools of the bot's token universe and scans a few blocks in
// paper mode (one multicall per block + exact eth_call simulations). Sends nothing, writes nothing.
// Usage: npm run build && npm run mev:scan -- 5     (number of blocks, default 3)
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CORE_TOKENS } from './config.js';
import { LiveExecutor } from './executor.js';
import { loadMarketCache, snapshot } from './market.js';
import { MevSearcher } from './mev/searcher.js';

const blocks = Math.max(1, Math.min(50, Number(process.argv[2] ?? 3) || 3));
const market = loadMarketCache(30 * 24 * 3_600_000);
const snap = market ? await snapshot(market) : null;
// a throwaway key: only used as the eth_call sender / contract owner inside simulations; never funded
const account = privateKeyToAccount(generatePrivateKey());
const mev = new MevSearcher({
  log: (m) => console.log(m),
  account,
  exec: new LiveExecutor(account),
  ethUsd: () => snap?.ethUsd ?? null,
  baseFeeGwei: () => null, // read from the block header each block
  tokens: () => (market ? market.tokens.map((t) => t.token) : CORE_TOKENS),
  tradePending: () => false,
}, false);

const t0 = Date.now();
await mev.refreshPools();
console.log(`pool discovery took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (let i = 0; i < blocks; i++) {
  const s = Date.now();
  await mev.scanOnce();
  const v = mev.view();
  const lb = v.lastBlock!;
  const b = v.bestThisHour;
  console.log(`block ${lb.number}: scanned in ${Date.now() - s} ms · ${lb.candidates} candidates · best this hour ${b ? `${b.symbol} ${b.grossEth.toFixed(6)} ETH before gas vs ${b.gasEth.toFixed(6)} ETH gas (${b.exact ? 'exact' : 'estimate'})` : 'n/a'} · simulated ${v.stats.simulated}, profitable ${v.stats.profitable}, RPC calls ${v.stats.rpcCalls}`);
  if (i < blocks - 1) await new Promise((r) => setTimeout(r, 12_500));
}
for (const o of mev.view().recent) {
  console.log(`  ${o.symbol}: ${o.buy} → ${o.sell} · size ${o.sizeEth.toFixed(4)} ETH · gross ${o.grossEth.toFixed(6)} · gas ${o.gasEth.toFixed(6)} · net ${o.netEth.toFixed(6)} ETH · ${o.status}${o.note ? ' (' + o.note + ')' : ''}${(o.count ?? 1) > 1 ? ' ×' + o.count : ''}`);
}
process.exit(0);
