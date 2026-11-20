import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import {
  JUPITER, KAMINO, KAMINO_MARKET, KAMINO_MARKET_LOOKUP, KAMINO_USDC_RESERVE, LOOKUP_PROGRAM, MAINNET_GENESIS,
  USDC, WRAPPED_SOL,
} from './protocol.js';
import { scanSolanaCycle } from './scan.js';

const wallet = address('23g1K6sr2bevNwLYPoB79jzEQtErioYQ8mpUa76xA6yu');
const tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fakeRpc = 'http://127.0.0.1:8899';
const fee = 6400;

function reserveFixture() {
  const data = Buffer.alloc(8624);
  Buffer.from('2bf2ccca1af73b7f', 'hex').copy(data);
  const fields = [
    [32, KAMINO_MARKET], [128, USDC],
    [160, 'Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6'],
    [192, 'BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX'],
    [408, tokenProgram],
  ] as const;
  for (const [offset, key] of fields) data.set(getAddressEncoder().encode(address(key)), offset);
  data.writeBigUInt64LE(10_000_000_000n, 224);
  data.writeBigUInt64LE(6n, 272);
  data.writeBigUInt64LE(11_529_215_046_068n, 4904);
  return data.toString('base64');
}

function lookupFixture() {
  const data = Buffer.alloc(56 + 64);
  data.writeUInt32LE(1, 0);
  data.set(getAddressEncoder().encode(KAMINO_MARKET), 56);
  data.set(getAddressEncoder().encode(KAMINO_USDC_RESERVE), 88);
  return data.toString('base64');
}

test('Solana paper scanner composes unsigned atomic borrow and repay and gates observed net profit', async (t) => {
  let simulationCount = 0;
  let actualWalletGain = 210_000;
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === 'https://api.jup.ag') {
      const params = url.searchParams;
      const inputMint = params.get('inputMint');
      const outputMint = params.get('outputMint');
      const venue = params.get('dexes');
      const first = inputMint === USDC;
      assert.equal(params.get('wrapAndUnwrapSol'), 'false');
      assert.equal(first ? outputMint : inputMint, WRAPPED_SOL);
      if (!first) assert.equal(params.get('amount'), '3499000000');
      return Response.json({
        inputMint, outputMint, inAmount: params.get('amount'),
        outAmount: first ? '3500000000' : '250250000',
        otherAmountThreshold: first ? '3499000000' : '250120000',
        swapMode: 'ExactIn', slippageBps: 5,
        routePlan: [{ swapInfo: { ammKey: first ? USDC : WRAPPED_SOL, label: venue, inputMint, outputMint } }],
        swapInstruction: { programId: JUPITER, data: 'AA==', accounts: [
          { pubkey: wallet, isSigner: true, isWritable: false },
          { pubkey: params.get('destinationTokenAccount'), isSigner: false, isWritable: true },
        ] },
        cleanupInstruction: null, tipInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
      });
    }

    assert.equal(url.origin, fakeRpc);
    const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
    const response = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    const atSlot = (value: unknown) => response({ context: { slot: 42 }, value });
    switch (request.method) {
      case 'getGenesisHash': return response(MAINNET_GENESIS);
      case 'getAccountInfo': return atSlot({ data: [reserveFixture(), 'base64'], executable: false, owner: KAMINO, lamports: 7, rentEpoch: 0, space: 8624 });
      case 'getBalance': return atSlot(10_000_000);
      case 'getMultipleAccounts': {
        assert.deepEqual(request.params[0], [KAMINO_MARKET_LOOKUP]);
        return atSlot([{ data: [lookupFixture(), 'base64'], executable: false, owner: LOOKUP_PROGRAM, lamports: 7, rentEpoch: 0, space: 120 }]);
      }
      case 'getLatestBlockhash': return atSlot({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 42 });
      case 'simulateTransaction': {
        simulationCount++;
        assert.equal((request.params[1] as { sigVerify: boolean }).sigVerify, false);
        const transaction = getTransactionDecoder().decode(Buffer.from(String(request.params[0]), 'base64'));
        assert.ok(Object.values(transaction.signatures).every((signature) => signature === null));
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        if (compiled.version !== 0) assert.fail('Expected a v0 transaction');
        assert.equal(compiled.addressTableLookups?.[0]?.lookupTableAddress, KAMINO_MARKET_LOOKUP);
        const sequence = compiled.instructions.map((instruction) => compiled.staticAccounts[instruction.programAddressIndex]);
        assert.deepEqual(sequence.slice(4), [KAMINO, JUPITER, JUPITER, KAMINO]);
        assert.equal(compiled.instructions[7].data?.[16], 4);
        const tokenBalance = (amount: number) => ({ accountIndex: 1, mint: USDC, owner: wallet, programId: tokenProgram,
          uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: amount / 1_000_000, uiAmountString: String(amount / 1_000_000) } });
        return atSlot({
          err: null, fee, unitsConsumed: 420000,
          preBalances: [10_000_000], postBalances: [10_000_000 - fee],
          preTokenBalances: [tokenBalance(1_000_000)], postTokenBalances: [tokenBalance(1_000_000 + actualWalletGain)],
        });
      }
      default: assert.fail(`Unexpected RPC method ${request.method}`);
    }
  });

  const config = { rpcUrl: fakeRpc, wallet };
  const scan = await scanSolanaCycle(config);
  assert.equal(scan.flashFeeUsdc, 0.0025);
  assert.equal(simulationCount, 2);
  for (const route of scan.routes) {
    assert.equal(route.status, 'simulated', route.detail);
    assert.equal(route.qualified, true);
    assert.equal(route.simulatedCostLamports, fee);
    assert.ok(route.simulatedNetUsdc! > 0.2);
  }

  actualWalletGain = 10_000;
  const belowFloor = await scanSolanaCycle(config);
  assert.ok(belowFloor.routes.every((route) => route.status === 'simulated' && route.qualified === false));
  actualWalletGain = 210_000;
  const overBudget = await scanSolanaCycle({ ...config, maxFeeLamports: 6000 });
  assert.ok(overBudget.routes.every((route) => route.status === 'simulated' && route.simulatedNetUsdc! > 0.2 && route.qualified === false));
});
