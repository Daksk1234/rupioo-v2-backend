/**
 * Bank-book (statement) balances use the BANK's movement convention:
 * CREDIT = money IN, DEBIT = money OUT.
 * Thus positive = CR and negative = DR (overdraft), independent of the
 * double-entry journal convention in which a bank asset increases by debit.
 */
export const bankStatementOpening = ({ amount = 0, type = 'CR' } = {}) => {
  const value = Math.abs(Number(amount) || 0);
  return String(type).toUpperCase() === 'DR' ? -value : value;
};
export const bankStatementNext = (previous, debit = 0, credit = 0) =>
  Math.round((Number(previous || 0) - Number(debit || 0) + Number(credit || 0) + Number.EPSILON) * 100) / 100;
export const bankStatementSide = value => Number(value || 0) < 0 ? 'Dr' : 'Cr';

/** Bank-to-bank transfer movements, never a customer receipt/payment. */
export function bankTransferMovement(transfer, bankAccountId) {
  const id = String(bankAccountId || '');
  if (id === String(transfer.fromBankAccountId || '')) return { debit: Number(transfer.amount || 0), credit: 0 };
  if (id === String(transfer.toBankAccountId || '')) return { debit: 0, credit: Number(transfer.amount || 0) };
  throw new Error('Transfer does not belong to this bank account');
}
