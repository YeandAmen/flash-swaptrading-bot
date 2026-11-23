import {
  AccountRole, address, appendTransactionMessageInstructions, isTransactionMessageWithinSizeLimit,
  compileTransaction, compressTransactionMessageUsingAddressLookupTables, createSolanaRpc, createTransactionMessage,
  getBase64Decoder, getBase64EncodedWireTransaction, getAddressDecoder, getCompiledTransactionMessageDecoder,
  setTransactionMessageComputeUnitLimit, setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type AddressesByLookupTableAddress, type TransactionMessageBytesBase64, type Instruction, type Transaction,
} from '@solana/kit';
import { describeSimulationFailure } from './simulation-error.js';
import { redactDiagnostic } from '../diagnostics.js';
import { validSolanaSwapLossUsdc, type FlashTest } from '../network-test.js';
import { lighthouseAtaFloor, lighthouseLamports, lighthouseTokenAmount } from './guard.js';
import { DEFAULT_SOLANA_LOAN_USDC, isValidSolanaLoanLimit, MAX_SAFE_SOLANA_LOAN_USDC, MAX_SOLANA_LOAN_UNITS } from './market.js';
import {
  createKaminoFlashInstructions, createWalletAta, decodeKaminoUsdcReserve, decodeLookupTable, kaminoRepayment,
  JUPITER, KAMINO_MARKET_LOOKUP, KAMINO_USDC_RESERVE, MAINNET_GENESIS, SOLANA_PUBLIC_RPC, USDC, WRAPPED_SOL,
} from './protocol.js';

const COMMITMENT = 'confirmed';
const REQUEST_TIMEOUT_MS = 8_000;
const ORDINARY_SLIPPAGE_BPS = 1;
const TEST_SLIPPAGE_BPS = 5;
const COMPUTE_UNITS = 1_400_000;
const PRIORITY_MICROLAMPORTS = 1_000n;
const USDC_UNITS = 1_000_000n;
const SOL_UNITS = 1_000_000_000n;
const legacyToken = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const systemProgram = address('11111111111111111111111111111111');
const routeV2 = Buffer.from('bb64facc31c4af14', 'hex');
const addressDecoder = getAddressDecoder();
export const solanaVenuePairs = [
  ['Whirlpool', 'Raydium CLMM'],
  ['Whirlpool', 'Meteora DLMM'],
  ['Raydium CLMM', 'Meteora DLMM'],
] as const;
export const solanaDiscoveryPairs = [
  solanaVenuePairs[0],
  ['Meteora DLMM', 'PancakeSwap'],
  ['SolFi V2', 'BisonFi'],
] as const;
const returnVenues = [...solanaDiscoveryPairs.flat(), 'Kipseli', 'ZeroFi'] as const;
const JUPITER_BUILD = 'https://api.jup.ag/swap/v2/build';
export const SOLANA_TEST_MAX_FEE_LAMPORTS = 50_000n;

type Rpc = ReturnType<typeof createSolanaRpc>;
type VenuePair = typeof solanaVenuePairs[number] | typeof solanaDiscoveryPairs[number];
type Venue = VenuePair[number];
type ReturnVenue = typeof returnVenues[number];
type JupiterAccount = { pubkey: string; isWritable: boolean; isSigner: boolean };
type JupiterInstruction = { programId: string; data: string; accounts: JupiterAccount[] };
type JupiterBuild = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: { swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string } }[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction: JupiterInstruction | null;
  otherInstructions: JupiterInstruction[];
  tipInstruction: JupiterInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

export interface SolanaScanConfig {
  wallet: string;
  rpcUrl?: string;
  jupiterApiKey?: string;
  fetchBuild?: (url: URL, init: RequestInit) => Promise<Response>;
  loanUsdc?: number;
  clampLoanToReserve?: boolean;
  // Unlimited ordinary planning keeps token amounts in atomic units through transaction assembly.
  plannedLoanUnits?: bigint;
  useFullReserve?: boolean;
  minNetUsdc?: number;
  maxFeeLamports?: number;
  venuePair?: VenuePair;
  compareReturnVenues?: boolean;
}

export type SolanaFlashTest = Pick<FlashTest, 'id' | 'minimumNetUsd' | 'minimumLoanUsd' | 'maximumSwapLossUsdc'>;

export interface SolanaSwapLossGuard {
  cap: bigint;
  baselineUsdc: bigint;
  baselineWsol: bigint;
  baselineLamports: bigint;
}

type TokenBalances = readonly { accountIndex: number; mint: Address; owner?: Address; uiTokenAmount: { amount: string } }[] | null;

/** Independently verify the canonical ATA and native balances reported for a capped-loss test. */
export function matchesSolanaSwapLossBalances(meta: {
  preBalances?: readonly bigint[] | null; postBalances?: readonly bigint[] | null;
  preTokenBalances?: TokenBalances; postTokenBalances?: TokenBalances;
}, accounts: readonly Address[], wallet: Address, usdcAta: Address, wsolAta: Address, guard: SolanaSwapLossGuard, fee: bigint): boolean {
  const amount = (balances: TokenBalances | undefined, mint: Address, ata: Address) => {
    const index = accounts.indexOf(ata);
    if (index < 0) return undefined;
    const token = balances?.find((token) => token.accountIndex === index && token.mint === mint && token.owner === wallet);
    return token && rawAmount(token.uiTokenAmount.amount);
  };
  const afterUsdc = amount(meta.postTokenBalances, USDC, usdcAta);
  const afterWsol = amount(meta.postTokenBalances, WRAPPED_SOL, wsolAta);
  return amount(meta.preTokenBalances, USDC, usdcAta) === guard.baselineUsdc
    && amount(meta.preTokenBalances, WRAPPED_SOL, wsolAta) === guard.baselineWsol
    && afterUsdc !== undefined && afterUsdc >= guard.baselineUsdc - guard.cap
    && afterWsol !== undefined && afterWsol >= guard.baselineWsol
    && meta.preBalances?.[0] === guard.baselineLamports
    && (meta.postBalances?.[0] ?? -1n) >= guard.baselineLamports - fee;
}

export interface PreparedSolanaCycle {
  testId?: string;
  transaction: Transaction;
  lastValidBlockHeight: bigint;
  simulationSlot: bigint;
  maximumLamportDebit: bigint;
  feeLamports: bigint;
  rentLamports: bigint;
  firstMinimum: bigint;
  loan: bigint;
  net: bigint;
  swapLossGuard?: SolanaSwapLossGuard;
}

export interface SolanaRouteDecline {
  status: 'route-declined';
  canTryAlternate(): boolean;
}

interface SolanaRoute {
  buy: Venue;
  sell: string;
  status: 'no-route' | 'quote-error' | 'below-profit-floor' | 'simulation-failed' | 'simulated';
  // Both figures use the amount of WSOL guaranteed by the first leg.
  expectedNetBeforeNetworkUsdc?: number;
  quotedNetBeforeNetworkUsdc?: number; // Guaranteed by the return instruction if the swap succeeds.
  simulatedNetUsdc?: number;
  simulatedCostLamports?: number;
  unitsConsumed?: number;
  slot?: number;
  qualified?: boolean;
  detail?: string;
}

export interface SolanaScanResult {
  chain: 'solana';
  mode: 'paper' | 'live';
  checkedAt: string;
  slot: number;
  wallet: Address;
  walletSol: number;
  loanUsdc: number;
  loanUsdcUnits: string;
  slippageBps: number;
  flashFeeUsdc: number | null;
  flashFeeUsdcUnits: string | null;
  availableUsdc: number;
  availableUsdcUnits: string;
  routes: SolanaRoute[];
  status: 'scanned' | 'loan-unavailable';
}

function envNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

export function solanaScanConfig(env: NodeJS.ProcessEnv = process.env): SolanaScanConfig {
  const rawLoan = env.SOLANA_LOAN_USDC?.trim();
  const loanUsdc = rawLoan === 'unlimited' ? Infinity : envNumber(rawLoan) ?? DEFAULT_SOLANA_LOAN_USDC;
  if ((loanUsdc === Infinity && rawLoan !== 'unlimited') || !isValidSolanaLoanLimit(loanUsdc)) {
    throw new Error('Loan size must be unlimited or a positive, safely representable USDC amount of at least 1');
  }
  return {
    wallet: env.SOLANA_WALLET_ADDRESS ?? '',
    rpcUrl: env.SOLANA_RPC_URL,
    jupiterApiKey: env.JUPITER_API_KEY,
    loanUsdc,
    minNetUsdc: envNumber(env.SOLANA_MIN_NET_USDC),
    maxFeeLamports: envNumber(env.SOLANA_MAX_FEE_LAMPORTS),
  };
}

function usdcAmount(value: number, minimum: number, maximum: number, label: string, round = Math.round): bigint {
  const units = round(value * Number(USDC_UNITS));
  if (!Number.isSafeInteger(units) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} USDC`);
  }
  return BigInt(units);
}

// A requested minimum is an inclusive floor in atomic USDC units, so sub-unit rounding is upward.
export function solanaTestMinimums(test?: Omit<SolanaFlashTest, 'id'> | null) {
  const maximumSwapLossUsdc = test?.maximumSwapLossUsdc;
  if (maximumSwapLossUsdc !== undefined && (!validSolanaSwapLossUsdc(maximumSwapLossUsdc)
    || test?.minimumNetUsd !== undefined || test?.minimumLoanUsd !== undefined)) {
    throw new Error('Invalid Solana test swap loss cap');
  }
  return {
    minimumNet: test?.minimumNetUsd === undefined ? undefined
      : usdcAmount(test.minimumNetUsd, Number.MIN_VALUE, 1_000, 'Test minimum net profit', Math.ceil),
    minimumLoan: test?.minimumLoanUsd === undefined ? undefined
      : usdcAmount(test.minimumLoanUsd, 1, 100_000, 'Test minimum loan size', Math.ceil),
    maximumSwapLoss: maximumSwapLossUsdc === undefined ? undefined : BigInt(Math.round(maximumSwapLossUsdc * Number(USDC_UNITS))),
  };
}

function rawAmount(value: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error('Jupiter returned an invalid token amount');
  const amount = BigInt(value);
  if (amount > MAX_SOLANA_LOAN_UNITS) throw new Error('Token amount exceeds u64');
  return amount;
}

function usdcUnits(raw: bigint): number {
  return Number(raw) / Number(USDC_UNITS);
}

function deadline(signal?: AbortSignal) {
  return { abortSignal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

export async function buildSwap(
  wallet: Address, input: Address, output: Address, destination: Address,
  amount: bigint, venues: ReturnVenue | readonly ReturnVenue[], apiKey?: string, slippageBps = TEST_SLIPPAGE_BPS, signal?: AbortSignal,
  fetchBuild: NonNullable<SolanaScanConfig['fetchBuild']> = fetch,
): Promise<JupiterBuild | null> {
  if (amount <= 0n || amount > MAX_SOLANA_LOAN_UNITS) throw new Error('Jupiter input amount is outside the token u64 range');
  const allowedVenues: readonly string[] = typeof venues === 'string' ? [venues] : venues;
  const url = new URL(JUPITER_BUILD);
  url.search = new URLSearchParams({
    inputMint: input, outputMint: output, taker: wallet, amount: amount.toString(),
    destinationTokenAccount: destination, wrapAndUnwrapSol: 'false',
    slippageBps: String(slippageBps), dexes: allowedVenues.join(','), maxAccounts: '22', transactionVersion: '0',
  }).toString();
  const result = await fetchBuild(url, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (result.status === 401 || result.status === 403) throw new Error('Jupiter rejected access. Set a valid JUPITER_API_KEY.');
  if (result.status === 429) throw new Error('Jupiter rate limited this scan.');
  if (!result.ok) {
    // The restrictive venue/account filter legitimately has no path for some amounts.
    const rejection = await result.json().catch(() => null) as { error?: string; errorCode?: string } | null;
    if (result.status === 400 && (rejection?.errorCode === 'COULD_NOT_FIND_ANY_ROUTE'
      || /could not find any route|no route/i.test(rejection?.error ?? ''))) return null;
    throw new Error(`Jupiter Build returned HTTP ${result.status}`);
  }
  const swap = await result.json() as JupiterBuild;
  if (swap.inputMint !== input || swap.outputMint !== output || rawAmount(swap.inAmount) !== amount
    || swap.swapMode !== 'ExactIn' || swap.slippageBps !== slippageBps
    || rawAmount(swap.otherAmountThreshold) === 0n || rawAmount(swap.otherAmountThreshold) > rawAmount(swap.outAmount)) {
    throw new Error('Jupiter returned incompatible swap terms');
  }
  if (!swap.routePlan?.length || swap.routePlan.some(({ swapInfo }) =>
    !allowedVenues.includes(swapInfo.label) || swapInfo.inputMint !== input || swapInfo.outputMint !== output)) return null;
  const instruction = swap.swapInstruction;
  if (instruction?.programId !== JUPITER
    || swap.cleanupInstruction || swap.tipInstruction || swap.otherInstructions?.length
    || !instruction.accounts.some((account) => account.pubkey === destination && account.isWritable)
    || instruction.accounts.some((account) => account.isSigner && account.pubkey !== wallet)) {
    throw new Error('Jupiter returned an unexpected swap instruction or auxiliary transfer');
  }
  // Both required wallet ATAs are created idempotently by this client. Jupiter's auxiliary instructions are not used.
  return swap;
}

export function swapInstruction(swap: JupiterBuild): Instruction {
  return {
    programAddress: JUPITER,
    accounts: swap.swapInstruction.accounts.map((meta) => {
      const role = meta.isSigner
        ? (meta.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
        : (meta.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY);
      return { address: address(meta.pubkey), role };
    }),
    data: Buffer.from(swap.swapInstruction.data, 'base64'),
  };
}

export async function lookupTables(rpc: Rpc, swaps: JupiterBuild[], signal?: AbortSignal): Promise<AddressesByLookupTableAddress> {
  const keys = [...new Set([
    KAMINO_MARKET_LOOKUP, ...swaps.flatMap((swap) => Object.keys(swap.addressesByLookupTableAddress ?? {})),
  ])].map(address);
  if (keys.length > 8) throw new Error('Jupiter returned too many lookup tables');
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: 'base64', commitment: COMMITMENT }).send(deadline(signal));
  return Object.fromEntries(keys.map((key, i) => {
    const account = value[i];
    if (!account) throw new Error('An address lookup table is missing on-chain');
    return [key, decodeLookupTable(account.owner, Buffer.from(account.data[0], 'base64'))];
  }));
}

class RouteCompositionError extends Error {}

export function routeMinimum(swap: JupiterBuild, wallet: Address, source: Address, destination: Address,
  slippageBps = TEST_SLIPPAGE_BPS): bigint {
  const bytes = Buffer.from(swap.swapInstruction.data, 'base64');
  const accounts = swap.swapInstruction.accounts;
  if (bytes.length < 34 || !bytes.subarray(0, 8).equals(routeV2)) {
    throw new RouteCompositionError('Jupiter returned an unsupported RouteV2 instruction layout');
  }
  if (bytes.readBigUInt64LE(8) !== rawAmount(swap.inAmount)
    || bytes.readBigUInt64LE(16) !== rawAmount(swap.outAmount)
    || bytes.readUInt16LE(24) !== slippageBps || bytes.readUInt16LE(26) !== 0 || bytes.readUInt16LE(28) !== 0
    || accounts[0]?.pubkey !== wallet || !accounts[0].isSigner
    || accounts[1]?.pubkey !== source || !accounts[1].isWritable
    || accounts[2]?.pubkey !== destination || !accounts[2].isWritable
    || accounts[3]?.pubkey !== swap.inputMint || accounts[4]?.pubkey !== swap.outputMint
    || accounts[5]?.pubkey !== legacyToken || accounts[6]?.pubkey !== legacyToken
    || accounts[7]?.pubkey !== destination || accounts[9]?.pubkey !== JUPITER) {
    throw new Error('Jupiter RouteV2 account or amount does not match the signed route');
  }
  // The integer lower bound also covers a JSON threshold that rounds up by one unit.
  return bytes.readBigUInt64LE(16) * BigInt(10_000 - slippageBps) / 10_000n;
}

async function liveWalletState(rpc: Rpc, wallet: Address, usdAta: Address, solAta: Address, minContextSlot: bigint, signal?: AbortSignal) {
  const { value: [payer, usdc, wsol], context } = await rpc.getMultipleAccounts(
    [wallet, usdAta, solAta], { encoding: 'base64', commitment: COMMITMENT, minContextSlot },
  ).send(deadline(signal));
  if (!payer || payer.owner !== systemProgram || payer.executable || payer.data[0] !== '') {
    throw new Error('The live Solana payer must be a normal System Program account');
  }
  const amount = (account: typeof usdc, mint: Address) => {
    if (!account) return 0n;
    const data = Buffer.from(account.data[0], 'base64');
    if (account.owner !== legacyToken || account.executable || data.length !== 165
      || addressDecoder.decode(data, 0) !== mint || addressDecoder.decode(data, 32) !== wallet
      || data.readUInt32LE(72) !== 0 || data[108] !== 1 || data.readUInt32LE(129) !== 0) {
      throw new Error('Solana wallet ATA has unexpected owner, mint, delegate, or close authority');
    }
    return data.readBigUInt64LE(64);
  };
  return {
    lamports: payer.lamports, usdc: amount(usdc, USDC), wsol: amount(wsol, WRAPPED_SOL), slot: context.slot,
    createUsdc: !usdc, createWsol: !wsol,
  };
}

function nativeCostInUsdc(lamports: bigint, loan: bigint, firstMinimum: bigint): bigint {
  return (lamports * loan + firstMinimum - 1n) / firstMinimum;
}

function summarizeFailure(error: unknown, apiKey?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactDiagnostic(apiKey ? message.replaceAll(apiKey, '[Jupiter API key]') : message).slice(0, 220);
}

/** Build and simulate an unsigned mainnet transaction. Only the live worker can authorize a qualified candidate. */
export async function scanSolanaCycle(config: SolanaScanConfig,
  execute?: (candidate: PreparedSolanaCycle) => Promise<void | SolanaRouteDecline>, requestedTest?: SolanaFlashTest | string): Promise<SolanaScanResult> {
  if (!config.wallet) throw new Error('Set SOLANA_WALLET_ADDRESS to the public address of your Solana wallet');
  const wallet = address(config.wallet);
  const test = execute && requestedTest ? (typeof requestedTest === 'string' ? { id: requestedTest } : requestedTest) : null;
  const slippageBps = test ? TEST_SLIPPAGE_BPS : ORDINARY_SLIPPAGE_BPS;
  const venues = config.venuePair ?? solanaVenuePairs[0];
  const limits = solanaTestMinimums(test);
  const unlimited = config.loanUsdc === Infinity;
  const { plannedLoanUnits, useFullReserve } = config;
  if ((plannedLoanUnits !== undefined || useFullReserve) && (!unlimited || requestedTest)) {
    throw new Error('Raw reserve sizing requires an unlimited ordinary scan');
  }
  if (plannedLoanUnits !== undefined && (typeof plannedLoanUnits !== 'bigint'
    || plannedLoanUnits < USDC_UNITS || plannedLoanUnits > MAX_SOLANA_LOAN_UNITS)) {
    throw new Error('Planned loan size must be at least 1 USDC and fit in u64 token units');
  }
  if (unlimited && test) throw new Error('Loan size for a manual Solana test must be between 1 and 100000 USDC');
  const requested = unlimited ? DEFAULT_SOLANA_LOAN_USDC : config.loanUsdc ?? DEFAULT_SOLANA_LOAN_USDC;
  const configuredLoan = plannedLoanUnits ?? usdcAmount(requested, 1, test ? 100_000 : MAX_SAFE_SOLANA_LOAN_USDC,
    'Loan size', requested <= 100_000 ? Math.round : Math.floor);
  const desiredLoan = limits.minimumLoan !== undefined && limits.minimumLoan > configuredLoan ? limits.minimumLoan : configuredLoan;
  const gasOnlyTest = !!test && limits.minimumNet === undefined;
  const lossCap = limits.maximumSwapLoss;
  const minimumNet = lossCap !== undefined ? -lossCap
    : gasOnlyTest ? 1n : limits.minimumNet ?? usdcAmount(config.minNetUsdc ?? 0.05, 0.000001, 1_000, 'Minimum net profit');
  const configuredFee = config.maxFeeLamports ?? 50_000;
  if (!Number.isSafeInteger(configuredFee) || configuredFee < 5_000 || configuredFee > 5_000_000) {
    throw new Error('Maximum network fee must be between 5,000 and 5,000,000 lamports');
  }
  const maxFeeLamports = test && BigInt(configuredFee) > SOLANA_TEST_MAX_FEE_LAMPORTS
    ? SOLANA_TEST_MAX_FEE_LAMPORTS : BigInt(configuredFee);
  const rpcUrl = config.rpcUrl ?? SOLANA_PUBLIC_RPC;
  const protocol = new URL(rpcUrl).protocol;
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('Solana RPC requires an HTTP(S) endpoint');
  const rpc = createSolanaRpc(rpcUrl);
  const [genesis, { value: account, context }, { value: balance }, usdcAta, solAta] = await Promise.all([
    rpc.getGenesisHash().send(deadline()),
    rpc.getAccountInfo(KAMINO_USDC_RESERVE, { encoding: 'base64', commitment: COMMITMENT }).send(deadline()),
    rpc.getBalance(wallet, { commitment: COMMITMENT }).send(deadline()),
    createWalletAta(wallet, USDC),
    createWalletAta(wallet, WRAPPED_SOL),
  ]);
  if (String(genesis) !== MAINNET_GENESIS) throw new Error('Solana RPC is not connected to mainnet-beta');
  if (!account || account.executable) throw new Error('Could not load the Kamino USDC reserve');
  const reserve = decodeKaminoUsdcReserve(account.owner, Buffer.from(account.data[0], 'base64'));
  const clamp = !test && (unlimited || config.clampLoanToReserve === true);
  const loan = useFullReserve || (clamp && desiredLoan > reserve.available) ? reserve.available : desiredLoan;
  const repay = reserve.active && loan >= USDC_UNITS ? kaminoRepayment(loan, reserve) : null;
  const result: SolanaScanResult = {
    chain: 'solana', mode: execute ? 'live' : 'paper', checkedAt: new Date().toISOString(),
    slot: Number(context.slot), wallet, walletSol: Number(balance) / Number(SOL_UNITS),
    loanUsdc: usdcUnits(loan), loanUsdcUnits: loan.toString(), slippageBps,
    flashFeeUsdc: repay === null ? null : usdcUnits(repay - loan), flashFeeUsdcUnits: repay === null ? null : (repay - loan).toString(),
    availableUsdc: usdcUnits(reserve.available), availableUsdcUnits: reserve.available.toString(), routes: [], status: 'loan-unavailable',
  };
  if (repay === null || repay > MAX_SOLANA_LOAN_UNITS || loan > reserve.available) return result;
  result.status = 'scanned';

  let submission: Promise<void | SolanaRouteDecline> | undefined;
  let alternate: PreparedSolanaCycle | undefined;
  let deferredReturn: { index: number; first: JupiterBuild; previousFailure?: string } | undefined;
  let retriedSimulationExit = false;
  const afterRetry = (route: SolanaRoute, previousFailure?: string): SolanaRoute => previousFailure
    ? { ...route, detail: `${route.detail ?? route.status}. Previous ${previousFailure}` } : route;
  const retryDeadline = performance.now() + REQUEST_TIMEOUT_MS;
  const scanRoute = async (buy: Venue, index: number, firstQuote?: JupiterBuild, signal?: AbortSignal): Promise<SolanaRoute> => {
    const pairedVenue = venues[1 - index];
    const compareReturns = config.compareReturnVenues && !test && !firstQuote;
    let reusableFirst = firstQuote;
    let hasDifferentExit = false;
    let sell: string = compareReturns ? 'Jupiter direct return' : pairedVenue;
    const tryPairedReturn = (first: JupiterBuild, unavailable: SolanaRoute, previousFailure?: string) => {
      if (!submission) {
        const remaining = Math.ceil(retryDeadline - performance.now());
        if (previousFailure && remaining <= 0) return unavailable;
        return scanRoute(buy, index, first, previousFailure ? AbortSignal.timeout(remaining) : undefined)
          .then(route => afterRetry(route, previousFailure));
      }
      // Only the opposite entry can reach this point once the first candidate has been handed off.
      deferredReturn = { index, first, previousFailure };
      return unavailable;
    };
    let quote: Pick<SolanaRoute, 'expectedNetBeforeNetworkUsdc' | 'quotedNetBeforeNetworkUsdc'> | undefined;
    try {
      const first = firstQuote ?? await buildSwap(wallet, USDC, WRAPPED_SOL, solAta.ata, loan, buy,
        config.jupiterApiKey, slippageBps, undefined, config.fetchBuild);
      if (!first) return { buy, sell, status: 'no-route', detail: 'No direct first-leg route' };
      reusableFirst = first;
      const firstMinimum = execute ? routeMinimum(first, wallet, usdcAta.ata, solAta.ata, slippageBps) : rawAmount(first.otherAmountThreshold);
      if (firstMinimum <= 0n) throw new Error('Jupiter did not guarantee any first-leg output');
      const exits = compareReturns ? returnVenues.filter((venue) => venue !== buy) : pairedVenue;
      const second = await buildSwap(wallet, WRAPPED_SOL, USDC, usdcAta.ata, firstMinimum, exits,
        config.jupiterApiKey, slippageBps, signal, config.fetchBuild);
      if (!second) {
        const unavailable: SolanaRoute = { buy, sell, status: 'no-route', detail: 'No direct return route' };
        return compareReturns ? tryPairedReturn(first, unavailable) : unavailable;
      }
      const labels = new Set(second.routePlan.map(({ swapInfo }) => swapInfo.label));
      sell = [...labels].join(' + ');
      hasDifferentExit = labels.size > 1 || !labels.has(pairedVenue);
      const usedPools = new Set(first.routePlan.map(({ swapInfo }) => address(swapInfo.ammKey)));
      if (second.routePlan.some(({ swapInfo }) => usedPools.has(address(swapInfo.ammKey)))) {
        return { buy, sell, status: 'no-route', detail: 'Routes share a liquidity pool' };
      }
      const returnMinimum = execute ? routeMinimum(second, wallet, solAta.ata, usdcAta.ata, slippageBps) : rawAmount(second.otherAmountThreshold);
      const beforeNetwork = returnMinimum - repay;
      quote = {
        expectedNetBeforeNetworkUsdc: usdcUnits(rawAmount(second.outAmount) - repay),
        quotedNetBeforeNetworkUsdc: usdcUnits(beforeNetwork),
      };
      if (beforeNetwork < minimumNet) return { buy, sell, status: 'below-profit-floor', ...quote };
      if (balance < 5_000n) throw new Error('The public wallet has no SOL to cover a full transaction simulation');

      const [tables, blockhashResult, baseline] = await Promise.all([
        lookupTables(rpc, [first, second], signal),
        rpc.getLatestBlockhash({ commitment: COMMITMENT, minContextSlot: context.slot }).send(deadline(signal)),
        execute ? liveWalletState(rpc, wallet, usdcAta.ata, solAta.ata, context.slot, signal) : null,
      ]);
      let swapLossGuard: SolanaSwapLossGuard | undefined;
      if (lossCap !== undefined) {
        if (!baseline || baseline.createUsdc || baseline.createWsol || baseline.usdc < lossCap) {
          throw new Error('The capped Solana test requires both existing wallet ATAs and USDC covering the swap loss cap');
        }
        swapLossGuard = { cap: lossCap, baselineUsdc: baseline.usdc, baselineWsol: baseline.wsol, baselineLamports: baseline.lamports };
      }
      const blockhash = blockhashResult.value;
      const requiredSlot = [context.slot, blockhashResult.context.slot, baseline?.slot ?? 0n]
        .reduce((latest, slot) => slot > latest ? slot : latest);
      const template = setTransactionMessageComputeUnitPrice(PRIORITY_MICROLAMPORTS, setTransactionMessageComputeUnitLimit(COMPUTE_UNITS,
        setTransactionMessageLifetimeUsingBlockhash(blockhash, setTransactionMessageFeePayer(wallet,
          createTransactionMessage({ version: 0 }))),
      ));
      const createAccounts = [
        ...(!baseline || baseline.createUsdc ? [usdcAta.instruction] : []),
        ...(!baseline || baseline.createWsol ? [solAta.instruction] : []),
      ];
      const assemble = async (before: readonly Instruction[], after: readonly Instruction[]) => {
        const prefix = appendTransactionMessageInstructions(before, template);
        const [borrow, repayment] = await createKaminoFlashInstructions(wallet, usdcAta.ata, loan, prefix.instructions.length, reserve);
        const message = compressTransactionMessageUsingAddressLookupTables(
          appendTransactionMessageInstructions([borrow, swapInstruction(first), swapInstruction(second), repayment, ...after], prefix), tables,
        );
        if (!isTransactionMessageWithinSizeLimit(message)) throw new RouteCompositionError('Composed Solana transaction exceeds the size limit');
        return compileTransaction(message);
      };
      let transaction = await assemble(createAccounts, []);
      let maxDebit = 0n;
      let rentLamports = 0n;
      let exactFee: bigint | null = null;
      if (baseline) {
        const encoded = getBase64Decoder().decode(transaction.messageBytes) as TransactionMessageBytesBase64;
        const [feeQuote, rentPerAccount] = await Promise.all([
          rpc.getFeeForMessage(encoded, { commitment: COMMITMENT, minContextSlot: requiredSlot }).send(deadline(signal)),
          createAccounts.length ? rpc.getMinimumBalanceForRentExemption(165n, { commitment: COMMITMENT }).send(deadline(signal)) : 0n,
        ]);
        rentLamports = BigInt(createAccounts.length) * rentPerAccount;
        exactFee = feeQuote.value;
        if (exactFee === null || exactFee > maxFeeLamports) throw new Error('Solana fee quote exceeds its cap or is unavailable');
        maxDebit = exactFee + rentLamports;
        if (baseline.lamports <= maxDebit) throw new Error('Solana fee payer cannot cover the fee and required ATA rent');
        const requiredUsdc = minimumNet + nativeCostInUsdc(gasOnlyTest ? rentLamports : maxDebit, loan, firstMinimum);
        if (beforeNetwork < requiredUsdc) return { buy, sell, status: 'below-profit-floor', ...quote };
        transaction = await assemble([
          lighthouseLamports(wallet, 'equal', baseline.lamports - exactFee),
          ...createAccounts,
          lighthouseTokenAmount(usdcAta.ata, 'equal', baseline.usdc),
        ], [
          lighthouseAtaFloor(usdcAta.ata, baseline.usdc + requiredUsdc),
          lighthouseAtaFloor(solAta.ata, baseline.wsol),
          lighthouseLamports(wallet, 'atLeast', baseline.lamports - maxDebit),
        ]);
      }
      const unsigned = getBase64EncodedWireTransaction(transaction);
      const { value: simulation, context: execution } = await rpc.simulateTransaction(unsigned, {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: !execute,
        minContextSlot: execute ? requiredSlot : context.slot, commitment: COMMITMENT,
      }).send(deadline(signal));
      if (simulation.err) {
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        const programs = compiled.version === 0
          ? compiled.instructions.map(ix => compiled.staticAccounts[ix.programAddressIndex]) : [];
        const failure = describeSimulationFailure(simulation.err, simulation.logs, programs);
        const unavailable: SolanaRoute = { buy, sell, status: 'simulation-failed', ...quote, detail: failure.detail };
        if (execute && failure.returnSlippage && compareReturns && hasDifferentExit && !retriedSimulationExit
          && performance.now() < retryDeadline) {
          retriedSimulationExit = true;
          return tryPairedReturn(first, unavailable, `${sell}: ${failure.detail}`);
        }
        return unavailable;
      }
      const usdBalance = (balances: typeof simulation.postTokenBalances) => balances?.reduce((sum, token) =>
        token.mint === USDC && token.owner === wallet ? sum + rawAmount(token.uiTokenAmount.amount) : sum, 0n);
      const preUsdc = usdBalance(simulation.preTokenBalances);
      const postUsdc = usdBalance(simulation.postTokenBalances);
      const preSol = simulation.preBalances?.[0];
      const postSol = simulation.postBalances?.[0];
      const fee = simulation.fee;
      if (preUsdc === undefined || postUsdc === undefined || preSol === undefined || postSol === undefined
        || fee === undefined || fee === null) throw new Error('Solana RPC omitted exact simulated balance or fee changes');
      const debit = preSol - postSol;
      const costLamports = debit > fee ? debit : fee;
      // Use the first-leg guaranteed output to conservatively convert SOL fees into the same USDC units as the gain.
      const costUsdc = nativeCostInUsdc(costLamports, loan, firstMinimum);
      const net = postUsdc - preUsdc - costUsdc;
      // Functional tests assess swap results before network fees. Capped-loss tests have no ATA rent.
      const protectedLamports = gasOnlyTest ? costLamports - fee : costLamports;
      const protectedCost = nativeCostInUsdc(protectedLamports, loan, firstMinimum);
      const lossBalancesMatch = !swapLossGuard || matchesSolanaSwapLossBalances(simulation,
        getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts,
        wallet, usdcAta.ata, solAta.ata, swapLossGuard, fee);
      const qualified = fee <= maxFeeLamports && postUsdc - preUsdc >= protectedCost + minimumNet
        && beforeNetwork >= protectedCost + minimumNet && lossBalancesMatch
        && (exactFee === null || (fee === exactFee && costLamports <= maxDebit));
      if (signal && (signal.aborted || performance.now() >= retryDeadline)) throw new Error('Paired Solana return quote expired');
      if (qualified && execute && baseline && exactFee !== null) {
        const candidate = { ...(test ? { testId: test.id } : {}), transaction, lastValidBlockHeight: blockhash.lastValidBlockHeight,
          simulationSlot: execution.slot, maximumLamportDebit: maxDebit, feeLamports: exactFee, rentLamports,
          firstMinimum, loan, net, ...(swapLossGuard ? { swapLossGuard } : {}) };
        if (!submission) {
          // Give the first qualifying route to the signer while the opposite direction finishes.
          submission = Promise.resolve().then(() => execute(candidate));
          void submission.catch(() => undefined); // Observe early failures during the remaining quote.
        } else if (!test) {
          alternate = candidate;
        }
      }
      return {
        buy, sell, status: 'simulated', ...quote, simulatedNetUsdc: usdcUnits(net),
        simulatedCostLamports: Number(costLamports), unitsConsumed: Number(simulation.unitsConsumed ?? 0),
        slot: Number(execution.slot),
        qualified,
      };
    } catch (error) {
      // A different, single-venue exit may fit when the router's best return cannot be composed.
      const unavailable: SolanaRoute = { buy, sell, status: quote === undefined ? 'quote-error' : 'simulation-failed', ...quote,
        detail: summarizeFailure(error, config.jupiterApiKey) };
      if (error instanceof RouteCompositionError && compareReturns && hasDifferentExit && reusableFirst) {
        return tryPairedReturn(reusableFirst, unavailable);
      }
      return unavailable;
    }
  };
  result.routes = await Promise.all(venues.map((buy, index) => scanRoute(buy, index)));
  const initial = await submission;
  if (initial?.status === 'route-declined') {
    if (!alternate && deferredReturn) {
      const remaining = Math.ceil(retryDeadline - performance.now());
      if (remaining <= 0 || !initial.canTryAlternate()) return result;
      const { first, index, previousFailure } = deferredReturn;
      result.routes[index] = afterRetry(await scanRoute(venues[index], index, first, AbortSignal.timeout(remaining)), previousFailure);
      if (performance.now() >= retryDeadline) return result;
    }
    if (alternate && initial.canTryAlternate()) await execute?.(alternate);
  }
  return result;
}
