import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CONFIG, DATA_DIR } from './config.js';

export interface WalletInfo {
  account: PrivateKeyAccount;
  storage: string;
  created: boolean;
}

const isKey = (k: string): k is Hex => /^0x[0-9a-fA-F]{64}$/.test(k);
const SEC_TIMEOUT_MS = 10_000;
const ERR_ITEM_NOT_FOUND = 44; // `security` exit code for errSecItemNotFound
const metaFile = path.join(DATA_DIR, 'wallet.json');
const fallbackFile = path.join(os.homedir(), '.eth-token-bot', 'wallet.key');

/** Returns the key, null if the item definitely does not exist, and THROWS on any other Keychain problem. */
function keychainRead(): string | null {
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', CONFIG.keychainService, '-a', CONFIG.keychainAccount, '-w'], {
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
function keychainWrite(key: string): boolean {
  try {
    const cmd = `add-generic-password -s "${CONFIG.keychainService}" -a "${CONFIG.keychainAccount}" -l "ETH Token Bot wallet" -w "${key}"\n`;
    execFileSync('security', ['-i'], { input: cmd, stdio: ['pipe', 'ignore', 'ignore'], timeout: SEC_TIMEOUT_MS });
    return keychainRead() === key;
  } catch {
    return false;
  }
}

function recordedAddress(): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { address?: string };
    return m.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Loads the bot wallet, creating it ONLY on a true first run.
 * The private key lives in the macOS Keychain (encrypted, survives deleting this folder).
 * It is never logged and never served by the API. If the recorded wallet's key can't be read,
 * the bot refuses to start instead of silently switching to a new address.
 */
export function loadOrCreateWallet(): WalletInfo {
  const recorded = recordedAddress();

  if (CONFIG.walletKeyFile) {
    const k = fs.readFileSync(CONFIG.walletKeyFile, 'utf8').trim();
    if (!isKey(k)) throw new Error('WALLET_KEY_FILE does not contain a valid private key');
    return finish(k, `file:${CONFIG.walletKeyFile}`, false, recorded);
  }

  const existing = keychainRead(); // throws on Keychain errors (locked, timeout...)
  if (existing !== null) {
    if (!isKey(existing)) throw new Error(`Keychain item "${CONFIG.keychainService}" does not hold a valid private key`);
    return finish(existing, 'macOS Keychain', false, recorded);
  }

  if (fs.existsSync(fallbackFile)) {
    const k = fs.readFileSync(fallbackFile, 'utf8').trim();
    if (!isKey(k)) throw new Error(`${fallbackFile} does not hold a valid private key`);
    return finish(k, `file ${fallbackFile}`, false, recorded);
  }

  if (recorded) {
    throw new Error(`Wallet ${recorded} is recorded in data/wallet.json but its private key was not found. Refusing to create a different wallet.`);
  }

  // true first run
  const key = generatePrivateKey();
  if (keychainWrite(key)) return finish(key, 'macOS Keychain', true, null);
  if (keychainRead() !== null) throw new Error('Keychain changed while creating the wallet; refusing to continue.');
  fs.mkdirSync(path.dirname(fallbackFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fallbackFile, key + '\n', { mode: 0o600, flag: 'wx' });
  return finish(key, `file ${fallbackFile}`, true, null);
}

function finish(key: Hex, storage: string, created: boolean, recorded: string | null): WalletInfo {
  const account = privateKeyToAccount(key);
  if (recorded && recorded.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`Loaded key is for ${account.address} but this bot's wallet is ${recorded}. Refusing to start.`);
  }
  if (!recorded) {
    fs.writeFileSync(metaFile, JSON.stringify({ address: account.address, createdAt: new Date().toISOString(), storage }, null, 2));
  }
  return { account, storage, created };
}
