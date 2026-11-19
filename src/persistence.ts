import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function syncDirectory(directory: string) {
  // Windows Node file descriptors cannot flush an open directory. The file itself is still flushed before replacement.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Persist the file and its directory entry before a caller acts on it. */
export function writeJson(file: string, value: unknown, exclusive = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
    syncDirectory(path.dirname(file));
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
