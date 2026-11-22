import assert from 'node:assert/strict';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { CONFIG, ADDR } from './config.js';
import { assertForkTestEnvironment } from './forktest-env.js';
import { FLASH_ARB_LOGIC_V2_BYTECODE, FLASH_ARB_LOGIC_V2_RUNTIME } from './mev/artifact-logic-v2.js';
import { FLASH_ARB_LOGIC_V3_ABI } from './mev/artifact-logic-v3.js';
import { FLASH_ARB_PROXY_ABI, FLASH_ARB_PROXY_BYTECODE } from './mev/artifact-proxy.js';
import {
  encodePathArbitrage,
  pinnedArbitrage,
  proxyReleaseHash,
  proxyUpgradeData,
  verifyFlashProxy,
  type PathHop,
} from './mev/proxy.js';
import { loadOrCreateWallet } from './wallet.js';

await assertForkTestEnvironment();
assert.equal(CONFIG.allowLiveTrading, false);
assert.equal(new URL(CONFIG.rpcUrl).hostname, '127.0.0.1');
const transport = http(CONFIG.rpcUrl, { timeout: 120_000, retryCount: 0, fetchOptions: { redirect: 'error' } });
const chain = createPublicClient({ chain: mainnet, transport, cacheTime: 0 });
const local = createTestClient({ mode: 'anvil', chain: mainnet, transport });
const tx = createWalletClient({ chain: mainnet, transport });
const owner = loadOrCreateWallet().account;
const fixture = privateKeyToAccount(generatePrivateKey());
const weth = ADDR.weth,
  usdc = ADDR.usdc;
const usdt = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const dai = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const morpho = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const v4 = '0x000000000004444c5dc75cB358380D2e3dE08A90';
const uniV2 = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const sushiV2 = '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac';
const factoryV3 = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const sushiRouter = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F';
const pairs = parseAbi([
  'function getPair(address,address) view returns (address)',
  'function getPool(address,address,uint24) view returns (address)',
]);
async function v2(factory: Address, a: Address, b: Address): Promise<PathHop> {
  const pool = await chain.readContract({ address: factory, abi: pairs, functionName: 'getPair', args: [a, b] });
  assert.notEqual(pool, zeroAddress);
  return { kind: factory === uniV2 ? 0 : 1, pool, tokenOut: b, fee: 3000, tickSpacing: 0, nativeEth: false };
}
async function v3(a: Address, b: Address, fee: number): Promise<PathHop> {
  const pool = await chain.readContract({ address: factoryV3, abi: pairs, functionName: 'getPool', args: [a, b, fee] });
  assert.notEqual(pool, zeroAddress);
  return { kind: 2, pool, tokenOut: b, fee, tickSpacing: 0, nativeEth: false };
}
const balance = (token: Address, account: Address) =>
  chain.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
async function confirm(hash: Hex) {
  const receipt = await chain.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', 'Anvil transaction must succeed');
  return receipt;
}
await Promise.all([
  local.setBalance({ address: owner.address, value: parseEther('10') }),
  local.setBalance({ address: fixture.address, value: parseEther('501') }),
]);
const oldRelease = keccak256(FLASH_ARB_LOGIC_V2_RUNTIME);
const created = await confirm(
  await tx.deployContract({
    account: owner,
    abi: FLASH_ARB_PROXY_ABI,
    bytecode: FLASH_ARB_PROXY_BYTECODE,
    args: [FLASH_ARB_LOGIC_V2_BYTECODE, oldRelease],
    gas: 7_000_000n,
  }),
);
assert.ok(created.contractAddress);
const proxy = created.contractAddress;
const oldImplementation = await verifyFlashProxy(proxy, owner.address, oldRelease);
assert.ok(oldImplementation);
const upgraded = await confirm(
  await tx.sendTransaction({ account: owner, to: proxy, data: proxyUpgradeData(oldRelease), gas: 7_000_000n }),
);
const newImplementation = await verifyFlashProxy(proxy, owner.address, proxyReleaseHash);
assert.ok(newImplementation);
assert.notEqual(newImplementation, oldImplementation);
console.log('Upgraded existing fork proxy and verified owner, admin and runtime. Gas used:', upgraded.gasUsed.toString());

const [sell, stable, buyDai, daiUsdc, buyUsdt] = await Promise.all([
  v2(sushiV2, usdt, weth),
  v3(usdc, usdt, 100),
  v2(uniV2, weth, dai),
  v3(dai, usdc, 100),
  v3(weth, usdt, 100),
]);
const first: PathHop = { kind: 5, pool: v4, fee: 500, tickSpacing: 10, nativeEth: true, tokenOut: usdc };
const three = [first, stable, sell];
const stableV4: PathHop = { kind: 5, pool: v4, fee: 10, tickSpacing: 1, nativeEth: false, tokenOut: usdt };
const four = [buyDai, daiUsdc, stableV4, sell];
const size = parseEther('0.05');
const deadline = (await chain.getBlockNumber()) + 100n;
const data = (hops: PathHop[], min = 1n, hash = proxyReleaseHash, by = deadline) =>
  encodePathArbitrage(hops, size, min, by, hash);
const simulate = (payload: Hex, account = owner.address) =>
  chain.call({ account, to: proxy, data: payload, gas: 4_000_000n });
await assert.rejects(simulate(data(three, 1n, oldRelease)), /wrong release/);
await assert.rejects(simulate(data(three), fixture.address), /owner/);
await assert.rejects(simulate(data(three, 0n)), /deadline or floor/);
await assert.rejects(simulate(data(three, 1n, proxyReleaseHash, 0n)), /deadline or floor/);
await assert.rejects(simulate(data(three.slice(0, 2))), /path length/);
await assert.rejects(simulate(data([...four, four[0]])), /path length/);
await assert.rejects(simulate(data([{ ...first, tokenOut: weth }, stable, sell])), /path token/);
await assert.rejects(simulate(data([first, { ...stable, pool: buyUsdt.pool }, sell])), /v3 factory/);
await assert.rejects(simulate(data([buyDai, daiUsdc, { ...stable, tokenOut: dai }, sell])), /repeated path token/);
await assert.rejects(
  simulate(encodeFunctionData({ abi: FLASH_ARB_LOGIC_V3_ABI, functionName: 'onMorphoFlashLoan', args: [size, '0x'] })),
  /callback context/,
);

// Create a controlled USDT/WETH price difference by exchanging disposable Anvil ETH on the real Sushi pair.
await confirm(
  await tx.writeContract({
    address: sushiRouter,
    account: fixture,
    gas: 500_000n,
    abi: parseAbi(['function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])']),
    functionName: 'swapExactETHForTokens',
    args: [1n, [weth, usdt], fixture.address, (await chain.getBlock()).timestamp + 3600n],
    value: parseEther('300'),
  }),
);
// Gifts must go back to the owner before borrowing. They cannot satisfy the profit floor.
const gift = parseEther('0.5');
await local.setBalance({ address: proxy, value: gift });
const depositAbi = parseAbi(['function deposit() payable']);
await confirm(
  await tx.writeContract({ account: fixture, address: weth, abi: depositAbi, functionName: 'deposit', value: gift }),
);
await confirm(
  await tx.writeContract({ account: fixture, address: weth, abi: erc20Abi, functionName: 'transfer', args: [proxy, gift] }),
);
await confirm(
  await tx.writeContract({
    account: fixture,
    address: usdt,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [proxy, 12345n],
    gas: 100_000n,
  }),
);
const reverse: PathHop[] = [
  { ...sell, tokenOut: usdt },
  { ...stable, tokenOut: usdc },
  { ...first, tokenOut: weth },
];
await assert.rejects(simulate(data(reverse)), /loan repayment/);
const preview = await simulate(data(three));
assert.ok(preview.data);
const gross = BigInt(preview.data);
assert.ok(gross > 0n);
await assert.rejects(simulate(data(three, gross + 1n)), /unprofitable/);
assert.equal(await balance(weth, proxy), gift);
assert.equal(await chain.getBalance({ address: proxy }), gift);
assert.equal(await balance(usdt, proxy), 12345n);

async function runPath(hops: PathHop[], includesGifts: boolean) {
  const before = await chain.getBalance({ address: owner.address });
  const beforeLender = await balance(weth, morpho);
  const ownerTokens = await balance(usdt, owner.address);
  const ownerWeth = await balance(weth, owner.address);
  const receipt = await confirm(await tx.sendTransaction({ account: owner, to: proxy, data: data(hops), gas: 2_000_000n }));
  const [result] = parseEventLogs({ abi: FLASH_ARB_LOGIC_V3_ABI, eventName: 'Arbitrage', logs: receipt.logs });
  const [funding] = parseEventLogs({ abi: FLASH_ARB_LOGIC_V3_ABI, eventName: 'FundedBy', logs: receipt.logs });
  const [executed] = parseEventLogs({ abi: FLASH_ARB_LOGIC_V3_ABI, eventName: 'PathExecuted', logs: receipt.logs });
  assert.ok(result.args.profit > 0n);
  assert.equal(result.args.tip, 0n);
  assert.equal(executed.args.hops, BigInt(hops.length));
  assert.equal(funding.args.amount, size);
  assert.equal(funding.args.premium, 0n);
  assert.equal(funding.args.funding, 2);
  assert.equal(await balance(weth, morpho), beforeLender);
  assert.equal(
    await chain.readContract({ address: weth, abi: erc20Abi, functionName: 'allowance', args: [proxy, morpho] }),
    0n,
  );
  assert.equal(
    (await chain.getBalance({ address: owner.address })) - before + receipt.gasUsed * receipt.effectiveGasPrice,
    result.args.profit + (includesGifts ? gift : 0n),
  );
  assert.equal((await balance(weth, owner.address)) - ownerWeth, includesGifts ? gift : 0n);
  assert.equal((await balance(usdt, owner.address)) - ownerTokens, includesGifts ? 12345n : 0n);
  assert.equal(await chain.getBalance({ address: proxy }), 0n);
  for (const hop of hops) assert.equal(await balance(hop.tokenOut, proxy), 0n);
  console.log(
    hops.length +
      '-hop fork cycle repaid Morpho and paid ' +
      formatEther(result.args.profit) +
      ' ETH, consumed ' +
      receipt.gasUsed +
      ' gas',
  );
}
await runPath(three, true);
await runPath(four, false);
const legacy = encodeFunctionData({
  abi: FLASH_ARB_LOGIC_V3_ABI,
  functionName: 'execute',
  args: [
    {
      funding: 2,
      token: usdt,
      buy: buyUsdt,
      sell,
      amountIn: size,
      minProfit: 1n,
      tip: 0n,
      maxBlock: deadline,
    },
  ],
});
const legacyResult = await simulate(pinnedArbitrage(legacy, proxyReleaseHash));
assert.ok(legacyResult.data && BigInt(legacyResult.data) > 0n, 'legacy two-leg pinned path still repays and earns');
console.log(
  'Stale release, wrong sender, forged callback, invalid routes and a dust-subsidized floor rejected. Legacy two-leg execution passed.',
);
