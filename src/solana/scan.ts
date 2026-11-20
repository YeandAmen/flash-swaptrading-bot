import {
  AccountRole, address, appendTransactionMessageInstructions, assertIsTransactionMessageWithinSizeLimit,
  compileTransaction, compressTransactionMessageUsingAddressLookupTables, createSolanaRpc, createTransactionMessage,
  getBase64EncodedWireTransaction, setTransactionMessageComputeUnitLimit, setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type AddressesByLookupTableAddress, type Instruction,
} from '@solana/kit';
import { redactDiagnostic } from '../diagnostics.js';
import {
  createKaminoFlashInstructions, createWalletAta, decodeKaminoUsdcReserve, decodeLookupTable, kaminoRepayment,
  JUPITER, KAMINO_MARKET_LOOKUP, KAMINO_USDC_RESERVE, MAINNET_GENESIS, SOLANA_PUBLIC_RPC, USDC, WRAPPED_SOL,
} from './protocol.js';

const COMMITMENT = 'confirmed';
const REQUEST_TIMEOUT_MS = 8_000;
const SLIPPAGE_BPS = 5;
const COMPUTE_UNITS = 1_400_000;
const PRIORITY_MICROLAMPORTS = 1_000n;
const USDC_UNITS = 1_000_000n;
const SOL_UNITS = 1_000_000_000n;
const VENUES = ['Whirlpool', 'Raydium CLMM'] as const;
const JUPITER_BUILD = 'https://api.jup.ag/swap/v2/build';

type Rpc = ReturnType<typeof createSolanaRpc>;
type Venue = typeof VENUES[number];
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
  loanUsdc?: number;
  minNetUsdc?: number;
  maxFeeLamports?: number;
}

interface SolanaRoute {
  buy: Venue;
  sell: Venue;
  status: 'no-route' | 'quote-error' | 'below-profit-floor' | 'simulation-failed' | 'simulated';
  quotedNetBeforeNetworkUsdc?: number;
  simulatedNetUsdc?: number;
  simulatedCostLamports?: number;
  unitsConsumed?: number;
  slot?: number;
  qualified?: boolean;
  detail?: string;
}

export interface SolanaScanResult {
  chain: 'solana';
  mode: 'paper';
  checkedAt: string;
  slot: number;
  wallet: Address;
  walletSol: number;
  loanUsdc: number;
  flashFeeUsdc: number | null;
  availableUsdc: number;
  routes: SolanaRoute[];
  status: 'scanned' | 'loan-unavailable';
}

function envNumber(value: string | undefined): number | undefined {
  return value === undefined || value.trim() === '' ? undefined : Number(value);
}

export function solanaScanConfig(env: NodeJS.ProcessEnv = process.env): SolanaScanConfig {
  return {
    wallet: env.SOLANA_WALLET_ADDRESS ?? '',
    rpcUrl: env.SOLANA_RPC_URL,
    jupiterApiKey: env.JUPITER_API_KEY,
    loanUsdc: envNumber(env.SOLANA_LOAN_USDC),
    minNetUsdc: envNumber(env.SOLANA_MIN_NET_USDC),
    maxFeeLamports: envNumber(env.SOLANA_MAX_FEE_LAMPORTS),
  };
}

function usdcAmount(value: number, minimum: number, maximum: number, label: string): bigint {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} USDC`);
  }
  return BigInt(Math.round(value * Number(USDC_UNITS)));
}

function rawAmount(value: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error('Jupiter returned an invalid token amount');
  return BigInt(value);
}

function usdcUnits(raw: bigint): number {
  return Number(raw) / Number(USDC_UNITS);
}

function deadline() {
  return { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

async function buildSwap(
  wallet: Address, input: Address, output: Address, destination: Address,
  amount: bigint, venue: Venue, apiKey?: string,
): Promise<JupiterBuild | null> {
  const url = new URL(JUPITER_BUILD);
  url.search = new URLSearchParams({
    inputMint: input, outputMint: output, taker: wallet, amount: amount.toString(),
    destinationTokenAccount: destination, wrapAndUnwrapSol: 'false',
    slippageBps: String(SLIPPAGE_BPS), dexes: venue, maxAccounts: '22', transactionVersion: '0',
  }).toString();
  const result = await fetch(url, {
    headers: apiKey ? { 'x-api-key': apiKey } : {},
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    || swap.swapMode !== 'ExactIn' || swap.slippageBps !== SLIPPAGE_BPS
    || rawAmount(swap.otherAmountThreshold) === 0n || rawAmount(swap.otherAmountThreshold) > rawAmount(swap.outAmount)) {
    throw new Error('Jupiter returned incompatible swap terms');
  }
  if (!swap.routePlan?.length || swap.routePlan.some(({ swapInfo }) =>
    swapInfo.label !== venue || swapInfo.inputMint !== input || swapInfo.outputMint !== output)) return null;
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

function swapInstruction(swap: JupiterBuild): Instruction {
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

async function lookupTables(rpc: Rpc, swaps: JupiterBuild[]): Promise<AddressesByLookupTableAddress> {
  const keys = [...new Set([
    KAMINO_MARKET_LOOKUP, ...swaps.flatMap((swap) => Object.keys(swap.addressesByLookupTableAddress ?? {})),
  ])].map(address);
  if (keys.length > 8) throw new Error('Jupiter returned too many lookup tables');
  const { value } = await rpc.getMultipleAccounts(keys, { encoding: 'base64', commitment: COMMITMENT }).send(deadline());
  return Object.fromEntries(keys.map((key, i) => {
    const account = value[i];
    if (!account) throw new Error('An address lookup table is missing on-chain');
    return [key, decodeLookupTable(account.owner, Buffer.from(account.data[0], 'base64'))];
  }));
}

function summarizeFailure(error: unknown, apiKey?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactDiagnostic(apiKey ? message.replaceAll(apiKey, '[Jupiter API key]') : message).slice(0, 220);
}

/** Read-only Solana mainnet paper scan. The transaction is unsigned and never returned or broadcast. */
export async function scanSolanaCycle(config: SolanaScanConfig): Promise<SolanaScanResult> {
  if (!config.wallet) throw new Error('Set SOLANA_WALLET_ADDRESS to the public address of your Solana wallet');
  const wallet = address(config.wallet);
  const loan = usdcAmount(config.loanUsdc ?? 250, 1, 100_000, 'Loan size');
  const minimumNet = usdcAmount(config.minNetUsdc ?? 0.05, 0.000001, 1_000, 'Minimum net profit');
  const maxFeeLamports = config.maxFeeLamports ?? 50_000;
  if (!Number.isSafeInteger(maxFeeLamports) || maxFeeLamports < 5_000 || maxFeeLamports > 5_000_000) {
    throw new Error('Maximum network fee must be between 5,000 and 5,000,000 lamports');
  }
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
  const repay = reserve.active ? kaminoRepayment(loan, reserve) : null;
  const result: SolanaScanResult = {
    chain: 'solana', mode: 'paper', checkedAt: new Date().toISOString(),
    slot: Number(context.slot), wallet, walletSol: Number(balance) / Number(SOL_UNITS),
    loanUsdc: usdcUnits(loan), flashFeeUsdc: repay === null ? null : usdcUnits(repay - loan),
    availableUsdc: usdcUnits(reserve.available), routes: [], status: 'loan-unavailable',
  };
  if (repay === null || loan > reserve.available) return result;
  result.status = 'scanned';

  result.routes = await Promise.all(VENUES.map(async (buy, index): Promise<SolanaRoute> => {
    const sell = VENUES[1 - index];
    let quote: number | undefined;
    try {
      const first = await buildSwap(wallet, USDC, WRAPPED_SOL, solAta.ata, loan, buy, config.jupiterApiKey);
      if (!first) return { buy, sell, status: 'no-route', detail: 'No direct first-leg route' };
      const firstMinimum = rawAmount(first.otherAmountThreshold);
      const second = await buildSwap(wallet, WRAPPED_SOL, USDC, usdcAta.ata, firstMinimum, sell, config.jupiterApiKey);
      if (!second) return { buy, sell, status: 'no-route', detail: 'No direct return route' };
      const usedPools = new Set(first.routePlan.map(({ swapInfo }) => address(swapInfo.ammKey)));
      if (second.routePlan.some(({ swapInfo }) => usedPools.has(address(swapInfo.ammKey)))) {
        return { buy, sell, status: 'no-route', detail: 'Routes share a liquidity pool' };
      }
      const beforeNetwork = rawAmount(second.otherAmountThreshold) - repay;
      quote = usdcUnits(beforeNetwork);
      if (beforeNetwork < minimumNet) return { buy, sell, status: 'below-profit-floor', quotedNetBeforeNetworkUsdc: quote };
      if (balance < 5_000n) throw new Error('The public wallet has no SOL to cover a full transaction simulation');

      const [tables, { value: blockhash }] = await Promise.all([
        lookupTables(rpc, [first, second]),
        rpc.getLatestBlockhash({ commitment: COMMITMENT, minContextSlot: context.slot }).send(deadline()),
      ]);
      const prefix = appendTransactionMessageInstructions(
        [usdcAta.instruction, solAta.instruction],
        setTransactionMessageComputeUnitPrice(PRIORITY_MICROLAMPORTS, setTransactionMessageComputeUnitLimit(COMPUTE_UNITS,
          setTransactionMessageLifetimeUsingBlockhash(blockhash, setTransactionMessageFeePayer(wallet,
            createTransactionMessage({ version: 0 }))),
        )),
      );
      const [borrow, repayment] = await createKaminoFlashInstructions(
        wallet, usdcAta.ata, loan, prefix.instructions.length, reserve,
      );
      const message = compressTransactionMessageUsingAddressLookupTables(
        appendTransactionMessageInstructions([borrow, swapInstruction(first), swapInstruction(second), repayment], prefix),
        tables,
      );
      assertIsTransactionMessageWithinSizeLimit(message);
      const unsigned = getBase64EncodedWireTransaction(compileTransaction(message));
      const { value: simulation, context: execution } = await rpc.simulateTransaction(unsigned, {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, minContextSlot: context.slot, commitment: COMMITMENT,
      }).send(deadline());
      if (simulation.err) {
        const programError = simulation.logs?.find((line) => line.startsWith('Program log: Error: '));
        const errorName = typeof simulation.err === 'string' ? simulation.err : Object.keys(simulation.err).join(', ');
        const cause = programError?.slice('Program log: Error: '.length) ?? errorName;
        throw new Error(`Atomic simulation failed: ${cause}`);
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
      const costUsdc = (costLamports * loan + firstMinimum - 1n) / firstMinimum;
      const net = postUsdc - preUsdc - costUsdc;
      return {
        buy, sell, status: 'simulated', quotedNetBeforeNetworkUsdc: quote, simulatedNetUsdc: usdcUnits(net),
        simulatedCostLamports: Number(costLamports), unitsConsumed: Number(simulation.unitsConsumed ?? 0),
        slot: Number(execution.slot),
        qualified: fee <= BigInt(maxFeeLamports) && net >= minimumNet && beforeNetwork >= costUsdc + minimumNet,
      };
    } catch (error) {
      return { buy, sell, status: quote === undefined ? 'quote-error' : 'simulation-failed', quotedNetBeforeNetworkUsdc: quote,
        detail: summarizeFailure(error, config.jupiterApiKey) };
    }
  }));
  return result;
}
