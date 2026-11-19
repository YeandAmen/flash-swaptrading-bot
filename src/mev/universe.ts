import fs from 'node:fs';
import path from 'node:path';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { ADDR, CONFIG, DATA_DIR, MEV, type TokenCfg } from '../config.js';
import { writeJson } from '../persistence.js';
import { loadMevTokenCandidates } from '../tokens.js';
import { discoverArbPools, type ArbPool, type ArbToken, type DiscoverArbOptions } from './pools.js';

const CACHE = path.join(DATA_DIR, 'mev-token-seeds.json');
const SEED_LIMIT = 48;
const DISCOVERY_BATCH = 48;
const DISCOVERY_PAUSE_MS = 4_000;
const WARMUP_REUSE_MS = 10 * 60_000;
const MAX_CACHE_AGE_MS = 7 * 24 * 3_600_000;

type Stage = 'warmup' | 'checking' | 'complete' | 'retrying';
type Log = (message: string, level?: 'warn') => void;

const tokenKey = (t: TokenCfg) => t.address.toLowerCase();
const poolDepth = (p: ArbPool) => typeof p.depthWeth === 'number' && Number.isFinite(p.depthWeth) ? p.depthWeth : 0;

function uniqueTokens(tokens: TokenCfg[]): TokenCfg[] {
  const excluded = new Set([ADDR.weth.toLowerCase(), zeroAddress]);
  return tokens.filter((token) => {
    const key = tokenKey(token);
    if (excluded.has(key)) return false;
    excluded.add(key);
    return true;
  });
}

/** Reserve two pools per token, then spend the remaining read budget on the deepest extra routes. */
export function selectActiveTokens(eligible: ArbToken[], budget: number): ArbToken[] {
  const viable = eligible.filter((t) => t.pools.length >= 2);
  if (viable.reduce((count, token) => count + token.pools.length, 0) <= budget) return viable;
  const selected = rankTokens(viable).slice(0, Math.floor(budget / 2));
  const active = selected.map((t) => ({ ...t, pools: t.pools.slice(0, 2) }));
  const extra = selected.flatMap((t, index) => t.pools.slice(2).map((pool) => ({ index, pool })))
    .sort((a, b) => poolDepth(b.pool) - poolDepth(a.pool) || a.index - b.index);
  for (const { index, pool } of extra.slice(0, budget - 2 * active.length)) active[index].pools.push(pool);
  return active;
}

function rankTokens(tokens: ArbToken[]): ArbToken[] {
  return tokens.map((t) => ({ ...t, pools: t.pools.slice().sort((a, b) => poolDepth(b) - poolDepth(a)) }))
    .sort((a, b) => Number(b.token.core) - Number(a.token.core)
      || poolDepth(b.pools[1]) - poolDepth(a.pools[1]) || a.token.address.localeCompare(b.token.address));
}

/** The cache stores candidate token metadata. Pools are always rediscovered from the supported factories. */
export class MevUniverse {
  readonly broad: boolean;
  private seeds: TokenCfg[];
  private matched = new Map<string, ArbToken>();
  private checkedAt = new Map<string, number>();
  private phase: Stage = 'warmup';
  private candidateCount = 0;
  private checked = 0;
  private completedAt: number | null = null;
  private sweepCutoff: number | null = null;

  constructor(persistent: boolean, private log: Log, private readonly options: DiscoverArbOptions = {}) {
    this.broad = persistent && !CONFIG.forkMode && MEV.universe === 'all';
    this.seeds = this.broad ? this.readSeeds() : [];
  }

  async warmup(priority: TokenCfg[]) {
    const prioritized = uniqueTokens(priority);
    const batch = this.broad
      ? uniqueTokens([...prioritized.slice(0, 16), ...this.seeds, ...prioritized]).slice(0, SEED_LIMIT)
      : prioritized;
    await this.check(batch);
    if (!this.broad) {
      this.candidateCount = batch.length;
      this.checked = batch.length;
      this.prune(batch);
      this.completedAt = Date.now();
      this.phase = 'complete';
    } else if (this.phase === 'warmup') {
      this.candidateCount = batch.length;
      this.checked = batch.length;
    }
  }

  /** Spread factory lookups across requests while block scans continue against the active set. */
  async sweep(priority: TokenCfg[], onUpdate: () => void, stopped: () => boolean) {
    this.phase = 'checking';
    try {
      const published = await loadMevTokenCandidates(this.log);
      const candidates = uniqueTokens([...priority, ...published]);
      const cutoff = this.sweepCutoff ??= Date.now() - WARMUP_REUSE_MS;
      const queued = candidates.filter((t) => (this.checkedAt.get(tokenKey(t)) ?? 0) < cutoff);
      this.candidateCount = candidates.length;
      this.checked = candidates.length - queued.length;
      for (let offset = 0; offset < queued.length && !stopped(); offset += DISCOVERY_BATCH) {
        const batch = queued.slice(offset, offset + DISCOVERY_BATCH);
        await this.check(batch);
        this.checked += batch.length;
        onUpdate();
        if (offset % (DISCOVERY_BATCH * 15) === 0) this.saveSeeds();
        if (offset + DISCOVERY_BATCH < queued.length && !stopped()) {
          await new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_PAUSE_MS));
        }
      }
      if (stopped()) return;
      this.prune(candidates);
      this.completedAt = Date.now();
      this.phase = 'complete';
      this.sweepCutoff = null;
      onUpdate();
      this.saveSeeds();
    } catch (error) {
      this.phase = 'retrying';
      throw error;
    }
  }

  active() {
    return selectActiveTokens([...this.matched.values()], MEV.maxTrackedPools);
  }

  view() {
    return {
      mode: this.broad ? 'all' : 'spot', phase: this.phase, checked: this.checked, candidates: this.candidateCount,
      eligible: this.matched.size, maxPools: MEV.maxTrackedPools, completedAt: this.completedAt,
    };
  }

  private async check(batch: TokenCfg[]) {
    const found = await discoverArbPools(batch, MEV.minPoolWeth, this.options);
    const now = Date.now();
    for (const token of batch) {
      const key = tokenKey(token);
      this.matched.delete(key);
      this.checkedAt.set(key, now);
    }
    for (const item of found) this.matched.set(tokenKey(item.token), item);
  }

  private prune(candidates: TokenCfg[]) {
    const used = new Set(candidates.map(tokenKey));
    for (const key of this.checkedAt.keys()) {
      if (used.has(key)) continue;
      this.checkedAt.delete(key);
      this.matched.delete(key);
    }
  }

  private readSeeds(): TokenCfg[] {
    try {
      if (Date.now() - fs.statSync(CACHE).mtimeMs > MAX_CACHE_AGE_MS) return [];
      const raw: unknown = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.slice(0, MEV.maxTrackedPools / 2).flatMap((t): TokenCfg[] => {
        if (typeof t?.address !== 'string' || !isAddress(t.address, { strict: false })
          || typeof t.symbol !== 'string' || !/^[\w.]{1,60}$/.test(t.symbol)
          || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) return [];
        return [{ address: getAddress(t.address.toLowerCase()), symbol: t.symbol, decimals: t.decimals, core: false }];
      });
    } catch {
      return [];
    }
  }

  private saveSeeds() {
    const active = rankTokens(this.active());
    if (!active.length) return;
    this.seeds = active.map((t) => t.token);
    try { writeJson(CACHE, this.seeds); } catch { /* cache is optional */ }
  }
}
