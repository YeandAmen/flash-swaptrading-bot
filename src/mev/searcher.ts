import fs from 'node:fs';
import path from 'node:path';
import { decodeFunctionResult, encodeFunctionData, keccak256, pad, parseEventLogs, parseGwei, type Address, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { DATA_DIR, MEV, type TokenCfg } from '../config.js';
import { publicClient } from '../chain.js';
import { UncertainTxError, type LiveExecutor } from '../executor.js';
import { BIG_BATCH, type McResult } from '../market.js';
import { FLASH_ARB_ABI, FLASH_ARB_BYTECODE, FLASH_ARB_RUNTIME } from './artifact.js';
import { sendBundle } from './bundles.js';
import { arbGas, bestCycle, buildStateReads, discoverArbPools, MEV_EXTRA_TOKENS, reservesOf, type ArbPool, type ArbToken } from './pools.js';

const STATE_FILE = path.join(DATA_DIR, 'mev.json');
/** Address where paper-mode simulations place the contract code (eth_call state override; nothing is deployed). */
const SIM_ADDR: Address = '0x00000000000000000000000000000000000ab1e5';
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0].slice(0, 200);
const eth = (wei: bigint) => Number(wei) / 1e18;

/** The bits of the trading engine the searcher needs. */
export interface MevHost {
  log(msg: string, level?: 'info' | 'warn' | 'error' | 'trade'): void;
  account: PrivateKeyAccount;
  exec: LiveExecutor;
  ethUsd(): number | null;
  gasPriceGwei(): number | null;
  /** latest base fee from the trading loop's block header (refreshed every ~30 s); null = read it ourselves */
  baseFeeGwei(): number | null;
  tokens(): TokenCfg[];
  /** an unresolved trading transaction exists (its nonce may still land) */
  tradePending(): boolean;
}

export type OppStatus = 'below gas' | 'would send' | 'sent' | 'landed' | 'not included' | 'failed' | 'skipped';

export interface MevOpp {
  t: number;
  block: number;
  symbol: string;
  buy: string; // venue where TOKEN is bought
  sell: string; // venue where it is sold
  sizeEth: number;
  grossEth: number; // profit before gas and tip
  gasEth: number;
  tipEth: number;
  netEth: number; // ours after gas and tip
  netUsd: number;
  status: OppStatus;
  count?: number; // times seen (repeats are merged)
  note?: string;
  hash?: Hex;
}

interface MevStats {
  since: number;
  blocks: number;
  candidates: number; // price gaps the quick math liked
  simulated: number; // checked exactly on-chain (eth_call)
  profitable: number; // still profitable after gas
  bundles: number;
  landed: number;
  netEth: number;
  netUsd: number;
  rpcCalls: number;
}

interface MevFile {
  version: 1;
  armed: boolean;
  armedAt: number | null;
  contract: Address | null;
  deployedAt: number | null;
  deployTx: Hex | null;
  deployStartedAt: number | null;
  deployGasUsd: number;
  stats: MevStats;
  recent: MevOpp[];
  best: HourBest[];
}

/** Closest the searcher got to a profitable arbitrage in one hour (ETH). */
interface HourBest {
  h: number; // hour start
  estGross: number; // best quick-math estimate before gas (every block, every token)
  estGas: number;
  estSymbol: string;
  simGross: number | null; // best exact simulation before gas (only gaps the quick math liked)
  simGas: number | null;
  simSymbol: string | null;
}

interface BlockRead {
  blockNumber: bigint;
  timestamp: number;
  results: McResult[];
}

interface Candidate {
  t: ArbToken;
  A: ArbPool;
  B: ArbPool;
  dx: number;
  est: number;
  gasUnits: number;
}

/** Short revert reason from a viem error ("unprofitable", "transfer", ...). */
function reasonOf(e: unknown): string {
  const x = e as { shortMessage?: string; details?: string; message?: string };
  const s = [x.details, x.shortMessage, x.message].filter(Boolean).join(' | ');
  const m = s.match(/reverted(?: with reason string)?:?\s*'?([^'|\n]{1,60})/i);
  return (m?.[1] ?? s.split('\n')[0]).trim().slice(0, 80) || 'reverted';
}

/**
 * MEV arbitrage searcher. Every block it reads all watched pools in ONE multicall, finds the token whose price differs
 * most between two pools (after fees), sizes the trade with closed-form math, confirms the exact profit with an
 * eth_call of the real contract, and, if it still pays after gas, sends a Flashbots bundle for the next block.
 * Paper mode (not armed) does everything except sending. It never front-runs or sandwiches anyone.
 */
export class MevSearcher {
  file: MevFile;
  tokens: ArbToken[] = [];
  status = 'starting';
  lastError: string | null = null;
  lastBlock: { number: number; at: number; candidates: number } | null = null;
  deploying = false;
  deployGas: number | null = null;
  private reads: ReturnType<typeof buildStateReads> | null = null;
  private poolsAt = 0;
  private pending: { hash: Hex; nonce: number; target: bigint; opp: MevOpp } | null = null;
  private cooldown = new Map<string, { until: number; est: number; grow: number }>();
  private stopping = false;

  constructor(private host: MevHost, private persist = true) {
    this.file = this.load();
  }

  // ------------------------------------------------------------------ persistence
  private load(): MevFile {
    try {
      const f = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as MevFile;
      if (f.version === 1) {
        f.recent ??= [];
        f.best = Array.isArray(f.best) ? f.best.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [];
        f.deployStartedAt ??= null;
        return f;
      }
    } catch { /* first run */ }
    return {
      version: 1, armed: false, armedAt: null, contract: null, deployedAt: null, deployTx: null, deployStartedAt: null, deployGasUsd: 0,
      stats: { since: Date.now(), blocks: 0, candidates: 0, simulated: 0, profitable: 0, bundles: 0, landed: 0, netEth: 0, netUsd: 0, rpcCalls: 0 },
      recent: [], best: [],
    };
  }

  save() {
    if (!this.persist) return;
    try {
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(this.file, null, 1));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) {
      console.error('mev save failed', e);
    }
  }

  private modeText(): string {
    if (!MEV.enabled) return 'Off (MEV=off in .env)';
    if (this.deploying) return 'Deploying the arbitrage contract (one time)…';
    if (this.file.armed && this.file.contract) return 'LIVE: a Flashbots bundle is sent whenever an arbitrage still pays after gas';
    if (this.file.armed) return 'Armed: waiting for the contract';
    return 'Paper mode: every block is scanned and simulated, nothing is sent';
  }

  // ------------------------------------------------------------------ lifecycle
  async start() {
    if (!MEV.enabled) { this.status = this.modeText(); return; }
    for (let i = 0; !this.stopping; i++) {
      try {
        await this.refreshPools();
        break;
      } catch (e) {
        this.lastError = errMsg(e);
        this.status = 'Finding arbitrage pools failed; retrying';
        await sleep(Math.min(120_000, 15_000 * (i + 1)));
      }
    }
    void this.estimateDeployGas();
    if (this.file.armed) void this.ensureDeployed(); // finish or verify an earlier deployment
    void this.loop();
  }

  stop() {
    this.stopping = true;
    this.save();
  }

  /** Re-discovers pools (daily, and after the trading universe changes). */
  async refreshPools() {
    if (!MEV.enabled) return;
    const tokens = await discoverArbPools([...this.host.tokens(), ...MEV_EXTRA_TOKENS], MEV.minPoolWeth);
    this.file.stats.rpcCalls += 3;
    this.tokens = tokens;
    this.reads = buildStateReads(tokens);
    this.poolsAt = Date.now();
    const pools = tokens.reduce((s, t) => s + t.pools.length, 0);
    this.host.log(`MEV: watching ${tokens.length} tokens in ${pools} pools (Uniswap v3 fee tiers, Uniswap v2, SushiSwap) for arbitrage — ${this.file.armed ? 'ARMED' : 'paper mode'}`);
    this.status = this.modeText();
  }

  private async loop() {
    let lastBlock = -1n;
    let backoff = 0;
    while (!this.stopping) {
      try {
        if (Date.now() - this.poolsAt > 24 * HOUR) await this.refreshPools();
        const r = await this.read();
        if (r.blockNumber === lastBlock) { await sleep(1_500); continue; }
        lastBlock = r.blockNumber;
        await this.onBlock(r);
        this.lastError = null;
        backoff = 0;
        // the next block is due 12 s after this one; read it shortly after it should exist
        await sleep(Math.min(13_000, Math.max(1_000, (r.timestamp + 12) * 1000 + 1_500 - Date.now())));
      } catch (e) {
        this.lastError = errMsg(e);
        backoff = Math.min(backoff * 2 + 5_000, 60_000);
        await sleep(backoff);
      }
    }
  }

  /** Test hook: read the current block and act on it once. */
  async scanOnce() {
    const r = await this.read();
    await this.onBlock(r);
    return r.blockNumber;
  }

  // ------------------------------------------------------------------ per block
  private async read(): Promise<BlockRead> {
    if (!this.reads) throw new Error('pools not loaded');
    const results = (await publicClient.multicall({ contracts: this.reads.contracts as any, allowFailure: true, batchSize: BIG_BATCH })) as McResult[];
    this.file.stats.rpcCalls++;
    if (results[0]?.status !== 'success' || results[1]?.status !== 'success') throw new Error('block read failed');
    return { blockNumber: results[0].result as bigint, timestamp: Number(results[1].result as bigint), results };
  }

  /** Latest base fee: the trading loop's recent header value, or (fresh = true / unknown) the block header right now. */
  private async baseFeeWei(fresh: boolean): Promise<{ wei: bigint; block: bigint | null }> {
    const g = fresh ? null : this.host.baseFeeGwei();
    if (g !== null && g > 0) return { wei: BigInt(Math.ceil(g * 1e9)), block: null };
    const b = await publicClient.getBlock({ blockTag: 'latest' });
    this.file.stats.rpcCalls++;
    return { wei: b.baseFeePerGas ?? parseGwei('1'), block: b.number };
  }

  private async onBlock(r: BlockRead) {
    this.file.stats.blocks++;
    await this.checkPending(r.blockNumber);
    // the next block's base fee can't be more than 12.5% above this one's; the estimate is refreshed before any real send
    const nextMaxBase = ((await this.baseFeeWei(false)).wei * 1125n) / 1000n + 1n;
    const gasPriceEth = Number(nextMaxBase) / 1e18;
    const cands: Candidate[] = [];
    const now = Date.now();
    let est: { net: number; gross: number; gas: number; symbol: string } | null = null;
    this.tokens.forEach((t, ti) => {
      const res = t.pools.map((p, pi) => reservesOf(t, p, r.results, this.reads!.at[ti][pi]));
      const { cycle } = bestCycle(t.pools, res);
      if (!cycle) return;
      const A = t.pools[cycle.buy];
      const B = t.pools[cycle.sell];
      const gasUnits = arbGas(A, B);
      const gasEth = gasUnits * gasPriceEth;
      if (!est || cycle.profit - gasEth > est.net) est = { net: cycle.profit - gasEth, gross: cycle.profit, gas: gasEth, symbol: t.token.symbol };
      if (cycle.profit <= gasEth * 0.8) return; // the quick math is rough: the simulation decides
      const cd = this.cooldown.get(`${A.address}|${B.address}`);
      if (cd && now < cd.until && cycle.profit < cd.est * cd.grow) return; // checked recently, nothing changed much
      cands.push({ t, A, B, dx: cycle.dx, est: cycle.profit, gasUnits });
    });
    this.lastBlock = { number: Number(r.blockNumber), at: now, candidates: cands.length };
    const e = est as { net: number; gross: number; gas: number; symbol: string } | null; // (set inside forEach: TS can't see it)
    if (e) {
      const hb = this.hourBest();
      if (hb.estGross < 0 || e.net > hb.estGross - hb.estGas) Object.assign(hb, { estGross: e.gross, estGas: e.gas, estSymbol: e.symbol });
    }
    cands.sort((x, y) => y.est - x.est);
    for (const c of cands.slice(0, MEV.maxSimsPerBlock)) {
      try {
        await this.evaluate(c, r, nextMaxBase);
      } catch (e) {
        this.lastError = errMsg(e);
      }
    }
    if (this.file.stats.blocks % 20 === 0) this.save();
  }

  /** This hour's record of how close we got (created on first use; the last 72 hours are kept). */
  private hourBest(): HourBest {
    const h = Math.floor(Date.now() / HOUR) * HOUR;
    const best = this.file.best;
    let cur = best[best.length - 1];
    if (!cur || cur.h !== h) {
      cur = { h, estGross: -1, estGas: 0, estSymbol: '', simGross: null, simGas: null, simSymbol: null };
      best.push(cur);
      if (best.length > 72) best.splice(0, best.length - 72);
    }
    return cur;
  }

  /** Best exact (simulated) arbitrage of the hour, next to what its gas would have cost. */
  private trackSim(grossEth: number, gasEth: number, symbol: string) {
    const b = this.hourBest();
    if (b.simGross === null || grossEth - gasEth > b.simGross - (b.simGas ?? 0)) {
      b.simGross = grossEth;
      b.simGas = gasEth;
      b.simSymbol = symbol;
    }
  }

  /** Exact profit of one route at `amountIn`, from an eth_call of the contract (the real one, or its code injected). */
  async simulate(t: ArbToken, A: ArbPool, B: ArbPool, amountIn: bigint, maxBlock: bigint): Promise<{ ok: true; profit: bigint } | { ok: false; reason: string }> {
    const contract = this.file.contract;
    const data = encodeFunctionData({
      abi: FLASH_ARB_ABI, functionName: 'execute',
      args: [{ poolA: A.address, poolB: B.address, token: t.token.address, aIsV2: A.v2, bIsV2: B.v2, amountIn, minProfit: 1n, tip: 0n, maxBlock }],
    });
    try {
      const res = await publicClient.call({
        account: this.host.account.address,
        to: contract ?? SIM_ADDR,
        data,
        stateOverride: contract
          ? undefined
          : [{ address: SIM_ADDR, code: FLASH_ARB_RUNTIME, stateDiff: [{ slot: pad('0x0'), value: pad(this.host.account.address) }] }],
      });
      if (!res.data) return { ok: false, reason: 'no result' };
      return { ok: true, profit: decodeFunctionResult({ abi: FLASH_ARB_ABI, functionName: 'execute', data: res.data }) as bigint };
    } catch (e) {
      return { ok: false, reason: reasonOf(e) };
    }
  }

  private async evaluate(c: Candidate, r: BlockRead, nextMaxBase: bigint) {
    const st = this.file.stats;
    st.candidates++;
    const sizes = [1, 0.5, 0.25, 0.1].map((f) => BigInt(Math.max(1, Math.floor(c.dx * f * 1e18))));
    const sims = await Promise.all(sizes.map((amt) => this.simulate(c.t, c.A, c.B, amt, r.blockNumber + 2n)));
    st.rpcCalls += sims.length;
    st.simulated++;
    let best: { amount: bigint; profit: bigint } | null = null;
    for (let i = 0; i < sims.length; i++) {
      const s = sims[i];
      if (s.ok && (!best || s.profit > best.profit)) best = { amount: sizes[i], profit: s.profit };
    }
    const ethUsd = this.host.ethUsd() ?? 0;
    const gasWei = BigInt(c.gasUnits) * nextMaxBase;
    const key = `${c.A.address}|${c.B.address}`;
    const opp: MevOpp = {
      t: Date.now(), block: Number(r.blockNumber), symbol: c.t.token.symbol, buy: c.A.venue, sell: c.B.venue,
      sizeEth: c.dx, grossEth: 0, gasEth: eth(gasWei), tipEth: 0, netEth: 0, netUsd: 0, status: 'failed',
    };
    if (!best) {
      // the quick estimate liked it but the exact simulation didn't (thin liquidity past the current tick,
      // transfer tax, odd token): such pools stay odd, so look again only after an hour or a much bigger gap
      this.cooldown.set(key, { until: Date.now() + HOUR, est: c.est, grow: 3 });
      opp.note = `simulation: ${sims.find((s): s is { ok: false; reason: string } => !s.ok)?.reason ?? 'reverted'}`;
      this.record(opp);
      return;
    }
    const b = best;
    const net = b.profit - gasWei;
    this.trackSim(eth(b.profit), eth(gasWei), c.t.token.symbol);
    opp.sizeEth = eth(b.amount);
    opp.grossEth = eth(b.profit);
    opp.netEth = eth(net);
    opp.netUsd = opp.netEth * ethUsd;
    const minNetWei = ethUsd > 0 ? BigInt(Math.floor((MEV.minNetUsd / ethUsd) * 1e18)) : 20_000_000_000_000n;
    if (net <= minNetWei * 2n) { // must leave room for the builder's tip and our minimum
      // estimate far above reality = an illusion of the quick math: back off for longer
      const illusion = Number(b.profit) / 1e18 < c.est * 0.1;
      this.cooldown.set(key, illusion ? { until: Date.now() + HOUR, est: c.est, grow: 3 } : { until: Date.now() + 5 * 60_000, est: c.est, grow: 1.5 });
      if (b.profit * 4n >= gasWei) { // only list near misses (gross at least a quarter of the gas), not dust
        opp.status = 'below gas';
        this.record(opp);
      }
      return;
    }
    st.profitable++;
    const tip = (net * BigInt(Math.round(MEV.builderTipPct * 10_000))) / 10_000n;
    opp.tipEth = eth(tip);
    opp.netEth = eth(net - tip);
    opp.netUsd = opp.netEth * ethUsd;
    if (!this.file.armed || !this.file.contract || this.deploying) {
      opp.status = 'would send';
      opp.note = 'paper mode';
      this.record(opp);
      return;
    }
    await this.sendLive(c, r, b, tip, opp);
  }

  private async sendLive(c: Candidate, r: BlockRead, best: { amount: bigint; profit: bigint }, tip: bigint, opp: MevOpp) {
    const exec = this.host.exec;
    const account = this.host.account;
    const contract = this.file.contract!;
    const skip = (note: string) => { opp.status = 'skipped'; opp.note = note; this.record(opp); };
    if (this.pending) return skip('previous bundle still pending');
    if (this.host.tradePending()) return skip('a trade is still settling');
    // exact base fee of the block we build on (the scan used the trading loop's value, up to ~30 s old)
    const fresh = await this.baseFeeWei(true);
    if (fresh.block !== null && fresh.block !== r.blockNumber) return skip('a new block arrived meanwhile; re-checked next block');
    const nextMaxBase = (fresh.wei * 1125n) / 1000n + 1n; // max possible base fee of the target block
    const target = r.blockNumber + 1n;
    const encode = (minProfit: bigint) => encodeFunctionData({
      abi: FLASH_ARB_ABI, functionName: 'execute',
      args: [{ poolA: c.A.address, poolB: c.B.address, token: c.t.token.address, aIsV2: c.A.v2, bIsV2: c.B.v2, amountIn: best.amount, minProfit, tip, maxBlock: target }],
    });
    // final check with the real contract and real limits; also gives the exact gas
    let gas: bigint;
    try {
      gas = ((await publicClient.estimateGas({ account, to: contract, data: encode(tip + BigInt(c.gasUnits) * nextMaxBase) })) * 125n) / 100n;
      this.file.stats.rpcCalls++;
    } catch (e) {
      opp.status = 'failed';
      opp.note = `final check: ${reasonOf(e)}`;
      this.record(opp);
      return;
    }
    const worstGas = gas * nextMaxBase; // gas limit x highest possible base fee: we never pay more than this
    if (best.profit - tip - worstGas <= 0n) {
      opp.status = 'below gas';
      opp.note = 'exact gas too high';
      this.record(opp);
      return;
    }
    // the contract reverts unless the profit covers the tip AND worst-case gas, so landing can never lose money
    const data = encode(tip + worstGas);
    if (!exec.reserveForBundle(Date.now() + 40_000)) return skip('wallet busy with a trade');
    try {
      const nonce = await exec.bundleNonce();
      const signed = await account.signTransaction({
        chainId: publicClient.chain.id, type: 'eip1559', to: contract, data, nonce, gas,
        maxFeePerGas: nextMaxBase, maxPriorityFeePerGas: 0n, value: 0n, // the builder is paid by the tip inside the tx
      });
      const hash = keccak256(signed);
      const res = await sendBundle([signed], target);
      const okN = res.filter((x) => x.ok).length;
      this.file.stats.bundles++;
      opp.hash = hash;
      opp.status = okN ? 'sent' : 'failed';
      opp.note = okN
        ? `to ${okN}/${res.length} builders for block ${target}`
        : `no builder accepted it: ${res.map((x) => `${x.builder}: ${x.detail}`).join('; ').slice(0, 160)}`;
      this.record(opp, false);
      if (!okN) { exec.releaseBundle(); return; }
      this.pending = { hash, nonce, target, opp };
      this.host.log(`[mev] Bundle sent: ${c.t.token.symbol} buy on ${c.A.venue}, sell on ${c.B.venue}; lands only if still profitable (+${opp.netEth.toFixed(5)} ETH expected), block ${target}`);
    } catch (e) {
      exec.releaseBundle();
      throw e;
    }
  }

  /** After the target block: did the bundle land? (Only it could have used our nonce while the gate was closed.) */
  private async checkPending(current: bigint) {
    const p = this.pending;
    if (!p || current < p.target) return;
    const exec = this.host.exec;
    const me = this.host.account.address;
    const nonceAfter = await publicClient.getTransactionCount({ address: me, blockNumber: p.target });
    this.file.stats.rpcCalls++;
    const st = this.file.stats;
    const ethUsd = this.host.ethUsd() ?? 0;
    if (nonceAfter > p.nonce) {
      exec.noteNonceUsed(p.nonce);
      let receipt = null;
      for (let i = 0; i < 3 && !receipt; i++) {
        receipt = await publicClient.getTransactionReceipt({ hash: p.hash }).catch(() => null);
        if (!receipt) await sleep(1_000);
      }
      if (receipt?.status === 'success') {
        const ev = parseEventLogs({ abi: FLASH_ARB_ABI, logs: receipt.logs, eventName: 'Arbitrage' })[0];
        const gasWei = receipt.gasUsed * receipt.effectiveGasPrice;
        const profit = ev?.args.profit ?? 0n;
        const tip = ev?.args.tip ?? 0n;
        const o = p.opp;
        o.status = 'landed';
        o.grossEth = eth(profit);
        o.tipEth = eth(tip);
        o.gasEth = eth(gasWei);
        o.netEth = eth(profit - tip - gasWei);
        o.netUsd = o.netEth * ethUsd;
        o.note = `block ${receipt.blockNumber}`;
        st.landed++;
        st.netEth += o.netEth;
        st.netUsd += o.netUsd;
        this.host.log(`[mev] ARBITRAGE LANDED: ${o.symbol} +${o.netEth.toFixed(5)} ETH (${o.netUsd >= 0 ? '+' : ''}$${o.netUsd.toFixed(2)}) after gas and builder tip`, 'trade');
      } else if (receipt) {
        const gasWei = receipt.gasUsed * receipt.effectiveGasPrice; // a builder included a reverting tx (should never happen)
        p.opp.status = 'failed';
        p.opp.note = 'included but reverted: gas lost';
        p.opp.netEth = -eth(gasWei);
        p.opp.netUsd = p.opp.netEth * ethUsd;
        st.netEth += p.opp.netEth;
        st.netUsd += p.opp.netUsd;
        this.host.log(`[mev] bundle tx ${p.hash} was included but reverted (gas ${eth(gasWei).toFixed(6)} ETH lost)`, 'warn');
      } else {
        p.opp.status = 'landed';
        p.opp.note = 'receipt not visible yet';
      }
    } else {
      p.opp.status = 'not included';
      p.opp.note = 'another searcher got there first, or builders skipped it (cost: nothing)';
    }
    exec.releaseBundle();
    this.pending = null;
    this.save();
  }

  /** Keeps the newest 60 results; repeats of the same route and outcome within 10 minutes are merged. */
  private record(o: MevOpp, merge = true) {
    const rec = this.file.recent;
    if (merge) {
      const i = rec.findIndex((x) => x.symbol === o.symbol && x.buy === o.buy && x.sell === o.sell && x.status === o.status && o.t - x.t < 10 * 60_000);
      if (i !== -1) {
        o.count = (rec[i].count ?? 1) + 1;
        rec.splice(i, 1);
      }
    }
    rec.unshift(o);
    if (rec.length > 60) rec.length = 60;
  }

  // ------------------------------------------------------------------ arming & the contract
  arm() {
    if (!MEV.enabled) throw new Error('MEV is turned off in .env (MEV=off)');
    if (!this.file.armed) {
      this.file.armed = true;
      this.file.armedAt = Date.now();
      this.save();
      this.host.log(`MEV arbitrage ARMED by user: profitable arbitrages will be sent as Flashbots bundles${this.file.contract ? '' : ' (deploying the contract first, one time)'}.`, 'warn');
    }
    void this.ensureDeployed();
  }

  disarm(reason = 'by user') {
    if (!this.file.armed) return;
    this.file.armed = false;
    this.save();
    this.status = this.modeText();
    this.host.log(`MEV arbitrage disarmed ${reason}. Scanning continues in paper mode.`, 'warn');
  }

  private async contractOk(addr: Address): Promise<boolean> {
    const [code, owner] = await Promise.all([
      publicClient.getCode({ address: addr }).catch(() => undefined),
      publicClient.readContract({ address: addr, abi: FLASH_ARB_ABI, functionName: 'owner' }).catch(() => null),
    ]);
    return !!code && code.toLowerCase() === FLASH_ARB_RUNTIME.toLowerCase() && String(owner).toLowerCase() === this.host.account.address.toLowerCase();
  }

  private async estimateDeployGas() {
    try {
      this.deployGas = Number(await publicClient.estimateGas({ account: this.host.account.address, data: FLASH_ARB_BYTECODE }));
    } catch { /* the dashboard shows the estimate only when known */ }
  }

  /** Deploys FlashArb once (owner = the bot wallet), or adopts/verifies an earlier deployment. */
  private async ensureDeployed() {
    if (this.deploying || !this.file.armed) return;
    this.deploying = true;
    this.status = this.modeText();
    const f = this.file;
    try {
      if (f.contract) {
        if (await this.contractOk(f.contract)) return;
        this.host.log(`MEV: contract ${f.contract} doesn't match this bot (owner/code); deploying a new one`, 'warn');
        f.contract = null;
        this.save();
      }
      if (f.deployTx) {
        // a deployment was signed before a restart: adopt it if it was mined, wait if it may still be
        const rc = await publicClient.getTransactionReceipt({ hash: f.deployTx }).catch(() => null);
        if (rc?.status === 'success' && rc.contractAddress && (await this.contractOk(rc.contractAddress))) {
          f.contract = rc.contractAddress;
          f.deployedAt = Date.now();
          f.deployTx = null;
          this.save();
          this.host.log(`[mev] Arbitrage contract found at ${f.contract} (deployed before the restart)`, 'trade');
          return;
        }
        if (!rc && Date.now() - (f.deployStartedAt ?? 0) < 15 * 60_000) {
          this.host.log('[mev] contract deployment still pending; will check again', 'warn');
          setTimeout(() => void this.ensureDeployed(), 60_000).unref();
          return;
        }
        f.deployTx = null;
      }
      const me = this.host.account.address;
      const [bal, gas, block] = await Promise.all([
        publicClient.getBalance({ address: me }),
        publicClient.estimateGas({ account: me, data: FLASH_ARB_BYTECODE }),
        publicClient.getBlock(),
      ]);
      const need = ((gas * 13n) / 10n) * ((block.baseFeePerGas ?? parseGwei('1')) * 2n + parseGwei('1.5'));
      if (bal < need) throw new Error(`not enough ETH to deploy the contract: have ${eth(bal).toFixed(5)}, need ~${eth(need).toFixed(5)} ETH`);
      const r = await this.host.exec.deployContract(FLASH_ARB_BYTECODE, (m) => this.host.log(`[mev] ${m}`), (hash) => {
        f.deployTx = hash;
        f.deployStartedAt = Date.now();
        this.save();
      });
      if (!(await this.contractOk(r.address))) throw new Error(`deployed contract ${r.address} failed verification`);
      f.contract = r.address;
      f.deployedAt = Date.now();
      f.deployTx = null;
      f.deployGasUsd = eth(r.gasWei) * (this.host.ethUsd() ?? 0);
      this.save();
      this.host.log(`[mev] Arbitrage contract deployed at ${r.address} (gas $${f.deployGasUsd.toFixed(2)}, one time). MEV is live.`, 'trade');
    } catch (e) {
      if (e instanceof UncertainTxError) {
        this.host.log(`[mev] contract deployment outcome unknown (${e.message}); will check again`, 'warn');
        setTimeout(() => void this.ensureDeployed(), 60_000).unref();
      } else {
        f.armed = false;
        this.save();
        this.host.log(`[mev] Contract deployment failed: ${errMsg(e)}. MEV disarmed; scanning continues in paper mode.`, 'error');
      }
    } finally {
      this.deploying = false;
      this.status = this.modeText();
    }
  }

  // ------------------------------------------------------------------ dashboard
  view() {
    const f = this.file;
    const venues: Record<string, number> = {};
    for (const t of this.tokens) for (const p of t.pools) venues[p.v2 ? p.venue : 'Uniswap v3'] = (venues[p.v2 ? p.venue : 'Uniswap v3'] ?? 0) + 1;
    const gp = this.host.gasPriceGwei();
    const ethUsd = this.host.ethUsd();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    return {
      enabled: MEV.enabled,
      mode: !MEV.enabled ? 'off' : this.deploying ? 'deploying' : f.armed && f.contract ? 'live' : f.armed ? 'arming' : 'paper',
      status: this.status,
      lastError: this.lastError,
      armed: f.armed,
      contract: f.contract,
      deployedAt: f.deployedAt,
      deployGasUsd: f.deployGasUsd,
      deployEstimateUsd: this.deployGas && gp && ethUsd ? this.deployGas * gp * 1e-9 * ethUsd : null,
      tokens: this.tokens.length,
      pools: this.tokens.reduce((s, t) => s + t.pools.length, 0),
      venues,
      lastBlock: this.lastBlock,
      bestThisHour: (() => {
        const b = f.best.find((x) => x.h === hour);
        if (!b) return null;
        // prefer the exact simulation; otherwise the quick estimate (it overstates, so "below gas" there is certain)
        const exact = b.simGross !== null;
        const grossEth = exact ? b.simGross! : Math.max(0, b.estGross);
        const gasEth = exact ? b.simGas! : b.estGas;
        if (!exact && b.estGross < 0) return null;
        return { exact, symbol: exact ? b.simSymbol : b.estSymbol, grossEth, gasEth, grossUsd: ethUsd ? grossEth * ethUsd : null, gasUsd: ethUsd ? gasEth * ethUsd : null };
      })(),
      best: f.best.slice(-24),
      stats: f.stats,
      pending: this.pending ? { hash: this.pending.hash, target: Number(this.pending.target) } : null,
      recent: f.recent.slice(0, 15),
      settings: { tipPct: MEV.builderTipPct, minNetUsd: MEV.minNetUsd, minPoolWeth: MEV.minPoolWeth, builders: MEV.builders.map((u) => new URL(u).hostname) },
    };
  }
}
