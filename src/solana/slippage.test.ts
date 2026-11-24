import assert from 'node:assert/strict';
import { test } from 'node:test';
import { address } from '@solana/kit';
import { LIGHTHOUSE } from './guard.js';
import { JUPITER, KAMINO } from './protocol.js';
import { describeSimulationFailure } from './simulation-error.js';
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

const entrySuccess = [`Program ${JUPITER} invoke [1]`, `Program ${JUPITER} success`];
const return6030 = { InstructionError: [4, { Custom: 6030 }] };
const plain6030 = 'Outer ix 4 Jupiter return: custom 6030';
const failed = (program: string, hex = '178e') => `Program ${program} failed: custom program error: 0x${hex}`;
const failingReturn = (nested: string[] = []) => [
  ...entrySuccess, `Program ${JUPITER} invoke [1]`, ...nested, failed(JUPITER),
];

test('attributes custom 6030 to the deepest program that failed and propagated it through the Jupiter return', () => {
  const cases = [
    { origin: JUPITER, logs: failingReturn([`Program ${ata} invoke [2]`, `Program ${ata} success`]) },
    { origin: ata, logs: failingReturn([`Program ${ata} invoke [2]`, failed(ata)]) },
    { origin: token, logs: failingReturn([
      `Program ${ata} invoke [2]`, `Program ${token} invoke [3]`, 'Program log: Instruction: Transfer',
      `Program ${token} consumed 4900 of 41000 compute units`, failed(token),
      `Program ${ata} consumed 5100 of 42000 compute units`, failed(ata),
    ]) },
  ];
  for (const { origin, logs } of cases) {
    assert.deepEqual(describeSimulationFailure(return6030, logs, programs), {
      detail: `${plain6030} (origin ${origin})`, returnSlippage: false, origin,
    });
  }
});

test('keeps the outer custom 6030 when runtime evidence is ambiguous or incomplete', () => {
  const cases = {
    missing: undefined,
    missingEntry: [`Program ${JUPITER} invoke [1]`, failed(JUPITER)],
    noInvoke: [...entrySuccess, failed(JUPITER)],
    incompleteEntry: [entrySuccess[0], `Program ${ata} invoke [2]`, entrySuccess[1],
      `Program ${JUPITER} invoke [1]`, failed(JUPITER)],
    unmatchedChild: failingReturn([`Program ${ata} invoke [2]`]),
    mismatchedProgram: failingReturn([`Program ${ata} invoke [2]`, failed(token)]),
    mismatchedDepth: failingReturn([`Program ${token} invoke [3]`, failed(token)]),
    spoofedChildFailure: failingReturn([`Program ${ata} invoke [2]`, `Program log: ${failed(ata)}`]),
    spoofedOuterFailure: [...entrySuccess, `Program ${JUPITER} invoke [1]`, `Program log: ${failed(JUPITER)}`],
    multilineSpoof: failingReturn([`Program log: Instruction: Transfer\n${failed(token)}`]),
    invalidAddress: failingReturn([`Program ${'z'.repeat(44)} invoke [2]`, failed('z'.repeat(44))]),
    truncated: failingReturn(['Log truncated']),
    recoveredChild: failingReturn([
      `Program ${ata} invoke [2]`, failed(ata), `Program ${token} invoke [2]`, `Program ${token} success`,
    ]),
    translatedChild: failingReturn([`Program ${ata} invoke [2]`, failed(ata, '1771')]),
    wrongFinalCode: [...entrySuccess, `Program ${JUPITER} invoke [1]`, failed(JUPITER, '1771')],
  };
  for (const [label, logs] of Object.entries(cases)) {
    assert.deepEqual(describeSimulationFailure(return6030, logs, programs),
      { detail: plain6030, returnSlippage: false }, label);
  }
});

test('preserves the verified 6001 return detail and requires an independent successful entry for return slippage', () => {
  const return6001 = { InstructionError: [4n, { Custom: 6001n }] };
  assert.deepEqual(describeSimulationFailure(return6001, [...entrySuccess, ...frame()], programs),
    { detail: 'Outer ix 4 Jupiter return: slippage 6001', returnSlippage: true });
  assert.equal(describeSimulationFailure(return6001, frame(), programs).returnSlippage, false);
  assert.equal(describeSimulationFailure(return6001,
    [...entrySuccess, ...frame([`Program ${token} invoke [2]`, failed(token, '1771')])], programs).returnSlippage, false);
});
