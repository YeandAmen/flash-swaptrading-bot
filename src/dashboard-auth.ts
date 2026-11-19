import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const file = path.join(DATA_DIR, 'dashboard-token');

/** Keep the per-installation token readable only by the account running the dashboard. */
export function dashboardToken(create = false): string {
  if (create) {
    try {
      fs.writeFileSync(file, `${randomBytes(24).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size !== 49) {
      throw new Error('Dashboard token must be a regular 0600 file owned by the bot account');
    }
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('Dashboard token has an invalid format');
    return token;
  } finally {
    fs.closeSync(fd);
  }
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
