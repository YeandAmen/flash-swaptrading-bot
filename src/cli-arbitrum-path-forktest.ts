import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, keccak256,
  parseAbi, parseEther, parseEventLogs, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { FLASH_ARB_PROXY_ABI, FLASH_ARB_PROXY_BYTECODE } from './mev/artifact-proxy.js';
import { ARBITRUM_FLASH_ARB_LOGIC_BYTECODE, ARBITRUM_FLASH_ARB_LOGIC_RUNTIME } from './arbitrum/artifact-logic.js';
import { ARBITRUM_FLASH_ARB_LOGIC_V2_ABI as abi, ARBITRUM_FLASH_ARB_LOGIC_V2_BYTECODE,
  ARBITRUM_FLASH_ARB_LOGIC_V2_RUNTIME } from './arbitrum/artifact-logic-v2.js';

const rpc = new URL(process.env.RPC_URL ?? '');
assert.equal(rpc.protocol, 'http:');
assert.equal(rpc.hostname, '127.0.0.1');
assert.equal(process.env.SEND_RPC_URL, process.env.RPC_URL);
assert.equal(process.env.FORK_MODE, '1');
assert.equal(process.env.ALLOW_LIVE_TRADING, 'off');
const transport = http(rpc.href, { timeout: 120_000, retryCount: 0, fetchOptions: { redirect: 'error' } });
const admin = createTestClient({ chain: arbitrum, mode: 'anvil', transport });
const client = createPublicClient({ chain: arbitrum, transport, cacheTime: 0, pollingInterval: 100 });
const owner = privateKeyToAccount(generatePrivateKey());
const fixture = privateKeyToAccount(generatePrivateKey());
const sender = createWalletClient({ chain: arbitrum, transport, account: owner });
assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
assert.equal(await client.getChainId(), 42161);
const weth = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const arb = '0x912CE59144191C1204E64559FE8253a0e49E6548';
const usdg = '0x004B506865409877C9fA29bfb1ebA929984B9bbC';
const morpho = '0x6c247b1F6182318877311737BaC0844bAa518F5e';
const uniRouter = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const aeroRouter = '0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418';
const legs = [
  { kind: 2, pool: '0xc6962004f452be9203591991d15f6b388e09e8d0', tokenOut: weth, tickSpacing: 0 },
  { kind: 6, pool: '0xbdf6749254c8760b42f38b9985baaf1cecf17617', tokenOut: arb, tickSpacing: 100 },
  { kind: 6, pool: '0xe41723a9fca1eac0f18728d4583510aa7377901b', tokenOut: usdg, tickSpacing: 100 },
  { kind: 6, pool: '0x09328be718d89228a985471bb470988a34d0b162', tokenOut: usdc, tickSpacing: 1 },
] as const;
const erc = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)']);
const routerAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)']);
const balance = (token: Address, account: Address) => client.readContract({ address: token, abi: erc, functionName: 'balanceOf', args: [account] });
const confirmed = async (hash: Hex) => {
  await admin.mine({ blocks: 1 });
  const receipt = await client.getTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', hash);
  return receipt;
};
const oldRelease = keccak256(ARBITRUM_FLASH_ARB_LOGIC_RUNTIME);
const release = keccak256(ARBITRUM_FLASH_ARB_LOGIC_V2_RUNTIME);
await admin.setBalance({ address: owner.address, value: parseEther('5') });
await admin.setBalance({ address: fixture.address, value: parseEther('300') });
// ArbSys is a Nitro precompile. The Anvil fixture returns the local L2 block number.
await admin.setCode({ address: '0x0000000000000000000000000000000000000064', bytecode: '0x435f5260205ff3' });
const deploy = await confirmed(await sender.deployContract({ abi: FLASH_ARB_PROXY_ABI, bytecode: FLASH_ARB_PROXY_BYTECODE,
  args: [ARBITRUM_FLASH_ARB_LOGIC_BYTECODE, oldRelease], gas: 8_000_000n }));
const proxy = deploy.contractAddress;
assert.ok(proxy);
const path = { asset: usdc, amountIn: 100_000_000n, minProfit: 1n, maxBlock: await client.getBlockNumber() + 50n, legs } as const;
const pathCall = { address: proxy, abi, functionName: 'executePath', account: owner } as const;
await assert.rejects(client.simulateContract({ ...pathCall, args: [release, path] }));
await confirmed(await sender.writeContract({ address: proxy, abi: FLASH_ARB_PROXY_ABI, functionName: 'upgradeRelease',
  args: [ARBITRUM_FLASH_ARB_LOGIC_V2_BYTECODE, oldRelease, release], gas: 10_000_000n }));
assert.equal(await client.readContract({ address: proxy, abi, functionName: 'owner' }), owner.address);
await assert.rejects(client.simulateContract({ ...pathCall, args: [oldRelease, path] }), /wrong path release/);
await assert.rejects(client.simulateContract({ ...pathCall, account: fixture, args: [release, path] }), /owner/);
await assert.rejects(client.simulateContract({ address: proxy, abi, functionName: 'onMorphoFlashLoan',
  account: fixture, args: [1n, '0x'] }), /morpho context/);
await assert.rejects(client.simulateContract({ ...pathCall, args: [release, { ...path, maxBlock: 0n }] }), /expired/);
await assert.rejects(client.simulateContract({ ...pathCall, args: [release, { ...path, legs: [legs[0], legs[0], legs[3]] }] }), /repeated leg/);
console.log('✓ Previous proxy upgraded in place. Owner, release, callback, deadline and cycle checks enforced.');

// Create a price difference with the separate fork-funded fixture account.
const displaced = parseEther('100');
await confirmed(await sender.writeContract({ address: uniRouter, abi: routerAbi, functionName: 'exactInputSingle', account: fixture,
  args: [{ tokenIn: weth, tokenOut: usdc, fee: 500, recipient: fixture.address, amountIn: displaced,
    amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }], value: displaced, gas: 3_000_000n }));
const wrongFactory = [legs[0], { ...legs[1], pool: fixture.address }, legs[2], legs[3]] as const;
await assert.rejects(client.simulateContract({ ...pathCall, args: [release, { ...path, legs: wrongFactory }] }), /aero pool/);
const [lenderBefore, ownerBefore] = await Promise.all([balance(usdc, morpho), balance(usdc, owner.address)]);
assert.equal(ownerBefore, 0n);
const gift = 500_000n;
await confirmed(await sender.writeContract({ address: usdc, abi: erc, functionName: 'transfer', account: fixture, args: [proxy, gift] }));
const expected = (await client.simulateContract({ ...pathCall, args: [release, path] })).result;
await assert.rejects(client.simulateContract({ ...pathCall, args: [release, { ...path, minProfit: expected + 1n }] }), /unprofitable/);
// Use the pinned network's base fee with an explicit small L2 priority fee.
// Anvil's generic wallet priority estimate is higher than this historical chain fee.
const blockFee = (await client.getBlock()).baseFeePerGas;
assert.ok(blockFee !== null);
const fees = { maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: blockFee * 2n + 1_000_000n };
const receipt = await confirmed(await sender.writeContract({ ...pathCall, args: [release, path], gas: 4_000_000n, ...fees }));
const logs = receipt.logs.filter((l) => l.address.toLowerCase() === proxy.toLowerCase());
const [gain] = parseEventLogs({ abi, eventName: 'PathArbitrage', logs });
const [funded] = parseEventLogs({ abi, eventName: 'FundedBy', logs });
assert.ok(gain && funded);
assert.equal(gain.args.asset.toLowerCase(), usdc.toLowerCase());
assert.equal(gain.args.recipient, owner.address);
assert.equal(gain.args.hops, 4);
assert.equal(gain.args.amountIn, path.amountIn);
assert.equal(gain.args.profit, expected);
assert.deepEqual(funded.args, { funding: 2, amount: path.amountIn, premium: 0n });
assert.equal(await balance(usdc, morpho), lenderBefore);
assert.equal(await balance(usdc, owner.address), expected + gift);
for (const token of [usdc, weth, arb, usdg] as const) {
  assert.equal(await balance(token, proxy), 0n);
  for (const spender of [morpho, uniRouter, aeroRouter] as const) {
    assert.equal(await client.readContract({ address: token, abi: erc, functionName: 'allowance', args: [proxy, spender] }), 0n);
  }
}
assert.equal(await client.getBalance({ address: proxy }), 0n);
const oracleAbi = parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const [, ethUsd] = await client.readContract({ address: '0x639fe6ab55c921f74e7fac1ee960c0b6293ba612', abi: oracleAbi, functionName: 'latestRoundData' });
const [, usdcUsd] = await client.readContract({ address: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3', abi: oracleAbi, functionName: 'latestRoundData' });
const gasUsd = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18 * Number(ethUsd) / 1e8;
const netUsd = Number(expected) / 1e6 * Number(usdcUsd) / 1e8 - gasUsd;
assert.ok(netUsd > 0, `Fork receipt gas $${gasUsd.toFixed(6)} exceeded loan profit`);
console.log(`✓ Four canonical swaps. Morpho repaid. Owner received ${expected} micro-USDC profit, gift excluded. No residual balances/allowances. Gas ${receipt.gasUsed}, net $${netUsd.toFixed(4)}.`);
const legacy = (maxBlock: bigint) => encodeFunctionData({ abi, functionName: 'execute', args: [{ funding: 1, token: usdc,
  buy: { kind: 2, pool: '0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c', fee: 3000, tickSpacing: 0, nativeEth: false },
  sell: { kind: 2, pool: legs[0].pool, fee: 500, tickSpacing: 0, nativeEth: false },
  amountIn: parseEther('0.25'), minProfit: 1n, tip: 0n, maxBlock }] });
await assert.rejects(client.simulateContract({ address: proxy, abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned',
  account: owner, args: [release, legacy(0n)] }), /expired/);
const legacyReceipt = await confirmed(await sender.writeContract({ address: proxy, abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned',
  account: owner, args: [release, legacy(await client.getBlockNumber() + 10n)], gas: 2_000_000n, ...fees }));
const [twoSwap] = parseEventLogs({ abi, eventName: 'Arbitrage', logs: legacyReceipt.logs.filter((l) => l.address.toLowerCase() === proxy.toLowerCase()) });
assert.ok(twoSwap && twoSwap.args.profit > 0n);
console.log('✓ Existing pinned Aave two-swap ABI also repaid and settled after the upgrade.');
