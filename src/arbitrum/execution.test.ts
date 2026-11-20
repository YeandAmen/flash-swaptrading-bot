import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionResult, parseEther, type Address } from 'viem';
import { ARBITRUM_FLASH_ARB_ABI } from './artifact.js';
import { prepareArbitrumOrder } from './execution.js';
import type { ArbQuote, ArbitrumClient } from './market.js';

const owner: Address = '0x0000000000000000000000000000000000000001';
const contract: Address = '0x0000000000000000000000000000000000000002';
const buy: ArbQuote['order']['buy'] = { kind: 2, pool: owner, fee: 500, tickSpacing: 0, nativeEth: false };
const profitable: ArbQuote = {
  order: { funding: 1, token: owner, buy, sell: { ...buy, pool: contract }, amountIn: parseEther('1'),
    minProfit: 1n, tip: 0n, maxBlock: 110n },
  symbol: 'WETH/USDC',
  payout: parseEther('0.001'),
};

function clientFor({ head = 104n, preparationBlock = 100n, payout = profitable.payout, feeCap = 100_000_000n } = {}) {
  let finalMinProfit = 0n;
  let finalDeadline = 0n;
  const client = {
    getBlock: async () => ({ number: preparationBlock, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    getBlockNumber: async () => head,
    estimateGas: async () => 200_000n,
    estimateFeesPerGas: async () => ({ maxFeePerGas: feeCap, maxPriorityFeePerGas: 1_000_000n }),
    call: async ({ data, blockTag }: { data: `0x${string}`; blockTag: string }) => {
      assert.equal(blockTag, 'pending');
      const parsed = decodeFunctionData({ abi: ARBITRUM_FLASH_ARB_ABI, data });
      assert.equal(parsed.functionName, 'execute');
      if (parsed.functionName === 'execute') {
        finalMinProfit = parsed.args[0].minProfit;
        finalDeadline = parsed.args[0].maxBlock;
      }
      return { data: encodeFunctionResult({ abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'execute', result: payout }) };
    },
  } as unknown as ArbitrumClient;
  return { client, finalMinProfit: () => finalMinProfit, finalDeadline: () => finalDeadline };
}

test('Arbitrum signing gate requires fresh execution to cover padded gas and the net floor', async () => {
  const ok = clientFor();
  const quote = await prepareArbitrumOrder(ok.client, contract, owner, profitable, 2_000, 0.05, 0.50);
  assert.ok(quote);
  assert.equal(quote.worstGasUsd, 0.05);
  assert.equal(ok.finalMinProfit(), quote.gasBudget + parseEther('0.000025'));
  const delayed = clientFor({ preparationBlock: 117n, head: 119n });
  const refreshed = await prepareArbitrumOrder(delayed.client, contract, owner, profitable, 2_000, 0.05, 0.50);
  assert.ok(refreshed);
  assert.equal(delayed.finalDeadline(), 127n);
  assert.equal(await prepareArbitrumOrder(clientFor({ head: 110n }).client, contract, owner, profitable, 2_000, 0.05, 0.50), null);
  assert.equal(await prepareArbitrumOrder(clientFor({ payout: 1n }).client, contract, owner, profitable, 2_000, 0.05, 0.50), null);
  assert.equal(await prepareArbitrumOrder(clientFor({ feeCap: 2_000_000_000n }).client, contract, owner, profitable, 2_000, 0.05, 0.50), null);
});
