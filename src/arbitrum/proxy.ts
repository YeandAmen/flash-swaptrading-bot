import {
  encodeDeployData, encodeFunctionData, getAddress, isAddressEqual, keccak256, zeroAddress, type Address, type Hex,
} from 'viem';
import { FLASH_ARB_PROXY_ABI, FLASH_ARB_PROXY_BYTECODE, FLASH_ARB_PROXY_RUNTIME } from '../mev/artifact-proxy.js';
import { ARBITRUM_FLASH_ARB_ABI, ARBITRUM_FLASH_ARB_RUNTIME } from './artifact.js';
import { ARBITRUM_FLASH_ARB_LOGIC_BYTECODE, ARBITRUM_FLASH_ARB_LOGIC_RUNTIME } from './artifact-logic.js';
import type { ArbitrumClient } from './market.js';

const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const adminSlot = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
export const arbitrumReleaseHash = keccak256(ARBITRUM_FLASH_ARB_LOGIC_RUNTIME);

export type ArbitrumExecutor =
  | { kind: 'standalone'; implementation: null; releaseHash: null }
  | { kind: 'proxy'; implementation: Address; releaseHash: Hex };

function readAddress(word: Hex | undefined): Address | null {
  return word && /^0x0{24}[a-f\d]{40}$/i.test(word) ? getAddress(`0x${word.slice(-40)}`) : null;
}

export async function verifyArbitrumExecutor(
  client: ArbitrumClient, address: Address, wallet: Address,
  requiredRelease?: Hex,
): Promise<ArbitrumExecutor> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const bytecode = await client.getCode({ address, blockNumber });
  const standalone = bytecode?.toLowerCase() === ARBITRUM_FLASH_ARB_RUNTIME.toLowerCase();
  if (!standalone && bytecode?.toLowerCase() !== FLASH_ARB_PROXY_RUNTIME.toLowerCase()) {
    throw new Error('Arbitrum executor bytecode does not match a supported deployment');
  }
  const owner = await client.readContract({ address, abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'owner', blockNumber });
  if (!isAddressEqual(owner, wallet)) throw new Error('Arbitrum executor owner does not match the configured wallet');
  if (standalone) {
    if (requiredRelease) throw new Error('A release hash requires an upgradeable Arbitrum proxy');
    return { kind: 'standalone', implementation: null, releaseHash: null };
  }
  const [implementationWord, adminWord] = await Promise.all([
    client.getStorageAt({ address, slot: implementationSlot, blockNumber }),
    client.getStorageAt({ address, slot: adminSlot, blockNumber }),
  ]);
  const implementation = readAddress(implementationWord);
  const admin = readAddress(adminWord);
  if (!implementation || isAddressEqual(implementation, zeroAddress) || isAddressEqual(implementation, address)
    || !admin || !isAddressEqual(admin, wallet)) {
    throw new Error('Arbitrum proxy implementation or admin is invalid');
  }
  const code = await client.getCode({ address: implementation, blockNumber });
  if (!code || code === '0x') throw new Error('Arbitrum implementation code is missing');
  const releaseHash = keccak256(code);
  const configured = process.env.ARBITRUM_RELEASE_HASH?.toLowerCase();
  if (requiredRelease ? releaseHash !== requiredRelease.toLowerCase()
    : releaseHash !== arbitrumReleaseHash && releaseHash !== configured) {
    throw new Error('Arbitrum proxy implementation does not match an approved release');
  }
  return { kind: 'proxy', implementation, releaseHash };
}

export const arbitrumProxyCreation = () => encodeDeployData({
  abi: FLASH_ARB_PROXY_ABI, bytecode: FLASH_ARB_PROXY_BYTECODE,
  args: [ARBITRUM_FLASH_ARB_LOGIC_BYTECODE, arbitrumReleaseHash],
});

export const arbitrumProxyUpgrade = (previous: Hex) => encodeFunctionData({
  abi: FLASH_ARB_PROXY_ABI, functionName: 'upgradeRelease',
  args: [ARBITRUM_FLASH_ARB_LOGIC_BYTECODE, previous, arbitrumReleaseHash],
});

export const arbitrumPinnedCall = (inner: Hex, release: Hex) => encodeFunctionData({
  abi: FLASH_ARB_PROXY_ABI, functionName: 'executePinned', args: [release, inner],
});
