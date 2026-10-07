import { financialModels } from "./accountingService.js";

const clean = (value) => String(value ?? "").trim();
const bankTypes = new Set(["RECEIPT", "PAYMENT", "BANK_STATEMENT_RECEIPT", "BANK_STATEMENT_PAYMENT"]);
export const canonicalBankType = (type) => {
  const value = clean(type).toUpperCase();
  return value === "BANK_STATEMENT_RECEIPT" ? "RECEIPT"
    : value === "BANK_STATEMENT_PAYMENT" ? "PAYMENT" : value;
};
export const bankStatementIdentity = (bank, row) => JSON.stringify([
  clean(bank), new Date(row.date).toISOString().slice(0, 10),
  clean(row.remarks).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim(),
  Number(row.debit || 0).toFixed(2), Number(row.credit || 0).toFixed(2),
  Number(row.runningBalance || 0).toFixed(2),
]);
export const bankLineIdentity = (row) => JSON.stringify([
  canonicalBankType(row.transactionType), clean(row.transactionId), clean(row.partyGlobalId),
  clean(row.accountCode), clean(row.ledgerId), clean(row.bankAccountId),
  Number(row.debit || 0).toFixed(2), Number(row.credit || 0).toFixed(2),
]);

// Keep the source document as the authority. Never synthesize posted journal
// entries from orphaned ledger rows after a document is removed in the DB.
export async function inspectBankLedgerRows({ tenantKey, financialYear, rows }) {
  const sourceRows = rows.filter((row) => bankTypes.has(clean(row.transactionType).toUpperCase()));
  if (!sourceRows.length) return { rows, duplicateIds: [], orphanIds: [], inconsistentIds: [] };
  const { Receipt, Payment, BankStatementRow } = financialModels(tenantKey, financialYear);
  const receiptIds = [...new Set(sourceRows.filter((r) => canonicalBankType(r.transactionType) === "RECEIPT").map((r) => clean(r.transactionId)).filter(Boolean))];
  const paymentIds = [...new Set(sourceRows.filter((r) => canonicalBankType(r.transactionType) === "PAYMENT").map((r) => clean(r.transactionId)).filter(Boolean))];
  const [receipts, payments, statementRows] = await Promise.all([
    receiptIds.length ? Receipt.find({ tenantKey, financialYear, receiptNo: { $in: receiptIds } }).sort({createdAt:1,_id:1}).lean() : [],
    paymentIds.length ? Payment.find({ tenantKey, financialYear, paymentNo: { $in: paymentIds } }).sort({createdAt:1,_id:1}).lean() : [],
    BankStatementRow.find({ tenantKey, financialYear, transactionId: { $in: [...receiptIds, ...paymentIds] } })
      .select("transactionId bankAccountId importId date remarks debit credit runningBalance")
      .sort({ createdAt: 1, _id: 1 }).lean(),
  ]);
  const receiptMap=new Map(),paymentMap=new Map();
  for(const row of receipts)if(!receiptMap.has(clean(row.receiptNo)))receiptMap.set(clean(row.receiptNo),row);
  for(const row of payments)if(!paymentMap.has(clean(row.paymentNo)))paymentMap.set(clean(row.paymentNo),row);
  const statementMap = new Map(statementRows.map((row) => [clean(row.transactionId), row]));
  const firstTransactionByStatement = new Map();
  for (const statement of statementRows) {
    const identity = bankStatementIdentity(statement.bankAccountId, statement);
    if (!firstTransactionByStatement.has(identity)) firstTransactionByStatement.set(identity, clean(statement.transactionId));
  }
  const seen = new Set(), accepted = [], duplicateIds = [], orphanIds = [], inconsistentIds = [];
  for (const row of rows) {
    if (!bankTypes.has(clean(row.transactionType).toUpperCase())) { accepted.push(row); continue; }
    const type = canonicalBankType(row.transactionType), id = clean(row.transactionId);
    const source = type === "RECEIPT" ? receiptMap.get(id) : paymentMap.get(id);
    if (!source || ["DELETED", "CANCELLED", "REVERSED"].includes(clean(source.status).toUpperCase())) {
      orphanIds.push(row._id); continue;
    }
    const postedViaBank = clean(row.transactionType).toUpperCase().startsWith("BANK_STATEMENT_") || clean(source.statementImportId);
    const statement = statementMap.get(id);
    if (postedViaBank && (!statement || (clean(source.statementImportId) && clean(statement.importId) !== clean(source.statementImportId)))) {
      inconsistentIds.push(row._id); continue;
    }
    if (postedViaBank && statement
      && firstTransactionByStatement.get(bankStatementIdentity(statement.bankAccountId, statement)) !== id) {
      duplicateIds.push(row._id); continue;
    }
    const expectedParty = type === "RECEIPT" ? clean(source.customerGlobalId) : clean(source.partyGlobalId);
    const amount = Number(source.amount || 0);
    const expectedBank = clean(source.bankAccountId);
    const amountMatches = Number.isFinite(amount) && (Math.abs(Number(row.debit || 0) - amount) < 0.005
      || Math.abs(Number(row.credit || 0) - amount) < 0.005);
    if (!amountMatches || clean(row.partyGlobalId) !== expectedParty
      || (clean(row.bankAccountId) && expectedBank && clean(row.bankAccountId) !== expectedBank)) {
      inconsistentIds.push(row._id); continue;
    }
    const signature = bankLineIdentity(row);
    if (seen.has(signature)) { duplicateIds.push(row._id); continue; }
    seen.add(signature); accepted.push(row);
  }
  return { rows: accepted, duplicateIds, orphanIds, inconsistentIds };
}
