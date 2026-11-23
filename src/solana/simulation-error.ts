import type { Address } from '@solana/kit';
import { LIGHTHOUSE } from './guard.js';
import { JUPITER, KAMINO } from './protocol.js';

function instructionFailure(error: unknown, programs: readonly Address[]) {
  if (!error || typeof error !== 'object' || !('InstructionError' in error) || Object.keys(error).length !== 1) return;
  const tuple = error.InstructionError;
  if (!Array.isArray(tuple) || tuple.length !== 2) return;
  const [rawIndex, cause] = tuple;
  if (typeof rawIndex !== 'bigint' && typeof rawIndex !== 'number') return;
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= programs.length) return;
  return { index, cause };
}

const knownErrors = new Set([
  'AccountInUse', 'AccountNotFound', 'BlockhashNotFound', 'InsufficientFundsForFee', 'AddressLookupTableNotFound',
  'InsufficientFunds', 'ComputationalBudgetExceeded', 'ProgramFailedToComplete', 'ProgramFailedToCompile',
  'InvalidAccountData', 'InvalidInstructionData', 'InvalidArgument', 'IncorrectProgramId', 'MissingAccount',
  'MissingRequiredSignature', 'NotEnoughAccountKeys', 'PrivilegeEscalation', 'ArithmeticOverflow', 'AccountBorrowFailed',
]);

// RPC log payloads and free-form program messages do not belong in operator diagnostics.
export function describeSimulationFailure(error: unknown, logs: readonly string[] | null | undefined, programs: readonly Address[]) {
  const failure = instructionFailure(error, programs);
  if (!failure) {
    const reason = typeof error === 'string' && knownErrors.has(error) ? error : 'unclassified error';
    return { detail: `Atomic simulation failed: ${reason}`, returnSlippage: false };
  }
  const { index, cause } = failure;
  const program = programs[index];
  const entry = programs.indexOf(JUPITER);
  const exit = programs.lastIndexOf(JUPITER);
  const returnInstruction = entry >= 0 && exit === entry + 1 && index === exit;
  let role = `program ${program}`;
  if (program === JUPITER) role = returnInstruction ? 'Jupiter return' : 'Jupiter entry';
  else if (program === KAMINO) role = index < entry ? 'Kamino borrow' : 'Kamino repay';
  else if (program === LIGHTHOUSE) role = index > exit ? 'Lighthouse balance floor' : 'Lighthouse precondition';
  else if (program === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') role = 'ATA setup';
  else if (program === 'ComputeBudget111111111111111111111111111111') role = 'compute budget';
  const code = cause && typeof cause === 'object' && Object.keys(cause).length === 1 ? cause.Custom : undefined;
  const validCode = (typeof code === 'number' || typeof code === 'bigint')
    && Number.isInteger(Number(code)) && code >= 0 && code <= 0xffffffff;
  // The two top-level Jupiter swaps are consecutive. Conflicting or incomplete logs cannot justify reusing the entry.
  const invoke = `Program ${JUPITER} invoke [1]`;
  const exitStart = Array.isArray(logs) ? logs.lastIndexOf(invoke) : -1;
  const entrySucceeded = Array.isArray(logs) && exitStart > 0 && logs[exitStart - 1] === `Program ${JUPITER} success`
    && logs.indexOf(invoke) < exitStart;
  const returnSlippage = returnInstruction && entrySucceeded && isJupiterSlippageFailure(error, logs, programs);
  const reason = returnSlippage ? 'slippage 6001' : validCode ? `custom ${code}` : knownErrors.has(cause) ? cause : 'unclassified error';
  return { detail: `Outer ix ${index} ${role}: ${reason}`, returnSlippage };
}

// A top-level Jupiter instruction can propagate a CPI's custom code. Accept 6001 only
// when its own runtime frame failed and every nested invocation returned successfully.
export function isJupiterSlippageFailure(error: unknown, logs: readonly string[] | null | undefined, programs: readonly Address[]): boolean {
  const failure = instructionFailure(error, programs);
  if (!failure) return false;
  const { index, cause } = failure;
  if (programs[index] !== JUPITER
    || !cause || typeof cause !== 'object' || Object.keys(cause).length !== 1
    || (cause.Custom !== 6001 && cause.Custom !== 6001n)
    || !Array.isArray(logs) || logs.some((line) => typeof line !== 'string' || line === 'Log truncated')
    || logs.at(-1) !== `Program ${JUPITER} failed: custom program error: 0x1771`) return false;

  // A failed CPI can propagate its custom code through Jupiter. Require all invoked children to have succeeded.
  const start = logs.lastIndexOf(`Program ${JUPITER} invoke [1]`);
  if (start < 0) return false;
  const nested: string[] = [];
  for (const line of logs.slice(start + 1, -1)) {
    if (/^Program (?:log:|data:|return:)/.test(line)
      || /^Program [1-9A-HJ-NP-Za-km-z]{32,44} consumed [0-9]+ of [0-9]+ compute units$/.test(line)) continue;
    const invocation = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
    if (invocation && Number(invocation[2]) === nested.length + 2) {
      nested.push(invocation[1]);
      continue;
    }
    if (!nested.length || line !== `Program ${nested.at(-1)} success`) return false;
    nested.pop();
  }
  return nested.length === 0;
}
