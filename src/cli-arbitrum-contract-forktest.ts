import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther, parseEventLogs, type Address, type ContractFunctionArgs, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { ARBITRUM_FLASH_ARB_ABI, ARBITRUM_FLASH_ARB_BYTECODE, ARBITRUM_FLASH_ARB_RUNTIME } from './arbitrum/artifact.js';

const rpc = new URL(process.env.RPC_URL ?? '');
assert.equal(rpc.protocol, 'http:');
assert.equal(rpc.hostname, '127.0.0.1');
assert.equal(rpc.href, new URL(process.env.SEND_RPC_URL ?? '').href);
assert.equal(process.env.FORK_MODE, '1');
assert.equal(process.env.ALLOW_LIVE_TRADING, 'off');

const transport = http(rpc.href, { timeout: 120_000, retryCount: 0, fetchOptions: { redirect: 'error' } });
const admin = createTestClient({ chain: arbitrum, mode: 'anvil', transport });
const client = createPublicClient({ chain: arbitrum, transport, cacheTime: 0 });
const sender = createWalletClient({ chain: arbitrum, transport });
const nodeInfo = await fetch(rpc.href, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }),
  redirect: 'error',
  signal: AbortSignal.timeout(3000),
});
const node = await nodeInfo.json() as { result?: unknown };
assert.ok(nodeInfo.ok && node.result && typeof node.result === 'object', 'Arbitrum fork tests require a local Anvil node');
assert.equal(await client.getChainId(), arbitrum.id);

const owner = privateKeyToAccount(generatePrivateKey());
const fixture = privateKeyToAccount(generatePrivateKey());
const weth = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const usdc = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const lender = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const lenderCustody = '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8';
const router = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const arbSys = '0x0000000000000000000000000000000000000064';
const abi = ARBITRUM_FLASH_ARB_ABI;
const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const routerAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
]);
const arbSysAbi = parseAbi(['function arbBlockNumber() view returns (uint256)']);
const lowFeeV3 = { kind: 2, pool: '0xC6962004f452bE9203591991D15f6b388e09E8D0', fee: 500, tickSpacing: 0, nativeEth: false } as const;
const highFeeV3 = { ...lowFeeV3, pool: '0xc473e2aEE3441BF9240Be85eb122aBB059A3B57c', fee: 3000 } as const;
const v4Weth = { ...lowFeeV3, kind: 5, pool: '0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32', tickSpacing: 10 } as const;
const v4Native = { ...v4Weth, nativeEth: true } as const;
type Order = ContractFunctionArgs<typeof abi, 'nonpayable', 'execute'>[0];
type Pool = Order['buy'];

async function confirmed(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', hash);
  return receipt;
}

const balance = (token: Address, account: Address) =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
const l2Block = () => client.readContract({ address: arbSys, abi: arbSysAbi, functionName: 'arbBlockNumber' });

// Anvil runs the standard EVM. Model ArbSys returning a different height than NUMBER.
await admin.setCode({ address: arbSys, bytecode: '0x5f3560e01c63a3b1b31d146011575f80fd5b43633b9aca00015f5260205ff3' });
assert.ok((await l2Block()) > (await client.getBlockNumber()), 'fixture must separate ArbSys and EVM block heights');
await admin.setBalance({ address: owner.address, value: parseEther('5') });
await admin.setBalance({ address: fixture.address, value: parseEther('500') });
const deployment = await confirmed(await sender.deployContract({
  abi, bytecode: ARBITRUM_FLASH_ARB_BYTECODE, account: owner, args: [owner.address],
}));
const address = deployment.contractAddress;
assert.ok(address);
assert.equal(await client.getCode({ address }), ARBITRUM_FLASH_ARB_RUNTIME);
assert.equal(await client.readContract({ address, abi, functionName: 'owner' }), owner.address);
const call = { address, abi, functionName: 'execute', account: owner } as const;
const basic: Omit<Order, 'maxBlock'> = { funding: 1, token: usdc, buy: lowFeeV3, sell: highFeeV3, amountIn: parseEther('1'), minProfit: 1n, tip: 0n };

const currentArbHeight = await l2Block();
await assert.rejects(client.simulateContract({ ...call, args: [{ ...basic, maxBlock: currentArbHeight - 1n }] }), /expired/);
await assert.rejects(client.simulateContract({
  ...call, account: fixture, args: [{ ...basic, maxBlock: currentArbHeight + 1n }],
}), /owner/);
await assert.rejects(client.simulateContract({
  ...call, args: [{ ...basic, funding: 0, maxBlock: currentArbHeight + 1n }],
}), /funding or tip/);
await assert.rejects(client.simulateContract({
  ...call, args: [{ ...basic, buy: { ...basic.buy, pool: fixture.address }, maxBlock: currentArbHeight + 1n }],
}), /v3 pool/);
await assert.rejects(client.simulateContract({
  address, abi, functionName: 'uniswapV3SwapCallback', args: [1n, -1n, '0x'], account: fixture,
}), /callback context/);
await assert.rejects(client.simulateContract({
  address, abi, functionName: 'executeOperation', args: [weth, 1n, 0n, address, '0x'], account: fixture,
}), /callback context/);
await assert.rejects(client.simulateContract({
  address, abi, functionName: 'unlockCallback', args: ['0x'], account: fixture,
}), /callback context/);
console.log('✓ approved callers, canonical pool validation, and L2 deadline tested');

async function skewPool(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint) {
  const value = tokenIn === weth ? amountIn : 0n;
  if (value === 0n) {
    await confirmed(await sender.writeContract({
      address: tokenIn, abi: erc20Abi, functionName: 'approve', args: [router, amountIn], account: fixture,
    }));
  }
  await confirmed(await sender.writeContract({
    address: router, abi: routerAbi, functionName: 'exactInputSingle', account: fixture, value,
    args: [{ tokenIn, tokenOut, fee, recipient: fixture.address, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }],
  }));
}

async function route(label: string, buy: Pool, sell: Pool) {
  const saved = await admin.snapshot();
  try {
    const maxBlock = (await l2Block()) + 3n;
    let candidate: { order: Order; payout: bigint } | undefined;
    const errors: string[] = [];
    for (const amount of ['1', '0.3', '0.1', '0.03', '0.01']) {
      const order = { ...basic, buy, sell, amountIn: parseEther(amount), maxBlock };
      try {
        const { result } = await client.simulateContract({ ...call, args: [order] });
        candidate = { order, payout: result };
        break;
      } catch (error) {
        errors.push((error as Error).message.split('\n')[0]);
      }
    }
    assert.ok(candidate, `${label} profitable simulation failed: ${errors.join(' | ')}`);
    await assert.rejects(client.simulateContract({
      ...call, args: [{ ...candidate.order, minProfit: candidate.payout + 1n }],
    }), /unprofitable/);

    // Preexisting gifts are returned and excluded from reported profit.
    const gift = parseEther('0.001');
    await admin.setBalance({ address: call.address, value: gift });
    const custodyBefore = await balance(weth, lenderCustody);
    const ownerBefore = await client.getBalance({ address: owner.address });
    const receipt = await confirmed(await sender.writeContract({
      ...call, args: [{ ...candidate.order, minProfit: candidate.payout }],
    }));
    const [settled] = parseEventLogs({ abi, eventName: 'Arbitrage', logs: receipt.logs });
    const [funded] = parseEventLogs({ abi, eventName: 'FundedBy', logs: receipt.logs });
    assert.ok(settled && funded);
    assert.equal(settled.args.profit, candidate.payout);
    assert.equal(settled.args.tip, 0n);
    assert.equal(funded.args.funding, 1);
    assert.equal(funded.args.amount, candidate.order.amountIn);
    assert.ok(funded.args.premium > 0n);
    assert.equal(await balance(weth, lenderCustody) - custodyBefore, funded.args.premium);
    const net = settled.args.profit - receipt.gasUsed * receipt.effectiveGasPrice;
    assert.ok(net > 0n, 'local net must cover fork gas');
    assert.equal((await client.getBalance({ address: owner.address })) - ownerBefore, gift + net);
    assert.equal(await client.getBalance({ address: call.address }), 0n);
    assert.equal(await balance(weth, call.address), 0n);
    assert.equal(await balance(usdc, call.address), 0n);
    assert.equal(await client.readContract({
      address: weth, abi: erc20Abi, functionName: 'allowance', args: [call.address, lender],
    }), 0n);
    console.log(`✓ ${label}: Aave repaid, exact wallet payout, no residual balance or approval`);
  } finally {
    await admin.revert({ id: saved });
  }
}

const beforeSkew = await admin.snapshot();
await skewPool(weth, usdc, 3000, parseEther('100'));
await route('Uniswap v3 → v3', lowFeeV3, highFeeV3);
await route('native ETH Uniswap v4 → Uniswap v3', v4Native, highFeeV3);
await route('WETH Uniswap v4 → Uniswap v3', v4Weth, highFeeV3);
await admin.revert({ id: beforeSkew });

await skewPool(weth, usdc, 500, parseEther('100'));
await skewPool(usdc, weth, 3000, await balance(usdc, fixture.address));
await route('Uniswap v3 → native ETH Uniswap v4', highFeeV3, v4Native);
await route('Uniswap v3 → WETH Uniswap v4', highFeeV3, v4Weth);
console.log('ALL ARBITRUM FLASHARB FORK TESTS PASSED');
