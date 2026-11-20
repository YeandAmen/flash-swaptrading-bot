import { createHash } from 'node:crypto';
import {
  AccountRole, address, getAddressDecoder, getAddressEncoder,
  type Address, type Instruction, type createSolanaRpc,
} from '@solana/kit';

export const LIGHTHOUSE = address('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');

const BPF_LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_DATA = address('CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c');
const DEPLOYMENT_SLOT = 294179293n;
const PROGRAM_HASH = 'a89179ae024ac36aa5fc308251caa84cd0a3390ae66d8523514004a86d5148bb';
const PROGRAM_DATA_HEADER_BYTES = 45;
const FAILED_PLAINTEXT = 4;
const ASSERT_ACCOUNT_INFO = 5;
const ASSERT_TOKEN_ACCOUNT = 9;
const ASSERT_TOKEN_ACCOUNT_MULTI = 10;
const ASSERT_LAMPORTS = 0;
const ASSERT_TOKEN_OWNER = 1;
const ASSERT_TOKEN_AMOUNT = 2;
const ASSERT_TOKEN_DELEGATE = 3;
const ASSERT_TOKEN_CLOSE_AUTHORITY = 7;
const ASSERT_TOKEN_IS_ASSOCIATED = 8;

type Comparison = 'equal' | 'atLeast';
const INTEGER_OPERATOR: Record<Comparison, number> = { equal: 0, atLeast: 4 };

// ABI checked against the generated upstream Kit codecs and the deployed program.
// https://github.com/Jac0xb/lighthouse/tree/4c579479c98635e419b1b167f08be02a71604a71/clients/kit-js/src/generated
function readOnlyAssertion(account: Address, data: Uint8Array): Instruction {
  return {
    programAddress: LIGHTHOUSE,
    accounts: [{ address: account, role: AccountRole.READONLY }],
    data,
  };
}

function assertAccount(account: Address, discriminator: number, field: number, value: Uint8Array, operator: number): Instruction {
  return readOnlyAssertion(account, Buffer.concat([
    Buffer.from([discriminator, FAILED_PLAINTEXT, field]), value, Buffer.from([operator]),
  ]));
}

function encodedAmount(amount: bigint): Uint8Array {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(amount);
  return data;
}

export function lighthouseTokenAmount(ata: Address, comparison: Comparison, amount: bigint): Instruction {
  return assertAccount(ata, ASSERT_TOKEN_ACCOUNT, ASSERT_TOKEN_AMOUNT, encodedAmount(amount), INTEGER_OPERATOR[comparison]);
}

export function lighthouseLamports(account: Address, comparison: Comparison, amount: bigint): Instruction {
  return assertAccount(account, ASSERT_ACCOUNT_INFO, ASSERT_LAMPORTS, encodedAmount(amount), INTEGER_OPERATOR[comparison]);
}

export function lighthouseTokenOwner(ata: Address, owner: Address): Instruction {
  return assertAccount(ata, ASSERT_TOKEN_ACCOUNT, ASSERT_TOKEN_OWNER, new Uint8Array(getAddressEncoder().encode(owner)), 0);
}

export function lighthouseTokenHasNoDelegate(ata: Address): Instruction {
  return assertAccount(ata, ASSERT_TOKEN_ACCOUNT, ASSERT_TOKEN_DELEGATE, Uint8Array.of(0), 0);
}

export function lighthouseTokenHasNoCloseAuthority(ata: Address): Instruction {
  return assertAccount(ata, ASSERT_TOKEN_ACCOUNT, ASSERT_TOKEN_CLOSE_AUTHORITY, Uint8Array.of(0), 0);
}

/** Verify minimum tokens, the wallet owner, and absent delegate and close authority. */
export function lighthouseTokenFloor(ata: Address, amount: bigint, owner?: Address): Instruction {
  if (!owner) return lighthouseTokenAmount(ata, 'atLeast', amount);
  // The upstream LEB128 vector has four assertions, so its encoded length is one byte.
  return readOnlyAssertion(ata, Buffer.concat([
    Buffer.from([ASSERT_TOKEN_ACCOUNT_MULTI, FAILED_PLAINTEXT, 4, ASSERT_TOKEN_AMOUNT]),
    encodedAmount(amount),
    Buffer.from([INTEGER_OPERATOR.atLeast, ASSERT_TOKEN_OWNER]),
    new Uint8Array(getAddressEncoder().encode(owner)),
    Buffer.from([0, ASSERT_TOKEN_DELEGATE, 0, 0, ASSERT_TOKEN_CLOSE_AUTHORITY, 0, 0]),
  ]));
}

/** The ATA address must be derived locally from the expected wallet and mint. */
export function lighthouseAtaFloor(ata: Address, amount: bigint): Instruction {
  return readOnlyAssertion(ata, Buffer.concat([
    Buffer.from([ASSERT_TOKEN_ACCOUNT_MULTI, FAILED_PLAINTEXT, 4, ASSERT_TOKEN_AMOUNT]),
    encodedAmount(amount),
    Buffer.from([INTEGER_OPERATOR.atLeast, ASSERT_TOKEN_IS_ASSOCIATED, ASSERT_TOKEN_DELEGATE, 0, 0,
      ASSERT_TOKEN_CLOSE_AUTHORITY, 0, 0]),
  ]));
}

/** Verify the immutable mainnet assertion program before enabling a live signer. */
export async function verifyLighthouseDeployment(rpc: ReturnType<typeof createSolanaRpc>): Promise<void> {
  const { value: [program, deployment] } = await rpc.getMultipleAccounts([LIGHTHOUSE, PROGRAM_DATA], {
    encoding: 'base64', commitment: 'finalized',
  }).send({ abortSignal: AbortSignal.timeout(8_000) });
  if (!program?.executable || program.owner !== BPF_LOADER
    || !deployment || deployment.executable || deployment.owner !== BPF_LOADER) {
    throw new Error('Solana RPC did not return the expected immutable Lighthouse program');
  }
  const programBytes = Buffer.from(program.data[0], 'base64');
  const deploymentBytes = Buffer.from(deployment.data[0], 'base64');
  if (programBytes.length !== 36 || programBytes.readUInt32LE(0) !== 2
    || getAddressDecoder().decode(programBytes, 4) !== PROGRAM_DATA
    || deploymentBytes.length <= PROGRAM_DATA_HEADER_BYTES || deploymentBytes.readUInt32LE(0) !== 3
    || deploymentBytes.readBigUInt64LE(4) !== DEPLOYMENT_SLOT || deploymentBytes[12] !== 0
    || createHash('sha256').update(deploymentBytes.subarray(PROGRAM_DATA_HEADER_BYTES)).digest('hex') !== PROGRAM_HASH) {
    throw new Error('Lighthouse deployment did not match the verified mainnet program pin');
  }
}
