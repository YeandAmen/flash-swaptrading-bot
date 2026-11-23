const MINUTE = 60_000;
const INTERVAL = 30 * MINUTE;
const EXPAND_AFTER = 25 * MINUTE;
export const MAX_FLASH_LOAN_WEI = (1n << 127n) - 1n;

/** Anchor the target to scan startup or the most recent confirmed direct fill. */
export function directCadence(now: number, anchor: number | null, baseRouteLimit: number, maxRouteLimit: number, active: boolean) {
  const elapsedMs = anchor === null ? null : Math.max(0, now - anchor);
  const expanded = elapsedMs !== null && elapsedMs >= EXPAND_AFTER;
  const state = !active ? 'paper' : elapsedMs !== null && elapsedMs >= INTERVAL ? 'overdue' : expanded ? 'expanded' : 'scanning';
  return { state, elapsedMs, intervalMs: INTERVAL, baseRouteLimit, routeLimit: expanded ? Math.max(baseRouteLimit, maxRouteLimit) : baseRouteLimit };
}

/** Convert the USD limit to wei. Unlimited returns the maximum positive signed 128-bit swap amount. */
export function loanLimitWei(maxUsd: number, ethUsd: number | null): bigint | null {
  if (ethUsd === null || !Number.isFinite(ethUsd) || ethUsd <= 0) return null;
  const price = Math.ceil(ethUsd * 1_000_000);
  if (!Number.isSafeInteger(price)) return null;
  if (maxUsd === Infinity) return MAX_FLASH_LOAN_WEI;
  const maximum = Math.floor(maxUsd * 1_000_000);
  if (!Number.isSafeInteger(maximum) || maximum < 0) return null;
  return BigInt(maximum) * 10n ** 18n / BigInt(price);
}

/** Prefer new tokens for extra simulations. */
export function extraRoutes<T>(candidates: T[], primary: T[], limit: number, token: (candidate: T) => string): T[] {
  if (limit <= 0) return [];
  const used = new Set(primary);
  const seenTokens = new Set(primary.map(token));
  const diverse: T[] = [];
  const remaining: T[] = [];
  for (const candidate of candidates) {
    if (used.has(candidate)) continue;
    const key = token(candidate);
    if (seenTokens.has(key)) remaining.push(candidate);
    else {
      diverse.push(candidate);
      seenTokens.add(key);
      if (diverse.length === limit) return diverse;
    }
  }
  return [...diverse, ...remaining.slice(0, limit - diverse.length)];
}
