import {
  AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress,
  type Address, type Instruction,
} from '@solana/kit';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const WRAPPED_SOL = address('So11111111111111111111111111111111111111112');
export const JUPITER = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const KAMINO = address('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
export const KAMINO_MARKET = address('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF');
export const KAMINO_USDC_RESERVE = address('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
// The SOL/BTC market's table is published in https://cdn.kamino.finance/kamino_lend_config_v3.json.
export const KAMINO_MARKET_LOOKUP = address('FGMSBiyVE8TvZcdQnZETAAKw28tkQJ2ccZy6pyp95URb');
export const LOOKUP_PROGRAM = address('AddressLookupTab1e1111111111111111111111111');

const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM = address('11111111111111111111111111111111');
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
const MAX_U64 = (1n << 64n) - 1n;
const KAMINO_FRACTION_SCALE = 1n << 60n;

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();

// Kamino KLend SDK v14 generated Reserve, ReserveLiquidity, ReserveConfig, and ReserveFees layouts.
// Mainnet reserve: https://kamino.com/earn/lend/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59
const RESERVE_BYTES = 8624;
const RESERVE_DISCRIMINATOR = Buffer.from('2bf2ccca1af73b7f', 'hex');
const KAMINO_USDC_SUPPLY = address('Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6');
const KAMINO_USDC_FEE_VAULT = address('BbDUrk1bVtSixgQsPLBJFZEF7mwGstnD5joA1WzYvYFX');
const reserveOffset = {
  lendingMarket: 32, mint: 128, supplyVault: 160, feeVault: 192,
  available: 224, decimals: 272, tokenProgram: 408, status: 4856, flashLoanFee: 4904,
};

export interface KaminoReserve {
  supplyVault: Address;
  feeVault: Address;
  available: bigint;
  fee: bigint;
  active: boolean;
}

export function decodeKaminoUsdcReserve(owner: Address, data: Buffer): KaminoReserve {
  if (owner !== KAMINO || data.length !== RESERVE_BYTES || !data.subarray(0, 8).equals(RESERVE_DISCRIMINATOR)
    || addressDecoder.decode(data, reserveOffset.lendingMarket) !== KAMINO_MARKET
    || addressDecoder.decode(data, reserveOffset.mint) !== USDC
    || addressDecoder.decode(data, reserveOffset.tokenProgram) !== TOKEN
    || data.readBigUInt64LE(reserveOffset.decimals) !== 6n) {
    throw new Error('Kamino USDC reserve did not match its expected program, layout, market, or mint');
  }
  // This existing reserve predates the newer reserve-address seed scheme.
  if (addressDecoder.decode(data, reserveOffset.supplyVault) !== KAMINO_USDC_SUPPLY
    || addressDecoder.decode(data, reserveOffset.feeVault) !== KAMINO_USDC_FEE_VAULT) {
    throw new Error('Kamino USDC reserve account did not match the canonical vault addresses');
  }
  const fee = data.readBigUInt64LE(reserveOffset.flashLoanFee);
  return {
    supplyVault: KAMINO_USDC_SUPPLY, feeVault: KAMINO_USDC_FEE_VAULT,
    available: data.readBigUInt64LE(reserveOffset.available),
    fee,
    active: data[reserveOffset.status] === 0 && fee !== MAX_U64,
  };
}

/** Round up for the prefilter. Simulation measures the exact post-repayment wallet delta. */
export function kaminoRepayment(amount: bigint, reserve: KaminoReserve): bigint {
  return amount + (amount * reserve.fee + KAMINO_FRACTION_SCALE - 1n) / KAMINO_FRACTION_SCALE;
}

export async function createWalletAta(wallet: Address, mint: typeof USDC | typeof WRAPPED_SOL): Promise<{
  ata: Address;
  instruction: Instruction;
}> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN,
    seeds: [addressEncoder.encode(wallet), addressEncoder.encode(TOKEN), addressEncoder.encode(mint)],
  });
  return {
    ata,
    instruction: {
      programAddress: ASSOCIATED_TOKEN,
      accounts: [
        { address: wallet, role: AccountRole.WRITABLE_SIGNER },
        { address: ata, role: AccountRole.WRITABLE },
        { address: wallet, role: AccountRole.READONLY },
        { address: mint, role: AccountRole.READONLY },
        { address: SYSTEM, role: AccountRole.READONLY },
        { address: TOKEN, role: AccountRole.READONLY },
      ],
      data: Uint8Array.of(1),
    },
  };
}

// Top-level borrow and repay pair from Kamino's public instruction interface.
// https://github.com/Kamino-Finance/klend/blob/master/libs/klend-interface/examples/flash_loan.rs
export async function createKaminoFlashInstructions(
  wallet: Address, ata: Address, amount: bigint, borrowIndex: number, reserve: KaminoReserve,
): Promise<readonly [Instruction, Instruction]> {
  const [authority] = await getProgramDerivedAddress({
    programAddress: KAMINO, seeds: ['lma', addressEncoder.encode(KAMINO_MARKET)],
  });
  const accounts = [
    { address: wallet, role: AccountRole.READONLY_SIGNER },
    { address: authority, role: AccountRole.READONLY },
    { address: KAMINO_MARKET, role: AccountRole.READONLY },
    { address: KAMINO_USDC_RESERVE, role: AccountRole.WRITABLE },
    { address: USDC, role: AccountRole.READONLY },
    { address: reserve.supplyVault, role: AccountRole.WRITABLE },
    { address: ata, role: AccountRole.WRITABLE },
    { address: reserve.feeVault, role: AccountRole.WRITABLE },
    { address: KAMINO, role: AccountRole.READONLY }, // no referrer token state
    { address: KAMINO, role: AccountRole.READONLY }, // no referrer account
    { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
    { address: TOKEN, role: AccountRole.READONLY },
  ];
  const borrow = Buffer.alloc(16);
  Buffer.from('87e734a70734d4c1', 'hex').copy(borrow);
  borrow.writeBigUInt64LE(amount, 8);
  const repay = Buffer.alloc(17);
  Buffer.from('b97500cb60f5b4ba', 'hex').copy(repay);
  repay.writeBigUInt64LE(amount, 8);
  repay.writeUInt8(borrowIndex, 16);
  return [
    { programAddress: KAMINO, accounts, data: borrow },
    { programAddress: KAMINO, accounts, data: repay },
  ];
}

export function decodeLookupTable(owner: Address, data: Buffer): Address[] {
  const metadataSize = 56;
  if (owner !== LOOKUP_PROGRAM || data.length < metadataSize || data.readUInt32LE(0) !== 1
    || (data.length - metadataSize) % 32 !== 0 || (data.length - metadataSize) / 32 > 256) {
    throw new Error('Invalid on-chain address lookup table');
  }
  const addresses: Address[] = [];
  for (let offset = metadataSize; offset < data.length; offset += 32) {
    addresses.push(addressDecoder.decode(data, offset));
  }
  return addresses;
}
