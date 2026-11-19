import {
  BaseError, decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodePacked, HttpRequestError, keccak256, pad,
  TimeoutError, toHex, type Address, type Hex,
} from 'viem';
import { ADDR, TOKENS } from './config.js';
import { publicClient, swapRouter02Abi } from './chain.js';
import type { TokenMarket } from './market.js';

/** A throwaway address used only inside eth_call simulations (never holds real funds). */
const SIM: Address = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe';
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002'; // SwapRouter02: keep output in the router
const CONTRACT_BALANCE = 0n; // SwapRouter02: amountIn 0 = swap the router's whole balance
// WETH9 storage layout: balanceOf = slot 3, allowance = slot 4
const WETH_BALANCE_SLOT = 3n;
const WETH_ALLOWANCE_SLOT = 4n;

const mapSlot = (key: Address, slot: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, slot]));
const nestedSlot = (k1: Address, k2: Address, slot: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [k2, mapSlot(k1, slot)]));

export interface SafetyResult {
  ok: boolean;
  roundTripLossPct: number; // total loss of WETH -> token -> WETH
  hiddenCostPct: number; // loss beyond the two pool fees (tax / honeypot / price impact)
  reason: string;
}

/**
 * Honeypot & hidden-tax check: simulates buying the token with `wethIn` and selling everything back in ONE eth_call
 * (state override gives the simulator WETH + router allowance). Catches tokens that can't be sold, transfer taxes,
 * blacklists and trading switches. Read-only: nothing is sent to the chain.
 */
export async function roundTripCheck(t: TokenMarket, wethIn: bigint): Promise<SafetyResult> {
  if (!t.pool) return { ok: true, roundTripLossPct: 0, hiddenCostPct: 0, reason: 'WETH itself' };
  const fee = t.pool.fee;
  const token = t.token.address;
  const buy = encodeFunctionData({
    abi: swapRouter02Abi, functionName: 'exactInput',
    args: [{ path: encodePacked(['address', 'uint24', 'address'], [ADDR.weth, fee, token]), recipient: ADDRESS_THIS, amountIn: wethIn, amountOutMinimum: 0n }],
  });
  const sell = encodeFunctionData({
    abi: swapRouter02Abi, functionName: 'exactInput',
    args: [{ path: encodePacked(['address', 'uint24', 'address'], [token, fee, ADDR.weth]), recipient: SIM, amountIn: CONTRACT_BALANCE, amountOutMinimum: 0n }],
  });
  const data = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'multicall', args: [BigInt(Math.floor(Date.now() / 1000) + 900), [buy, sell]] });
  const amount = pad(toHex(wethIn), { size: 32 });
  try {
    const res = await publicClient.call({
      account: SIM,
      to: ADDR.swapRouter02,
      data,
      stateOverride: [{
        address: ADDR.weth,
        stateDiff: [
          { slot: mapSlot(SIM, WETH_BALANCE_SLOT), value: amount },
          { slot: nestedSlot(SIM, ADDR.swapRouter02, WETH_ALLOWANCE_SLOT), value: amount },
        ],
      }],
    });
    if (!res.data) return { ok: false, roundTripLossPct: 1, hiddenCostPct: 1, reason: 'simulation returned nothing' };
    const results = decodeFunctionResult({ abi: swapRouter02Abi, functionName: 'multicall', data: res.data }) as readonly Hex[];
    const [wethBack] = decodeAbiParameters([{ type: 'uint256' }], results[1]);
    const loss = 1 - Number(wethBack) / Number(wethIn);
    const fees = 1 - (1 - fee / 1e6) ** 2;
    const hidden = loss - fees;
    if (wethBack === 0n) return { ok: false, roundTripLossPct: 1, hiddenCostPct: 1, reason: 'sell returns nothing (honeypot)' };
    if (hidden > TOKENS.maxRoundTripTaxPct) {
      return { ok: false, roundTripLossPct: loss, hiddenCostPct: hidden, reason: `buy+sell loses ${(loss * 100).toFixed(2)}% (tax/honeypot?)` };
    }
    return { ok: true, roundTripLossPct: loss, hiddenCostPct: hidden, reason: `round trip ${(loss * 100).toFixed(2)}%` };
  } catch (e) {
    const msg = ((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? 'reverted').split('\n')[0].slice(0, 120);
    // RPC trouble is not a token verdict: let the caller retry instead of blacklisting the token
    const transport = e instanceof BaseError && !!e.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError);
    if (transport || /fetch failed|HTTP request failed|timeout|took too long|ECONN|429|rate limit/i.test(msg)) throw e;
    return { ok: false, roundTripLossPct: 1, hiddenCostPct: 1, reason: `sell simulation reverted: ${msg}` };
  }
}
