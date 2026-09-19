import { useDatabase, getFinancialYearDbName } from "../config/db.js";
import { fyModels } from "../models/fyModels.js";

export function financialModels(tenantKey, financialYear) {
  const db = useDatabase(getFinancialYearDbName(tenantKey, financialYear));
  return fyModels(db);
}

export async function postBalancedEntries({ tenantKey, financialYear, transactionId, transactionType, date, partyGlobalId, entries, narration }) {
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const debit = entries.reduce((s, e) => s + Number(e.debit || 0), 0);
  const credit = entries.reduce((s, e) => s + Number(e.credit || 0), 0);
  if (Math.abs(debit - credit) > 0.01) throw new Error(`Unbalanced accounting entry: debit ${debit}, credit ${credit}`);
  await LedgerEntry.insertMany(entries.map((e) => ({
    tenantKey, financialYear, transactionId, transactionType, date, partyGlobalId,
    accountCode: e.accountCode, ledgerId: e.ledgerId || "", bankAccountId: e.bankAccountId || "",
    debit: Number(e.debit || 0), credit: Number(e.credit || 0), narration: e.narration || narration, status: "POSTED"
  })));
}

export async function reversePostedTransaction({ tenantKey, financialYear, transactionId, reason = "Bulk cancellation" }) {
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const existing = await LedgerEntry.find({ tenantKey, financialYear, transactionId, status: "POSTED" }).lean();
  if (!existing.length) return { reversed: 0 };
  const reversalId = `REV-${transactionId}-${Date.now().toString(36).toUpperCase()}`;
  await LedgerEntry.insertMany(existing.map((e) => ({
    tenantKey,
    financialYear,
    transactionId: reversalId,
    transactionType: `${e.transactionType || "TXN"}_REVERSAL`,
    date: new Date(),
    partyGlobalId: e.partyGlobalId,
    accountCode: e.accountCode,
    ledgerId: e.ledgerId || "",
    bankAccountId: e.bankAccountId || "",
    debit: Number(e.credit || 0),
    credit: Number(e.debit || 0),
    narration: `${reason}: ${transactionId}`,
    status: "REVERSAL"
  })));
  await LedgerEntry.updateMany(
    { tenantKey, financialYear, transactionId, status: "POSTED" },
    { $set: { status: "REVERSED" } },
  );
  return { reversed: existing.length, reversalId };
}

export async function customerReceivableBalance({ tenantKey, financialYear, customerGlobalId }) {
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const [row] = await LedgerEntry.aggregate([
    { $match: { tenantKey, financialYear, partyGlobalId: customerGlobalId, accountCode: "SYS_SUNDRY_DEBTORS", status: "POSTED" } },
    { $group: { _id: null, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } }
  ]);
  return Number(row?.debit || 0) - Number(row?.credit || 0);
}
