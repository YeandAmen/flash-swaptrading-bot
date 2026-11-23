const windowMs = 60_000;
const buildsPerMinute = 30;
// Two directions can each request an entry, a grouped return and one paired return.
const maxBuildsPerScan = 6;
export const liveScanDelayMs = 12_000;

function resetDelay(headers: Headers, now: number): number {
  const retry = headers.get('retry-after')?.trim() ?? '';
  const retryMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
  const reset = headers.get('x-ratelimit-reset')?.trim() ?? '';
  // Jupiter specifies absolute Unix seconds. Ignore missing, malformed and millisecond timestamps.
  const resetMs = /^\d{1,10}$/.test(reset) ? Number(reset) * 1000 - now : 0;
  return Math.max(0, Number.isSafeInteger(retryMs) ? retryMs : 0, resetMs);
}

/** Process-local budget for the serial opt-in poller. All actual Build attempts use the same rolling window. */
export class SolanaScanCadence {
  private starts: number[] = [];
  private completedAt = -Infinity;
  private lastHealthy = false;
  private pausedUntil = 0;
  private backoff = 0;
  private throttledThisPoll = false;

  get providerCooldownUntil(): number | null {
    const remaining = Math.ceil(this.pausedUntil - performance.now());
    return remaining > 0 ? Date.now() + remaining : null;
  }

  private prune(now: number) {
    while (this.starts.length && this.starts[0] + windowMs <= now) this.starts.shift();
  }

  delay(ordinaryLive: boolean): number {
    const now = performance.now();
    this.prune(now);
    const needsToExpire = this.starts.length + maxBuildsPerScan - buildsPerMinute;
    const budgetAt = needsToExpire > 0 ? this.starts[needsToExpire - 1] + windowMs : 0;
    return Math.max(0, Math.ceil(Math.max(budgetAt, this.pausedUntil,
      this.completedAt + (ordinaryLive && this.lastHealthy ? 10_500 : liveScanDelayMs)) - now));
  }

  complete(healthyOrdinary: boolean): number {
    this.completedAt = performance.now();
    this.lastHealthy = healthyOrdinary && !this.throttledThisPoll;
    if (this.lastHealthy) this.backoff = 0;
    this.throttledThisPoll = false;
    return this.delay(healthyOrdinary);
  }

  fetchBuild = async (url: URL, init: RequestInit): Promise<Response> => {
    const now = performance.now();
    this.prune(now);
    if (now < this.pausedUntil || this.starts.length >= buildsPerMinute) {
      throw new Error('Jupiter Build request held for the rate limit.');
    }
    this.starts.push(now);
    const response = await fetch(url, init);
    if (response.status === 429) {
      if (!this.throttledThisPoll) this.backoff = Math.min(windowMs, Math.max(liveScanDelayMs, this.backoff * 2));
      this.throttledThisPoll = true;
      this.pausedUntil = Math.max(this.pausedUntil, performance.now() + Math.max(this.backoff, resetDelay(response.headers, Date.now())));
    } else if ((!response.ok && response.headers.has('retry-after')) || (response.ok
      && /^-?\d+$/.test(response.headers.get('x-ratelimit-remaining') ?? '')
      && Number(response.headers.get('x-ratelimit-remaining')) <= 0)) {
      this.pausedUntil = Math.max(this.pausedUntil, performance.now() + (resetDelay(response.headers, Date.now()) || liveScanDelayMs));
    }
    return response;
  };
}
