import { redactDiagnostic } from '../diagnostics.js';
import { scanSolanaCycle, solanaScanConfig } from './scan.js';

try {
  console.log(JSON.stringify(await scanSolanaCycle(solanaScanConfig()), null, 2));
} catch (error) {
  console.error(redactDiagnostic(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
