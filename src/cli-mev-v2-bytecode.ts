import { FLASH_ARB_V2_BYTECODE } from './mev/artifact-v2.js';
import { FLASH_ARB_V3_BYTECODE } from './mev/artifact-v3.js';

// This prints public contract creation data only. Deployment is a separate wallet action.
const version = process.argv[2] ?? 'v2';
if (version !== 'v2' && version !== 'v3') throw new Error('Use the v2 or v3 bytecode command.');
console.log(version === 'v3' ? FLASH_ARB_V3_BYTECODE : FLASH_ARB_V2_BYTECODE);
