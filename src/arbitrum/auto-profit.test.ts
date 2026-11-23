import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { encodeAbiParameters, padHex, parseAbiParameters, parseEther, toEventSelector, type Address, type Hex } from 'viem';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrum-profit-test-'));
process.env.DATA_DIR = dir;
process.env.RPC_URL ??= 'http://127.0.0.1:8545';
const { ArbitrumWorker } = await import('./worker.js');
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const journalFile = path.join(dir, 'arbitrum-trades.json');
const owner = '0x0000000000000000000000000000000000000001';
process.env.ARBITRUM_OWNER_ADDRESS = owner;
const executor = '0x0000000000000000000000000000000000000002';
const token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const morpho = '0x6c247b1f6182318877311737bac0844baa518f5e';
const hash = (n: number) => padHex(`0x${n.toString(16)}` as Hex, { size: 32 });
const nativeProfit = parseEther('0.003');
const gasUsed = 100_000n, gasPrice = 10n ** 9n, ethUsd = 2000;
type Event = { address: Address; topics: Hex[]; data: Hex };
const topics = (sig: string, ...indexed: Address[]) => [toEventSelector(sig), ...indexed.map(a => padHex(a, { size: 32 }))];
const funding = (kind: number, amount: bigint): Event => ({ address: executor, topics: topics('FundedBy(uint8,uint256,uint256)'),
  data: encodeAbiParameters(parseAbiParameters('uint8,uint256,uint256'), [kind, amount, 0n]) });
const native = (profit = nativeProfit): Event[] => [funding(1, parseEther('1')), {
  address: executor, topics: topics('Arbitrage(address,address,address,uint256,uint256,uint256)', token),
  data: encodeAbiParameters(parseAbiParameters('address,address,uint256,uint256,uint256'), [owner, executor, parseEther('1'), profit, 0n]),
}];
const transfer = (from: Address, to: Address, amount: bigint): Event => ({ address: token,
  topics: topics('Transfer(address,address,uint256)', from, to), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });
const principal = 50_000_000n, gain = 2_000_000n;
const route = (hops: number) => ({ asset: token, decimals: 6, assetUsd: 1, amount: principal.toString(), hops });
const cycle = (hops: number, recipient: Address = owner): Event[] => [funding(2, principal),
  transfer(morpho, executor, principal), transfer(executor, morpho, principal), transfer(executor, owner, gain),
  { address: executor, topics: topics('PathArbitrage(address,address,uint256,uint256,uint8)', token, recipient),
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint8'), [principal, gain, hops]) },
];

type Options = { automatic?: boolean; route?: ReturnType<typeof route>; testHash?: Hex; gasPrice?: bigint; head?: bigint;
  status?: 'success' | 'reverted' };
async function settle(id: number, logs: Event[], opts: Options = {}) {
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const pending = { hash: hash(id), nonce: 1, owner, executor, ethUsd, automatic: opts.automatic, path: opts.route };
  fs.writeFileSync(journalFile, JSON.stringify({ ...journal, pending,
    test: opts.testHash ? { hash: opts.testHash, status: 'submitted', checked: 1 } : undefined }));
  const worker = new ArbitrumWorker();
  worker['openJournal']();
  const receipt = { from: owner, to: executor, transactionHash: hash(id), blockNumber: 123n, blockHash: hash(123),
    status: opts.status ?? 'success', logs, gasUsed, effectiveGasPrice: opts.gasPrice ?? gasPrice };
  Object.assign(worker, { client: { getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: hash(123) }),
    getBlockNumber: async () => opts.head ?? 125n } });
  await worker['reconcile']();
  return worker.view();
}

test('the latest automatic native or token payout persists across unrelated attempts, day pruning and restarts', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  fs.writeFileSync(journalFile, JSON.stringify({ pending: null, recent: [{ hash: hash(90), status: 'landed', at: now, netUsd: 12, gasUsd: 0.2 }] }));
  assert.equal(new ArbitrumWorker().view().lastAutoProfit, null, 'legacy settlements lack automatic provenance');
  assert.equal((await settle(1, native())).lastAutoProfit, null, 'legacy pending intent is unclassified');
  const auto = { automatic: true };
  const first = { hash: hash(2), owner, at: now, block: 123, netUsd: 5.8 };
  assert.deepEqual((await settle(2, native(), auto)).lastAutoProfit, first);
  assert.deepEqual(new ArbitrumWorker().view().lastAutoProfit, first);
  now += 2 * 86_400_000;
  assert.deepEqual((await settle(3, native(), { automatic: false, testHash: hash(3) })).lastAutoProfit, first);
  assert.deepEqual((await settle(4, native(), { ...auto, testHash: hash(4) })).lastAutoProfit, first);
  assert.deepEqual((await settle(5, native(), { ...auto, status: 'reverted' })).lastAutoProfit, first);
  assert.deepEqual((await settle(6, native(gasUsed * gasPrice), auto)).lastAutoProfit, first);
  assert.deepEqual((await settle(7, native(1n), auto)).lastAutoProfit, first);
  assert.deepEqual((await settle(8, native().slice(1), auto)).lastAutoProfit, first);
  assert.deepEqual((await settle(9, native(), { ...auto, head: 124n })).lastAutoProfit, first);
  assert.deepEqual((await settle(10, native(), { ...auto, gasPrice: 0n })).lastAutoProfit, first);
  assert.deepEqual(new ArbitrumWorker().view().lastAutoProfit, first);
  assert.ok(!JSON.parse(fs.readFileSync(journalFile, 'utf8')).recent.some((r: { hash: Hex }) => r.hash === first.hash));
  for (const hops of [3, 4]) {
    const id = 20 + hops, path = { ...auto, route: route(hops) };
    const expected = { hash: hash(id), owner, at: ++now, block: 123, netUsd: 1.8 };
    assert.deepEqual((await settle(id, cycle(hops), path)).lastAutoProfit, expected);
    const noOwnerTransfer = cycle(hops).filter((_log, i) => i !== 3);
    assert.deepEqual((await settle(id + 10, noOwnerTransfer, path)).lastAutoProfit, expected);
    assert.deepEqual((await settle(id + 20, cycle(hops, executor), path)).lastAutoProfit, expected);
    assert.deepEqual(new ArbitrumWorker().view().lastAutoProfit, expected);
  }
});

test('restart requires a valid proof for the configured owner while pending receipts still reconcile', async () => {
  const proof = { hash: hash(80), owner, at: Date.now(), block: 123, netUsd: 5.8 };
  const journal = { recent: [], pending: null };
  fs.writeFileSync(journalFile, JSON.stringify({ ...journal, lastAutoProfit: proof }));
  process.env.ARBITRUM_OWNER_ADDRESS = executor;
  try {
    assert.equal(new ArbitrumWorker().view().lastAutoProfit, null);
    const foreign = await settle(81, native(), { automatic: true });
    assert.equal(foreign.settled?.status, 'landed');
    assert.equal(foreign.lastAutoProfit, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(journalFile, 'utf8')).lastAutoProfit, proof);
  } finally {
    process.env.ARBITRUM_OWNER_ADDRESS = owner;
  }
  assert.deepEqual(new ArbitrumWorker().view().lastAutoProfit, proof);
  for (const damaged of [{ owner: undefined }, { hash: '0xabc' }, { at: -1 }, { block: 1.5 }, { netUsd: 0 }, { netUsd: '5.8' }]) {
    fs.writeFileSync(journalFile, JSON.stringify({ ...journal, lastAutoProfit: { ...proof, ...damaged } }));
    const worker = new ArbitrumWorker();
    assert.equal(worker.view().lastAutoProfit, null);
    worker['openJournal']();
    assert.equal(worker.view().lastAutoProfit, null);
  }
  const next = await settle(82, native(), { automatic: true });
  assert.equal(next.lastAutoProfit?.hash, hash(82));
  assert.equal(next.lastAutoProfit?.owner, owner);
});
