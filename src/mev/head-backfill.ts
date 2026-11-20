const MAX_PENDING_HEIGHTS = 128;
const MAX_ATTEMPTS = 3;

interface MissingBlock {
  height: bigint;
  attempts: number;
  lastAttemptHead: bigint | null;
}

/** Tracks gaps between successfully scanned heads without blocking current-head scans. */
export class HeadBackfill {
  private readonly queue: MissingBlock[] = [];
  private idle = true;
  private newestObserved: bigint | null = null;
  private recovered = 0;
  private discarded = 0;

  get caughtUp() { return this.recovered; }
  get missed() { return this.discarded; }
  get pending() { return this.queue.length + (this.idle ? 0 : 1); }

  observe(previous: bigint, latest: bigint) {
    const seen = this.newestObserved;
    if (latest <= previous || (seen !== null && latest <= seen)) return;
    this.newestObserved = latest;

    const firstMissing = (seen !== null && seen > previous ? seen : previous) + 1n;
    const oldestRetained = latest - BigInt(MAX_PENDING_HEIGHTS);
    const start = firstMissing < oldestRetained ? oldestRetained : firstMissing;
    this.countMissed(start - firstMissing);
    for (let height = start; height < latest; height++) {
      this.queue.push({ height, attempts: 0, lastAttemptHead: null });
    }
    this.trim();
  }

  /** Starts one read. A failed height becomes eligible to retry on a later head. */
  run(read: (height: bigint) => Promise<void>) {
    if (!this.idle) return;
    const index = this.queue.findIndex((item) => item.lastAttemptHead !== this.newestObserved);
    if (index < 0) return;
    const [item] = this.queue.splice(index, 1);
    this.idle = false;
    item.attempts++;
    item.lastAttemptHead = this.newestObserved;
    void Promise.resolve().then(() => read(item.height)).then(
      () => { this.recovered++; },
      () => {
        if (item.attempts >= MAX_ATTEMPTS) {
          this.countMissed(1n);
          return;
        }
        const next = this.queue.findIndex((entry) => entry.height > item.height);
        this.queue.splice(next < 0 ? this.queue.length : next, 0, item);
      },
    ).finally(() => {
      this.idle = true;
      this.trim();
    });
  }

  private trim() {
    const excess = this.pending - MAX_PENDING_HEIGHTS;
    if (excess <= 0) return;
    this.queue.splice(0, excess);
    this.countMissed(BigInt(excess));
  }

  private countMissed(count: bigint) {
    this.discarded = Math.min(Number.MAX_SAFE_INTEGER, this.discarded + Number(count));
  }
}
