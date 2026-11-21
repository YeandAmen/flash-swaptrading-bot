const usdcUnits = 1_000_000;
const quoteMaxAgeMs = 60_000;
const minRefineEdgeBps = -25;

interface SolanaMarketSample {
  venue: number;
  loanUsdc: number;
  quotedNetUsdc: number;
  edgeBps: number;
  at: number;
}

export interface SolanaMarketProbe {
  venue: number;
  loanUsdc: number;
  maxLoanUsdc: number;
  reason: 'discovery' | 'refinement';
  lead?: SolanaMarketSample;
}

function boundedLoan(amount: number, maxLoanUnits: number): number {
  return Math.min(maxLoanUnits, Math.floor(Math.max(1, amount) * usdcUnits)) / usdcUnits;
}

/** Use one quote probe per poll. Keep discovery on schedule while refining fresh executable spreads. */
export class SolanaMarketPlanner {
  private probes = 0;
  private discoveries = 0;
  private samples: SolanaMarketSample[] = [];

  constructor(private readonly venueCount: number) {}

  plan(limitUsdc: number, now: number): SolanaMarketProbe {
    const maxLoanUnits = Math.floor(limitUsdc * usdcUnits);
    const maxLoanUsdc = maxLoanUnits / usdcUnits;
    this.samples = this.samples.filter((sample) => sample.at >= now - quoteMaxAgeMs
      && sample.at <= now && sample.loanUsdc <= maxLoanUsdc);
    if (this.probes++ % 4 === 3) {
      const refinement = this.refine(maxLoanUnits);
      if (refinement) return refinement;
    }

    // Sweep every venue at each depth before repeating. Geometric spacing keeps the low probe useful with a high cap.
    const small = Math.min(25, maxLoanUsdc / 20);
    const sizes = [...new Set([boundedLoan(small, maxLoanUnits),
      boundedLoan(Math.sqrt(Math.max(1, small) * maxLoanUsdc), maxLoanUnits), maxLoanUsdc])];
    const discovery = this.discoveries++;
    const venue = discovery % this.venueCount;
    const loanUsdc = sizes[Math.floor(discovery / this.venueCount) % sizes.length];
    return { venue, loanUsdc, maxLoanUsdc, reason: 'discovery' };
  }

  record(probe: SolanaMarketProbe, quotedNetUsdc: number | undefined, at: number): void {
    const { venue, loanUsdc } = probe;
    this.samples = this.samples.filter((sample) => sample.venue !== venue || sample.loanUsdc !== loanUsdc);
    if (quotedNetUsdc !== undefined && Number.isFinite(quotedNetUsdc)) {
      this.samples.push({ venue, loanUsdc, quotedNetUsdc, edgeBps: quotedNetUsdc / loanUsdc * 10_000, at });
    }
  }

  private refine(maxLoanUnits: number): SolanaMarketProbe | undefined {
    const leads = this.samples.filter((sample) => sample.edgeBps >= minRefineEdgeBps)
      .sort((a, b) => {
        // For positive quotes prefer the best absolute return. For near misses compare spread across sizes.
        if (a.quotedNetUsdc > 0 || b.quotedNetUsdc > 0) return b.quotedNetUsdc - a.quotedNetUsdc || b.at - a.at;
        return b.edgeBps - a.edgeBps || b.at - a.at;
      });
    for (const lead of leads) {
      const larger = lead.loanUsdc * 1.6;
      const smaller = lead.loanUsdc / 1.6;
      const neighbors = lead.quotedNetUsdc > 0 ? [larger, smaller] : [smaller, larger];
      for (const amount of neighbors) {
        const loanUsdc = boundedLoan(amount, maxLoanUnits);
        if (this.samples.some((sample) => sample.venue === lead.venue
          && sample.loanUsdc >= loanUsdc * 0.9 && sample.loanUsdc <= loanUsdc * 1.1)) continue;
        return { venue: lead.venue, loanUsdc, maxLoanUsdc: maxLoanUnits / usdcUnits, reason: 'refinement', lead };
      }
    }
    return undefined;
  }
}
