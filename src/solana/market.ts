export const DEFAULT_SOLANA_LOAN_USDC = 250;
export const MAX_SOLANA_LOAN_UNITS = (1n << 64n) - 1n;
const usdcUnits = 1_000_000;
// MAX_SAFE_INTEGER / 1e6 itself rounds back to an unsafe integer on multiplication.
export const MAX_SAFE_SOLANA_LOAN_USDC = (Number.MAX_SAFE_INTEGER - 1) / usdcUnits;
const quoteMaxAgeMs = 60_000;
const minRefineEdgeBps = -25;

export function isValidSolanaLoanLimit(value: number): boolean {
  return value === Infinity || (value >= 1 && value <= MAX_SAFE_SOLANA_LOAN_USDC);
}

interface SolanaMarketSample {
  venue: number;
  loanUsdc: number;
  loanUsdcUnits: string;
  quotedNetUsdc: number;
  edgeBps: number;
  at: number;
}

export interface SolanaMarketProbe {
  venue: number;
  loanUsdc: number;
  loanUsdcUnits: string;
  maxLoanUsdc: number;
  maxLoanUsdcUnits: string;
  reason: 'discovery' | 'refinement';
  fullReserve?: true;
  lead?: SolanaMarketSample;
}

function boundedLoan(amount: bigint, maximum: bigint): bigint {
  return amount < 1_000_000n ? 1_000_000n : amount > maximum ? maximum : amount;
}

function probeAmounts(loan: bigint, maximum: bigint) {
  return { loanUsdc: Number(loan) / usdcUnits, loanUsdcUnits: loan.toString(),
    maxLoanUsdc: Number(maximum) / usdcUnits, maxLoanUsdcUnits: maximum.toString() };
}

/** Use one quote probe per poll. Keep discovery on schedule while refining fresh executable spreads. */
export class SolanaMarketPlanner {
  private probes = 0;
  private discoveries = 0;
  private samples: SolanaMarketSample[] = [];

  constructor(private readonly venueCount: number) {}

  plan(limitUsdc: number, now: number, availableUnits?: bigint): SolanaMarketProbe {
    if (!isValidSolanaLoanLimit(limitUsdc)) {
      throw new RangeError('Solana discovery loan cap is outside the supported range');
    }
    if (availableUnits !== undefined && (availableUnits < 0n || availableUnits > MAX_SOLANA_LOAN_UNITS)) {
      throw new RangeError('Invalid Solana reserve amount');
    }
    const maximum = limitUsdc === Infinity
      ? boundedLoan(availableUnits ?? BigInt(DEFAULT_SOLANA_LOAN_USDC * usdcUnits), MAX_SOLANA_LOAN_UNITS)
      : BigInt(Math.floor(limitUsdc * usdcUnits));
    const maximumUsdc = Number(maximum) / usdcUnits;
    this.samples = this.samples.filter((sample) => sample.at >= now - quoteMaxAgeMs
      && sample.at <= now && BigInt(sample.loanUsdcUnits) <= maximum);
    const small = Math.min(25, maximumUsdc / 20);
    const smallestDiscovery = boundedLoan(BigInt(Math.floor(small * usdcUnits)), maximum);
    if (this.probes++ % 4 === 3) {
      const refinement = this.refine(maximum, smallestDiscovery);
      if (refinement) return refinement;
    }

    // Sweep every venue at each depth before repeating. Geometric spacing keeps the low probe useful with a high cap.
    const grid: bigint[] = [];
    if (maximum > 100_000_000_000n) {
      for (let amount = 25_000_000n; amount < maximum; amount *= 10n) grid.push(amount);
    } else {
      const middle = Math.sqrt(Math.max(1, small) * maximumUsdc);
      grid.push(smallestDiscovery, boundedLoan(BigInt(Math.floor(middle * usdcUnits)), maximum));
    }
    const sizes = [...new Set([...grid, maximum])];
    const discovery = this.discoveries++;
    const venue = discovery % this.venueCount;
    const loan = sizes[Math.floor(discovery / this.venueCount) % sizes.length];
    const fullReserve = limitUsdc === Infinity && availableUnits === loan;
    return { venue, ...probeAmounts(loan, maximum), reason: 'discovery', ...(fullReserve ? { fullReserve: true } : {}) };
  }

  record(probe: SolanaMarketProbe, quotedNetUsdc: number | undefined, at: number): void {
    const { venue, loanUsdc, loanUsdcUnits } = probe;
    this.samples = this.samples.filter((sample) => sample.venue !== venue || sample.loanUsdcUnits !== loanUsdcUnits);
    if (quotedNetUsdc !== undefined && Number.isFinite(quotedNetUsdc)) {
      this.samples.push({ venue, loanUsdc, loanUsdcUnits, quotedNetUsdc, edgeBps: quotedNetUsdc / loanUsdc * 10_000, at });
    }
  }

  private refine(maximum: bigint, smallestDiscovery: bigint): SolanaMarketProbe | undefined {
    // A near miss can test below the shallow discovery size. Continue from that smaller size only on a positive quote.
    const leads = this.samples.filter((sample) => sample.edgeBps >= minRefineEdgeBps
      && (BigInt(sample.loanUsdcUnits) >= smallestDiscovery || sample.quotedNetUsdc > 0))
      .sort((a, b) => {
        // For positive quotes prefer the best absolute return. For near misses compare spread across sizes.
        if (a.quotedNetUsdc > 0 || b.quotedNetUsdc > 0) return b.quotedNetUsdc - a.quotedNetUsdc || b.at - a.at;
        return b.edgeBps - a.edgeBps || b.at - a.at;
      });
    for (const lead of leads) {
      const principal = BigInt(lead.loanUsdcUnits);
      const larger = principal * 8n / 5n;
      const smaller = principal * 5n / 8n;
      const neighbors = lead.quotedNetUsdc > 0 ? [larger, smaller] : [smaller, larger];
      for (const amount of neighbors) {
        const loan = boundedLoan(amount, maximum);
        if (this.samples.some((sample) => sample.venue === lead.venue
          && 10n * BigInt(sample.loanUsdcUnits) >= loan * 9n && 10n * BigInt(sample.loanUsdcUnits) <= loan * 11n)) continue;
        return { venue: lead.venue, ...probeAmounts(loan, maximum), reason: 'refinement', lead };
      }
    }
    return undefined;
  }
}
