import { exportWallet, loadOrCreateWallet } from './wallet.js';

try {
  const [command, destination, ...extra] = process.argv.slice(2);
  if (command === 'address' && destination === undefined) {
    console.log(loadOrCreateWallet().account.address);
  } else if (command === 'export' && destination && extra.length === 0) {
    const { address, file } = exportWallet(destination);
    console.log(`Exported ${address} to a protected file at ${file}`);
  } else {
    throw new Error('Use npm run --silent wallet:address or npm run --silent wallet:export -- <absolute-path-outside-repo>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Wallet command failed');
  process.exitCode = 1;
}
