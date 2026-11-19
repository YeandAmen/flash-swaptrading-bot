import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { CONFIG, DATA_DIR, ROOT } from './config.js';
import { writeJson } from './persistence.js';
import { readPrivateFile, writePrivateFile } from './private-file.js';

export interface WalletInfo {
  account: PrivateKeyAccount;
  storage: string;
  created: boolean;
}

const isKey = (k: string): k is Hex => /^0x[0-9a-fA-F]{64}$/.test(k);
const SEC_TIMEOUT_MS = 10_000;
const ERR_ITEM_NOT_FOUND = 44; // `security` exit code for errSecItemNotFound
const metaFile = path.join(DATA_DIR, 'wallet.json');
const fallbackFile = process.platform === 'darwin'
  ? path.join(os.homedir(), '.eth-token-bot', 'wallet.key')
  : path.join(DATA_DIR, 'wallet.key');
const macSecurity = '/usr/bin/security';

interface StoredKey { key: Hex; storage: string }

/** Returns the key, null if the item definitely does not exist, and THROWS on any other Keychain problem. */
function keychainRead(): string | null {
  try {
    const out = execFileSync(macSecurity, ['find-generic-password', '-s', CONFIG.keychainService, '-a', CONFIG.keychainAccount, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: SEC_TIMEOUT_MS,
    });
    return out.toString().trim();
  } catch (e) {
    const status = (e as { status?: number | null }).status;
    if (status === ERR_ITEM_NOT_FOUND) return null;
    throw new Error(`macOS Keychain read failed (${status ?? 'timeout'}). Is the login keychain unlocked? Not touching the wallet; will retry.`);
  }
}

/** Writes via `security -i` on stdin so the key never appears in the process list. */
function keychainWrite(key: Hex): boolean {
  const quote = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  if ([CONFIG.keychainService, CONFIG.keychainAccount].some((value) => /[\x00-\x1F\x7F]/.test(value))) {
    throw new Error('Invalid Keychain service or account');
  }
  try {
    const cmd = `add-generic-password -s ${quote(CONFIG.keychainService)} -a ${quote(CONFIG.keychainAccount)} -l "ETH Token Bot wallet" -w "${key}"\n`;
    execFileSync(macSecurity, ['-i'], { input: cmd, stdio: ['pipe', 'ignore', 'ignore'], timeout: SEC_TIMEOUT_MS });
    return keychainRead() === key;
  } catch {
    return false;
  }
}

function recordedAddress(): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { address?: string };
    if (typeof m?.address !== 'string' || !isAddress(m.address, { strict: false })) throw new Error('Invalid wallet address');
    return m.address;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Wallet metadata is unreadable. Restore wallet.json and its original key before starting.');
  }
}

function checkKey(value: string): Hex {
  if (!isKey(value)) throw new Error('Wallet storage must contain exactly one 0x-prefixed 32-byte private key');
  return value;
}

function storedKey(): StoredKey | null {
  if (CONFIG.walletKeyFile) {
    const file = path.resolve(ROOT, CONFIG.walletKeyFile);
    return { key: checkKey(readPrivateFile(file, 68).trim()), storage: 'protected key file' };
  }
  if (process.platform === 'darwin') {
    const existing = keychainRead(); // Keychain errors such as a locked store are fail-closed.
    if (existing !== null) return { key: checkKey(existing), storage: 'macOS Keychain' };
  }
  try {
    return { key: checkKey(readPrivateFile(fallbackFile, 68).trim()), storage: 'protected key file' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Load the original key, or create one only when the installation has no existing wallet. */
export function loadOrCreateWallet(): WalletInfo {
  const recorded = recordedAddress();
  const existing = storedKey();
  if (existing) return finish(existing, false, recorded);
  if (recorded) {
    throw new Error(`No private key found for recorded wallet ${recorded}. Restore the original key.`);
  }

  const key = generatePrivateKey();
  if (process.platform === 'darwin') {
    if (keychainWrite(key)) return finish({ key, storage: 'macOS Keychain' }, true, null);
    if (keychainRead() !== null) throw new Error('Keychain changed while creating the wallet; try again.');
  }
  fs.mkdirSync(path.dirname(fallbackFile), { recursive: true, mode: 0o700 });
  writePrivateFile(fallbackFile, key + '\n');
  return finish({ key, storage: 'protected key file' }, true, null);
}

function finish({ key, storage }: StoredKey, created: boolean, recorded: string | null): WalletInfo {
  let account: PrivateKeyAccount;
  try { account = privateKeyToAccount(key); } catch { throw new Error('Wallet storage does not contain a valid secp256k1 private key'); }
  if (!recorded) {
    try {
      writeJson(metaFile, { address: account.address, createdAt: new Date().toISOString(), storage }, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      recorded = recordedAddress();
      if (!recorded) throw new Error('Wallet metadata changed during startup');
    }
  }
  if (recorded && recorded.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Loaded key belongs to ${account.address}; wallet metadata records ${recorded}. Restore the matching key.`);
  }
  return { account, storage, created };
}

/** Write a new protected copy outside the checkout without printing the key. */
export function exportWallet(destination: string): { address: string; file: string } {
  const recorded = recordedAddress();
  const existing = storedKey();
  if (!existing || !recorded) throw new Error('Initialize the wallet first with npm run wallet:address');
  const { account } = finish(existing, false, recorded);
  if (!path.isAbsolute(destination)) throw new Error('An absolute export path outside the checkout is required');
  const directory = fs.realpathSync(path.dirname(destination));
  const relative = path.relative(fs.realpathSync(ROOT), directory);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('Choose an export destination outside the repository');
  }
  const file = path.join(directory, path.basename(destination));
  writePrivateFile(file, existing.key + '\n');
  return { address: account.address, file };
}
