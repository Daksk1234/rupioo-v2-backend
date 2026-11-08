/**
 * CASH page DISPLAY convention (not the debit/credit sides of SYS_CASH journals):
 *  - Debit = cash paid OUT (subtract)
 *  - Credit = cash received IN (add)
 * A cash balance is a signed number. Do not use Math.abs() on running balances.
 * Calculations use integer paise to avoid accumulated floating-point drift.
 */
export const cashPaise = value => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) throw new Error('Invalid cashbook amount');
  return Math.round(n * 100);
};

export const cashAmount = value => cashPaise(value) / 100;

export function cashMovement({ debit = 0, credit = 0 } = {}) {
  return (cashPaise(credit) - cashPaise(debit)) / 100;
}

export function cashClosingBalance(openingBalance, { debit = 0, credit = 0 } = {}) {
  return (cashPaise(openingBalance) + cashPaise(credit) - cashPaise(debit)) / 100;
}
