import fs from 'node:fs';

/** The origin is enough to identify an endpoint in operator diagnostics. */
export function endpointOrigin(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return '[endpoint]';
  }
}

export function redactDiagnostic(message: string): string {
  const walletFile = process.env.WALLET_KEY_FILE;
  const text = walletFile ? message.replaceAll(walletFile, '[local key file]') : message;
  return text.replace(/https?:\/\/[^\s<>"']+/gi, endpointOrigin)
    .replace(/\(key (stored )?in file[ :][^\r\n]+\)$/gm, '(key $1in local key file)');
}

export function appendRotatingLog(file: string, line: string, limit = 2 * 1024 * 1024): void {
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size > 0 && size + Buffer.byteLength(line) > limit) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, line, { mode: 0o600 });
}

export function readLogTail(file: string, limit = 256 * 1024): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8', 0, bytes).trimEnd().split('\n');
    if (start > 0) lines.shift(); // the first line may start in the middle of an event
    return lines.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}
