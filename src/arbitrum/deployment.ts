import fs from 'node:fs';
import path from 'node:path';
import {
  encodeDeployData, formatEther, getContractAddress, isAddress, isAddressEqual, keccak256, type Address, type Hash,
} from 'viem';
import { CONFIG, DATA_DIR } from '../config.js';
import { readPrivateFile, writePrivateFile } from '../private-file.js';
import { loadOrCreateWallet } from '../wallet.js';
import { ARBITRUM_FLASH_ARB_ABI, ARBITRUM_FLASH_ARB_BYTECODE, ARBITRUM_FLASH_ARB_RUNTIME } from './artifact.js';
import { arbitrumChainId, arbitrumClient, arbitrumEthUsd, type ArbitrumClient } from './market.js';

interface SubmittedDeployment {
  hash: Hash;
  contract: Address;
}
const deploymentFile = path.join(DATA_DIR, 'arbitrum-deployment.json');

export async function verifyArbitrumExecutor(client: ArbitrumClient, contract: Address, owner: Address): Promise<void> {
  const bytecode = await client.getCode({ address: contract });
  if (bytecode?.toLowerCase() !== ARBITRUM_FLASH_ARB_RUNTIME.toLowerCase()) {
    throw new Error('Arbitrum executor bytecode does not match this release');
  }
  const actual = await client.readContract({ address: contract, abi: ARBITRUM_FLASH_ARB_ABI, functionName: 'owner' });
  if (!isAddressEqual(actual, owner)) throw new Error('Arbitrum executor owner does not match the configured wallet');
}

export async function deployArbitrum(publish: boolean, maxFeeUsd: number, owner: Address) {
  if (!isAddress(owner) || owner.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    throw new Error('Set ARBITRUM_OWNER_ADDRESS to the expected deployment wallet');
  }
  if (publish && (!CONFIG.allowLiveTrading || CONFIG.forkMode)) throw new Error('Mainnet signing is disabled');
  if (!Number.isFinite(maxFeeUsd) || maxFeeUsd <= 0 || maxFeeUsd > 50) throw new Error('Invalid deployment fee cap');
  const client = arbitrumClient(process.env.ARBITRUM_RPC_URL);
  if (await client.getChainId() !== arbitrumChainId) throw new Error('Arbitrum RPC must report chain ID 42161');

  const confirm = async ({ hash, contract }: SubmittedDeployment) => {
    const receipt = await client.waitForTransactionReceipt({
      hash, timeout: 120_000,
      onReplaced: () => { throw new Error('Arbitrum deployment nonce was replaced'); },
    });
    if (receipt.status !== 'success' || receipt.transactionHash !== hash || receipt.contractAddress?.toLowerCase() !== contract.toLowerCase()) {
      throw new Error('Arbitrum deployment did not settle as expected');
    }
    await verifyArbitrumExecutor(client, contract, owner);
    return { status: 'verified', hash, contract, owner, gasEth: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
  };
  if (publish && fs.existsSync(deploymentFile)) {
    const existing = JSON.parse(readPrivateFile(deploymentFile, 512)) as SubmittedDeployment;
    if (!/^0x[0-9a-fA-F]{64}$/.test(existing.hash) || !isAddress(existing.contract)) throw new Error('Invalid Arbitrum deployment journal');
    return confirm(existing);
  }

  const data = encodeDeployData({ abi: ARBITRUM_FLASH_ARB_ABI, bytecode: ARBITRUM_FLASH_ARB_BYTECODE, args: [owner] });
  const [estimatedGas, fees, ethUsd, balance, nonce, pending] = await Promise.all([
    client.estimateGas({ account: owner, data }), client.estimateFeesPerGas(), arbitrumEthUsd(client),
    client.getBalance({ address: owner }), client.getTransactionCount({ address: owner }),
    client.getTransactionCount({ address: owner, blockTag: 'pending' }),
  ]);
  const gas = (estimatedGas * 120n + 99n) / 100n;
  const gasBudget = gas * fees.maxFeePerGas;
  const feeUsd = Number(formatEther(gasBudget)) * ethUsd;
  const contract = getContractAddress({ from: owner, nonce: BigInt(nonce) });
  if (!publish) return { status: 'quote', owner, contract, maxFeeEth: formatEther(gasBudget), maxFeeUsd: feeUsd, balanceEth: formatEther(balance) };
  if (nonce !== pending) throw new Error('Arbitrum wallet already has a pending transaction');
  if (feeUsd > maxFeeUsd) throw new Error('Arbitrum deployment exceeds the requested fee cap');
  if (balance < gasBudget) throw new Error('Arbitrum wallet needs native ETH to cover deployment');
  const { account } = loadOrCreateWallet();
  if (!isAddressEqual(account.address, owner)) throw new Error('Loaded wallet differs from ARBITRUM_OWNER_ADDRESS');
  const serializedTransaction = await account.signTransaction({ chainId: arbitrumChainId, type: 'eip1559', data, ...fees, gas, nonce });
  const hash = keccak256(serializedTransaction);
  writePrivateFile(deploymentFile, JSON.stringify({ hash, contract }));
  console.log('Arbitrum deployment submitted for tracking:', hash);
  await client.sendRawTransaction({ serializedTransaction });
  return confirm({ hash, contract });
}
