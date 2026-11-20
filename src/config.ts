import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- tiny .env loader (no dependency) -------------------------------------
function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
// Fork tests use only their explicit loopback endpoints and isolated data.
if (process.env.FORK_MODE !== '1') loadEnv(path.join(ROOT, '.env'));

const num = (k: string, d: number) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${k} must be a number`);
  return n;
};
const str = (k: string, d = '') => process.env[k] ?? d;
const liveTradingSetting = str('ALLOW_LIVE_TRADING', 'off');
const forkSetting = str('FORK_MODE', '0');

function isLocalForkRpc(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

const dataDirSetting = str('DATA_DIR');
export const DATA_DIR = path.resolve(ROOT, dataDirSetting || 'data');

export const CONFIG = {
  rpcUrl: str('RPC_URL'),
  /** Where signed spot transactions are sent. Flashbots Protect is the default. */
  sendRpcUrl: str('SEND_RPC_URL', 'https://rpc.flashbots.net/fast'),
  port: num('PORT', 7777),
  host: '127.0.0.1',
  loopSeconds: num('LOOP_SECONDS', 30),
  historyDays: num('HISTORY_DAYS', 60),
  paperStartUsd: num('PAPER_START_USD', 50),
  /** Mainnet signing requires this opt-in in addition to an explicit arming action. */
  allowLiveTrading: liveTradingSetting === 'on',
  keychainService: str('KEYCHAIN_SERVICE', 'eth-token-bot'),
  keychainAccount: str('KEYCHAIN_ACCOUNT', 'bot-wallet'),
  /** Optional local import from an owner-only key file. Forks always use an isolated throwaway one. */
  walletKeyFile: str('WALLET_KEY_FILE'),
  /** Test mode for a local anvil fork: skip Flashbots status checks. */
  forkMode: forkSetting === '1',
};

if (!CONFIG.rpcUrl) throw new Error('RPC_URL missing. Put it in .env');
if (liveTradingSetting !== 'off' && liveTradingSetting !== 'on') throw new Error('ALLOW_LIVE_TRADING must be on or off');
if (forkSetting !== '0' && forkSetting !== '1') throw new Error('FORK_MODE must be 0 or 1');
if (CONFIG.forkMode && (!isLocalForkRpc(CONFIG.rpcUrl) || !isLocalForkRpc(CONFIG.sendRpcUrl))) {
  throw new Error('FORK_MODE requires loopback HTTP RPC_URL and SEND_RPC_URL (127.0.0.1 or [::1])');
}
if (CONFIG.forkMode && (CONFIG.allowLiveTrading || !CONFIG.walletKeyFile || !dataDirSetting || DATA_DIR === path.join(ROOT, 'data'))) {
  throw new Error('FORK_MODE requires ALLOW_LIVE_TRADING=off, a throwaway WALLET_KEY_FILE and a separate DATA_DIR');
}
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const a = (x: string): Address => getAddress(x.toLowerCase());

export const ADDR = {
  usdc: a('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  weth: a('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  uniFactory: a('0x1F98431c8aD98523631AE4a59f267346ea31F984'),
  quoterV2: a('0x61fFE014bA17989E743c5F6cB21bF9697530B21e'),
  swapRouter02: a('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'),
  multicall3: a('0xcA11bde05977b3631167028862bE2a173976CA11'),
};

/** `symbol` is the bot's unique, stable key for the token (core: plain symbol, others: SYMBOL.abcd from the address). */
export interface TokenCfg { symbol: string; address: Address; decimals: number; core: boolean; name?: string }

/**
 * Core tokens: always scanned, slightly looser depth rule. In TOKEN_MODE=all (default) every other ERC-20
 * from public token lists is scanned too, and kept only if it passes the on-chain safety checks.
 */
export const CORE_TOKENS: TokenCfg[] = [
  { symbol: 'WETH', address: ADDR.weth, decimals: 18, core: true },
  { symbol: 'WBTC', address: a('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'), decimals: 8, core: true },
  { symbol: 'LINK', address: a('0x514910771AF9Ca656af840dff83E8264EcF986CA'), decimals: 18, core: true },
  { symbol: 'UNI', address: a('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'), decimals: 18, core: true },
  { symbol: 'AAVE', address: a('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9'), decimals: 18, core: true },
  { symbol: 'LDO', address: a('0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32'), decimals: 18, core: true },
];

/** Token universe & safety filters for "all tokens" mode. */
export const TOKENS = {
  mode: str('TOKEN_MODE', 'all') as 'all' | 'core',
  listUrls: str('TOKEN_LIST_URLS', 'https://tokens.coingecko.com/ethereum/all.json,https://tokens.uniswap.org')
    .split(',').map((s) => s.trim()).filter(Boolean),
  // non-core token's deepest Uniswap v3 pool (vs WETH or USDC) must hold at least this much quote-side value
  minPoolUsd: num('MIN_POOL_USD', 30_000),
  corePoolUsd: 25_000,
  maxTokens: num('MAX_TOKENS', 300), // deepest N non-core tokens are scanned
  minHistoryDays: num('MIN_HISTORY_DAYS', 14), // non-core tokens need this much price history before they can be bought
  maxRoundTripTaxPct: num('MAX_ROUNDTRIP_TAX_PCT', 0.02), // simulated buy->sell may lose at most fees + this
  maxAllocPct: num('LONGTAIL_MAX_ALLOC_PCT', 0.5), // max equity in one non-core token
  refreshHours: 24,
};

/** Automatic gas top-up: swap a little USDC -> ETH when the wallet's ETH runs low. */
export const GAS_TOPUP = {
  enabled: str('GAS_TOPUP', 'on') !== 'off',
  belowEth: num('GAS_TOPUP_BELOW_ETH', 0.0015),
  usd: num('GAS_TOPUP_USD', 3),
  maxPerDay: num('GAS_TOPUP_MAX_PER_DAY', 4),
};

export const USDC_DECIMALS = 6;

/**
 * ML signal model (inspired by asavinov/intelligent-trading-bot): engineered features -> logistic regression
 * -> probability that a trade reaches +1R before -1R within the horizon. Walk-forward validated; in `auto` mode it only
 * drives entries when its out-of-sample results beat the rule-based strategy.
 */
export const ML = {
  mode: str('ML_MODE', 'auto') as 'auto' | 'on' | 'off',
  horizonHours: 48,
  retrainEveryHours: 72, // walk-forward refit cadence in backtests
  minTrainDays: 21,
  minAuc: num('ML_MIN_AUC', 0.55),
  /** buy when the model's probability is at least this many times the base rate (winners are rare, so absolute 50%+ never happens) */
  liftThresholds: [1.5, 2, 2.5, 3],
  l2: 0.01,
};

/** Strategy brain parameters (hourly bars). */
export const STRATEGY = {
  emaFast: 20,
  emaSlow: 50,
  emaLong: 200, // long-term trend filter (~8 days)
  rsiPeriod: 14,
  volLookback: 168, // 7 days of hourly returns
  momLookback: 72, // 3 days
  minMomentumSigma: 0.75, // risk-adjusted 3-day momentum needed to buy
  rsiMin: 45,
  rsiMax: 72,
  max24hDrop: -0.03,
  minDailyVol: 0.015, // skip stablecoins / pegged assets (their tiny volatility fakes "momentum")
  stopVolMult: 1.5, // stop = 1.5 x daily volatility
  minStopPct: 0.03,
  maxStopPct: 0.15,
  rewardRisk: 2.5, // take-profit = 2.5 x stop distance
  trailActivateR: 1.0, // start trailing after +1R
  trailFactor: 0.8, // trail distance = 0.8 x stop distance
  timeStopHours: 120,
  timeStopMinPnl: 0.01,
  minBars: 80,
};

/** Risk manager parameters. */
export const RISK = {
  riskPerTradePct: num('RISK_PER_TRADE_PCT', 0.025), // max equity lost if stop is hit
  maxAllocPct: num('MAX_ALLOC_PCT', 0.95),
  maxPositions: num('MAX_POSITIONS', 3), // tokens held at the same time
  maxPositionPct: num('MAX_POSITION_PCT', 0.45), // max equity in any one position
  minTradeUsd: num('MIN_TRADE_USD', 10),
  maxSlippageBps: num('MAX_SLIPPAGE_BPS', 50),
  panicSlippageBps: 200,
  costHurdleMult: num('COST_HURDLE_MULT', 3), // target move must be >= 3x round-trip cost
  maxRoundTripCostPct: num('MAX_ROUND_TRIP_COST_PCT', 0.03),
  maxEntryGasGwei: num('MAX_ENTRY_GAS_GWEI', 8),
  maxExitGasGwei: num('MAX_EXIT_GAS_GWEI', 60),
  dailyLossLimitPct: num('DAILY_LOSS_LIMIT_PCT', 0.06),
  maxDrawdownPct: num('MAX_DRAWDOWN_PCT', 0.25),
  cooldownHoursAfterExit: 6,
  cooldownHoursAfterStop: 24,
  maxConsecutiveFailures: 3,
  minGasEth: num('MIN_GAS_ETH', 0.0005), // floor for new buys (the bot tops itself up from USDC above this)
  approvalMode: str('APPROVAL_MODE', 'exact') as 'exact' | 'unlimited',
  /** Gas units used for cost estimates (measured on fork tests). */
  gasUnits: { approve: 60_000, swap1Hop: 150_000, swap2Hop: 230_000 },
};

/**
 * MEV arbitrage searcher: watches every token that has 2+ WETH pools (Uniswap v3 fee tiers, Uniswap v2, SushiSwap),
 * and when the same token is cheaper in one pool than another, buys in the cheap pool and sells in the dear one in a
 * single flash-swap transaction (no capital needed), sent privately as a Flashbots bundle: it only lands if it is
 * profitable, otherwise it costs nothing. Arbitrage only: it never front-runs or sandwiches anyone.
 * Scanning is always on (paper mode); real bundles need "Arm MEV" in the dashboard.
 */
const configuredMevV2 = str('MEV_V2_CONTRACT_ADDRESS').trim();
const configuredMevV3 = str('MEV_V3_CONTRACT_ADDRESS').trim();
const mevBuilderTipPct = num('MEV_BUILDER_TIP_PCT', 0.5);
const mevMinNetUsd = num('MEV_MIN_NET_USD', 0.05);
export type MevFundingMode = 'auto' | 'pool' | 'aave' | 'morpho' | 'balancer';
export const MEV = {
  enabled: str('MEV', 'on') !== 'off',
  funding: str('MEV_FUNDING', 'auto') as MevFundingMode,
  v2ContractAddress: configuredMevV2 ? getAddress(configuredMevV2) : null,
  v3ContractAddress: configuredMevV3 ? getAddress(configuredMevV3) : null,
  minPoolWeth: num('MEV_MIN_POOL_WETH', 2), // ignore pools holding less WETH than this
  universe: str('MEV_UNIVERSE', 'all'), // independently check the public list; 'spot' only uses the spot/core universe
  maxTrackedPools: num('MEV_MAX_TRACKED_POOLS', 480),
  builderTipPct: mevBuilderTipPct, // share of the after-gas profit paid to the block builder
  minNetUsd: mevMinNetUsd, // smallest after-gas, after-tip profit worth a bundle
  idleBuilderTipPct: num('MEV_IDLE_BUILDER_TIP_PCT', mevBuilderTipPct),
  idleMinNetUsd: num('MEV_IDLE_MIN_NET_USD', mevMinNetUsd),
  idleGasPaddingPct: num('MEV_IDLE_GAS_PADDING_PCT', 0.25),
  maxSimsPerBlock: num('MEV_MAX_SIMS_PER_BLOCK', 3),
  builders: str('MEV_BUILDERS', 'https://relay.flashbots.net,https://rpc.titanbuilder.xyz,https://rpc.beaverbuild.org,https://rpc.quasar.win')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

// --- validate settings at startup (a typo here must stop the bot, not silently disable a safety limit)
function check(ok: boolean, msg: string) {
  if (!ok) throw new Error(`Invalid setting in .env: ${msg}`);
}
const frac = (k: string, v: number, maxInclusive = false) =>
  check(v > 0 && (maxInclusive ? v <= 1 : v < 1), `${k}=${v} must be a fraction like 0.25 (= 25%)`);
frac('RISK_PER_TRADE_PCT', RISK.riskPerTradePct);
frac('MAX_ALLOC_PCT', RISK.maxAllocPct, true);
frac('DAILY_LOSS_LIMIT_PCT', RISK.dailyLossLimitPct);
frac('MAX_DRAWDOWN_PCT', RISK.maxDrawdownPct);
frac('MAX_ROUND_TRIP_COST_PCT', RISK.maxRoundTripCostPct);
check(Number.isInteger(RISK.maxSlippageBps) && RISK.maxSlippageBps >= 1 && RISK.maxSlippageBps <= 1000, `MAX_SLIPPAGE_BPS=${RISK.maxSlippageBps} must be a whole number 1..1000 (50 = 0.5%)`);
check(RISK.costHurdleMult >= 1, 'COST_HURDLE_MULT must be >= 1');
check(RISK.minTradeUsd >= 1, 'MIN_TRADE_USD must be >= 1');
check(RISK.minGasEth >= 0, 'MIN_GAS_ETH must be >= 0');
check(RISK.maxEntryGasGwei > 0 && RISK.maxExitGasGwei >= RISK.maxEntryGasGwei, 'MAX_EXIT_GAS_GWEI must be >= MAX_ENTRY_GAS_GWEI > 0');
check(RISK.approvalMode === 'exact' || RISK.approvalMode === 'unlimited', 'APPROVAL_MODE must be exact or unlimited');
check(CONFIG.loopSeconds >= 5, 'LOOP_SECONDS must be >= 5');
check(CONFIG.historyDays >= 15 && CONFIG.historyDays <= 365, 'HISTORY_DAYS must be 15..365');
check(CONFIG.paperStartUsd > 0, 'PAPER_START_USD must be > 0');
check(Number.isInteger(CONFIG.port) && CONFIG.port >= 1024 && CONFIG.port <= 65535, 'PORT must be 1024..65535');
check(TOKENS.mode === 'all' || TOKENS.mode === 'core', 'TOKEN_MODE must be all or core');
check(TOKENS.minPoolUsd >= 1000, 'MIN_POOL_USD must be >= 1000');
check(Number.isInteger(RISK.maxPositions) && RISK.maxPositions >= 1 && RISK.maxPositions <= 10, 'MAX_POSITIONS must be 1..10');
frac('MAX_POSITION_PCT', RISK.maxPositionPct, true);
check(ML.mode === 'auto' || ML.mode === 'on' || ML.mode === 'off', 'ML_MODE must be auto, on or off');
check(ML.minAuc > 0.5 && ML.minAuc < 1, 'ML_MIN_AUC must be between 0.5 and 1');
check(Number.isInteger(TOKENS.maxTokens) && TOKENS.maxTokens >= 1 && TOKENS.maxTokens <= 1000, 'MAX_TOKENS must be 1..1000');
check(TOKENS.minHistoryDays >= 4 && TOKENS.minHistoryDays <= CONFIG.historyDays, 'MIN_HISTORY_DAYS must be 4..HISTORY_DAYS');
frac('MAX_ROUNDTRIP_TAX_PCT', TOKENS.maxRoundTripTaxPct);
frac('LONGTAIL_MAX_ALLOC_PCT', TOKENS.maxAllocPct, true);
check(GAS_TOPUP.belowEth > 0 && GAS_TOPUP.belowEth < 1, 'GAS_TOPUP_BELOW_ETH must be between 0 and 1 ETH');
check(GAS_TOPUP.usd >= 1 && GAS_TOPUP.usd <= 100, 'GAS_TOPUP_USD must be 1..100');
check(Number.isInteger(GAS_TOPUP.maxPerDay) && GAS_TOPUP.maxPerDay >= 1 && GAS_TOPUP.maxPerDay <= 24, 'GAS_TOPUP_MAX_PER_DAY must be 1..24');
check(MEV.minPoolWeth >= 0.1, 'MEV_MIN_POOL_WETH must be >= 0.1');
check(['auto', 'pool', 'aave', 'morpho', 'balancer'].includes(MEV.funding), 'MEV_FUNDING must be auto, pool, aave, morpho or balancer');
check(!(MEV.v2ContractAddress && MEV.v3ContractAddress), 'Configure only one FlashArb contract address');
check(MEV.funding !== 'balancer' || MEV.v3ContractAddress !== null, 'MEV_FUNDING=balancer requires MEV_V3_CONTRACT_ADDRESS');
check(MEV.universe === 'all' || MEV.universe === 'spot', 'MEV_UNIVERSE must be all or spot');
check(Number.isInteger(MEV.maxTrackedPools) && MEV.maxTrackedPools >= 16 && MEV.maxTrackedPools <= 1000, 'MEV_MAX_TRACKED_POOLS must be 16..1000');
frac('MEV_BUILDER_TIP_PCT', MEV.builderTipPct);
check(MEV.minNetUsd >= 0.01, 'MEV_MIN_NET_USD must be >= 0.01');
frac('MEV_IDLE_BUILDER_TIP_PCT', MEV.idleBuilderTipPct);
check(MEV.idleBuilderTipPct >= MEV.builderTipPct, 'MEV_IDLE_BUILDER_TIP_PCT must be at least MEV_BUILDER_TIP_PCT');
check(MEV.idleMinNetUsd >= 0.01 && MEV.idleMinNetUsd <= MEV.minNetUsd, 'MEV_IDLE_MIN_NET_USD must be between 0.01 and MEV_MIN_NET_USD');
check(MEV.idleGasPaddingPct >= 0.10 && MEV.idleGasPaddingPct <= 0.25, 'MEV_IDLE_GAS_PADDING_PCT must be between 0.10 and 0.25');
check(Number.isInteger(MEV.maxSimsPerBlock) && MEV.maxSimsPerBlock >= 1 && MEV.maxSimsPerBlock <= 10, 'MEV_MAX_SIMS_PER_BLOCK must be 1..10');
check(MEV.builders.every((u) => /^https:\/\//.test(u)), 'MEV_BUILDERS must be https URLs separated by commas');
