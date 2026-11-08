import { financialModels } from "./accountingService.js";
import { canonicalBankType, inspectBankLedgerRows } from "./bankLedgerIntegrityService.js";

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const normalizeFY = (value) => {
  const raw = clean(value);
  const m = raw.match(/^(\d{4})\s*-\s*(\d{2}|\d{4})$/);
  return m ? `${m[1]}-${m[2].length === 4 ? m[2].slice(-2) : m[2]}` : raw;
};
const fyStart = (fy) => Number(normalizeFY(fy).split("-")[0]) || 0;
const fyLabel = (y) => `${y}-${String(y + 1).slice(-2)}`;
const keyOf = (type, id) => `${upper(canonicalBankType(type))}|${clean(id)}`;

async function currentYearRows({ tenantKey, financialYear, customerGlobalId }) {
  const fy = normalizeFY(financialYear);
  const { LedgerEntry, SalesInvoice, Receipt, CreditNote, BankStatementRow } = financialModels(tenantKey, fy);
  const raw = await LedgerEntry.find({
    tenantKey, financialYear: fy, partyGlobalId: customerGlobalId,
    accountCode: "SYS_SUNDRY_DEBTORS", status: "POSTED",
  }).sort({ date: 1, createdAt: 1 }).lean();
  const { rows: journalRows } = await inspectBankLedgerRows({ tenantKey, financialYear: fy, rows: raw });
  const seen = new Set(journalRows.map((r) => keyOf(r.transactionType, r.transactionId)));

  const [sales, receipts, creditNotes] = await Promise.all([
    SalesInvoice.find({ tenantKey, financialYear: fy, customerGlobalId, status: "POSTED" })
      .select("_id invoiceNo date grandTotal remarks createdAt").lean(),
    Receipt.find({ tenantKey, financialYear: fy, customerGlobalId, status: "POSTED", $or: [
        { collectionSource: { $ne: "SALESPERSON_APP" } },
        { ledgerPostedAt: { $exists: true } },
      ] })
      .select("_id receiptNo date amount remarks createdAt statementImportId").lean(),
    CreditNote.find({
      tenantKey, financialYear: fy, status: "ISSUED",
      $and: [
        { $or: [{ documentType: "CREDIT_NOTE" }, { documentType: { $exists: false } }] },
        { $or: [{ customerGlobalId }, { partyGlobalId: customerGlobalId }] },
      ],
    }).select("_id creditNoteNo documentNo date grandTotal reason remarks createdAt").lean(),
  ]);

  const bankReceiptNos = receipts.filter((r) => clean(r.statementImportId)).map((r) => clean(r.receiptNo));
  const bankRows = bankReceiptNos.length
    ? await BankStatementRow.find({ tenantKey, financialYear: fy, transactionId: { $in: bankReceiptNos } }).select("transactionId importId").lean()
    : [];
  const validBank = new Set(bankRows.map((r) => `${clean(r.transactionId)}|${clean(r.importId)}`));
  const fallback = [];

  for (const r of sales) {
    const k = keyOf("SALES_INVOICE", r.invoiceNo); if (seen.has(k)) continue; seen.add(k);
    fallback.push({ _id:`LEGACY-SALES-${r._id}`, tenantKey, financialYear:fy, date:r.date, createdAt:r.createdAt, transactionType:"SALES_INVOICE", transactionId:clean(r.invoiceNo), partyGlobalId:customerGlobalId, accountCode:"SYS_SUNDRY_DEBTORS", debit:money(r.grandTotal), credit:0, narration:clean(r.remarks)||`Sales Invoice ${clean(r.invoiceNo)}`, status:"POSTED", legacyFallback:true });
  }
  for (const r of receipts) {
    if (clean(r.statementImportId) && !validBank.has(`${clean(r.receiptNo)}|${clean(r.statementImportId)}`)) continue;
    const k = keyOf("RECEIPT", r.receiptNo); if (seen.has(k)) continue; seen.add(k);
    fallback.push({ _id:`LEGACY-RECEIPT-${r._id}`, tenantKey, financialYear:fy, date:r.date, createdAt:r.createdAt, transactionType:"RECEIPT", transactionId:clean(r.receiptNo), partyGlobalId:customerGlobalId, accountCode:"SYS_SUNDRY_DEBTORS", debit:0, credit:money(r.amount), narration:clean(r.remarks)||`Receipt ${clean(r.receiptNo)}`, status:"POSTED", legacyFallback:true });
  }
  for (const r of creditNotes) {
    const no = clean(r.documentNo || r.creditNoteNo);
    const k = keyOf("SALES_CREDIT_NOTE", no); if (!no || seen.has(k)) continue; seen.add(k);
    fallback.push({ _id:`LEGACY-CN-${r._id}`, tenantKey, financialYear:fy, date:r.date, createdAt:r.createdAt, transactionType:"SALES_CREDIT_NOTE", transactionId:no, partyGlobalId:customerGlobalId, accountCode:"SYS_SUNDRY_DEBTORS", debit:0, credit:money(r.grandTotal), narration:clean(r.remarks||r.reason)||`Credit Note ${no}`, status:"POSTED", legacyFallback:true });
  }
  return [...journalRows, ...fallback].sort((a,b) => {
    const ad=new Date(a.date||a.createdAt||0).getTime(), bd=new Date(b.date||b.createdAt||0).getTime();
    return ad===bd ? new Date(a.createdAt||0).getTime()-new Date(b.createdAt||0).getTime() : ad-bd;
  });
}

async function effectiveOpening({ tenantKey, financialYear, customer }) {
  const target = fyStart(financialYear);
  const profile = customer?.accountingProfile || {};
  const amount = Math.abs(num(profile.openingBalance));
  const signed = upper(profile.openingBalanceType) === "CR" ? -amount : amount;
  const baseFy = normalizeFY(profile.financialYear || "");
  if (!baseFy || !target) return signed;
  const base = fyStart(baseFy);
  if (!base || target < base) return 0;
  let opening = signed;
  for (let y = base; y < target; y += 1) {
    const rows = await currentYearRows({ tenantKey, financialYear: fyLabel(y), customerGlobalId: customer.globalCustomerId });
    opening += rows.reduce((sum, r) => sum + num(r.debit) - num(r.credit), 0);
  }
  return money(opening);
}

export async function buildCustomerReceivableLedger({ tenantKey, financialYear, customer }) {
  const fy = normalizeFY(financialYear);
  const [rows, openingSigned] = await Promise.all([
    currentYearRows({ tenantKey, financialYear: fy, customerGlobalId: customer.globalCustomerId }),
    effectiveOpening({ tenantKey, financialYear: fy, customer }),
  ]);
  let running = openingSigned;
  const withRunning = rows.map((r) => {
    running = money(running + num(r.debit) - num(r.credit));
    return { ...r, runningBalance: running, balanceType: running < 0 ? "CR" : "DR" };
  });
  const totalDebit = money(rows.reduce((s,r)=>s+num(r.debit),0));
  const totalCredit = money(rows.reduce((s,r)=>s+num(r.credit),0));
  return {
    financialYear: fy,
    rows: withRunning,
    openingSigned: money(openingSigned),
    closingSigned: money(running),
    totalDebit,
    totalCredit,
  };
}
