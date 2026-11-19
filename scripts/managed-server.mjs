import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { appendRotatingLog, redactDiagnostic } from '../dist/diagnostics.js';

const log = fileURLToPath(new URL('../data/server.log', import.meta.url));
let reportedLogFailure = false;
const logStream = new Writable({
  write(chunk, _encoding, done) {
    try {
      appendRotatingLog(log, redactDiagnostic(chunk.toString()));
      reportedLogFailure = false;
    } catch {
      if (!reportedLogFailure) process.stderr.write('Could not write the managed server log.\n');
      reportedLogFailure = true;
    }
    done();
  },
});
globalThis.console = new Console({ stdout: logStream, stderr: logStream, colorMode: false });

try {
  await import('../dist/server.js');
} catch (error) {
  console.error(`Startup failed: ${String(error).split('\n')[0]}`);
  process.exitCode = 1;
}
