import { cashClosingBalance } from './cashbookBalanceMath.js';
/**
 * Company cashbook: Opening + Cash Receipts - Cash Payments = Cash in Hand.
 * DMS statement convention: CREDIT = cash IN, DEBIT = cash OUT.
 * Double-entry journal convention is different: SYS_CASH DR = in, CR = out.
 *
 * Only real, POSTED cash journals and system-CASH customer Sales Invoices
 * belong in this report. Cashier receipt journals appear only after day close;
 * a handover, an OTP, and a cashier's receipt are NOT company cashbook credits.
 * This is a read-only projection; it does not silently repair old journals.
 */
const money = value => Math.round((Number(value) || 0) * 100) / 100;
const upper = value => String(value || '').toUpperCase();
const same = (a, b) => Math.abs(money(a) - money(b)) < 0.005;
const keyOf = row => `${upper(row.transactionType)}\0${String(row.transactionId || row._id || '')}`;

export function buildCompanyCashbook({
  lines = [], payments = [], receipts = [], salesInvoices = [], cashPartyIds = [],
  openingBalance = 0, enforceSourceDocuments = false, closedCashierReceiptNos = null,
} = {}) {
  const paymentByNo = new Map(payments.map(item => [String(item.paymentNo), item]));
  const receiptByNo = new Map(receipts.map(item => [String(item.receiptNo), item]));
  const validCashParties = new Set(cashPartyIds.map(String));
  const closedCashierReceipts=Array.isArray(closedCashierReceiptNos)?new Set(closedCashierReceiptNos.map(String)):null;
  const invoices = new Map(salesInvoices.filter(inv =>
    ['POSTED','COMPLETED'].includes(upper(inv.status)) && upper(inv.invoiceType) !== 'PERFORMA' &&
    validCashParties.has(String(inv.customerGlobalId)) && money(inv.grandTotal) > 0
  ).map(inv => [String(inv.invoiceNo), inv]));
  const groups = new Map();
  for (const line of lines) {
    const id = String(line.transactionId || line._id || '');
    const key = keyOf(line);
    let row = groups.get(key);
    if (!row) {
      row = { _id: String(line._id), transactionId: id, transactionType: line.transactionType || '',
        date: line.date, createdAt: line.createdAt, partyGlobalId: line.partyGlobalId || '',
        remarks: line.narration || '', journalDebit: 0, journalCredit: 0, count: 0 };
      groups.set(key, row);
    }
    row.journalDebit = money(row.journalDebit + Number(line.debit || 0));
    row.journalCredit = money(row.journalCredit + Number(line.credit || 0));
    row.count++;
  }
  // A posted Sales Invoice of the genuine system-CASH party is a cash sale,
  // even if a legacy invoice is missing its SYS_CASH posting. Mark such cases
  // provisional instead of silently losing the sale or double-counting it.
  if (enforceSourceDocuments) for (const invoice of invoices.values()) {
    const key = `SALES_INVOICE\0${String(invoice.invoiceNo)}`;
    if (groups.has(key)) continue;
    groups.set(key, {
      _id: `MISSING-CASH-JOURNAL:${invoice._id || invoice.invoiceNo}`,
      transactionId: String(invoice.invoiceNo), transactionType: 'SALES_INVOICE',
      date: invoice.date, createdAt: invoice.createdAt,
      partyGlobalId: invoice.customerGlobalId, remarks: 'System CASH customer sales invoice',
      journalDebit: 0, journalCredit: 0, count: 0, missingCashJournal: true,
    });
  }
  if (enforceSourceDocuments) {
    // A posted direct CASH voucher with a lost journal is not silently hidden.
    // Show it once as a PROVISIONAL source projection so accounting can repair
    // the missing balanced posting. Unposted collector receipts stay excluded.
    for (const receipt of receipts) {
      if (upper(receipt.status) !== 'POSTED' || upper(receipt.mode) !== 'CASH' || !(money(receipt.amount) > 0)) continue;
      if (receipt.collectionSource === 'SALESPERSON_APP' &&
        (!receipt.ledgerPostedAt || (closedCashierReceipts && !closedCashierReceipts.has(String(receipt.receiptNo))))) continue;
      const key = `RECEIPT\0${String(receipt.receiptNo)}`;
      if (groups.has(key)) continue;
      groups.set(key, { _id:`MISSING-CASH-JOURNAL:${receipt._id || receipt.receiptNo}`,
        transactionId:String(receipt.receiptNo),transactionType:'RECEIPT',date:receipt.date,
        createdAt:receipt.createdAt,partyGlobalId:receipt.customerGlobalId || '',
        remarks:receipt.remarks || '',journalDebit:0,journalCredit:0,count:0,missingCashJournal:true });
    }
    for (const payment of payments) {
      if (upper(payment.status) !== 'POSTED' || upper(payment.mode) !== 'CASH' || !(money(payment.amount) > 0)) continue;
      const key = `PAYMENT\0${String(payment.paymentNo)}`;
      if (groups.has(key)) continue;
      groups.set(key, { _id:`MISSING-CASH-JOURNAL:${payment._id || payment.paymentNo}`,
        transactionId:String(payment.paymentNo),transactionType:'PAYMENT',date:payment.date,
        createdAt:payment.createdAt,partyGlobalId:'',remarks:payment.remarks || '',
        journalDebit:0,journalCredit:0,count:0,missingCashJournal:true });
    }
  }
  let running = money(openingBalance), journalBalance = money(openingBalance);
  const sorted = [...groups.values()].sort((a,b) => new Date(a.date) - new Date(b.date) ||
    new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || a.transactionId.localeCompare(b.transactionId));
  const rows = [], issues = [];
  for (const row of sorted) {
    const originalNet = money(row.journalDebit - row.journalCredit);
    journalBalance = money(journalBalance + originalNet);
    const kind = upper(row.transactionType);
    const payment = paymentByNo.get(row.transactionId), receipt = receiptByNo.get(row.transactionId);
    const invoice = invoices.get(row.transactionId);
    const selfOffset = row.journalDebit > 0.005 && row.journalCredit > 0.005;
    const validPayment = payment && upper(payment.mode) === 'CASH' && upper(payment.status) === 'POSTED' && money(payment.amount) > 0;
    const validReceipt = receipt && upper(receipt.mode) === 'CASH' && upper(receipt.status) === 'POSTED' && money(receipt.amount) > 0;
    let debit = 0, credit = 0, issue = '', category = 'CASH_ADJUSTMENT';
    let particular = row.remarks || row.partyGlobalId || row.transactionId;
    if (kind === 'SALES_INVOICE' || kind === 'CASH_SALE') {
      category = 'CASH_SALE';
      particular = "Cash Sale";
      if (enforceSourceDocuments && !invoice) {
        issue = 'Invoice is not a posted sale of the system-managed CASH customer; cash posting requires reconciliation';
        category = 'REVIEW';
      } else if (row.missingCashJournal) {
        credit = money(invoice.grandTotal);
        issue = 'CASH sales invoice missing its posted SYS_CASH journal; projected sale requires accounting repair';
      } else if (originalNet < -0.005 || selfOffset || (invoice && !same(invoice.grandTotal, originalNet))) {
        issue = 'Cash sales invoice amount/direction differs from posted cash journal';
        category = 'REVIEW';
      } else { credit = Math.max(0, originalNet); }
    } else if (kind === 'RECEIPT') {
      category = receipt?.collectionSource === 'SALESPERSON_APP' ? 'CASHIER_RECEIPT' : 'CASH_RECEIPT';
      // Keep the operator/imported narration as the primary particulars.
      // Voucher classification and party already have their own columns.
      particular = String(receipt?.remarks || '').trim() || String(row.remarks || '').trim() ||
        String(receipt?.partyNameSnapshot || row.partyGlobalId || row.transactionId);
      if (enforceSourceDocuments && !validReceipt) {
        issue = 'Receipt was deleted, voided, or is not a posted CASH receipt; reconcile its orphan journal'; category = 'REVIEW';
      } else if (row.missingCashJournal && validReceipt) {
        credit = money(receipt.amount); issue = 'Posted CASH receipt missing its cash journal; provisional until accounting repair';
      } else if (selfOffset && validReceipt && same(row.journalDebit, receipt.amount) && same(row.journalCredit, receipt.amount)) {
        credit = money(receipt.amount); issue = 'Legacy receipt debits and credits Cash-in-Hand; journal repair required';
      } else if (validReceipt && (selfOffset || originalNet < -0.005 || !same(receipt.amount, originalNet))) {
        // A valid POSTED receipt is incoming cash even when a legacy journal
        // has the wrong SYS_CASH direction. Do not treat it as a payment or
        // reverse its visible balance. Flag its journal for correction.
        credit = money(receipt.amount);
        issue = 'Cash receipt source differs from its posted SYS_CASH journal; repair journal direction/amount';
      } else if (selfOffset || originalNet < -0.005) {
        issue = 'Cash receipt journal has the wrong direction; verify original receipt'; category = 'REVIEW';
      } else credit = Math.max(0,originalNet);
      if (validReceipt && receipt.collectionSource === 'SALESPERSON_APP' &&
        (!receipt.ledgerPostedAt || (closedCashierReceipts && !closedCashierReceipts.has(String(receipt.receiptNo))))) {
        issue = 'Collector cash was not confirmed by a posted Cashier Day Close; reconcile premature cash journal';
        category = 'REVIEW'; credit = 0;
      }
    } else if (kind === 'PAYMENT') {
      category = 'CASH_PAYMENT';
      particular = String(payment?.remarks || '').trim() || String(row.remarks || '').trim() ||
        String(payment?.partyNameSnapshot || row.partyGlobalId || row.transactionId);
      if (enforceSourceDocuments && !validPayment) {
        issue = 'Payment was deleted, voided, or is not a posted CASH payment; reconcile its orphan journal'; category = 'REVIEW';
      } else if (row.missingCashJournal && validPayment) {
        debit = money(payment.amount); issue = 'Posted CASH payment missing its cash journal; provisional until accounting repair';
      } else if (selfOffset && validPayment && same(row.journalDebit,payment.amount) && same(row.journalCredit,payment.amount)) {
        debit = money(payment.amount); issue = 'Legacy payment debits and credits Cash-in-Hand; journal repair required';
      } else if (validPayment && (selfOffset || originalNet > 0.005 || !same(payment.amount,-originalNet))) {
        // The original POSTED CASH payment authoritatively denotes cash OUT.
        // An incorrectly debited SYS_CASH journal must NEVER make cash rise.
        // Preserve the original journal in the accounting integrity report.
        debit = money(payment.amount);
        issue = 'Cash payment source differs from its posted SYS_CASH journal; repair journal direction/amount';
      } else if (selfOffset || originalNet > 0.005) {
        issue = 'Cash payment journal has the wrong direction; verify original payment'; category = 'REVIEW';
      } else debit = Math.max(0,-originalNet);
    } else if (kind === 'CONTRA' || kind === 'SALESPERSON_BANK_DEPOSIT' ||
      kind === 'BANK_CASH_WITHDRAWAL' || kind === 'CASH_BANK_DEPOSIT') {
      if (selfOffset) { issue = 'Contra incorrectly moves cash in both directions; reconcile'; category = 'REVIEW'; }
      else if (originalNet >= 0.005) { credit = originalNet; category = 'CONTRA_IN'; particular = row.remarks || 'Bank to Cash · Withdrawal'; }
      else if (originalNet <= -0.005) { debit = -originalNet; category = 'CONTRA_OUT'; particular = row.remarks || 'Cash to Bank · Deposit'; }
    } else if (kind === 'PURCHASE_INVOICE' || kind === 'CASH_PURCHASE') {
      category = 'CASH_PAYMENT'; particular = "Cash Purchase";
      if (selfOffset || originalNet > 0.005) { issue = 'Cash purchase journal has invalid direction; reconcile'; category = 'REVIEW'; }
      else debit = Math.max(0,-originalNet);
    } else {
      category = originalNet >= 0 ? 'CASH_ADJUSTMENT_IN' : 'CASH_ADJUSTMENT_OUT';
      particular = row.remarks || `${originalNet >= 0 ? 'Other Cash Receipt' : 'Other Cash Payment'} · ${row.transactionId}`;
      if (selfOffset) { issue = 'Cash journal debits and credits itself; reconcile'; category = 'REVIEW'; }
      else if (originalNet > 0.005) credit = originalNet;
      else if (originalNet < -0.005) debit = -originalNet;
    }
    if (issue) issues.push({ transactionId:row.transactionId, transactionType:kind, message:issue });
    running = cashClosingBalance(running, { debit, credit });
    rows.push({ ...row, particular, category, debit:money(debit), credit:money(credit), runningBalance:running,
      cashNetMovement:money(credit-debit), journalNetMovement:originalNet,
      journalCorrectionPending:Boolean(issue), needsCorrection:Boolean(issue), correctionMessage:issue,
      voucherKind:kind === 'PAYMENT' && validPayment && !payment.statementImportId ? 'payments' :
        kind === 'RECEIPT' && validReceipt && !receipt.statementImportId && receipt.receiptWorkflowStatus === 'DMS_DIRECT' ? 'receipts' : '',
      voucherId:kind === 'PAYMENT' && validPayment ? String(payment._id || '') :
        kind === 'RECEIPT' && validReceipt && receipt.receiptWorkflowStatus === 'DMS_DIRECT' ? String(receipt._id || '') : '',
      partyName:payment?.partyNameSnapshot || receipt?.partyNameSnapshot || invoice?.customerNameSnapshot || '',
      remarks:row.remarks || payment?.remarks || receipt?.remarks || '',
      type:credit > 0 ? 'RECEIPT' : debit > 0 ? 'PAYMENT' : 'REVIEW' });
  }
  const totals = rows.reduce((summary,row) => {
    const label = row.category;
    const previous = summary[label] || {count:0,received:0,paid:0};
    summary[label] = {count:previous.count+1,received:money(previous.received+row.credit),paid:money(previous.paid+row.debit)};
    return summary;
  },{});
  return { rows, issues, categoryTotals:totals, closingBalance:running,
    journalClosingBalance:journalBalance, provisional:issues.length > 0 || !same(running,journalBalance) };
}
