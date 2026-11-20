import fs from 'node:fs';
import path from 'node:path';
import { formatEther, getContractAddress, isAddress, isAddressEqual, keccak256, zeroAddress, type Address, type Hash } from 'viem';
import { CONFIG, DATA_DIR } from '../config.js';
import { readPrivateFile, writePrivateFile } from '../private-file.js';
import { loadOrCreateWallet } from '../wallet.js';
import { arbitrumChainId, arbitrumClient, arbitrumEthUsd } from './market.js';
import { arbitrumProxyCreation, arbitrumProxyUpgrade, arbitrumReleaseHash, verifyArbitrumExecutor } from './proxy.js';

interface SubmittedDeployment { hash: Hash; contract: Address }

/** Without a proxy address, deploy the first release. With one, replace its implementation in place. */
export async function deployArbitrum(publish: boolean, maxFeeUsd: number, owner: Address, proxy?: Address) {
  if (!isAddress(owner) || isAddressEqual(owner, zeroAddress)) throw new Error('Set ARBITRUM_OWNER_ADDRESS to the expected wallet');
  if (proxy !== undefined && (!isAddress(proxy) || isAddressEqual(proxy, zeroAddress))) {
    throw new Error('Set ARBITRUM_EXECUTOR_ADDRESS to the proxy you want to upgrade');
  }
  if (publish && (!CONFIG.allowLiveTrading || CONFIG.forkMode)) throw new Error('Mainnet signing is disabled');
  if (!Number.isFinite(maxFeeUsd) || maxFeeUsd <= 0 || maxFeeUsd > 50) throw new Error('Invalid deployment fee cap');
  const action = proxy ? 'upgrade' : 'deploy';
  const file = path.join(DATA_DIR, proxy
    ? `arbitrum-upgrade-${proxy.toLowerCase()}-${arbitrumReleaseHash}.json`
    : 'arbitrum-proxy-deployment.json');
  const client = arbitrumClient(process.env.ARBITRUM_RPC_URL);
  if (await client.getChainId() !== arbitrumChainId) throw new Error('Arbitrum RPC must report chain ID 42161');

  const confirm = async ({ hash, contract }: SubmittedDeployment) => {
    const receipt = await client.waitForTransactionReceipt({
      hash, timeout: 120_000,
      onReplaced: () => { throw new Error('Arbitrum operation nonce was replaced'); },
    });
    const destination = action === 'deploy' ? receipt.contractAddress : receipt.to;
    if (receipt.status !== 'success' || receipt.transactionHash !== hash || !destination
      || !isAddressEqual(destination, contract) || !isAddressEqual(receipt.from, owner)) {
      throw new Error('Arbitrum transaction did not settle as expected');
    }
    const executor = await verifyArbitrumExecutor(client, contract, owner, arbitrumReleaseHash);
    return { action, status: 'verified', hash, contract, owner, block: Number(receipt.blockNumber), ...executor,
      gasEth: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
  };
  if (publish && fs.existsSync(file)) {
    const existing = JSON.parse(readPrivateFile(file, 512)) as SubmittedDeployment;
    if (!/^0x[0-9a-fA-F]{64}$/.test(existing.hash) || !isAddress(existing.contract)
      || (proxy && !isAddressEqual(proxy, existing.contract))) throw new Error('Invalid Arbitrum operation journal');
    return confirm(existing);
  }

  const previous = proxy ? await verifyArbitrumExecutor(client, proxy, owner) : null;
  if (previous?.kind === 'standalone') throw new Error('This address was deployed as standalone. Deploy a new proxy once.');
  if (previous?.releaseHash === arbitrumReleaseHash) return { action, status: 'already-current', contract: proxy, owner, ...previous };
  const data = previous ? arbitrumProxyUpgrade(previous.releaseHash) : arbitrumProxyCreation();
  const tx = proxy ? { to: proxy, data } : { data };
  const [estimatedGas, fees, ethUsd, balance, nonce, pending] = await Promise.all([
    client.estimateGas({ account: owner, ...tx }), client.estimateFeesPerGas(), arbitrumEthUsd(client),
    client.getBalance({ address: owner }), client.getTransactionCount({ address: owner }),
    client.getTransactionCount({ address: owner, blockTag: 'pending' }),
  ]);
  const gas = (estimatedGas * 120n + 99n) / 100n;
  const gasBudget = gas * fees.maxFeePerGas;
  const feeUsd = Number(formatEther(gasBudget)) * ethUsd;
  const contract = proxy ?? getContractAddress({ from: owner, nonce: BigInt(nonce) });
  if (!publish) return { action, status: 'quote', owner, contract, releaseHash: arbitrumReleaseHash,
    previousRelease: previous?.releaseHash ?? null, maxFeeEth: formatEther(gasBudget), maxFeeUsd: feeUsd, balanceEth: formatEther(balance) };
  if (nonce !== pending) throw new Error('Arbitrum wallet already has a pending transaction');
  if (feeUsd > maxFeeUsd) throw new Error('Arbitrum operation exceeds the requested fee cap');
  if (balance < gasBudget) throw new Error('Arbitrum wallet needs native ETH for the operation');
  const { account } = loadOrCreateWallet();
  if (!isAddressEqual(account.address, owner)) throw new Error('Loaded wallet differs from ARBITRUM_OWNER_ADDRESS');
  const serializedTransaction = await account.signTransaction({ chainId: arbitrumChainId, type: 'eip1559', ...tx, ...fees, gas, nonce });
  const hash = keccak256(serializedTransaction);
  writePrivateFile(file, JSON.stringify({ hash, contract }));
  console.log(`Arbitrum ${action} submitted for tracking:`, hash);
  await client.sendRawTransaction({ serializedTransaction });
  return confirm({ hash, contract });
}
