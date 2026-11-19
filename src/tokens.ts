import fs from 'node:fs';
import path from 'node:path';
import { getAddress, isAddress, type Address } from 'viem';
import { CORE_TOKENS, DATA_DIR, TOKENS, type TokenCfg } from './config.js';

const CACHE = path.join(DATA_DIR, 'tokenlist.json');

/**
 * Not tradeable for a trend strategy, or unsafe for exact-balance accounting:
 * stablecoins, fiat/gold pegs, liquid-staking/ETH derivatives (≈ ETH), rebasing tokens.
 */
const SKIP_SYMBOL = new RegExp(
  '^(USDC|USDT|DAI|SDAI|FRAX|SFRAX|LUSD|TUSD|USDP|GUSD|PYUSD|USDE|SUSDE|USDS|SUSDS|FDUSD|CRVUSD|SCRVUSD|GHO|USD0|USDD|BUSD|RLUSD|USDY|USD1|DOLA|MIM|ALUSD|' +
    'EURC|EURS|EURT|AGEUR|EURA|XAUT|PAXG|' +
    'ETH|STETH|WSTETH|RETH|CBETH|WEETH|EETH|SFRXETH|FRXETH|METH|CMETH|OSETH|ETHX|EZETH|RSETH|PUFETH|SWETH|ANKRETH|LSETH|RSWETH|' +
    'AMPL|SPELL|OHM|BTRFLY|STKAAVE|AWETH|CWETH)$',
  'i',
);
const PEGGED_HINT = /USD|EUR|GBP|JPY|CHF|XAU|GOLD/i;

interface ListToken { chainId?: number; address?: string; symbol?: string; decimals?: number; name?: string }

const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || 'TKN';

async function fetchList(url: string): Promise<ListToken[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const j = (await res.json()) as { tokens?: ListToken[] };
  return Array.isArray(j.tokens) ? j.tokens : [];
}

/** Core tokens first, then every unique Ethereum-mainnet ERC-20 from the public token lists (cached on disk). */
export async function loadCandidates(log: (m: string) => void): Promise<TokenCfg[]> {
  const out: TokenCfg[] = [...CORE_TOKENS];
  if (TOKENS.mode === 'core') return out;

  let raw: ListToken[] = [];
  const results = await Promise.allSettled(TOKENS.listUrls.map(fetchList));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') raw.push(...r.value);
    else log(`Token list unavailable (${TOKENS.listUrls[i]}): ${(r.reason as Error).message}`);
  });
  if (raw.length > 0) {
    const slim = raw.filter((t) => t.chainId === 1).map((t) => ({ chainId: 1, address: t.address, symbol: t.symbol, decimals: t.decimals, name: t.name }));
    try { fs.writeFileSync(CACHE, JSON.stringify(slim)); } catch { /* ignore */ }
  } else {
    try {
      raw = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as ListToken[];
      log(`Using cached token list (${raw.length} tokens)`);
    } catch {
      log('No token list available: trading core tokens only');
      return out;
    }
  }

  const keys = new TokenKeys();
  const seen = new Set(CORE_TOKENS.map((t) => t.address.toLowerCase()));
  for (const t of raw) {
    if (t.chainId !== 1 || !t.address || !isAddress(t.address, { strict: false })) continue;
    const lower = t.address.toLowerCase();
    if (seen.has(lower)) continue;
    const sym = clean(t.symbol ?? '');
    if (SKIP_SYMBOL.test(sym) || PEGGED_HINT.test(sym)) continue;
    if (typeof t.decimals !== 'number' || t.decimals < 0 || t.decimals > 36) continue;
    seen.add(lower);
    out.push({
      symbol: keys.keyFor(lower, sym),
      address: getAddress(lower) as Address,
      decimals: t.decimals,
      core: false,
      name: (t.name ?? '').replace(/[^\w .-]/g, '').slice(0, 40),
    });
  }
  keys.save();
  log(`Token lists: ${out.length - CORE_TOKENS.length} candidate tokens + ${CORE_TOKENS.length} core`);
  return out;
}

/**
 * The bot's key for a token (used for history, positions, prices) is assigned ONCE per address and persisted:
 * unique (collisions get a longer address suffix) and stable even if a token list renames the symbol later.
 */
export class TokenKeys {
  private file = path.join(DATA_DIR, 'tokenkeys.json');
  private byAddr: Record<string, string> = {};
  private owner = new Map<string, string>(); // key -> address
  private dirty = false;

  constructor() {
    try { this.byAddr = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>; } catch { /* first run */ }
    for (const c of CORE_TOKENS) this.owner.set(c.symbol, c.address.toLowerCase());
    for (const [a, k] of Object.entries(this.byAddr)) this.owner.set(k, a);
  }

  keyFor(lower: string, sym: string): string {
    const known = this.byAddr[lower];
    if (known) return known;
    for (const n of [4, 8, 40]) {
      const k = `${sym}.${lower.slice(2, 2 + n)}`;
      const o = this.owner.get(k);
      if (!o || o === lower) {
        this.byAddr[lower] = k;
        this.owner.set(k, lower);
        this.dirty = true;
        return k;
      }
    }
    return lower; // unreachable: the full address is unique
  }

  save() {
    if (!this.dirty) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.byAddr)); } catch { /* ignore */ }
  }
}
