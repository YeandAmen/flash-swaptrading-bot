import fs from 'node:fs';
import path from 'node:path';
import { getAddress, isAddress, type Address } from 'viem';
import { CORE_TOKENS, DATA_DIR, TOKENS, type TokenCfg } from './config.js';
import { writeJson } from './persistence.js';

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

function readCache(maxAgeMs = Infinity): ListToken[] {
  try {
    if (Date.now() - fs.statSync(CACHE).mtimeMs > maxAgeMs) return [];
    const raw: unknown = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function publishedTokens(log: (m: string) => void, useFreshCache: boolean): Promise<ListToken[]> {
  if (useFreshCache) {
    const fresh = readCache(12 * 3_600_000);
    if (fresh.length) return fresh;
  }

  let raw: ListToken[] = [];
  const results = await Promise.allSettled(TOKENS.listUrls.map(fetchList));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') raw.push(...r.value);
    else log(`Token list unavailable (${TOKENS.listUrls[i]}): ${(r.reason as Error).message}`);
  });
  if (raw.length > 0) {
    raw = raw.filter((t) => t?.chainId === 1).map((t) => ({ chainId: 1, address: t.address, symbol: t.symbol, decimals: t.decimals, name: t.name }));
    if (raw.length) {
      try { writeJson(CACHE, raw); } catch { /* cache is optional */ }
    }
  }
  if (raw.length === 0) {
    raw = readCache();
    if (raw.length) log(`Using cached token list (${raw.length} tokens)`);
  }
  return raw;
}

/** Core tokens first, then every unique Ethereum-mainnet ERC-20 permitted by the spot strategy. */
export async function loadCandidates(log: (m: string) => void): Promise<TokenCfg[]> {
  if (TOKENS.mode === 'core') return [...CORE_TOKENS];
  const raw = await publishedTokens(log, false);
  if (!raw.length) {
    log('No token list available: trading core tokens only');
    return [...CORE_TOKENS];
  }
  const out = listedCandidates(raw, true);
  log(`Token lists: ${out.length - CORE_TOKENS.length} candidate tokens + ${CORE_TOKENS.length} core`);
  return out;
}

/** Include pegged assets for atomic arbitrage, independent of the spot market's policy and size cap. */
export async function loadMevTokenCandidates(log: (m: string) => void): Promise<TokenCfg[]> {
  const raw = await publishedTokens(log, true);
  if (!raw.length) throw new Error('No Ethereum token list available for expanded arbitrage discovery');
  return listedCandidates(raw, false);
}

function listedCandidates(raw: ListToken[], spot: boolean): TokenCfg[] {
  const out: TokenCfg[] = spot ? [...CORE_TOKENS] : [];
  const keys = new TokenKeys(spot ? 'tokenkeys.json' : 'mev-tokenkeys.json');
  const seen = new Set(out.map((t) => t.address.toLowerCase()));
  for (const t of raw) {
    if (t?.chainId !== 1 || typeof t.address !== 'string' || !isAddress(t.address, { strict: false })) continue;
    const lower = t.address.toLowerCase();
    if (seen.has(lower)) continue;
    const sym = clean(typeof t.symbol === 'string' ? t.symbol : '');
    if (spot && (SKIP_SYMBOL.test(sym) || PEGGED_HINT.test(sym))) continue;
    if (typeof t.decimals !== 'number' || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue;
    seen.add(lower);
    out.push({
      symbol: keys.keyFor(lower, sym),
      address: getAddress(lower) as Address,
      decimals: t.decimals,
      core: false,
      name: (typeof t.name === 'string' ? t.name : '').replace(/[^\w .-]/g, '').slice(0, 40),
    });
  }
  keys.save();
  return out;
}

/**
 * The bot's key for a token (used for history, positions, prices) is assigned ONCE per address and persisted:
 * unique (collisions get a longer address suffix) and stable even if a token list renames the symbol later.
 */
export class TokenKeys {
  private file: string;
  private byAddr: Record<string, string> = {};
  private owner = new Map<string, string>(); // key -> address
  private dirty = false;

  constructor(filename = 'tokenkeys.json') {
    this.file = path.join(DATA_DIR, filename);
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
