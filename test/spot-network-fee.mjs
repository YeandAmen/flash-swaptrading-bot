import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keccak256, parseGwei, toHex } from 'viem';

const temporary = mkdtempSync(join(tmpdir(), 'eth-spot-fees-'));
Object.assign(process.env, {
  RPC_URL: 'http://127.0.0.1:1', SEND_RPC_URL: 'http://127.0.0.1:1', FORK_MODE: '1', ALLOW_LIVE_TRADING: 'off',
  DATA_DIR: temporary, WALLET_KEY_FILE: join(temporary, 'unused-test-key'), MAX_SWAP_NETWORK_FEE_USD: '5',
});
const { ADDR } = await import('../dist/config.js');
const { publicClient, sendClient } = await import('../dist/chain.js');
const { LiveExecutor, LiveSendBlocked, SwapNetworkBudget } = await import('../dist/executor.js');
after(() => rmSync(temporary, { recursive: true, force: true }));

test('USD budget rounds down, protects already-spent gas after price changes and fails closed on stale prices', () => {
  const budget = new SwapNetworkBudget();
  const gas = 130_000n;
  const mark = 2000n * 10n ** 8n;
  assert.equal(budget.feeLimit(gas, mark, 100n, 101n), 2_500_000_000_000_000n / gas);
  budget.spentWei = 1_500_000_000_000_000n;
  assert.equal(budget.feeLimit(gas, mark / 2n, 100n, 101n), 1_000_000_000_000_000n / gas);
  assert.equal(budget.feeLimit(gas, mark * 2n, 100n, 101n), 0n);
  for (const [price, updatedAt, time] of [[0n, 100n, 100n], [mark, 0n, 100n], [mark, 0n, 4000n], [mark, 100n, 3701n], [mark, 101n, 100n]]) {
    assert.throws(() => budget.feeLimit(gas, price, updatedAt, time), LiveSendBlocked);
  }
});

for (const operation of ['swap', 'topUpGas']) {
  test(operation + ' caps each proposal and defers the router when two confirmed approvals consumed its budget', async t => {
    const proposals = [];
    const wallet = {
      address: '0x00000000000000000000000000000000000000a1',
      // Dummy bytes for the in-memory transport. No private key is loaded.
      signTransaction: async proposal => {
        proposals.push(proposal);
        return toHex(proposals.length);
      },
    };
    const executor = new LiveExecutor(wallet);
    let allowance = 1n;
    let base = parseGwei('8');
    t.mock.method(publicClient, 'getTransactionCount', async () => 0);
    t.mock.method(publicClient, 'getBlock', async () => ({ baseFeePerGas: base, number: 123n,
      timestamp: 100n, gasLimit: 30_000_000n, gasUsed: 15_000_000n }));
    t.mock.method(publicClient, 'estimateGas', async () => 100_000n);
    t.mock.method(publicClient, 'getFeeHistory', async () => ({ reward: [[parseGwei('0.1')]] }));
    let oracleReads = 0;
    t.mock.method(publicClient, 'readContract', async q => {
      if (q.functionName === 'allowance') return allowance;
      assert.equal(q.functionName, 'latestRoundData');
      assert.equal(q.blockNumber, 123n);
      oracleReads++;
      return [1n, 2000n * 10n ** 8n, 99n, 100n, 1n];
    });
    t.mock.method(publicClient, 'simulateContract', async () => ({ result: [500n, [], [], 100_000n] }));
    t.mock.method(sendClient, 'request', async ({ method, params }) => {
      assert.equal(method, 'eth_sendRawTransaction');
      return keccak256(params[0]);
    });
    t.mock.method(executor, 'waitSettlement', async () => ({
      status: 'receipt', receipt: { status: 'success', gasUsed: 100_000n, effectiveGasPrice: parseGwei('7.5'), blockNumber: 124n },
    }));
    const log = () => {};
    const order = () => operation === 'swap'
      ? executor.swap({ ethUsd: 2000, path: '0x01', tokenIn: ADDR.usdc, tokenOut: ADDR.weth, hops: 1,
        amountIn: 50n, slippageBps: 1, gasPriceGwei: 8.1 }, log)
      : executor.topUpGas(50n, '0x01', 1, 2000, log, log);
    await assert.rejects(order(), /total network fee would exceed \$5/);
    assert.equal(oracleReads, 3);
    assert.equal(proposals.length, 2);
    assert.ok(proposals.every(p => p.to === ADDR.usdc));
    const maximumWei = 2_500_000_000_000_000n;
    assert.ok(proposals[0].gas * proposals[0].maxFeePerGas <= maximumWei);
    assert.equal(proposals[1].maxFeePerGas, (maximumWei - 750_000_000_000_000n) / proposals[1].gas);

    // A fresh order with enough allowance can propose the router swap at the cap.
    allowance = 50n;
    base = parseGwei('13');
    wallet.signTransaction = async proposal => {
      assert.equal(proposal.to, ADDR.swapRouter02);
      assert.equal(proposal.maxFeePerGas, maximumWei / proposal.gas);
      assert.ok(proposal.maxPriorityFeePerGas <= proposal.maxFeePerGas - base);
      throw new Error('inspected unsigned router proposal');
    };
    await assert.rejects(order(), /inspected unsigned router proposal/);
  });
}
