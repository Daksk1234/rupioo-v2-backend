import crypto from "crypto";
import { env } from "../config/env.js";
import { makeId } from "../utils/ids.js";
import { financialYearFromDate } from "../utils/financialYear.js";
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

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const n = (v) => {
  const x = Number(String(v ?? "").replace(/[₹,$\s]/g, "").replace(/,/g, ""));
  return Number.isFinite(x) ? x : 0;
};
const round2 = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

export function normalizePattern(narration = "") {
  return upper(narration)
    .replace(/\b\d{4,}\b/g, "#")
    .replace(/[A-Z]{2,}\d{2,}/g, "#")
    .replace(/[^A-Z0-9# ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function feedFingerprint({ assesseeId, bankAccountId, date, narration, debit, credit, reference }) {
  return crypto.createHash("sha256").update([
    assesseeId,
    bankAccountId,
    new Date(date).toISOString().slice(0, 10),
    upper(narration),
    round2(debit),
    round2(credit),
    upper(reference),
  ].join("|")).digest("hex");
}

const DEFAULT_LEDGERS = [
  ["CAPITAL", "Capital Account", "CAPITAL", "BALANCE_SHEET", "CAPITAL"],
  ["DRAWINGS", "Drawings", "CAPITAL", "BALANCE_SHEET", "DRAWINGS"],
  ["CASH", "Cash in Hand", "ASSET", "BALANCE_SHEET", "CASH"],
  ["TRANSFER", "Self Transfer Clearing", "ASSET", "BALANCE_SHEET", "TRANSFER"],
  ["SUSPENSE", "Suspense / Review", "ASSET", "BALANCE_SHEET", "SUSPENSE"],
  ["OPENING", "Opening Balance Adjustment", "CAPITAL", "BALANCE_SHEET", "OPENING"],
  ["SALARY", "Salary Income", "INCOME", "PNL", "SALARY"],
  ["BUSINESS_INCOME", "Business Income", "INCOME", "TRADING", "BUSINESS"],
  ["INTEREST", "Interest Income", "INCOME", "PNL", "INTEREST"],
  ["DIVIDEND", "Dividend Income", "INCOME", "PNL", "DIVIDEND"],
  ["RENT", "Rental Income", "INCOME", "PNL", "HOUSE_PROPERTY"],
  ["CAPITAL_GAIN", "Capital Gain / Loss", "INCOME", "PNL", "CAPITAL_GAIN"],
  ["OTHER_INCOME", "Other Income", "INCOME", "PNL", "OTHER_INCOME"],
  ["PURCHASE", "Purchases", "EXPENSE", "TRADING", "PURCHASE"],
  ["DIRECT_EXP", "Direct Expenses", "EXPENSE", "TRADING", "DIRECT_EXPENSE"],
  ["HOUSEHOLD", "Household / Personal Expense", "EXPENSE", "PNL", "PERSONAL"],
  ["BUSINESS_EXP", "Business Expense", "EXPENSE", "PNL", "BUSINESS_EXPENSE"],
  ["MEDICAL", "Medical Expense", "EXPENSE", "PNL", "MEDICAL"],
  ["TRAVEL", "Travel & Conveyance", "EXPENSE", "PNL", "TRAVEL"],
  ["FUEL", "Fuel / Vehicle Expense", "EXPENSE", "PNL", "VEHICLE"],
  ["EDUCATION", "Education Expense", "EXPENSE", "PNL", "EDUCATION"],
  ["INSURANCE_EXP", "Insurance Expense", "EXPENSE", "PNL", "INSURANCE"],
  ["PROFESSIONAL", "Professional / Consultancy Fees", "EXPENSE", "PNL", "PROFESSIONAL_FEES"],
  ["BANK_CHARGES", "Bank Charges", "EXPENSE", "PNL", "BANK_CHARGES"],
  ["TAX_EXP", "Income Tax / Tax Expense", "EXPENSE", "PNL", "TAX"],
  ["TDS", "TDS Receivable", "ASSET", "BALANCE_SHEET", "TDS"],
  ["ADV_TAX", "Advance Tax", "ASSET", "BALANCE_SHEET", "ADVANCE_TAX"],
  ["TAX_REFUND", "Income Tax Refund Receivable", "ASSET", "BALANCE_SHEET", "TAX_REFUND"],
  ["INVESTMENT", "Investments", "ASSET", "BALANCE_SHEET", "INVESTMENT"],
  ["PROPERTY", "Property / Immovable Assets", "ASSET", "BALANCE_SHEET", "PROPERTY"],
  ["FIXED_ASSET", "Other Fixed Assets", "ASSET", "BALANCE_SHEET", "FIXED_ASSET"],
  ["LOAN_GIVEN", "Loans & Advances Given", "ASSET", "BALANCE_SHEET", "LOAN_GIVEN"],
  ["LOAN_TAKEN", "Loans Taken", "LIABILITY", "BALANCE_SHEET", "LOAN_TAKEN"],
  ["CREDIT_CARD", "Credit Card Payable", "LIABILITY", "BALANCE_SHEET", "CREDIT_CARD"],
  ["PAYABLE", "Other Payables", "LIABILITY", "BALANCE_SHEET", "PAYABLE"],
  ["RECEIVABLE", "Other Receivables", "ASSET", "BALANCE_SHEET", "RECEIVABLE"],
  ["OPENING_STOCK", "Opening Stock", "ASSET", "TRADING", "OPENING_STOCK"],
  ["CLOSING_STOCK", "Closing Stock", "ASSET", "TRADING", "CLOSING_STOCK"],
];

export async function ensurePersonalLedgers({ tenantKey, assesseeId, userId = "SYSTEM" }) {
  const ops = DEFAULT_LEDGERS.map(([code, name, nature, statement, taxCategory]) => ({
    updateOne: {
      filter: { tenantKey, assesseeId, ledgerId: `SYS-${code}` },
      update: { $setOnInsert: { tenantKey, assesseeId, ledgerId: `SYS-${code}`, code, name, nature, statement, taxCategory, system: true, status: "ACTIVE", createdBy: userId } },
      upsert: true,
    },
  }));
  if (ops.length) await PersonalLedger.bulkWrite(ops, { ordered: false });

  const banks = await PersonalBankAccount.find({ tenantKey, assesseeId, status: "ACTIVE" }).lean();
  for (const bank of banks) {
    const ledgerId = `BANK-${bank.accountId}`;
    await PersonalLedger.updateOne(
      { tenantKey, assesseeId, ledgerId },
      { $set: { code: ledgerId, name: bank.accountName || `${bank.bankName || "Bank"} ${bank.accountNumberMasked || ""}`.trim(), nature: "ASSET", statement: "BALANCE_SHEET", taxCategory: "BANK", isBank: true, bankAccountId: bank.accountId, status: "ACTIVE", updatedBy: userId }, $setOnInsert: { tenantKey, assesseeId, ledgerId, createdBy: userId } },
      { upsert: true },
    );
  }
  return PersonalLedger.find({ tenantKey, assesseeId, status: "ACTIVE" }).sort({ system: -1, name: 1 }).lean();
}

export async function checkYearOpen({ tenantKey, assesseeId, date }) {
  const financialYear = financialYearFromDate(date);
  const lock = await PersonalYearLock.findOne({ tenantKey, assesseeId, financialYear }).lean();
  if (["FILED", "LOCKED"].includes(lock?.status)) {
    const error = new Error(`${financialYear} is ${lock.status}. Reopen the year with a reason before posting.`);
    error.statusCode = 409;
    throw error;
  }
  return financialYear;
}

export async function postPersonalJournal({ tenantKey, assesseeId, date, narration, reference = "", source = "MANUAL", sourceId = "", documentId = "", entries = [], aiMeta = {}, userId = "SYSTEM", reviewedBy = "" }) {
  const financialYear = await checkYearOpen({ tenantKey, assesseeId, date });
  const cleaned = (entries || []).map((e) => ({ ledgerId: clean(e.ledgerId), ledgerName: clean(e.ledgerName), debit: round2(n(e.debit)), credit: round2(n(e.credit)), memo: clean(e.memo) })).filter((e) => e.ledgerId && (e.debit || e.credit));
  const totalDebit = round2(cleaned.reduce((s, e) => s + e.debit, 0));
  const totalCredit = round2(cleaned.reduce((s, e) => s + e.credit, 0));
  if (!cleaned.length || Math.abs(totalDebit - totalCredit) > 0.009) {
    const error = new Error(`Journal is not balanced. Debit ₹${totalDebit.toFixed(2)} / Credit ₹${totalCredit.toFixed(2)}`);
    error.statusCode = 400;
    throw error;
  }
  const journalId = makeId("PFJ");
  return PersonalJournal.create({ tenantKey, assesseeId, journalId, financialYear, date, narration, reference, source, sourceId, documentId, entries: cleaned, totalDebit, totalCredit, status: "POSTED", aiMeta, createdBy: userId, reviewedBy: reviewedBy || userId, reviewedAt: reviewedBy ? new Date() : undefined });
}

function guessByNarration(narration, credit) {
  const t = upper(narration);
  const rules = [
    [/\b(INT|INTEREST|SBINT|FD INT|TERM DEP.*INT)\b/, credit ? "SYS-INTEREST" : "SYS-BANK_CHARGES", "INTEREST/BANK", 0.94],
    [/\bDIVIDEND\b/, "SYS-DIVIDEND", "DIVIDEND", 0.96],
    [/\bSALARY\b/, "SYS-SALARY", "SALARY", 0.96],
    [/\b(RENT|TENANT)\b/, credit ? "SYS-RENT" : "SYS-HOUSEHOLD", "RENT", 0.83],
    [/\b(TDS|TAX DEDUCT)\b/, "SYS-TDS", "TDS", 0.88],
    [/\b(ADVANCE TAX|INCOME TAX CHALLAN|ITNS)\b/, "SYS-ADV_TAX", "ADVANCE_TAX", 0.95],
    [/\b(TAX REFUND|IT REFUND)\b/, "SYS-TAX_REFUND", "TAX_REFUND", 0.95],
    [/\b(MUTUAL FUND|MF |SIP|ZERODHA|GROWW|UPSTOX|BROKING|DEMAT|NSE|BSE)\b/, credit ? "SYS-CAPITAL_GAIN" : "SYS-INVESTMENT", "INVESTMENT", 0.82],
    [/\b(EMI|LOAN|HOME LOAN|CAR LOAN)\b/, "SYS-LOAN_TAKEN", "LOAN", 0.76],
    [/\b(INSURANCE|LIC|POLICY)\b/, "SYS-INSURANCE_EXP", "INSURANCE", 0.90],
    [/\b(HOSPITAL|MEDICAL|PHARMA|PHARMACY|DOCTOR)\b/, "SYS-MEDICAL", "MEDICAL", 0.90],
    [/\b(PETROL|DIESEL|FUEL|HPCL|IOCL|BPCL)\b/, "SYS-FUEL", "FUEL", 0.92],
    [/\b(UBER|OLA|IRCTC|AIR INDIA|INDIGO|HOTEL|TRAVEL)\b/, "SYS-TRAVEL", "TRAVEL", 0.83],
    [/\b(SCHOOL|COLLEGE|TUITION|EDUCATION|UNIVERSITY)\b/, "SYS-EDUCATION", "EDUCATION", 0.88],
    [/\b(BANK CHARGE|SMS CHARGE|IMPS CHARGE|NEFT CHARGE|ATM CHARGE|ANNUAL FEE|GST ON CHARGE)\b/, "SYS-BANK_CHARGES", "BANK_CHARGES", 0.96],
    [/\b(CA |CHARTERED|CONSULT|PROFESSIONAL|LEGAL FEE)\b/, "SYS-PROFESSIONAL", "PROFESSIONAL", 0.80],
    [/\b(AMAZON|FLIPKART|MYNTRA|SWIGGY|ZOMATO|GROCERY|SUPERMARKET)\b/, "SYS-HOUSEHOLD", "PERSONAL", 0.68],
  ];
  for (const [re, ledgerId, classification, confidence] of rules) if (re.test(t)) return { ledgerId, classification, confidence, explanation: `Matched known ${classification.toLowerCase()} pattern` };
  return null;
}

export async function classifyBankFeed({ tenantKey, assesseeId, row }) {
  const pattern = normalizePattern(row.narration);
  const learned = pattern ? await PersonalAiRule.findOne({ tenantKey, assesseeId, pattern, active: true }).lean() : null;
  if (learned) {
    return { ledgerId: learned.ledgerId, ledgerName: learned.ledgerName, classification: learned.classification || "LEARNED_RULE", businessPct: Number(learned.businessPct ?? 100), confidence: learned.approvedCount >= 2 ? 0.99 : 0.93, explanation: `Learned from ${learned.approvedCount} approved transaction(s)`, ruleId: learned.ruleId, canAutoPost: learned.approvedCount >= 2 };
  }
  const guess = guessByNarration(row.narration, Number(row.credit || 0) > 0);
  if (guess) {
    const ledger = await PersonalLedger.findOne({ tenantKey, assesseeId, ledgerId: guess.ledgerId }).lean();
    return { ...guess, ledgerName: ledger?.name || "", businessPct: guess.classification === "PERSONAL" ? 0 : 100, canAutoPost: false };
  }
  const suspense = await PersonalLedger.findOne({ tenantKey, assesseeId, ledgerId: "SYS-SUSPENSE" }).lean();
  return { ledgerId: "SYS-SUSPENSE", ledgerName: suspense?.name || "Suspense / Review", classification: "UNCLASSIFIED", businessPct: 100, confidence: 0.35, explanation: "No approved rule or reliable deterministic pattern matched", canAutoPost: false };
}

export async function detectSelfTransfers({ tenantKey, assesseeId, rows }) {
  const pending = rows || await PersonalBankFeed.find({ tenantKey, assesseeId, reviewStatus: { $in: ["PENDING", "SUGGESTED"] } }).sort({ date: 1 }).lean();
  const byAmount = new Map();
  for (const r of pending) {
    const amount = round2(Number(r.debit || r.credit || 0));
    if (!amount) continue;
    const key = amount.toFixed(2);
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key).push(r);
  }
  const updates = [];
  for (const group of byAmount.values()) {
    for (const debit of group.filter((r) => Number(r.debit || 0) > 0)) {
      const match = group.find((r) => Number(r.credit || 0) > 0 && r.bankAccountId !== debit.bankAccountId && Math.abs(new Date(r.date) - new Date(debit.date)) <= 3 * 86400000 && !r.transferMatchFeedId);
      if (!match) continue;
      updates.push(PersonalBankFeed.updateOne({ _id: debit._id }, { $set: { suggestedLedgerId: "SYS-TRANSFER", suggestedLedgerName: "Self Transfer Clearing", suggestedClassification: "SELF_TRANSFER", aiConfidence: 0.995, aiExplanation: `Matched credit in ${match.bankAccountId}`, transferMatchFeedId: String(match._id), reviewStatus: "SUGGESTED" } }));
      updates.push(PersonalBankFeed.updateOne({ _id: match._id }, { $set: { suggestedLedgerId: "SYS-TRANSFER", suggestedLedgerName: "Self Transfer Clearing", suggestedClassification: "SELF_TRANSFER", aiConfidence: 0.995, aiExplanation: `Matched debit in ${debit.bankAccountId}`, transferMatchFeedId: String(debit._id), reviewStatus: "SUGGESTED" } }));
      debit.transferMatchFeedId = String(match._id); match.transferMatchFeedId = String(debit._id);
    }
  }
  if (updates.length) await Promise.all(updates);
  return updates.length / 2;
}

export async function aiClassifyFeeds({ tenantKey, assesseeId, feedIds = [], userId = "SYSTEM" }) {
  await ensurePersonalLedgers({ tenantKey, assesseeId, userId });
  const filter = { tenantKey, assesseeId, reviewStatus: { $in: ["PENDING", "SUGGESTED"] } };
  if (feedIds.length) filter._id = { $in: feedIds };
  const feeds = await PersonalBankFeed.find(filter).sort({ date: 1 }).limit(200);
  for (const feed of feeds) {
    if (feed.suggestedClassification === "SELF_TRANSFER") continue;
    const suggestion = await classifyBankFeed({ tenantKey, assesseeId, row: feed });
    Object.assign(feed, { suggestedLedgerId: suggestion.ledgerId, suggestedLedgerName: suggestion.ledgerName, suggestedClassification: suggestion.classification, suggestedBusinessPct: suggestion.businessPct, aiConfidence: suggestion.confidence, aiExplanation: suggestion.explanation, reviewStatus: "SUGGESTED" });
    await feed.save();
  }
  await detectSelfTransfers({ tenantKey, assesseeId });
  return PersonalBankFeed.find(filter).sort({ date: -1 }).lean();
}

export async function aiClassifyWithOpenAI({ tenantKey, assesseeId, feeds = [] }) {
  if (!env.openai?.apiKey || !feeds.length) return [];
  const ledgers = await PersonalLedger.find({ tenantKey, assesseeId, status: "ACTIVE" }).select("ledgerId name nature statement taxCategory").lean();
  const allowed = ledgers.map((l) => ({ ledgerId: l.ledgerId, name: l.name, nature: l.nature, taxCategory: l.taxCategory }));
  const schema = {
    type: "object",
    properties: {
      rows: { type: "array", items: { type: "object", properties: { feedId: { type: "string" }, ledgerId: { type: "string" }, classification: { type: "string" }, businessPct: { type: "number", minimum: 0, maximum: 100 }, confidence: { type: "number", minimum: 0, maximum: 1 }, explanation: { type: "string" } }, required: ["feedId", "ledgerId", "classification", "businessPct", "confidence", "explanation"], additionalProperties: false } },
    },
    required: ["rows"], additionalProperties: false,
  };
  const payloadRows = feeds.slice(0, 80).map((r) => ({ feedId: String(r._id), date: new Date(r.date).toISOString().slice(0, 10), narration: r.narration, debit: r.debit, credit: r.credit, currentSuggestion: r.suggestedLedgerName }));
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env.openai.model,
      input: [{ role: "user", content: [{ type: "input_text", text: `You are an Indian personal-accounting classification assistant. Classify each bank transaction into exactly one ledger from the allowed list. Never invent a ledger. Distinguish personal drawings, business expenses, investments, loans, transfers, tax, interest, dividend, rent and salary. Use lower confidence when ambiguous. Allowed ledgers: ${JSON.stringify(allowed)}\nTransactions: ${JSON.stringify(payloadRows)}` }] }],
      max_output_tokens: 7000,
      text: { format: { type: "json_schema", name: "rupio_personal_bank_classification", strict: true, schema } },
    }),
  });
  const raw = await response.json();
  if (!response.ok) throw new Error(raw?.error?.message || `AI classification failed (${response.status})`);
  const text = raw.output_text || (raw.output || []).flatMap((x) => x.content || []).find((x) => x.type === "output_text")?.text || "{}";
  const parsed = JSON.parse(text);
  const ledgerMap = new Map(ledgers.map((l) => [l.ledgerId, l]));
  const updates = [];
  for (const item of parsed.rows || []) {
    const ledger = ledgerMap.get(item.ledgerId);
    if (!ledger) continue;
    updates.push(PersonalBankFeed.updateOne({ _id: item.feedId, tenantKey, assesseeId, reviewStatus: { $in: ["PENDING", "SUGGESTED"] } }, { $set: { suggestedLedgerId: ledger.ledgerId, suggestedLedgerName: ledger.name, suggestedClassification: item.classification, suggestedBusinessPct: Number(item.businessPct ?? 100), aiConfidence: Number(item.confidence || 0), aiExplanation: item.explanation, reviewStatus: "SUGGESTED" } }));
  }
  if (updates.length) await Promise.all(updates);
  return parsed.rows || [];
}

export async function approveBankFeed({ tenantKey, assesseeId, feedId, ledgerId, businessPct = 100, learnRule = true, userId }) {
  await ensurePersonalLedgers({ tenantKey, assesseeId, userId });
  const feed = await PersonalBankFeed.findOne({ _id: feedId, tenantKey, assesseeId });
  if (!feed) throw Object.assign(new Error("Bank transaction not found"), { statusCode: 404 });
  if (feed.postedJournalId) return feed;
  const bankLedger = await PersonalLedger.findOne({ tenantKey, assesseeId, bankAccountId: feed.bankAccountId, isBank: true });
  const counter = await PersonalLedger.findOne({ tenantKey, assesseeId, ledgerId: ledgerId || feed.suggestedLedgerId, status: "ACTIVE" });
  if (!bankLedger || !counter) throw Object.assign(new Error("Select a valid bank account and classification ledger"), { statusCode: 400 });
  const amount = round2(Number(feed.debit || feed.credit || 0));
  if (!amount) throw Object.assign(new Error("Transaction amount is zero"), { statusCode: 400 });
  const entries = Number(feed.credit || 0) > 0
    ? [{ ledgerId: bankLedger.ledgerId, ledgerName: bankLedger.name, debit: amount }, { ledgerId: counter.ledgerId, ledgerName: counter.name, credit: amount }]
    : [{ ledgerId: counter.ledgerId, ledgerName: counter.name, debit: amount }, { ledgerId: bankLedger.ledgerId, ledgerName: bankLedger.name, credit: amount }];
  const journal = await postPersonalJournal({ tenantKey, assesseeId, date: feed.date, narration: feed.narration, reference: feed.reference, source: "BANK_IMPORT", sourceId: String(feed._id), entries, aiMeta: { classification: feed.suggestedClassification, confidence: feed.aiConfidence, explanation: feed.aiExplanation, autoPosted: false }, userId, reviewedBy: userId });
  feed.suggestedLedgerId = counter.ledgerId; feed.suggestedLedgerName = counter.name; feed.suggestedBusinessPct = Number(businessPct ?? 100); feed.reviewStatus = "APPROVED"; feed.postedJournalId = journal.journalId; feed.reviewedBy = userId; feed.reviewedAt = new Date();
  await feed.save();
  if (learnRule) {
    const pattern = normalizePattern(feed.narration);
    if (pattern && pattern !== "#") {
      const existingRule = await PersonalAiRule.findOne({ tenantKey, assesseeId, pattern });
      if (existingRule) {
        existingRule.ledgerId = counter.ledgerId;
        existingRule.ledgerName = counter.name;
        existingRule.classification = feed.suggestedClassification || counter.taxCategory || counter.nature;
        existingRule.businessPct = Number(businessPct ?? 100);
        existingRule.active = true;
        existingRule.updatedBy = userId;
        existingRule.lastUsedAt = new Date();
        existingRule.approvedCount = Number(existingRule.approvedCount || 0) + 1;
        await existingRule.save();
      } else {
        await PersonalAiRule.create({ tenantKey, assesseeId, ruleId: makeId("PFR"), pattern, ledgerId: counter.ledgerId, ledgerName: counter.name, classification: feed.suggestedClassification || counter.taxCategory || counter.nature, businessPct: Number(businessPct ?? 100), approvedCount: 1, active: true, createdBy: userId, lastUsedAt: new Date() });
      }
    }
  }
  return feed.toObject();
}

export async function autoPostHighConfidence({ tenantKey, assesseeId, userId }) {
  const feeds = await PersonalBankFeed.find({ tenantKey, assesseeId, reviewStatus: "SUGGESTED", aiConfidence: { $gte: 0.985 }, suggestedLedgerId: { $ne: "SYS-SUSPENSE" } }).limit(200);
  let posted = 0;
  for (const feed of feeds) {
    const pattern = normalizePattern(feed.narration);
    const rule = pattern ? await PersonalAiRule.findOne({ tenantKey, assesseeId, pattern, active: true, approvedCount: { $gte: 2 } }).lean() : null;
    if (!rule) continue;
    try {
      await approveBankFeed({ tenantKey, assesseeId, feedId: feed._id, ledgerId: rule.ledgerId, businessPct: rule.businessPct, learnRule: false, userId });
      await PersonalBankFeed.updateOne({ _id: feed._id }, { $set: { reviewStatus: "AUTO_POSTED" } });
      posted += 1;
    } catch { /* leave for review */ }
  }
  return posted;
}

export async function liveFinancialStatements({ tenantKey, assesseeId, financialYear }) {
  const ledgers = await PersonalLedger.find({ tenantKey, assesseeId, status: "ACTIVE" }).lean();
  const journals = await PersonalJournal.find({ tenantKey, assesseeId, financialYear, status: "POSTED" }).lean();
  const totals = new Map(ledgers.map((l) => [l.ledgerId, { ...l, debit: 0, credit: 0, balance: 0 }]));
  for (const j of journals) for (const e of j.entries || []) {
    if (!totals.has(e.ledgerId)) totals.set(e.ledgerId, { ledgerId: e.ledgerId, name: e.ledgerName || e.ledgerId, nature: "ASSET", statement: "BALANCE_SHEET", debit: 0, credit: 0, balance: 0 });
    const row = totals.get(e.ledgerId); row.debit = round2(row.debit + Number(e.debit || 0)); row.credit = round2(row.credit + Number(e.credit || 0));
  }
  const rows = Array.from(totals.values()).map((r) => ({ ...r, balance: round2(r.debit - r.credit) }));
  const trialBalance = rows.filter((r) => Math.abs(r.balance) > 0.004).map((r) => ({ ledgerId: r.ledgerId, ledgerName: r.name, group: r.group, nature: r.nature, debit: r.balance > 0 ? r.balance : 0, credit: r.balance < 0 ? Math.abs(r.balance) : 0 }));
  const tradingRows = rows.filter((r) => r.statement === "TRADING" && Math.abs(r.balance) > 0.004);
  const pnlRows = rows.filter((r) => r.statement === "PNL" && Math.abs(r.balance) > 0.004);
  const tradingIncome = round2(tradingRows.filter((r) => r.nature === "INCOME").reduce((s, r) => s + Math.max(0, r.credit - r.debit), 0));
  const tradingExpense = round2(tradingRows.filter((r) => r.nature === "EXPENSE").reduce((s, r) => s + Math.max(0, r.debit - r.credit), 0));
  const grossProfit = round2(tradingIncome - tradingExpense);
  const otherIncome = round2(pnlRows.filter((r) => r.nature === "INCOME").reduce((s, r) => s + Math.max(0, r.credit - r.debit), 0));
  const otherExpense = round2(pnlRows.filter((r) => r.nature === "EXPENSE").reduce((s, r) => s + Math.max(0, r.debit - r.credit), 0));
  const netProfit = round2(grossProfit + otherIncome - otherExpense);
  const balanceRows = rows.filter((r) => r.statement === "BALANCE_SHEET" && Math.abs(r.balance) > 0.004);
  const assets = balanceRows.filter((r) => r.nature === "ASSET").map((r) => ({ ...r, amount: round2(Math.max(0, r.debit - r.credit)) })).filter((r) => r.amount);
  const liabilities = balanceRows.filter((r) => ["LIABILITY", "CAPITAL"].includes(r.nature)).map((r) => ({ ...r, amount: round2(Math.max(0, r.credit - r.debit)) })).filter((r) => r.amount);
  const drawings = balanceRows.find((r) => r.ledgerId === "SYS-DRAWINGS");
  const capital = balanceRows.find((r) => r.ledgerId === "SYS-CAPITAL");
  const adjustedCapital = round2(Math.max(0, (capital ? capital.credit - capital.debit : 0) + netProfit - (drawings ? drawings.debit - drawings.credit : 0)));
  const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
  const liabilitiesWithoutCapital = liabilities.filter((r) => r.ledgerId !== "SYS-CAPITAL" && r.ledgerId !== "SYS-DRAWINGS");
  const totalLiabilities = round2(liabilitiesWithoutCapital.reduce((s, r) => s + r.amount, 0) + adjustedCapital);
  return {
    financialYear,
    trialBalance,
    trading: { rows: tradingRows, income: tradingIncome, expenses: tradingExpense, grossProfit },
    pnl: { rows: pnlRows, grossProfit, otherIncome, otherExpense, netProfit },
    balanceSheet: { assets, liabilities: liabilitiesWithoutCapital, capital: adjustedCapital, drawings: drawings ? round2(drawings.debit - drawings.credit) : 0, currentYearProfit: netProfit, totalAssets, totalLiabilities, difference: round2(totalAssets - totalLiabilities) },
  };
}

export async function itrReadiness({ tenantKey, assesseeId, financialYear }) {
  const [assessee, banks, feeds, pendingFeeds, historical, docs, statements] = await Promise.all([
    PersonalAssessee.findOne({ tenantKey, assesseeId }).lean(),
    PersonalBankAccount.find({ tenantKey, assesseeId, status: "ACTIVE" }).lean(),
    PersonalBankFeed.countDocuments({ tenantKey, assesseeId, financialYear }),
    PersonalBankFeed.countDocuments({ tenantKey, assesseeId, financialYear, reviewStatus: { $in: ["PENDING", "SUGGESTED"] } }),
    PersonalHistoricalStatement.find({ tenantKey, assesseeId }).lean(),
    PersonalTaxDocument.find({ tenantKey, assesseeId, financialYear }).lean(),
    liveFinancialStatements({ tenantKey, assesseeId, financialYear }),
  ]);
  const issues = [];
  if (!assessee?.pan) issues.push({ severity: "HIGH", code: "PAN_MISSING", text: "PAN is missing from Assessee Master." });
  if (!banks.length) issues.push({ severity: "HIGH", code: "NO_BANK", text: "No bank account is linked to this assessee." });
  if (pendingFeeds) issues.push({ severity: pendingFeeds > 20 ? "HIGH" : "MEDIUM", code: "BANK_REVIEW", text: `${pendingFeeds} bank transaction(s) still require classification/review.` });
  const bankAssets = new Map((statements.balanceSheet.assets || []).filter((x) => String(x.ledgerId || "").startsWith("BANK-")).map((x) => [String(x.ledgerId).slice(5), Number(x.amount || 0)]));
  let bankReconChecked = 0, bankReconMatched = 0;
  for (const bank of banks) {
    if (!bank.currentBalanceAsOf || bank.currentBalanceSnapshot === null || bank.currentBalanceSnapshot === undefined) continue;
    bankReconChecked += 1;
    const book = Number(bankAssets.get(bank.accountId) || 0), statement = Number(bank.currentBalanceSnapshot || 0), difference = round2(book - statement);
    if (Math.abs(difference) <= 1) bankReconMatched += 1;
    else issues.push({ severity: Math.abs(difference) > 1000 ? "HIGH" : "MEDIUM", code: `BANK_RECON_${bank.accountId}`, text: `${bank.accountName || bank.bankName || "Bank"} differs from last imported statement by ₹${Math.abs(difference).toFixed(2)}.` });
  }
  if (Math.abs(statements.balanceSheet.difference) > 1) issues.push({ severity: "HIGH", code: "BS_DIFF", text: `Balance Sheet differs by ₹${Math.abs(statements.balanceSheet.difference).toFixed(2)}.` });
  const types = new Set(docs.map((d) => d.documentType));
  if (!types.has("AIS")) issues.push({ severity: "MEDIUM", code: "AIS_MISSING", text: "AIS has not been uploaded/reconciled for this financial year." });
  if (!types.has("26AS")) issues.push({ severity: "MEDIUM", code: "26AS_MISSING", text: "Form 26AS has not been uploaded/reconciled for this financial year." });
  const histYears = new Set(historical.map((h) => h.financialYear));
  if (histYears.size < 3) issues.push({ severity: "LOW", code: "HISTORY", text: `Only ${histYears.size} historical financial year(s) imported; three years are recommended for AI comparison.` });
  const bankScore = feeds ? Math.round(((feeds - pendingFeeds) / feeds) * 100) : 0;
  const scores = {
    profile: assessee?.pan ? 100 : 60,
    bankReconciliation: bankReconChecked ? Math.round((bankReconMatched / bankReconChecked) * 100) : bankScore,
    bankClassification: bankScore,
    books: Math.abs(statements.balanceSheet.difference) <= 1 ? 100 : 60,
    ais: types.has("AIS") ? 100 : 0,
    form26as: types.has("26AS") ? 100 : 0,
    history: Math.min(100, Math.round((histYears.size / 3) * 100)),
  };
  const overall = Math.round(Object.values(scores).reduce((s, x) => s + x, 0) / Object.keys(scores).length);
  return { overall, scores, issues, counts: { bankTransactions: feeds, pendingBankTransactions: pendingFeeds, banks: banks.length, historicalYears: histYears.size, taxDocuments: docs.length }, statements };
}

export async function familyDashboard({ tenantKey, financialYear }) {
  const assessees = await PersonalAssessee.find({ tenantKey, status: "ACTIVE" }).sort({ displayName: 1 }).lean();
  const rows = [];
  for (const a of assessees) {
    await ensurePersonalLedgers({ tenantKey, assesseeId: a.assesseeId });
    const [s, readiness, banks] = await Promise.all([
      liveFinancialStatements({ tenantKey, assesseeId: a.assesseeId, financialYear }),
      itrReadiness({ tenantKey, assesseeId: a.assesseeId, financialYear }),
      PersonalBankAccount.find({ tenantKey, assesseeId: a.assesseeId, status: "ACTIVE" }).lean(),
    ]);
    const bankLedgerIds = new Set(banks.map((b) => `BANK-${b.accountId}`));
    const bankTotal = s.balanceSheet.assets.filter((x) => bankLedgerIds.has(x.ledgerId)).reduce((sum, x) => sum + x.amount, 0);
    const investmentTotal = s.balanceSheet.assets.filter((x) => x.ledgerId === "SYS-INVESTMENT").reduce((sum, x) => sum + x.amount, 0);
    const propertyTotal = s.balanceSheet.assets.filter((x) => x.ledgerId === "SYS-PROPERTY").reduce((sum, x) => sum + x.amount, 0);
    rows.push({ assesseeId: a.assesseeId, name: a.displayName, entityType: a.entityType, pan: a.pan, bankAccounts: banks.length, bankBalance: round2(bankTotal), investments: round2(investmentTotal), property: round2(propertyTotal), netProfit: s.pnl.netProfit, netWorth: round2(s.balanceSheet.totalAssets - s.balanceSheet.liabilities.reduce((sum, x) => sum + x.amount, 0)), itrReadiness: readiness.overall, pendingReview: readiness.counts.pendingBankTransactions, issues: readiness.issues.length });
  }
  return { financialYear, rows, totals: { bankBalance: round2(rows.reduce((s, r) => s + r.bankBalance, 0)), investments: round2(rows.reduce((s, r) => s + r.investments, 0)), property: round2(rows.reduce((s, r) => s + r.property, 0)), netWorth: round2(rows.reduce((s, r) => s + r.netWorth, 0)), pendingReview: rows.reduce((s, r) => s + r.pendingReview, 0) } };
}

export async function reconcileTaxDocuments({ tenantKey, assesseeId, financialYear }) {
  const docs = await PersonalTaxDocument.find({ tenantKey, assesseeId, financialYear, documentType: { $in: ["AIS", "26AS", "FORM16", "FORM16A"] } }).lean();
  const statements = await liveFinancialStatements({ tenantKey, assesseeId, financialYear });
  const incomeLedgers = [...statements.trading.rows, ...statements.pnl.rows].filter((r) => r.nature === "INCOME");
  const bookIncome = round2(incomeLedgers.reduce((s, r) => s + Math.max(0, r.credit - r.debit), 0));
  const byType = {};
  for (const d of docs) {
    const bucket = byType[d.documentType] || { income: 0, tds: 0, documents: 0 };
    bucket.documents += 1;
    for (const item of d.items || []) {
      bucket.income += n(item.amount ?? item.incomeAmount ?? item.transactionAmount ?? item.value);
      bucket.tds += n(item.taxDeducted ?? item.tds ?? item.tax);
    }
    const v = d.extractedValues || {};
    if (!bucket.income) bucket.income += n(v.totalIncomeReported);
    if (!bucket.tds) bucket.tds += n(v.totalTaxDeducted);
    byType[d.documentType] = bucket;
  }
  for (const bucket of Object.values(byType)) { bucket.income = round2(bucket.income); bucket.tds = round2(bucket.tds); }
  const reportedIncome = Number(byType.AIS?.income || byType["26AS"]?.income || byType.FORM16?.income || 0);
  const reportedTds = round2(Math.max(Number(byType["26AS"]?.tds || 0), Number(byType.AIS?.tds || 0), Number(byType.FORM16?.tds || 0) + Number(byType.FORM16A?.tds || 0)));
  const difference = round2(bookIncome - reportedIncome);
  return { financialYear, bookIncome, reportedIncome: round2(reportedIncome), difference, reportedTds, documentCount: docs.length, byType, status: reportedIncome && Math.abs(difference) <= 1 ? "MATCHED" : "REVIEW" };
}

export const pfNumber = n;
