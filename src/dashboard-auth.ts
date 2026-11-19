import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readPrivateFile, writePrivateFile } from './private-file.js';

const file = path.join(DATA_DIR, 'dashboard-token');

/** Keep the per-installation token readable only by the account running the dashboard. */
export function dashboardToken(create = false): string {
  if (create) {
    try {
      writePrivateFile(file, `${randomBytes(24).toString('hex')}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  const token = readPrivateFile(file, 50).trim();
  if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Dashboard token has an invalid format');
  return token;
}

export function createDashboardCredentialCheck(): (authorization?: string) => boolean {
  const expected = Buffer.from(`operator:${dashboardToken(true)}`);
  return (authorization) => {
    const value = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1];
    if (!value) return false;
    const actual = Buffer.from(value, 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
}
