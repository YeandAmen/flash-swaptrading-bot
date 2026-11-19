// End-to-end test of the MEV arbitrage path against a local anvil mainnet fork (fake money).
// Run via: npm run build && npm run mev-fork-test   (scripts/fork-test.sh starts anvil and sets the env)
// A "whale" creates real price gaps between pools with big swaps; the searcher must find, simulate and capture them.
import assert from 'node:assert/strict';
import { createTestClient, createWalletClient, decodeFunctionData, http, maxUint256, parseAbi, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { ADDR, CONFIG, CORE_TOKENS, MEV } from './config.js';
import { erc20Abi, publicClient } from './chain.js';
import { LiveExecutor } from './executor.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_ABI } from './mev/artifact.js';
import type { ArbPool, ArbToken } from './mev/pools.js';
import { MevSearcher, type MevHost, type MevOpp } from './mev/searcher.js';
import { loadOrCreateWallet } from './wallet.js';

await assertForkTestEnvironment();

const testClient = createTestClient({ chain: mainnet, mode: 'anvil', transport: http(CONFIG.rpcUrl) });
const wc = createWalletClient({ chain: mainnet, transport: http(CONFIG.rpcUrl, { timeout: 60_000, retryCount: 0 }) });
const wait = async (hash: `0x${string}`) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success', `tx ${hash} succeeded`);
  return r;
};

const wallet = loadOrCreateWallet();
const me = wallet.account.address;
await testClient.setBalance({ address: me, value: parseEther('5') });
const exec = new LiveExecutor(wallet.account);
const host: MevHost = {
  log: (m, l = 'info') => console.log(`    [${l}] ${m}`),
  account: wallet.account,
  exec,
  ethUsd: () => 3000,
  gasPriceGwei: () => 1,
  baseFeeGwei: () => null, // exercise the block-header path
  tokens: () => CORE_TOKENS,
  tradePending: () => false,
};
let mev = new MevSearcher(host);
await mev.refreshPools();
const poolCount = mev.tokens.reduce((s, t) => s + t.pools.length, 0);
for (const t of mev.tokens) console.log(`  ${t.token.symbol}: ${t.pools.map((p) => p.venue).join(', ')}`);
assert.ok(mev.tokens.length >= 4 && poolCount >= 10, `found arbitrage pools (${mev.tokens.length} tokens, ${poolCount} pools)`);
console.log(`✓ discovery: ${mev.tokens.length} tokens with 2+ WETH pools, ${poolCount} pools`);

// ---- a whale that moves prices
const whale = privateKeyToAccount(generatePrivateKey()).address;
await testClient.setBalance({ address: whale, value: parseEther('100000') });
await testClient.impersonateAccount({ address: whale });
const V2_ROUTERS: Record<string, Address> = {
  'Uniswap v2': '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  SushiSwap: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
};
const v2RouterAbi = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const routerAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 3600);
const wethIn = async (p: ArbPool) => Number(await publicClient.readContract({ address: ADDR.weth, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] })) / 1e18;

/** Whale buys TOKEN with ETH in pool p: TOKEN gets more expensive there. */
async function pump(t: ArbToken, p: ArbPool, frac: number) {
  const value = parseEther(((await wethIn(p)) * frac).toFixed(6));
  if (p.v2) {
    await wait(await wc.writeContract({ account: whale, chain: mainnet, address: V2_ROUTERS[p.venue], abi: v2RouterAbi, functionName: 'swapExactETHForTokens', args: [0n, [ADDR.weth, t.token.address], whale, deadline()], value }));
  } else {
    await wait(await wc.writeContract({
      account: whale, chain: mainnet, address: ADDR.swapRouter02, abi: routerAbi, functionName: 'exactInputSingle', value,
      args: [{ tokenIn: ADDR.weth, tokenOut: t.token.address, fee: Math.round(p.fee * 1e6), recipient: whale, amountIn: value, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    }));
  }
}

/** Whale sells all its TOKEN into v2 pool p: TOKEN gets cheaper there. */
async function dump(t: ArbToken, p: ArbPool) {
  const bal = await publicClient.readContract({ address: t.token.address, abi: erc20Abi, functionName: 'balanceOf', args: [whale] });
  assert.ok(bal > 0n, 'whale holds the token');
  await wait(await wc.writeContract({ account: whale, chain: mainnet, address: t.token.address, abi: erc20Abi, functionName: 'approve', args: [V2_ROUTERS[p.venue], maxUint256] }));
  await wait(await wc.writeContract({ account: whale, chain: mainnet, address: V2_ROUTERS[p.venue], abi: v2RouterAbi, functionName: 'swapExactTokensForETH', args: [bal, 0n, [t.token.address, ADDR.weth], whale, deadline()] }));
}

const latestOpp = (sym: string): MevOpp | undefined => mev.file.recent.find((o) => o.symbol === sym);
const gasByRoute: Record<string, bigint> = {};
let testBundleRestart = true;

async function scan(searcher = mev) {
  for (let attempt = 1; ; attempt++) {
    try {
      await searcher.scanOnce();
      return;
    } catch (error) {
      // Anvil may need to retry the upstream reads for a fresh local block. This guard runs
      // before the scan can evaluate routes or sign anything, so repeating the read is safe.
      if (attempt === 3 || !(error instanceof Error) || error.message !== 'pool snapshot did not match the block header') throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
}

/** Scan block after block (fork: each bundle is mined at once) until no bundle is pending and nothing new was sent. */
async function settle(): Promise<MevOpp[]> {
  const before = new Set(mev.file.recent.filter((o) => o.hash).map((o) => o.hash));
  for (let i = 0; i < 8; i++) {
    const n = mev.file.stats.bundles;
    await scan();
    if (testBundleRestart && mev.file.pending) {
      const { hash } = mev.file.pending;
      const restarted = new MevSearcher(host);
      assert.equal(restarted.file.armed, false);
      assert.equal(restarted.file.pending?.hash, hash, 'an unsettled bundle must survive restart');
      await restarted.refreshPools();
      await scan(restarted);
      assert.equal(restarted.file.pending, null, 'the restarted paper searcher resolves the bundle');
      assert.equal(restarted.file.recent.find((o) => o.hash === hash)?.status, 'landed', 'the restarted searcher books the verified receipt');
      restarted.arm();
      for (let i = 0; i < 500 && restarted.deploying; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(restarted.view().mode, 'live', 'explicit test rearm adopts the deployed contract');
      mev = restarted;
      testBundleRestart = false;
      console.log('✓ Pending bundle survived restart and reconciled by receipt while disarmed');
    }
    if (!mev.file.pending && mev.file.stats.bundles === n) break;
  }
  return mev.file.recent.filter((o) => o.hash && !before.has(o.hash)).reverse(); // oldest first
}

/** The gap must be captured: first bundle lands on the expected route, every bundle is profitable, books match the wallet. */
async function captures(t: ArbToken, label: string, buy: ArbPool, sell: ArbPool) {
  const ethBefore = await publicClient.getBalance({ address: me });
  const opps = await settle();
  assert.ok(opps.length > 0, `${label}: a bundle was sent`);
  const o = opps[0];
  assert.equal(o.status, 'landed', `${label}: landed (${o.note ?? ''})`);
  assert.ok(o.symbol === t.token.symbol && (o.buy === buy.venue || o.sell === sell.venue), `${label}: route ${o.buy} → ${o.sell}`);
  for (const x of opps) {
    assert.ok(x.status === 'landed' && x.netUsd >= MEV.minNetUsd, `${label}: every included bundle clears the minimum net profit`);
    assert.ok(x.hash);
    const tx = await publicClient.getTransaction({ hash: x.hash });
    assert.equal(tx.type, 'eip1559');
    const call = decodeFunctionData({ abi: FLASH_ARB_ABI, data: tx.input });
    assert.equal(call.functionName, 'execute');
    const order = call.args[0];
    const minProfitWei = BigInt(Math.ceil(MEV.minNetUsd / host.ethUsd()! * 1e18));
    assert.ok(order.minProfit >= order.tip + tx.gas * tx.maxFeePerGas + minProfitWei, `${label}: signed order enforces padded gas, builder tip, and minimum net on-chain`);
  }
  const ethAfter = await publicClient.getBalance({ address: me });
  const diff = Number(ethAfter - ethBefore) / 1e18;
  const booked = opps.reduce((s, x) => s + x.netEth, 0);
  assert.ok(Math.abs(diff - booked) < 1e-9, `${label}: wallet ETH grew by exactly the reported net (${diff} vs ${booked})`);
  const rc = await publicClient.getTransactionReceipt({ hash: o.hash! });
  const kind = (venue: string) => (venue.startsWith('Uniswap v3') ? 'v3' : 'v2');
  gasByRoute[`${kind(o.buy)}→${kind(o.sell)}`] = rc.gasUsed;
  console.log(`✓ ${label}: ${t.token.symbol} buy ${o.buy} → sell ${o.sell}, size ${o.sizeEth.toFixed(3)} ETH, gross ${o.grossEth.toFixed(5)}, tip ${o.tipEth.toFixed(5)}, gas ${rc.gasUsed} units → net +${o.netEth.toFixed(5)} ETH` +
    (opps.length > 1 ? ` (+${opps.length - 1} follow-up arb${opps.length > 2 ? 's' : ''} on the leftover gap)` : ''));
}

const pick = (want: (t: ArbToken) => [ArbPool, ArbPool] | null): { t: ArbToken; a: ArbPool; b: ArbPool } => {
  for (const t of mev.tokens) {
    const r = want(t);
    if (r) return { t, a: r[0], b: r[1] };
  }
  throw new Error('no suitable token on this fork');
};
const v3Pools = (t: ArbToken) => t.pools.filter((p) => !p.v2);
const v2Of = (t: ArbToken, venue: string) => t.pools.find((p) => p.venue === venue);

// ---- 1. paper mode: finds and simulates the gap, sends nothing
const s1 = pick((t) => (v2Of(t, 'Uniswap v2') && v3Pools(t).length ? [v2Of(t, 'Uniswap v2')!, v3Pools(t)[0]] : null));
await pump(s1.t, s1.a, 0.04); // TOKEN dearer on Uniswap v2 -> buy on v3, sell on v2
const nonce0 = await publicClient.getTransactionCount({ address: me });
await scan();
const paper = latestOpp(s1.t.token.symbol);
assert.ok(paper && paper.status === 'would send' && paper.sell === 'Uniswap v2', `paper: gap found and simulated (got ${paper?.status} ${paper?.note ?? ''})`);
assert.equal(await publicClient.getTransactionCount({ address: me }), nonce0, 'paper mode sent nothing');
console.log(`✓ paper mode: ${s1.t.token.symbol} gap found, simulated profit ${paper.grossEth.toFixed(5)} ETH, nothing sent`);

// ---- 2. arm: deploys the contract once and verifies it
mev.arm();
for (let i = 0; i < 500 && (mev.deploying || !mev.file.contract); i++) await new Promise((r) => setTimeout(r, 100));
const contract = mev.file.contract!;
assert.ok(contract, 'contract deployed');
assert.equal(String(await publicClient.readContract({ address: contract, abi: FLASH_ARB_ABI, functionName: 'owner' })).toLowerCase(), me.toLowerCase(), 'owner is the bot wallet');
console.log(`✓ armed: contract deployed at ${contract}`);

// ---- 3. live captures on every route type
await captures(s1.t, 'dear on Uniswap v2', s1.b, s1.a);
await dump(s1.t, s1.a); // TOKEN now cheaper on Uniswap v2 -> buy on v2 (flash swap via uniswapV2Call), sell on v3
await captures(s1.t, 'cheap on Uniswap v2', s1.a, s1.b);

// every contract path explicitly (the scanner picks whichever pair pays most, so check v3->v3 and v2->v2 directly too)
const s3 = pick((t) => (t.token.address !== s1.t.token.address && v3Pools(t).length >= 2 ? [v3Pools(t)[1], v3Pools(t)[0]] : null));
await pump(s3.t, s3.a, 0.05); // dearer in the pumped v3 tier
{
  const sim = await mev.simulate(s3.t, s3.b, s3.a, parseEther('0.3'), (await publicClient.getBlockNumber()) + 5n);
  assert.ok(sim.ok && sim.profit > 0n, `v3→v3 contract path works (${JSON.stringify(sim, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
}
await captures(s3.t, 'dear in one v3 fee tier', s3.b, s3.a);
const s4 = pick((t) => (t.token.address !== s1.t.token.address && t.token.address !== s3.t.token.address
  && v2Of(t, 'Uniswap v2') && v2Of(t, 'SushiSwap') ? [v2Of(t, 'SushiSwap')!, v2Of(t, 'Uniswap v2')!] : null));
await pump(s4.t, s4.a, 0.04); // dearer on SushiSwap
{
  const sim = await mev.simulate(s4.t, s4.b, s4.a, parseEther('0.1'), (await publicClient.getBlockNumber()) + 5n);
  assert.ok(sim.ok && sim.profit > 0n, `v2→v2 contract path works (${JSON.stringify(sim, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
}
await captures(s4.t, 'dear on SushiSwap', s4.b, s4.a);

// ---- 4. safety properties of the contract
const route = { poolA: s1.b.address, poolB: s1.a.address, token: s1.t.token.address, aIsV2: s1.b.v2, bIsV2: s1.a.v2, amountIn: parseEther('0.1'), minProfit: 1n, tip: 0n };
const bn = await publicClient.getBlockNumber();
await assert.rejects(publicClient.simulateContract({ account: whale, address: contract, abi: FLASH_ARB_ABI, functionName: 'execute', args: [{ ...route, maxBlock: bn + 5n }] }), /owner/, 'only the owner can call execute');
await assert.rejects(publicClient.simulateContract({ account: me, address: contract, abi: FLASH_ARB_ABI, functionName: 'execute', args: [{ ...route, maxBlock: bn - 1n }] }), /late/, 'expired bundles revert');
await assert.rejects(publicClient.simulateContract({ account: me, address: contract, abi: FLASH_ARB_ABI, functionName: 'execute', args: [{ ...route, minProfit: parseEther('1000'), maxBlock: bn + 5n }] }), /unprofitable|transfer/, 'unprofitable trades revert');
await assert.rejects(publicClient.simulateContract({ account: whale, address: contract, abi: FLASH_ARB_ABI, functionName: 'uniswapV3SwapCallback', args: [1n, 1n, '0x'] }), /cb/, 'callbacks only from the pool being traded');
await assert.rejects(publicClient.simulateContract({ account: whale, address: contract, abi: FLASH_ARB_ABI, functionName: 'uniswapV2Call', args: [whale, 1n, 1n, '0x01'] }), /cb/, 'v2 callback guarded too');
await assert.rejects(publicClient.simulateContract({ account: whale, address: contract, abi: FLASH_ARB_ABI, functionName: 'sweep', args: [ADDR.weth] }), /owner/, 'only the owner can sweep');
for (const tok of [ADDR.weth, s1.t.token.address, s3.t.token.address, s4.t.token.address]) {
  assert.equal(await publicClient.readContract({ address: tok, abi: erc20Abi, functionName: 'balanceOf', args: [contract] }), 0n, 'contract keeps no tokens');
}
assert.equal(await publicClient.getBalance({ address: contract }), 0n, 'contract keeps no ETH');
console.log('✓ contract: owner-only, expiry, profit check, callback guards, holds nothing');

// ---- 5. paper simulation (code injected via state override) == real contract
await pump(s3.t, s3.a, 0.03);
const [A, B] = [s3.t.pools.indexOf(s3.b), s3.t.pools.indexOf(s3.a)].map((i) => s3.t.pools[i]);
const live = await mev.simulate(s3.t, A, B, parseEther('1'), (await publicClient.getBlockNumber()) + 5n);
const saved = mev.file.contract;
mev.file.contract = null;
const paperSim = await mev.simulate(s3.t, A, B, parseEther('1'), (await publicClient.getBlockNumber()) + 5n);
mev.file.contract = saved;
assert.ok(live.ok && paperSim.ok && live.profit === paperSim.profit, `paper sim equals live sim (${JSON.stringify([live, paperSim], (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
console.log(`✓ paper simulation matches the deployed contract exactly (${(Number((live as { profit: bigint }).profit) / 1e18).toFixed(6)} ETH)`);

// ---- 6. disarm: back to paper mode
mev.disarm();
await scan();
assert.equal(latestOpp(s3.t.token.symbol)?.status, 'would send', 'disarmed: only simulates');
console.log('✓ disarmed: gap simulated, no bundle');

// ---- 7. restart adopts the existing contract (no second deployment)
mev.arm();
for (let i = 0; i < 50 && mev.deploying; i++) await new Promise((r) => setTimeout(r, 100));
const again = new MevSearcher(host);
assert.equal(again.file.contract, contract, 'state survives a restart');
assert.equal(again.file.armed, false, 'MEV restarts in paper even when previously armed');
const nonceBeforeRearm = await publicClient.getTransactionCount({ address: me });
again.arm();
for (let i = 0; i < 500 && again.deploying; i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(again.view().mode, 'live', 'explicit rearm verifies prior deployment');
assert.equal(again.file.contract, contract, 'restart keeps the same contract');
assert.equal(await publicClient.getTransactionCount({ address: me }), nonceBeforeRearm, 'valid deployment is reused without a transaction');
again.disarm();
console.log('✓ restart: paper mode by default, explicit rearm verified the existing contract');

// ---- 8. nonce gate: a normal transaction waits while a bundle may still land
assert.ok(exec.reserveForBundle(Date.now() + 1_500), 'bundle reservation');
const t0 = Date.now();
await exec.deployContract('0x6001600c60003960016000f300', () => {}); // tiny contract, just to send a tx
assert.ok(Date.now() - t0 >= 1_400, 'normal tx waited for the bundle window');
exec.releaseBundle();
console.log('✓ nonce gate: wallet transactions never collide with a pending bundle');

console.log('\nGas used per route:', Object.entries(gasByRoute).map(([k, v]) => `${k} ${v}`).join(', '));
console.log('ALL MEV FORK TESTS PASSED');
process.exit(0);
