import { encodeDeployData, encodeFunctionData, getAddress, isAddressEqual, keccak256, zeroAddress, type Address, type Hex } from 'viem';
import { publicClient } from '../chain.js';
import { FLASH_ARB_V3_RUNTIME } from './artifact-v3.js';
import { FLASH_ARB_LOGIC_RUNTIME } from './artifact-logic.js';
import { FLASH_ARB_LOGIC_V2_RUNTIME } from './artifact-logic-v2.js';
import { FLASH_ARB_LOGIC_V3_ABI, FLASH_ARB_LOGIC_V3_RUNTIME } from './artifact-logic-v3.js';
import { FLASH_ARB_LOGIC_V4_BYTECODE, FLASH_ARB_LOGIC_V4_RUNTIME } from './artifact-logic-v4.js';
import { FLASH_ARB_PROXY_ABI, FLASH_ARB_PROXY_BYTECODE, FLASH_ARB_PROXY_RUNTIME } from './artifact-proxy.js';

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const OWNER_ABI = [{ type: 'function', name: 'owner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const;

// Retain prior reviewed releases while the operator decides when to upgrade.
const release = { creation: FLASH_ARB_LOGIC_V4_BYTECODE, hash: keccak256(FLASH_ARB_LOGIC_V4_RUNTIME) };
const approvedReleases = new Map<Hex, { runtime: Hex; spark: boolean; pancakeV2: boolean; curve: boolean; paths?: true; aero?: true }>([
  [keccak256(FLASH_ARB_V3_RUNTIME), { runtime: FLASH_ARB_V3_RUNTIME, spark: false, pancakeV2: false, curve: false }],
  [keccak256(FLASH_ARB_LOGIC_RUNTIME), { runtime: FLASH_ARB_LOGIC_RUNTIME, spark: true, pancakeV2: true, curve: false }],
  [keccak256(FLASH_ARB_LOGIC_V2_RUNTIME), { runtime: FLASH_ARB_LOGIC_V2_RUNTIME, spark: true, pancakeV2: true, curve: true }],
  [keccak256(FLASH_ARB_LOGIC_V3_RUNTIME), { runtime: FLASH_ARB_LOGIC_V3_RUNTIME, spark: true, pancakeV2: true, curve: true, paths: true }],
  [release.hash, { runtime: FLASH_ARB_LOGIC_V4_RUNTIME, spark: true, pancakeV2: true, curve: true, paths: true, aero: true }],
]);

export const proxyReleaseHash = release.hash;
export const proxyReleaseRuntime = FLASH_ARB_LOGIC_V4_RUNTIME;
export const releaseRuntime = (hash: Hex) => approvedReleases.get(hash)?.runtime;
export const releaseSupportsSpark = (hash: Hex) => approvedReleases.get(hash)?.spark === true;
export const releaseSupportsPancakeV2 = (hash: Hex) => approvedReleases.get(hash)?.pancakeV2 === true;

export const releaseSupportsCurve = (hash: Hex) => approvedReleases.get(hash)?.curve === true;

export const releaseSupportsPath = (hash: Hex) => approvedReleases.get(hash)?.paths === true;
export const releaseSupportsAero = (hash: Hex) => approvedReleases.get(hash)?.aero === true;
export interface PathHop {
  kind: number;
  pool: Address;
  fee: number;
  tickSpacing: number;
  nativeEth: boolean;
  tokenOut: Address;
}

export function encodePathArbitrage(hops: readonly PathHop[], amountIn: bigint, minProfit: bigint, maxBlock: bigint, expectedRelease: Hex): Hex {
  return encodeFunctionData({ abi: FLASH_ARB_LOGIC_V3_ABI, functionName: 'executePath', args: [expectedRelease, hops, amountIn, minProfit, maxBlock] });
}

export function proxyCreationData(): Hex {
  return encodeDeployData({ abi: FLASH_ARB_PROXY_ABI, bytecode: FLASH_ARB_PROXY_BYTECODE, args: [release.creation, release.hash] });
}

export function proxyUpgradeData(previousRelease: Hex): Hex {
  return encodeFunctionData({ abi: FLASH_ARB_PROXY_ABI, functionName: 'upgradeRelease', args: [release.creation, previousRelease, release.hash] });
}

export function pinnedArbitrage(data: Hex, implementationHash: Hex): Hex {
  return encodeFunctionData({ abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned', args: [implementationHash, data] });
}

function storageAddress(word: Hex | undefined): Address | null {
  return word && /^0x0{24}[0-9a-f]{40}$/i.test(word) ? getAddress('0x' + word.slice(-40)) : null;
}

/** Verify the facade, wallet and both ERC-1967 slots at the same block as the implementation. */
export async function verifyFlashProxy(address: Address, wallet: Address, hash: Hex, at?: bigint): Promise<Address | null> {
  const expected = releaseRuntime(hash);
  if (!expected) return null;
  const blockNumber = at ?? await publicClient.getBlockNumber({ cacheTime: 0 });
  const [code, implementationSlot, adminSlot, owner] = await Promise.all([
    publicClient.getCode({ address, blockNumber }),
    publicClient.getStorageAt({ address, slot: IMPLEMENTATION_SLOT, blockNumber }),
    publicClient.getStorageAt({ address, slot: ADMIN_SLOT, blockNumber }),
    publicClient.readContract({ address, abi: OWNER_ABI, functionName: 'owner', blockNumber }),
  ]);
  const implementation = storageAddress(implementationSlot);
  const admin = storageAddress(adminSlot);
  if (code?.toLowerCase() !== FLASH_ARB_PROXY_RUNTIME.toLowerCase() || !implementation || !admin
    || isAddressEqual(implementation, zeroAddress) || isAddressEqual(implementation, address)
    || !isAddressEqual(admin, wallet) || !isAddressEqual(owner, wallet)) return null;
  const implementationCode = await publicClient.getCode({ address: implementation, blockNumber });
  return implementationCode?.toLowerCase() === expected.toLowerCase() ? implementation : null;
}
