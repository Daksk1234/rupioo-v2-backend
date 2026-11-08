// Deletion eligibility for Company Received. These checks apply to both the
// combined register's action metadata and the DELETE endpoint. Never delete an
// original customer-OTP receipt or a ledger/bank posting via cheque control.
import { isCustodyPending } from './receivedChequeRules.js';

const filled = value => String(value ?? '').trim().length > 0;

export function receivedChequeDeleteBlocker(row = {}) {
  if (row.entryType === 'ONLINE') {
    return 'This online payment is an original customer receipt. Delete is blocked because the receipt/ledger posting must first be reversed through the accounting workflow.';
  }
  if (row.status === 'NEEDS_REGISTRATION' || String(row.id || '').startsWith('unlinked:')) {
    return 'This cheque row comes from an original customer receipt. Fix its missing cheque registration; do not delete the source receipt from Cheque Control.';
  }
  if (row.receiptBacked || filled(row.linkedReceiptNo) || row.collectionLinked) {
    return 'This cheque is linked to a customer receipt. Delete is blocked to protect the receipt and ledger audit trail. Correct/reverse the original receipt through accounting approval.';
  }
  if ([row.linkedBankTransactionId, row.ledgerTransactionId, row.bounceChargeTransactionId, row.reversalTransactionId].some(filled)
      || ['POSTED', 'LINKED', 'ORIGINAL_RECEIPT_POSTED'].includes(String(row.ledgerStatus || '').toUpperCase())) {
    return 'This cheque has a bank or ledger posting. Correct/reverse its accounting transaction before removing the control entry.';
  }
  if (['DEPOSITED', 'REDEPOSITED', 'CLEARED', 'BOUNCED', 'RETURNED'].includes(String(row.status || '').toUpperCase())) {
    return 'This cheque has already been deposited or processed and cannot be deleted. Use the cheque status/accounting correction workflow.';
  }
  if (isCustodyPending(row.status)) {
    return 'This cheque is in a salesperson/collector custody or OTP handover stage. Complete/cancel the custody workflow before deletion.';
  }
  return '';
}
