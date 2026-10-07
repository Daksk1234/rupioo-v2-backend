import crypto from "crypto";
import { useDatabase, getFinancialYearDbName } from "../config/db.js";
import { fyModels } from "../models/fyModels.js";
import { isTenantMigrationActive } from "./tenantMigrationLock.js";
import { resolveFinancialStorageTenantKeySync } from "./financialStorageTenantService.js";

export function financialModels(tenantKey, financialYear) {
  if (isTenantMigrationActive(tenantKey)) {
    const error = new Error("Company GST/tenant migration is in progress. Retry this request after the migration completes.");
    error.status = 423;
    error.code = "TENANT_MIGRATION_RUNNING";
    throw error;
  }
  const physicalTenantKey = resolveFinancialStorageTenantKeySync(tenantKey);
  const db = useDatabase(getFinancialYearDbName(physicalTenantKey, financialYear));
  return fyModels(db);
}

// One transaction ID can have exactly one immutable, balanced journal posting.
// Identical retries return the existing lines; changed retries are rejected.
export async function postBalancedEntries({ tenantKey, financialYear, transactionId, transactionType, date, partyGlobalId, entries, narration }) {
  const { LedgerEntry } = financialModels(tenantKey, financialYear);
  const transaction = String(transactionId || "").trim();
  if (!transaction || !String(transactionType || "").trim()) throw new Error("Ledger posting requires transaction ID and type");
  if (!Array.isArray(entries) || entries.length < 2) throw new Error("At least two balanced journal lines are required");
  const prepared = entries.map((e, lineNo) => {
    const debit = Number(e.debit || 0), credit = Number(e.credit || 0);
    if (!String(e.accountCode || "").trim() || !Number.isFinite(debit) || !Number.isFinite(credit)
      || debit < 0 || credit < 0 || (debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw new Error(`Invalid journal line ${lineNo + 1}`);
    }
    return {
      tenantKey, financialYear, transactionId: transaction, transactionType, date, partyGlobalId,
      accountCode: e.accountCode, ledgerId: e.ledgerId || "", bankAccountId: e.bankAccountId || "",
      debit, credit, narration: e.narration || narration, status: "POSTED",
      postingKey: crypto.createHash("sha256").update(
        JSON.stringify([tenantKey, financialYear, transaction, transactionType, lineNo]),
      ).digest("hex"),
    };
  });
  const totalDebit = prepared.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = prepared.reduce((sum, e) => sum + e.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Unbalanced accounting entry: debit ${totalDebit}, credit ${totalCredit}`);
  }
  // Ensure the database-level uniqueness index is built before accepting posts.
  await LedgerEntry.init();

  // IMPORTANT FOR EDITS:
  // A legitimate invoice edit first reverses its old POSTED journal. Those old
  // rows remain in the ledger as REVERSED audit history and must NOT block the
  // corrected journal from being posted under the same transaction number.
  // Older builds also left postingKey on REVERSED rows, which can collide with
  // the deterministic key of the corrected posting. Archive/release those keys
  // before checking the currently active journal.
  const inactiveWithPostingKey = await LedgerEntry.find({
    tenantKey,
    financialYear,
    transactionId: transaction,
    status: { $ne: "POSTED" },
    postingKey: { $exists: true, $type: "string" },
  }).select("_id postingKey archivedPostingKey").lean();
  if (inactiveWithPostingKey.length) {
    await LedgerEntry.bulkWrite(
      inactiveWithPostingKey.map((old) => ({
        updateOne: {
          filter: { _id: old._id, status: { $ne: "POSTED" } },
          update: {
            $set: { archivedPostingKey: old.archivedPostingKey || old.postingKey || "" },
            $unset: { postingKey: "" },
          },
        },
      })),
      { ordered: false },
    );
  }

  // Duplicate protection applies only to the ACTIVE posting. Reversed history
  // is intentionally retained for audit and is not a duplicate.
  const existing = await LedgerEntry.find({
    tenantKey,
    financialYear,
    transactionId: transaction,
    status: "POSTED",
  }).lean();
  if (existing.length) {
    const same = existing.length === prepared.length && prepared.every((line) =>
      existing.some((old) =>
        old.transactionType === line.transactionType
        && new Date(old.date || 0).getTime() === new Date(line.date || 0).getTime()
        && String(old.narration || "") === String(line.narration || "")
        && String(old.partyGlobalId || "") === String(line.partyGlobalId || "")
        && String(old.accountCode || "") === String(line.accountCode || "")
        && String(old.ledgerId || "") === String(line.ledgerId || "")
        && String(old.bankAccountId || "") === String(line.bankAccountId || "")
        && Math.abs(Number(old.debit || 0) - line.debit) < 0.005
        && Math.abs(Number(old.credit || 0) - line.credit) < 0.005));
    if (same) return existing; // retry did not create another debit/credit pair
    const error = new Error(`Transaction ${transaction} already has ACTIVE ledger entries. Reconcile it before posting again.`);
    error.statusCode = 409;
    throw error;
  }
  try {
    return await LedgerEntry.insertMany(prepared, { ordered: true });
  } catch (error) {
    if (error?.code === 11000) {
      const conflict = new Error(`Transaction ${transaction} has already been posted. Duplicate journal posting prevented.`);
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
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
  // Preserve the old posting key for audit but release the unique active key.
  // This is what allows a legitimate invoice edit to post corrected ledger
  // lines under the SAME invoice number without weakening duplicate protection.
  await LedgerEntry.bulkWrite(
    existing.map((e) => ({
      updateOne: {
        filter: { _id: e._id, status: "POSTED" },
        update: {
          $set: {
            status: "REVERSED",
            archivedPostingKey: e.archivedPostingKey || e.postingKey || "",
          },
          $unset: { postingKey: "" },
        },
      },
    })),
    { ordered: false },
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
