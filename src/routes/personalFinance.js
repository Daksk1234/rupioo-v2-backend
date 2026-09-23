import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { financialYearFromDate } from "../utils/financialYear.js";
import { canPageAction } from "../config/permissionPageMap.js";
import { saveUploadedFile } from "../services/storageService.js";
import { extractWithOpenAI } from "../services/documentAiService.js";
import {
  PersonalAssessee,
  PersonalBankAccount,
  PersonalLedger,
  PersonalJournal,
  PersonalBankFeed,
  PersonalAiRule,
  PersonalHistoricalStatement,
  PersonalTaxDocument,
  PersonalYearLock,
} from "../models/personalFinanceModels.js";
import {
  ensurePersonalLedgers,
  feedFingerprint,
  aiClassifyFeeds,
  aiClassifyWithOpenAI,
  approveBankFeed,
  autoPostHighConfidence,
  liveFinancialStatements,
  itrReadiness,
  familyDashboard,
  reconcileTaxDocuments,
  postPersonalJournal,
  pfNumber,
} from "../services/personalFinanceService.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = pfNumber;

router.use(requireAuth);
router.use((req, res, next) => {
  if (["MASTER", "SUPERADMIN"].includes(req.auth?.role)) return next();
  if (!canPageAction(req.auth?.permissions || [], "/dms/family", req.method === "GET" ? "view" : req.method === "DELETE" ? "delete" : ["PUT", "PATCH"].includes(req.method) ? "edit" : "create")) {
    return fail(res, "Family & Individual Accounts permission required", 403);
  }
  return next();
});

const parseDate = (value) => {
  if (!value && value !== 0) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && value > 20000) {
    const p = XLSX.SSF.parse_date_code(value);
    if (p) return new Date(Date.UTC(p.y, p.m - 1, p.d));
  }
  const s = clean(value);
  if (!s) return null;
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct;
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (m) {
    const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1])));
  }
  return null;
};
const masked = (value) => {
  const s = clean(value).replace(/\s+/g, "");
  if (!s) return "";
  return s.length <= 4 ? s : `${"X".repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`;
};

const bankStatementTemplate = {
  type: "PERSONAL_BANK_STATEMENT", title: "Personal Bank Statement", version: 1,
  sections: [{ title: "Account", fields: [
    { key: "bankName", label: "Bank Name", type: "text" },
    { key: "accountNumber", label: "Account Number", type: "text" },
    { key: "statementFrom", label: "Statement From", type: "date" },
    { key: "statementTo", label: "Statement To", type: "date" },
    { key: "closingBalance", label: "Closing Balance", type: "number" },
  ] }],
  table: { key: "items", title: "Transactions", columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "valueDate", label: "Value Date", type: "date" },
    { key: "narration", label: "Narration", type: "text" },
    { key: "reference", label: "Reference", type: "text" },
    { key: "debit", label: "Debit", type: "number" },
    { key: "credit", label: "Credit", type: "number" },
    { key: "balance", label: "Balance", type: "number" },
  ] },
};

const historicalTemplate = (statementType) => ({
  type: `PERSONAL_${statementType}`, title: statementType.replaceAll("_", " "), version: 1,
  sections: [{ title: "Statement", fields: [
    { key: "financialYear", label: "Financial Year", type: "text" },
    { key: "name", label: "Name", type: "text" },
    { key: "pan", label: "PAN", type: "text" },
  ] }],
  table: { key: "items", title: "Statement Lines", columns: [
    { key: "section", label: "Section / Group", type: "text" },
    { key: "particular", label: "Particular", type: "text" },
    { key: "amount", label: "Amount", type: "number" },
    { key: "side", label: "Side (ASSET/LIABILITY/INCOME/EXPENSE/DEBIT/CREDIT)", type: "text" },
  ] },
});

const taxDocumentTemplate = (documentType) => ({
  type: `PERSONAL_${documentType}`, title: `${documentType} / Tax Document`, version: 1,
  sections: [{ title: "Tax Document", fields: [
    { key: "pan", label: "PAN", type: "text" },
    { key: "financialYear", label: "Financial Year", type: "text" },
    { key: "assessmentYear", label: "Assessment Year", type: "text" },
    { key: "totalIncomeReported", label: "Total Income / Reported Amount", type: "number" },
    { key: "totalTaxDeducted", label: "Total TDS / Tax", type: "number" },
  ] }],
  table: { key: "items", title: "Reported Information", columns: [
    { key: "section", label: "Section / Information Code", type: "text" },
    { key: "infoSource", label: "Information Source / Deductor", type: "text" },
    { key: "description", label: "Description", type: "text" },
    { key: "amount", label: "Income / Transaction Amount", type: "number" },
    { key: "taxDeducted", label: "Tax Deducted", type: "number" },
    { key: "date", label: "Date", type: "date" },
  ] },
});

function spreadsheetRows(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
}
function keyMap(row) {
  const m = new Map();
  for (const [k, v] of Object.entries(row || {})) m.set(upper(k).replace(/[^A-Z0-9]/g, ""), v);
  const pick = (...names) => {
    for (const name of names) {
      const value = m.get(upper(name).replace(/[^A-Z0-9]/g, ""));
      if (value !== undefined && value !== "") return value;
    }
    return "";
  };
  return { pick };
}
function parseBankSpreadsheet(buffer) {
  return spreadsheetRows(buffer).map((row, i) => {
    const { pick } = keyMap(row);
    const date = parseDate(pick("DATE", "TXN DATE", "TRANSACTION DATE", "POSTING DATE", "VALUE DATE"));
    const valueDate = parseDate(pick("VALUE DATE", "VAL DATE"));
    let debit = num(pick("DEBIT", "WITHDRAWAL", "WITHDRAWAL AMT", "DR", "DEBIT AMOUNT"));
    let credit = num(pick("CREDIT", "DEPOSIT", "DEPOSIT AMT", "CR", "CREDIT AMOUNT"));
    const amount = num(pick("AMOUNT", "TXN AMOUNT"));
    const type = upper(pick("TYPE", "DR/CR", "CR/DR", "TRANSACTION TYPE"));
    if (!debit && !credit && amount) type.includes("CR") ? credit = amount : debit = amount;
    return { rowNo: i + 2, date, valueDate, narration: clean(pick("NARRATION", "DESCRIPTION", "PARTICULARS", "TRANSACTION DETAILS", "REMARKS")), reference: clean(pick("REFERENCE", "REF NO", "CHQ/REF NO", "CHEQUE NO", "UTR")), debit, credit, balance: num(pick("BALANCE", "CLOSING BALANCE", "RUNNING BALANCE")), raw: row };
  }).filter((r) => r.date && (r.debit || r.credit || r.narration));
}

async function createAssesseeDefaults({ tenantKey, assesseeId, userId }) {
  return ensurePersonalLedgers({ tenantKey, assesseeId, userId });
}

router.get("/health", (_req, res) => ok(res, { module: "personal-finance-ai", build: "2026-09-20-family-office-ai-v1" }));

router.get("/dashboard", async (req, res) => {
  try { return ok(res, await familyDashboard({ tenantKey: req.auth.tenantKey, financialYear: clean(req.query.financialYear) || financialYearFromDate(new Date()) })); }
  catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/assessees", async (req, res) => {
  const rows = await PersonalAssessee.find({ tenantKey: req.auth.tenantKey }).sort({ status: 1, displayName: 1 }).lean();
  return ok(res, rows);
});
router.post("/assessees", async (req, res) => {
  try {
    const assesseeId = clean(req.body.assesseeId) || makeId("ASS");
    const row = await PersonalAssessee.create({ tenantKey: req.auth.tenantKey, assesseeId, displayName: clean(req.body.displayName), legalName: clean(req.body.legalName || req.body.displayName), entityType: upper(req.body.entityType || "INDIVIDUAL"), relation: clean(req.body.relation), pan: upper(req.body.pan), aadhaarLast4: clean(req.body.aadhaarLast4).slice(-4), dateOfBirth: parseDate(req.body.dateOfBirth), email: clean(req.body.email), mobile: clean(req.body.mobile), address: clean(req.body.address), residentialStatus: clean(req.body.residentialStatus || "RESIDENT"), taxRegime: clean(req.body.taxRegime || "AUTO"), itrPreference: clean(req.body.itrPreference || "AUTO"), openingFinancialYear: clean(req.body.openingFinancialYear), notes: clean(req.body.notes), createdBy: req.auth.sub });
    await createAssesseeDefaults({ tenantKey: req.auth.tenantKey, assesseeId, userId: req.auth.sub });
    return ok(res, row, "Assessee created", 201);
  } catch (e) { return fail(res, e.code === 11000 ? "PAN or Assessee ID already exists" : e.message, e.statusCode || 400); }
});
router.put("/assessees/:assesseeId", async (req, res) => {
  const allowed = ["displayName", "legalName", "entityType", "relation", "pan", "aadhaarLast4", "dateOfBirth", "email", "mobile", "address", "residentialStatus", "taxRegime", "itrPreference", "openingFinancialYear", "notes", "status"];
  const patch = {};
  for (const key of allowed) if (req.body[key] !== undefined) patch[key] = ["pan", "entityType"].includes(key) ? upper(req.body[key]) : key === "dateOfBirth" ? parseDate(req.body[key]) : req.body[key];
  patch.updatedBy = req.auth.sub;
  const row = await PersonalAssessee.findOneAndUpdate({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId }, { $set: patch }, { new: true });
  return row ? ok(res, row, "Assessee updated") : fail(res, "Assessee not found", 404);
});

router.post("/banks/bulk-upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return fail(res, "Bank master Excel/CSV is required", 400);
    const rows = spreadsheetRows(req.file.buffer);
    let created = 0, updated = 0, failed = [];
    for (let i = 0; i < rows.length; i += 1) {
      try {
        const { pick } = keyMap(rows[i]);
        const assesseeKey = clean(pick("ASSESSEE ID", "ASSESSEE", "NAME", "PERSON", "FAMILY MEMBER"));
        const pan = upper(pick("PAN"));
        const accountNumber = clean(pick("ACCOUNT NUMBER", "A/C NUMBER", "ACCOUNT NO", "A/C NO"));
        const bankName = clean(pick("BANK NAME", "BANK"));
        if (!assesseeKey && !pan) throw new Error("Assessee name/ID/PAN missing");
        if (!accountNumber || !bankName) throw new Error("Bank name/account number missing");
        const assessee = await PersonalAssessee.findOne({ tenantKey: req.auth.tenantKey, $or: [
          ...(pan ? [{ pan }] : []),
          { assesseeId: assesseeKey },
          { displayName: new RegExp(`^${assesseeKey.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "i") },
        ] });
        if (!assessee) throw new Error(`Assessee not found: ${assesseeKey || pan}`);
        let bank = await PersonalBankAccount.findOne({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, accountNumber });
        const openingBalance = num(pick("OPENING BALANCE", "OPENING"));
        const openingBalanceType = upper(pick("OPENING SIDE", "DR/CR", "SIDE") || "DR");
        const openingBalanceDate = parseDate(pick("OPENING DATE", "DATE"));
        if (!bank) {
          bank = await PersonalBankAccount.create({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, accountId: makeId("PFB"), accountName: clean(pick("ACCOUNT NAME", "NAME OF ACCOUNT")), bankName, branchName: clean(pick("BRANCH", "BRANCH NAME")), accountNumber, accountNumberMasked: masked(accountNumber), ifsc: upper(pick("IFSC", "IFSC CODE")), accountType: upper(pick("ACCOUNT TYPE", "TYPE") || "SAVINGS"), openingBalance, openingBalanceType: ["CR", "CREDIT"].includes(openingBalanceType) ? "CR" : "DR", openingBalanceDate, status: "ACTIVE", notes: clean(pick("REMARKS", "NOTES")), createdBy: req.auth.sub });
          created += 1;
        } else {
          Object.assign(bank, { accountName: clean(pick("ACCOUNT NAME", "NAME OF ACCOUNT")) || bank.accountName, bankName, branchName: clean(pick("BRANCH", "BRANCH NAME")) || bank.branchName, ifsc: upper(pick("IFSC", "IFSC CODE")) || bank.ifsc, accountType: upper(pick("ACCOUNT TYPE", "TYPE")) || bank.accountType, updatedBy: req.auth.sub });
          await bank.save(); updated += 1;
        }
        await ensurePersonalLedgers({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, userId: req.auth.sub });
        if (openingBalance && openingBalanceDate) {
          const already = await PersonalJournal.findOne({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, source: "OPENING", sourceId: bank.accountId });
          if (!already) {
            const bankLedger = await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, bankAccountId: bank.accountId, isBank: true });
            const opening = await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, ledgerId: "SYS-OPENING" });
            const amount = Math.abs(openingBalance); const debitBank = !["CR", "CREDIT"].includes(openingBalanceType);
            await postPersonalJournal({ tenantKey: req.auth.tenantKey, assesseeId: assessee.assesseeId, date: openingBalanceDate, narration: `Opening balance - ${bank.accountName || bank.bankName}`, source: "OPENING", sourceId: bank.accountId, entries: debitBank ? [{ ledgerId: bankLedger.ledgerId, ledgerName: bankLedger.name, debit: amount }, { ledgerId: opening.ledgerId, ledgerName: opening.name, credit: amount }] : [{ ledgerId: opening.ledgerId, ledgerName: opening.name, debit: amount }, { ledgerId: bankLedger.ledgerId, ledgerName: bankLedger.name, credit: amount }], userId: req.auth.sub, reviewedBy: req.auth.sub });
          }
        }
      } catch (e) { failed.push({ row: i + 2, error: e.message }); }
    }
    return ok(res, { created, updated, failed }, `${created} bank account(s) created; ${updated} updated`);
  } catch (e) { return fail(res, e.message, 400); }
});

router.get("/assessees/:assesseeId/banks", async (req, res) => ok(res, await PersonalBankAccount.find({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId }).sort({ status: 1, bankName: 1 }).lean()));
router.post("/assessees/:assesseeId/banks", async (req, res) => {
  try {
    const accountId = clean(req.body.accountId) || makeId("PFB");
    const accountNumber = clean(req.body.accountNumber);
    const row = await PersonalBankAccount.create({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, accountId, accountName: clean(req.body.accountName), bankName: clean(req.body.bankName), branchName: clean(req.body.branchName), accountNumber, accountNumberMasked: masked(accountNumber), ifsc: upper(req.body.ifsc), accountType: upper(req.body.accountType || "SAVINGS"), openingBalance: num(req.body.openingBalance), openingBalanceType: upper(req.body.openingBalanceType || "DR"), openingBalanceDate: parseDate(req.body.openingBalanceDate), status: "ACTIVE", notes: clean(req.body.notes), createdBy: req.auth.sub });
    await ensurePersonalLedgers({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, userId: req.auth.sub });
    if (row.openingBalance && row.openingBalanceDate) {
      const bankLedger = await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, bankAccountId: accountId, isBank: true });
      const opening = await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, ledgerId: "SYS-OPENING" });
      const amount = Math.abs(Number(row.openingBalance));
      const debitBank = row.openingBalanceType !== "CR";
      await postPersonalJournal({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, date: row.openingBalanceDate, narration: `Opening balance - ${row.accountName || row.bankName}`, source: "OPENING", sourceId: accountId, entries: debitBank ? [{ ledgerId: bankLedger.ledgerId, ledgerName: bankLedger.name, debit: amount }, { ledgerId: opening.ledgerId, ledgerName: opening.name, credit: amount }] : [{ ledgerId: opening.ledgerId, ledgerName: opening.name, debit: amount }, { ledgerId: bankLedger.ledgerId, ledgerName: bankLedger.name, credit: amount }], userId: req.auth.sub });
    }
    return ok(res, row, "Bank account added", 201);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/assessees/:assesseeId/ledgers", async (req, res) => {
  await ensurePersonalLedgers({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, userId: req.auth.sub });
  return ok(res, await PersonalLedger.find({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, status: "ACTIVE" }).sort({ statement: 1, name: 1 }).lean());
});
router.post("/assessees/:assesseeId/ledgers", async (req, res) => {
  try {
    const row = await PersonalLedger.create({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, ledgerId: clean(req.body.ledgerId) || makeId("PFL"), code: clean(req.body.code), name: clean(req.body.name), group: clean(req.body.group), nature: upper(req.body.nature || "EXPENSE"), statement: upper(req.body.statement || "PNL"), taxCategory: upper(req.body.taxCategory), status: "ACTIVE", createdBy: req.auth.sub });
    return ok(res, row, "Ledger created", 201);
  } catch (e) { return fail(res, e.code === 11000 ? "Ledger already exists" : e.message, 400); }
});

router.post("/bank-import", upload.single("statement"), async (req, res) => {
  try {
    if (!req.file) return fail(res, "Bank statement file is required", 400);
    const assesseeId = clean(req.body.assesseeId), bankAccountId = clean(req.body.bankAccountId);
    if (!assesseeId || !bankAccountId) return fail(res, "Assessee and bank account are required", 400);
    const bank = await PersonalBankAccount.findOne({ tenantKey: req.auth.tenantKey, assesseeId, accountId: bankAccountId, status: "ACTIVE" });
    if (!bank) return fail(res, "Bank account not found", 404);
    await ensurePersonalLedgers({ tenantKey: req.auth.tenantKey, assesseeId, userId: req.auth.sub });
    const file = await saveUploadedFile({ file: req.file, tenantKey: req.auth.tenantKey, module: "personal-finance", entityType: "BANK_STATEMENT", entityId: bankAccountId, uploadedBy: req.auth.sub, access: "PRIVATE" });
    const importId = makeId("PFBI");
    let rows = [];
    const lower = clean(req.file.originalname).toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(lower) || /spreadsheet|csv/.test(req.file.mimetype)) {
      rows = parseBankSpreadsheet(req.file.buffer);
    } else {
      const extraction = await extractWithOpenAI({ file: req.file, template: bankStatementTemplate });
      rows = (extraction.items || []).map((r, i) => ({ rowNo: i + 1, date: parseDate(r.date), valueDate: parseDate(r.valueDate), narration: clean(r.narration), reference: clean(r.reference), debit: num(r.debit), credit: num(r.credit), balance: num(r.balance), raw: r })).filter((r) => r.date && (r.debit || r.credit || r.narration));
      if (num(extraction.values?.closingBalance)) { bank.currentBalanceSnapshot = num(extraction.values.closingBalance); bank.currentBalanceAsOf = parseDate(extraction.values.statementTo) || new Date(); }
    }
    let inserted = 0, duplicates = 0;
    for (const r of rows) {
      const fingerprint = feedFingerprint({ assesseeId, bankAccountId, ...r });
      try {
        await PersonalBankFeed.create({ tenantKey: req.auth.tenantKey, assesseeId, bankAccountId, importId, rowNo: r.rowNo, financialYear: financialYearFromDate(r.date), date: r.date, valueDate: r.valueDate, narration: r.narration, reference: r.reference, debit: r.debit, credit: r.credit, balance: r.balance, fingerprint, raw: r.raw, reviewStatus: "PENDING" });
        inserted += 1;
      } catch (e) { if (e.code === 11000) duplicates += 1; else throw e; }
    }
    bank.statementImportCount = Number(bank.statementImportCount || 0) + 1;
    if (rows.length && rows[rows.length - 1].balance) { bank.currentBalanceSnapshot = rows[rows.length - 1].balance; bank.currentBalanceAsOf = rows[rows.length - 1].date; }
    await bank.save();
    await aiClassifyFeeds({ tenantKey: req.auth.tenantKey, assesseeId, userId: req.auth.sub });
    const autoPosted = await autoPostHighConfidence({ tenantKey: req.auth.tenantKey, assesseeId, userId: req.auth.sub });
    return ok(res, { importId, fileId: file.fileId, rows: rows.length, inserted, duplicates, autoPosted }, `${inserted} bank transactions imported; ${duplicates} duplicate(s) skipped`, 201);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/assessees/:assesseeId/bank-feed", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId };
  if (req.query.financialYear) filter.financialYear = clean(req.query.financialYear);
  if (req.query.status) filter.reviewStatus = upper(req.query.status);
  const rows = await PersonalBankFeed.find(filter).sort({ date: -1, rowNo: -1 }).limit(Math.min(1000, Number(req.query.limit || 500))).lean();
  return ok(res, rows);
});
router.post("/assessees/:assesseeId/ai-classify", async (req, res) => {
  try {
    const assesseeId = req.params.assesseeId;
    await aiClassifyFeeds({ tenantKey: req.auth.tenantKey, assesseeId, feedIds: req.body.feedIds || [], userId: req.auth.sub });
    if (req.body.deepAi !== false) {
      const filter = { tenantKey: req.auth.tenantKey, assesseeId, reviewStatus: { $in: ["PENDING", "SUGGESTED"] }, aiConfidence: { $lt: 0.9 } };
      if ((req.body.feedIds || []).length) filter._id = { $in: req.body.feedIds };
      const ambiguous = await PersonalBankFeed.find(filter).sort({ date: -1 }).limit(80).lean();
      if (ambiguous.length) await aiClassifyWithOpenAI({ tenantKey: req.auth.tenantKey, assesseeId, feeds: ambiguous });
    }
    const autoPosted = req.body.autoPost === false ? 0 : await autoPostHighConfidence({ tenantKey: req.auth.tenantKey, assesseeId, userId: req.auth.sub });
    return ok(res, { autoPosted, rows: await PersonalBankFeed.find({ tenantKey: req.auth.tenantKey, assesseeId }).sort({ date: -1 }).limit(500).lean() }, "AI classification refreshed");
  } catch (e) { return fail(res, e.message, 400); }
});
router.post("/assessees/:assesseeId/bank-feed/:feedId/approve", async (req, res) => {
  try { return ok(res, await approveBankFeed({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, feedId: req.params.feedId, ledgerId: clean(req.body.ledgerId), businessPct: Number(req.body.businessPct ?? 100), learnRule: req.body.learnRule !== false, userId: req.auth.sub }), "Transaction posted and AI rule learned"); }
  catch (e) { return fail(res, e.message, e.statusCode || 400); }
});
router.post("/assessees/:assesseeId/bank-feed/bulk-approve", async (req, res) => {
  let posted = 0, failed = [];
  for (const item of req.body.items || []) {
    try { await approveBankFeed({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, feedId: item.feedId, ledgerId: item.ledgerId, businessPct: Number(item.businessPct ?? 100), learnRule: item.learnRule !== false, userId: req.auth.sub }); posted += 1; }
    catch (e) { failed.push({ feedId: item.feedId, error: e.message }); }
  }
  return ok(res, { posted, failed }, `${posted} transaction(s) posted`);
});

router.get("/assessees/:assesseeId/journals", async (req, res) => {
  const filter = { tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId };
  if (req.query.financialYear) filter.financialYear = clean(req.query.financialYear);
  return ok(res, await PersonalJournal.find(filter).sort({ date: -1, createdAt: -1 }).limit(1000).lean());
});
router.post("/assessees/:assesseeId/journals", async (req, res) => {
  try { return ok(res, await postPersonalJournal({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, date: parseDate(req.body.date) || new Date(), narration: clean(req.body.narration), reference: clean(req.body.reference), source: "MANUAL", entries: req.body.entries || [], userId: req.auth.sub, reviewedBy: req.auth.sub }), "Journal posted", 201); }
  catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.get("/assessees/:assesseeId/statements", async (req, res) => {
  try { return ok(res, await liveFinancialStatements({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, financialYear: clean(req.query.financialYear) || financialYearFromDate(new Date()) })); }
  catch (e) { return fail(res, e.message, 400); }
});
router.get("/assessees/:assesseeId/itr-readiness", async (req, res) => {
  try { return ok(res, await itrReadiness({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, financialYear: clean(req.query.financialYear) || financialYearFromDate(new Date()) })); }
  catch (e) { return fail(res, e.message, 400); }
});
router.get("/assessees/:assesseeId/tax-reconciliation", async (req, res) => {
  try { return ok(res, await reconcileTaxDocuments({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, financialYear: clean(req.query.financialYear) || financialYearFromDate(new Date()) })); }
  catch (e) { return fail(res, e.message, 400); }
});

router.post("/historical/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return fail(res, "Historical statement file is required", 400);
    const assesseeId = clean(req.body.assesseeId), financialYear = clean(req.body.financialYear), statementType = upper(req.body.statementType);
    if (!assesseeId || !financialYear || !["BALANCE_SHEET", "TRADING", "PNL", "TRIAL_BALANCE"].includes(statementType)) return fail(res, "Assessee, financial year and statement type are required", 400);
    const file = await saveUploadedFile({ file: req.file, tenantKey: req.auth.tenantKey, module: "personal-finance", entityType: statementType, entityId: assesseeId, uploadedBy: req.auth.sub, access: "PRIVATE" });
    let items = [], warnings = [], engine = "SPREADSHEET";
    const lower = clean(req.file.originalname).toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(lower)) {
      items = spreadsheetRows(req.file.buffer).map((r) => { const { pick } = keyMap(r); return { section: clean(pick("SECTION", "GROUP", "HEAD")), particular: clean(pick("PARTICULAR", "PARTICULARS", "LEDGER", "ACCOUNT", "NAME")), amount: num(pick("AMOUNT", "BALANCE", "VALUE", "CLOSING")), side: upper(pick("SIDE", "TYPE", "NATURE")), confidence: 0.95 }; }).filter((x) => x.particular && x.amount);
    } else {
      const x = await extractWithOpenAI({ file: req.file, template: historicalTemplate(statementType) }); engine = "OPENAI"; warnings = x.warnings || []; items = (x.items || []).map((r) => ({ section: clean(r.section), particular: clean(r.particular), amount: num(r.amount), side: upper(r.side), confidence: 0.85 })).filter((x) => x.particular && x.amount);
    }
    const row = await PersonalHistoricalStatement.create({ tenantKey: req.auth.tenantKey, assesseeId, statementId: makeId("PFH"), financialYear, statementType, sourceFileId: file.fileId, sourceFileName: req.file.originalname, extractionEngine: engine, status: "EXTRACTED", items, warnings, createdBy: req.auth.sub });
    return ok(res, row, `${statementType.replaceAll("_", " ")} extracted for review`, 201);
  } catch (e) { return fail(res, e.message, 400); }
});
router.get("/assessees/:assesseeId/historical", async (req, res) => ok(res, await PersonalHistoricalStatement.find({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId }).sort({ financialYear: -1, statementType: 1 }).lean()));
router.post("/historical/:statementId/apply-opening", async (req, res) => {
  try {
    const row = await PersonalHistoricalStatement.findOne({ tenantKey: req.auth.tenantKey, statementId: req.params.statementId, statementType: "BALANCE_SHEET" });
    if (!row) return fail(res, "Balance Sheet history not found", 404);
    await ensurePersonalLedgers({ tenantKey: req.auth.tenantKey, assesseeId: row.assesseeId, userId: req.auth.sub });
    const [y1, y2] = row.financialYear.split("-");
    const startYear = Number(y1) + 1;
    const openingDate = new Date(Date.UTC(startYear, 3, 1));
    const adjustment = await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: row.assesseeId, ledgerId: "SYS-OPENING" });
    const journalIds = [];
    for (const item of row.items || []) {
      const side = upper(item.side || item.section);
      const isAsset = /(ASSET|DEBIT|DR)/.test(side), isLiability = /(LIABIL|CAPITAL|CREDIT|CR)/.test(side);
      if (!isAsset && !isLiability) continue;
      let ledger = item.mappedLedgerId ? await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: row.assesseeId, ledgerId: item.mappedLedgerId }) : await PersonalLedger.findOne({ tenantKey: req.auth.tenantKey, assesseeId: row.assesseeId, name: new RegExp(`^${item.particular.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
      if (!ledger) ledger = await PersonalLedger.create({ tenantKey: req.auth.tenantKey, assesseeId: row.assesseeId, ledgerId: makeId("PFL"), name: item.particular, group: item.section, nature: isAsset ? "ASSET" : /CAPITAL/.test(side) ? "CAPITAL" : "LIABILITY", statement: "BALANCE_SHEET", system: false, status: "ACTIVE", createdBy: req.auth.sub });
      const amount = Math.abs(Number(item.amount || 0)); if (!amount) continue;
      const journal = await postPersonalJournal({ tenantKey: req.auth.tenantKey, assesseeId: row.assesseeId, date: openingDate, narration: `Opening from ${row.financialYear} Balance Sheet - ${item.particular}`, source: "HISTORICAL_OPENING", sourceId: row.statementId, documentId: row.sourceFileId, entries: isAsset ? [{ ledgerId: ledger.ledgerId, ledgerName: ledger.name, debit: amount }, { ledgerId: adjustment.ledgerId, ledgerName: adjustment.name, credit: amount }] : [{ ledgerId: adjustment.ledgerId, ledgerName: adjustment.name, debit: amount }, { ledgerId: ledger.ledgerId, ledgerName: ledger.name, credit: amount }], userId: req.auth.sub, reviewedBy: req.auth.sub });
      journalIds.push(journal.journalId);
    }
    row.status = "APPLIED"; row.appliedJournalIds = journalIds; row.reviewedBy = req.auth.sub; row.reviewedAt = new Date(); await row.save();
    return ok(res, { journalIds, openingDate }, `${journalIds.length} opening balance(s) posted`);
  } catch (e) { return fail(res, e.message, e.statusCode || 400); }
});

router.post("/tax-documents/upload", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return fail(res, "Tax document is required", 400);
    const assesseeId = clean(req.body.assesseeId), documentType = upper(req.body.documentType), financialYear = clean(req.body.financialYear) || financialYearFromDate(new Date());
    const allowed = ["AIS", "26AS", "FORM16", "FORM16A", "TAX_CHALLAN", "LOAN_STATEMENT", "DEMAT", "CAPITAL_GAIN", "PROPERTY", "INSURANCE", "OTHER"];
    if (!assesseeId || !allowed.includes(documentType)) return fail(res, "Valid assessee and document type are required", 400);
    const file = await saveUploadedFile({ file: req.file, tenantKey: req.auth.tenantKey, module: "personal-finance", entityType: documentType, entityId: assesseeId, uploadedBy: req.auth.sub, access: "PRIVATE" });
    let extractedValues = {}, items = [], confidence = {}, warnings = [], engine = "MANUAL";
    if (/\.(xlsx|xls|csv)$/i.test(req.file.originalname)) {
      const rows = spreadsheetRows(req.file.buffer); engine = "SPREADSHEET";
      items = rows.map((r) => { const { pick } = keyMap(r); return { section: clean(pick("SECTION", "INFO CODE", "CODE")), infoSource: clean(pick("SOURCE", "DEDUCTOR", "INFORMATION SOURCE", "NAME")), description: clean(pick("DESCRIPTION", "PARTICULARS", "TRANSACTION")), amount: num(pick("AMOUNT", "TRANSACTION AMOUNT", "INCOME")), taxDeducted: num(pick("TDS", "TAX DEDUCTED", "TAX")), date: clean(pick("DATE", "TRANSACTION DATE")) }; }).filter((x) => x.amount || x.taxDeducted || x.description);
    } else {
      const x = await extractWithOpenAI({ file: req.file, template: taxDocumentTemplate(documentType) }); engine = "OPENAI"; extractedValues = x.values || {}; items = x.items || []; confidence = x.confidence || {}; warnings = x.warnings || [];
    }
    const row = await PersonalTaxDocument.create({ tenantKey: req.auth.tenantKey, assesseeId, documentId: makeId("PFD"), financialYear, assessmentYear: clean(req.body.assessmentYear || extractedValues.assessmentYear), documentType, fileId: file.fileId, fileName: req.file.originalname, extractionEngine: engine, extractedValues, items, confidence, warnings, status: "EXTRACTED", createdBy: req.auth.sub });
    return ok(res, row, `${documentType} uploaded and extracted`, 201);
  } catch (e) { return fail(res, e.message, 400); }
});
router.get("/assessees/:assesseeId/tax-documents", async (req, res) => ok(res, await PersonalTaxDocument.find({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId }).sort({ createdAt: -1 }).lean()));

router.get("/assessees/:assesseeId/rules", async (req, res) => ok(res, await PersonalAiRule.find({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, active: true }).sort({ approvedCount: -1, lastUsedAt: -1 }).lean()));

router.get("/assessees/:assesseeId/year-locks", async (req, res) => ok(res, await PersonalYearLock.find({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId }).sort({ financialYear: -1 }).lean()));
router.post("/assessees/:assesseeId/year-lock", async (req, res) => {
  const financialYear = clean(req.body.financialYear), status = upper(req.body.status || "LOCKED");
  if (!financialYear || !["OPEN", "READY", "FILED", "LOCKED", "REOPENED"].includes(status)) return fail(res, "Financial year and valid status are required", 400);
  const patch = { status };
  if (["FILED", "LOCKED"].includes(status)) { patch.lockedAt = new Date(); patch.lockedBy = req.auth.sub; patch.itrForm = clean(req.body.itrForm); patch.acknowledgementNo = clean(req.body.acknowledgementNo); if (status === "FILED") patch.filedAt = new Date(); }
  if (status === "REOPENED") { if (!clean(req.body.reason)) return fail(res, "Reopen reason is mandatory", 400); patch.reopenedAt = new Date(); patch.reopenedBy = req.auth.sub; patch.reopenReason = clean(req.body.reason); }
  const row = await PersonalYearLock.findOneAndUpdate({ tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, financialYear }, { $set: patch, $setOnInsert: { tenantKey: req.auth.tenantKey, assesseeId: req.params.assesseeId, financialYear } }, { upsert: true, new: true });
  return ok(res, row, `Financial year marked ${status}`);
});

export default router;
