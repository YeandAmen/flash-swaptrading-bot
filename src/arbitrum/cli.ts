import type { Address } from 'viem';
import { redactDiagnostic } from '../diagnostics.js';
import { deployArbitrum } from './deployment.js';
import { arbitrumChainId, arbitrumClient, discoverArbitrumPools, scanArbitrum } from './market.js';

try {
  const command = process.argv[2] ?? 'scan';
  if (command === 'deploy' || command === 'quote') {
    const owner = (process.env.ARBITRUM_OWNER_ADDRESS ?? '') as Address;
    console.log(JSON.stringify(await deployArbitrum(command === 'deploy', Number(process.argv[3] ?? 2), owner), null, 2));
  } else if (command === 'scan') {
    const client = arbitrumClient(process.env.ARBITRUM_RPC_URL);
    if (await client.getChainId() !== arbitrumChainId) throw new Error('RPC is not Arbitrum One');
    const block = await client.getBlockNumber({ cacheTime: 0 });
    const markets = await discoverArbitrumPools(client, block);
    const { quotedRoutes, best } = await scanArbitrum(client, block, markets);
    console.log(JSON.stringify({ mode: 'paper', block: Number(block), markets: markets.length,
      pools: markets.reduce((total, market) => total + market.pools.length, 0), quotedRoutes, best }, null, 2));
  } else {
    throw new Error('Use scan, quote, or deploy');
  }
} catch (error) {
  console.error(redactDiagnostic(error instanceof Error ? error.message.split('\n')[0] : String(error)));
  process.exitCode = 1;
}
