import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address } from '@solana/kit';
import { LIGHTHOUSE } from './guard.js';
import { JUPITER, KAMINO } from './protocol.js';
import { isJupiterSlippageFailure } from './worker.js';

const token = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ata = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const system = address('11111111111111111111111111111111');
const programs = [system, ata, KAMINO, JUPITER, JUPITER, KAMINO, LIGHTHOUSE];
const failure = { InstructionError: [3, { Custom: 6001 }] };
const frame = (nested: string[] = []) => [`Program ${JUPITER} invoke [1]`, ...nested,
  `Program ${JUPITER} failed: custom program error: 0x1771`];

test('identifies either Jupiter swap when the runtime attributes 6001 to the outer program', () => {
  const logs = frame([
    `Program ${ata} invoke [2]`, `Program ${token} invoke [3]`, 'Program log: Instruction: Transfer',
    `Program ${token} consumed 4900 of 41000 compute units`, `Program ${token} success`, `Program ${ata} success`,
    'Program log: AnchorError. Error Code: SlippageToleranceExceeded. Error Number: 6001.',
    `Program ${JUPITER} consumed 80000 of 100000 compute units`,
  ]);
  assert.equal(isJupiterSlippageFailure(failure, logs, programs), true);
  assert.equal(isJupiterSlippageFailure({ InstructionError: [4n, { Custom: 6001n }] },
    [`Program ${JUPITER} invoke [1]`, `Program ${JUPITER} success`, ...logs], programs), true);
});

test('rejects unknown simulation errors and 6001 outside the actual Jupiter instruction', () => {
  for (const index of [0, 1, 2, 5, 6, -1, 3.5, 7, '3']) {
    assert.equal(isJupiterSlippageFailure({ InstructionError: [index, { Custom: 6001 }] }, frame(), programs), false);
  }
  for (const error of [null, 'AccountNotFound', { InstructionError: [3, 'ProgramFailedToComplete'] },
    { InstructionError: [3, { Custom: '6001' }] }, { InstructionError: [3, { Custom: 6002 }] },
    { InstructionError: [3, { Custom: 6001, other: true }] }, { InstructionError: [3, { Custom: 6001 }, 3] }]) {
    assert.equal(isJupiterSlippageFailure(error, frame(), programs), false);
  }
});

test('rejects propagated CPI errors, truncated, incomplete, spoofed or unknown runtime evidence', () => {
  const nestedFailure = (child: string) => [`Program ${child} invoke [2]`, `Program ${child} failed: custom program error: 0x1771`];
  const badLogs = [null, undefined, [], [`Program ${JUPITER} failed: custom program error: 0x1771`],
    frame(nestedFailure(token)), frame(nestedFailure(JUPITER)), frame(['Log truncated']),
    frame([`Program ${token} invoke [2]`, `Program log: Program ${token} success`]),
    frame([`Program ${token} invoke [2]`, `Program ${ata} success`]), frame([`Program ${token} invoke [4]`]),
    frame(['unexpected runtime line']), [`Program log: Program ${JUPITER} invoke [1]`, frame()[1]],
    [`Program ${JUPITER} invoke [1]`, `Program log: Program ${JUPITER} failed: custom program error: 0x1771`],
    [`Program ${token} invoke [1]`, `Program ${token} failed: custom program error: 0x1771`],
    [`Program ${JUPITER} invoke [1]`, `Program ${JUPITER} failed: custom program error: 0x1772`]];
  for (const logs of badLogs) assert.equal(isJupiterSlippageFailure(failure, logs, programs), false);
});
