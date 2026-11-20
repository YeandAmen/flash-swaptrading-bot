import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, parseAbi, parseEther, parseEventLogs, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { erc20Abi } from './chain.js';
import { ADDR, CONFIG } from './config.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_V2_ABI, FLASH_ARB_V2_BYTECODE, FLASH_ARB_V2_RUNTIME } from './mev/artifact-v2.js';
import { FLASH_ARB_V3_ABI, FLASH_ARB_V3_BYTECODE, FLASH_ARB_V3_RUNTIME } from './mev/artifact-v3.js';
import { NextVenueKind } from './mev/next-pools.js';
import { discoverArbPools, poolIdentity, toNextVenue, type ArbPool } from './mev/pools.js';
import { loadOrCreateWallet } from './wallet.js';

// The harness supplies only a disposable account and the same loopback Anvil read and send RPCs.
await assertForkTestEnvironment();
assert.equal(CONFIG.allowLiveTrading, false);
const useV3 = process.env.MEV_FORK_USE_V3 === '1';

const transport = http(CONFIG.rpcUrl, { timeout: 120_000, retryCount: 0, fetchOptions: { redirect: 'error' } });
const fork = createTestClient({ chain: mainnet, mode: 'anvil', transport });
const publicClient = createPublicClient({ chain: mainnet, transport });
const walletClient = createWalletClient({ chain: mainnet, transport });
const owner = loadOrCreateWallet().account;
const fixture = privateKeyToAccount(generatePrivateKey());
await fork.setBalance({ address: owner.address, value: parseEther('5') });
await fork.setBalance({ address: fixture.address, value: parseEther('200') });

const uniswapV2Router = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const sushiV2Router = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F';
const fixtureRouterAbi = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const lenders: Record<number, Address> = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  2: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  3: '0xbA1333333333a1BA1108E8412f11850A5C319bA9',
};

async function confirmed(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `local transaction ${hash} succeeded`);
  return receipt;
}

const [market] = await discoverArbPools([{ address: ADDR.usdc, symbol: 'USDC', decimals: 6, core: true }], 2,
  { includePancakeV3: true, includeUniswapV4: true });
assert.ok(market, 'fork has canonical USDC markets');
function pick(kind: NextVenueKind, fee: number, nativeEth = false) {
  const pool = market.pools.find((p) => p.kind === kind && Math.round(p.fee * 1e6) === fee && Boolean(p.v4?.nativeEth) === nativeEth);
  assert.ok(pool, `canonical fixture pool (${kind}, ${fee}, ${nativeEth})`);
  return pool;
}
const pancake500 = pick(NextVenueKind.PancakeV3, 500);
const v4Native500 = pick(NextVenueKind.UniswapV4, 500, true);
const v4Weth500 = pick(NextVenueKind.UniswapV4, 500);
const sushiV2 = pick(NextVenueKind.SushiV2, 3000);
assert.notEqual(poolIdentity(v4Native500), poolIdentity(v4Weth500), 'v4 liquidity pools have distinct IDs despite a shared manager');
console.log('✓ canonical Pancake v3, native ETH Uniswap v4, and WETH Uniswap v4 pools discovered');

const bytecode = useV3 ? FLASH_ARB_V3_BYTECODE : FLASH_ARB_V2_BYTECODE;
const runtime = useV3 ? FLASH_ARB_V3_RUNTIME : FLASH_ARB_V2_RUNTIME;
const deployment = await confirmed(await walletClient.deployContract({ account: owner, abi: FLASH_ARB_V2_ABI, bytecode }));
const contract = deployment.contractAddress;
assert.ok(contract);
assert.equal((await publicClient.getCode({ address: contract }))?.toLowerCase(), runtime.toLowerCase());
assert.equal(await publicClient.readContract({ address: contract, abi: FLASH_ARB_V2_ABI, functionName: 'owner' }), owner.address);
if (useV3) {
  await assert.rejects(publicClient.simulateContract({
    address: contract, abi: FLASH_ARB_V3_ABI, functionName: 'onBalancerV3Loan', args: ['0x'], account: fixture.address,
  }), /callback context/);
}

async function balanceOf(token: Address, account: Address) {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
}

async function buyFixtureTokens(router: Address, amount: bigint) {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  await confirmed(await walletClient.writeContract({ account: fixture, address: router, abi: fixtureRouterAbi, functionName: 'swapExactETHForTokens', gas: 1_000_000n, value: amount,
    args: [1n, [ADDR.weth, ADDR.usdc], fixture.address, block.timestamp + 600n],
  }));
}

async function sellFixtureTokensOnSushi() {
  const amount = await balanceOf(ADDR.usdc, fixture.address);
  assert.ok(amount > 0n);
  await confirmed(await walletClient.writeContract({ account: fixture, address: ADDR.usdc, abi: erc20Abi, functionName: 'approve', args: [sushiV2Router, amount] }));
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  await confirmed(await walletClient.writeContract({ account: fixture, address: sushiV2Router, abi: fixtureRouterAbi, functionName: 'swapExactTokensForETH', gas: 1_000_000n,
    args: [amount, 1n, [ADDR.usdc, ADDR.weth], fixture.address, block.timestamp + 600n],
  }));
}

async function testRoute(label: string, buy: ArbPool, sell: ArbPool, funding: number) {
  const point = await fork.snapshot();
  try {
    const maxBlock = (await publicClient.getBlockNumber({ cacheTime: 0 })) + 3n;
    const prepare = { funding, token: ADDR.usdc, buy: toNextVenue(buy), sell: toNextVenue(sell), minProfit: 1n, tip: useV3 ? 0n : 1n, maxBlock };
    let profitable: { args: typeof prepare & { amountIn: bigint }; profit: bigint } | undefined;
    const errors: string[] = [];
    for (const size of ['0.5', '0.15', '0.05', '1']) {
      const amountIn = parseEther(size);
      const args = { ...prepare, amountIn };
      try {
        const simulated = await publicClient.simulateContract({ address: contract!, abi: FLASH_ARB_V2_ABI, functionName: 'execute', account: owner.address, args: [args] });
        if (simulated.result > parseEther('0.002')) {
          profitable = { args, profit: simulated.result };
          break;
        }
      } catch (error) {
        errors.push((error as { shortMessage?: string }).shortMessage ?? (error as Error).message);
      }
    }
    assert.ok(profitable, `${label} must simulate a profit: ${errors.join(' | ')}`);
    const order = { ...profitable.args, minProfit: profitable.profit };
    const ethBefore = await publicClient.getBalance({ address: owner.address });
    const vaultBalance = funding === 3 ? await balanceOf(ADDR.weth, lenders[funding]) : 0n;
    let hash: Hex;
    if (useV3) {
      const fees = await publicClient.estimateFeesPerGas();
      const nonce = await publicClient.getTransactionCount({ address: owner.address, blockTag: 'pending' });
      const signed = await owner.signTransaction({
        type: 'eip1559', chainId: mainnet.id, to: contract!, nonce, gas: 3_000_000n,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        data: encodeFunctionData({ abi: FLASH_ARB_V2_ABI, functionName: 'execute', args: [order] }),
      });
      hash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
    } else {
      hash = await walletClient.writeContract({ account: owner, address: contract!, abi: FLASH_ARB_V2_ABI, functionName: 'execute', args: [order], gas: 3_000_000n });
    }
    const receipt = await confirmed(hash);
    const [payout] = parseEventLogs({ abi: FLASH_ARB_V2_ABI, eventName: 'Arbitrage', logs: receipt.logs });
    assert.ok(payout, `${label} emitted payout receipt`);
    assert.equal(payout.args.profit, profitable.profit, `${label} simulation matched settlement`);
    if (funding > 0) {
      const [funded] = parseEventLogs({ abi: FLASH_ARB_V2_ABI, eventName: 'FundedBy', logs: receipt.logs });
      assert.ok(funded);
      assert.equal(funded.args.funding, funding);
      assert.equal(funded.args.premium > 0n, funding === 1, 'only Aave charges a funding premium');
      assert.equal(await publicClient.readContract({ address: ADDR.weth, abi: erc20Abi, functionName: 'allowance', args: [contract!, lenders[funding]] }), 0n, 'flash lender left no usable allowance');
      if (funding === 3) assert.equal(await balanceOf(ADDR.weth, lenders[funding]), vaultBalance, 'Balancer principal returned in full');
    }
    const expected = payout.args.profit - payout.args.tip - receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await publicClient.getBalance({ address: owner.address });
    assert.ok(expected > 0n, `${label} covers even test gas and builder payment`);
    assert.equal(ethAfter - ethBefore, expected, `${label} accrued exact proceeds to the deploying wallet`);
    assert.equal(await publicClient.getBalance({ address: contract! }), 0n);
    assert.equal(await balanceOf(ADDR.weth, contract!), 0n);
    assert.equal(await balanceOf(ADDR.usdc, contract!), 0n);
    console.log(`✓ ${label}: exact wallet payout and no contract balance after settlement`);
  } finally {
    await fork.revert({ id: point });
  }
}

// Ordinary swaps funded entirely by Anvil create price fixtures only on the guarded local fork.
const baseline = await fork.snapshot();
await buyFixtureTokens(sushiV2Router, parseEther('18'));
console.log('✓ fork-local Sushi v2 buy fixture prepared');
await testRoute('Pancake v3 buy-pool flash swap', pancake500, sushiV2, 0);
await testRoute('native ETH v4 flash settlement', v4Native500, sushiV2, 0);
await testRoute('WETH v4 flash settlement', v4Weth500, sushiV2, 0);
await testRoute('Aave v3 funding with native ETH v4', v4Native500, sushiV2, 1);
await testRoute('Morpho Blue funding with WETH v4', v4Weth500, sushiV2, 2);
if (useV3) await testRoute('Balancer V3 funding with WETH v4', v4Weth500, sushiV2, 3);
await fork.revert({ id: baseline });

await buyFixtureTokens(uniswapV2Router, parseEther('30'));
await sellFixtureTokensOnSushi();
console.log('✓ fork-local Sushi v2 sell fixture prepared');
await testRoute('Pancake v3 callback on the sell leg', sushiV2, pancake500, 0);
await testRoute('native ETH v4 settlement on the sell leg', sushiV2, v4Native500, 0);
console.log(useV3 ? 'ALL FLASHARB V3 DIRECT RPC FORK TESTS PASSED' : 'ALL FLASHARB V2 FORK TESTS PASSED');
