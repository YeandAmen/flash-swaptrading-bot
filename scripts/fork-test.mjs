import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';

const root = fileURLToPath(new URL('..', import.meta.url));
const [suite = 'cli-forktest', mode = '', ...extra] = process.argv.slice(2);
const suites = ['cli-forktest', 'cli-mev-forktest', 'cli-mev-v2-forktest', 'cli-wallet-forktest'];
const standalone = suite === 'cli-wallet-forktest' && mode === '--standalone';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE'].includes(key.toUpperCase())));
const argv = ['--host', '127.0.0.1', '--port', '0', '--chain-id', '1', '--accounts', '0', '--color', 'never'];

function listeningPort(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error('Anvil did not start within 60 seconds. Check Anvil and the fork provider.')), 60_000);
    const stopped = () => finish(new Error('Anvil exited before listening. Check Anvil and the fork provider.'));
    const unavailable = () => finish(new Error('Could not run Anvil. Install Foundry or set ANVIL to the Anvil executable.'));
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-8192);
      const port = /^Listening on 127\.0\.0\.1:(\d+)\r?$/m.exec(output)?.[1];
      if (port) finish(null, port);
    };
    function finish(error, port) {
      clearTimeout(timeout);
      child.off('error', unavailable);
      child.off('exit', stopped);
      child.stdout.off('data', onData);
      child.stdout.resume();
      if (error) reject(error);
      else resolve(port);
    }
    child.once('error', unavailable);
    child.once('exit', stopped);
    child.stdout.on('data', onData);
  });
}

function exitStatus(child) {
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not start the fork test process')));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

let temporary;
let anvil;
let test;
function terminate() {
  test?.kill();
  anvil?.kill();
}
process.on('SIGINT', terminate);
process.on('SIGTERM', terminate);

try {
  if (!suites.includes(suite) || (mode && !standalone) || extra.length) throw new Error('Unknown fork test suite or mode');
  const dist = path.resolve(root, process.env.DIST ?? 'dist');
  const testFile = path.join(dist, `${suite}.js`);
  if (!fs.existsSync(testFile)) throw new Error('Run npm run build before running the fork tests');
  if (!standalone) {
    let upstream;
    try { upstream = new URL(process.env.FORK_RPC_URL ?? ''); } catch { /* handled below */ }
    if (!upstream || !['http:', 'https:'].includes(upstream.protocol)) {
      throw new Error('Set FORK_RPC_URL to an Ethereum mainnet archive RPC URL for Anvil’s read-only upstream');
    }
    argv.push('--fork-url', upstream.href, '--no-storage-caching');
    const block = process.env.FORK_BLOCK_NUMBER;
    if (block) {
      if (!/^[1-9][0-9]*$/.test(block)) throw new Error('FORK_BLOCK_NUMBER must be a positive decimal block number');
      argv.push('--fork-block-number', block);
    }
  }
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-token-fork-'));
  const key = path.join(temporary, 'test.key');
  const { writePrivateFile } = await import(pathToFileURL(path.join(dist, 'private-file.js')).href);
  writePrivateFile(key, generatePrivateKey() + '\n');
  anvil = spawn(process.env.ANVIL || 'anvil', argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await listeningPort(anvil);
  const loopback = `http://127.0.0.1:${port}`;
  test = spawn(process.execPath, [testFile], { cwd: root, stdio: 'inherit', env: {
    ...env, RPC_URL: loopback, SEND_RPC_URL: loopback, FORK_MODE: '1', ALLOW_LIVE_TRADING: 'off',
    WALLET_KEY_FILE: key, DATA_DIR: path.join(temporary, 'data'), LOOP_SECONDS: '5', TOKEN_MODE: 'core',
  } });
  process.exitCode = await exitStatus(test);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cannot run the fork test');
  process.exitCode = 1;
} finally {
  terminate();
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  process.off('SIGINT', terminate);
  process.off('SIGTERM', terminate);
}
