// Cashbook presentation helper. This is deliberately READ-ONLY: a voucher's
// description cannot change the journal nor the running balance.
const amount = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const equalMoney = (a, b) => Math.abs(amount(a) - amount(b)) < 0.005;

export function cashbookVoucherDisplay({transactionType, voucherNumber, journalDebit, journalCredit, payment, receipt}) {
  const debit = amount(journalDebit);
  const credit = amount(journalCredit);
  const needsCorrection = debit > 0 && credit > 0;
  const net = amount(debit - credit);
  const matchingPayment = needsCorrection && String(transactionType).toUpperCase() === "PAYMENT" &&
    payment && String(payment.paymentNo) === String(voucherNumber) &&
    String(payment.status).toUpperCase() === "POSTED" &&
    String(payment.mode).toUpperCase() === "CASH" &&
    !payment.statementImportId && amount(payment.amount) > 0 &&
    equalMoney(debit, payment.amount) && equalMoney(credit, payment.amount);
  if (matchingPayment) {
    return { needsCorrection:true, journalCorrectionPending:true, voucherDirection:"PAYMENT",
      payment:amount(payment.amount),receipt:0,expectedCashNetMovement:-amount(payment.amount) };
  }
  const matchingReceipt = needsCorrection && String(transactionType).toUpperCase() === "RECEIPT" &&
    receipt && String(receipt.receiptNo) === String(voucherNumber) &&
    String(receipt.status).toUpperCase() === "POSTED" &&
    String(receipt.mode).toUpperCase() === "CASH" &&
    !receipt.statementImportId && amount(receipt.amount) > 0 &&
    equalMoney(debit, receipt.amount) && equalMoney(credit, receipt.amount);
  if (matchingReceipt) {
    return { needsCorrection:true, journalCorrectionPending:true, voucherDirection:"RECEIPT",
      payment:0,receipt:amount(receipt.amount),expectedCashNetMovement:amount(receipt.amount) };
  }
  // Unmatched historical journal: show both recorded Cash sides as evidence,
  // rather than guessing a direction. Ordinary vouchers use net cash movement.
  return {needsCorrection,journalCorrectionPending:false,voucherDirection:null,
    payment:needsCorrection?credit:Math.max(0,-net),
    receipt:needsCorrection?debit:Math.max(0,net),
    expectedCashNetMovement:null};
}
