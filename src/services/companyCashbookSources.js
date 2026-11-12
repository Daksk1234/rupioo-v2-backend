/**
 * Cashbook source projection for one financial year.
 * The customer master carrying systemKey=CASH is the ONLY CASH-sale customer.
 * Merely having a paymentType of CASH does not turn a credit customer's invoice
 * into a cash sale. All other cash inflows/outflows come from posted SYS_CASH
 * journals (including Cashier day-close and genuine Cash/Bank contra).
 *
 * Read only: never inserts a receipt/journal and never changes FY balances.
 */
import { CustomerLink } from '../models/index.js';
import { financialCollectionExists, financialModels } from './accountingService.js';

const upper = value => String(value || '').toUpperCase();
const unique = values => [...new Set(values.map(value => String(value || '')).filter(Boolean))];

export async function loadCompanyCashbookSources({ tenantKey, financialYear, lines = [] }) {
  const models = financialModels(tenantKey, financialYear);
  const paymentNos = unique(lines.filter(row => upper(row.transactionType) === 'PAYMENT').map(row => row.transactionId));
  const receiptNos = unique(lines.filter(row => upper(row.transactionType) === 'RECEIPT').map(row => row.transactionId));
  const cashParties = await CustomerLink.find({ tenantKey, systemKey: 'CASH', systemManaged: true })
    .select('globalCustomerId systemKey').lean();
  // The system-generated CASH globalCustomerId is authoritative; never match
  // normal customer names or paymentType=CASH.
  const cashPartyIds = unique(cashParties.map(party => party.globalCustomerId));
  const [paymentsExist, receiptsExist, salesExist] = await Promise.all([
    financialCollectionExists(tenantKey, financialYear, 'payments'),
    financialCollectionExists(tenantKey, financialYear, 'receipts'),
    cashPartyIds.length ? financialCollectionExists(tenantKey, financialYear, 'salesinvoices') : false,
  ]);
  const [payments, receipts, salesInvoices] = await Promise.all([
    paymentsExist ? models.Payment.find({tenantKey,financialYear,$or:[
      {mode:'CASH',status:'POSTED'},...(paymentNos.length?[{paymentNo:{$in:paymentNos}}]:[])]})
      .select('_id paymentNo partyNameSnapshot amount mode remarks status statementImportId sourceKey date createdAt').lean() : [],
    receiptsExist ? models.Receipt.find({tenantKey,financialYear,$or:[
      {mode:'CASH',status:'POSTED'},...(receiptNos.length?[{receiptNo:{$in:receiptNos}}]:[])]})
      .select('_id receiptNo customerGlobalId partyNameSnapshot amount mode remarks status statementImportId receiptWorkflowStatus collectionSource cashDepositStatus cashDepositBatchId ledgerPostedAt againstInvoices sourceKey date createdAt').lean() : [],
    salesExist ? models.SalesInvoice.find({ tenantKey, financialYear, customerGlobalId: { $in: cashPartyIds },
      status: { $in: ['POSTED', 'COMPLETED'] }, invoiceType: { $ne: 'PERFORMA' } })
      .select('_id invoiceNo customerGlobalId customerNameSnapshot status invoiceType grandTotal date createdAt').lean() : [],
  ]);
  // Physical collector custody and ledger posting are different events.
  // An OTP-verified receipt is NOT a company cashbook inflow until the handover
  // belongs to a POSTED cashier day close. Previously buggy early postings are
  // flagged as reconciliation items by the engine, not silently recognized.
  const cashCollectorReceipts=receipts.filter(r=>r.collectionSource==='SALESPERSON_APP' &&
    upper(r.mode)==='CASH' && r.ledgerPostedAt);
  const batchIds=unique(cashCollectorReceipts.map(r=>r.cashDepositBatchId))
    .filter(id=>/^[a-f\d]{24}$/i.test(id));
  const batches=batchIds.length?await models.SalespersonCashMovement.find({tenantKey,financialYear,
    type:'HANDOVER',status:'APPROVED',_id:{$in:batchIds}}).select('_id cashierCloseId receiptBreakdown.receiptId').lean():[];
  const closeIds=unique(batches.map(b=>b.cashierCloseId)).filter(id=>/^[a-f\d]{24}$/i.test(id));
  const postedClosings=closeIds.length?await models.SalespersonCashMovement.find({tenantKey,financialYear,
    type:'CASHIER_CLOSE',status:'POSTED',_id:{$in:closeIds}}).select('_id').lean():[];
  const closedIds=new Set(postedClosings.map(c=>String(c._id)));
  const postedBatches=new Map(batches.filter(b=>closedIds.has(String(b.cashierCloseId)))
    .map(b=>[String(b._id),new Set((b.receiptBreakdown||[]).map(r=>String(r.receiptId)))]));
  const closedCashierReceiptNos=cashCollectorReceipts.filter(r=>postedBatches.get(String(r.cashDepositBatchId))?.has(String(r._id)))
    .map(r=>String(r.receiptNo));
  return { payments, receipts, salesInvoices, cashPartyIds, closedCashierReceiptNos };
}
