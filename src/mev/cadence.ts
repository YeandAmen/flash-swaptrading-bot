const MINUTE = 60_000;
const INTERVAL = 30 * MINUTE;
const EXPAND_AFTER = 25 * MINUTE;

/** Anchor the target to scan startup or the most recent confirmed direct fill. */
export function directCadence(now: number, anchor: number | null, baseRouteLimit: number, maxRouteLimit: number, active: boolean) {
  const elapsedMs = anchor === null ? null : Math.max(0, now - anchor);
  const expanded = elapsedMs !== null && elapsedMs >= EXPAND_AFTER;
  const state = !active ? 'paper' : elapsedMs !== null && elapsedMs >= INTERVAL ? 'overdue' : expanded ? 'expanded' : 'scanning';
  return { state, elapsedMs, intervalMs: INTERVAL, baseRouteLimit, routeLimit: expanded ? Math.max(baseRouteLimit, maxRouteLimit) : baseRouteLimit };
}

/** Convert the USD cap to wei, rounding the ETH price up and the allowance down. */
export function loanLimitWei(maxUsd: number, ethUsd: number | null): bigint | null {
  if (ethUsd === null || !Number.isFinite(ethUsd) || ethUsd <= 0) return null;
  const maximum = BigInt(Math.floor(maxUsd * 1_000_000));
  const price = Math.ceil(ethUsd * 1_000_000);
  return Number.isSafeInteger(price) ? maximum * 10n ** 18n / BigInt(price) : null;
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
