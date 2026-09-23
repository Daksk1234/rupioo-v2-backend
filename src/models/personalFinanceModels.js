import mongoose from "mongoose";

const { Schema } = mongoose;
const getModel = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

const ledgerLinkSchema = new Schema({
  ledgerId: String,
  ledgerCode: String,
  ledgerName: String,
  purpose: String,
}, { _id: false });

const assesseeSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  displayName: { type: String, required: true, index: true },
  legalName: String,
  entityType: { type: String, enum: ["INDIVIDUAL", "HUF", "OTHER"], default: "INDIVIDUAL", index: true },
  relation: String,
  pan: { type: String, index: true },
  aadhaarLast4: String,
  dateOfBirth: Date,
  email: String,
  mobile: String,
  address: String,
  residentialStatus: { type: String, default: "RESIDENT" },
  taxRegime: { type: String, default: "AUTO" },
  itrPreference: { type: String, default: "AUTO" },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true },
  openingFinancialYear: String,
  notes: String,
  ledgers: [ledgerLinkSchema],
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
assesseeSchema.index({ tenantKey: 1, assesseeId: 1 }, { unique: true });
assesseeSchema.index({ tenantKey: 1, pan: 1 }, { unique: true, sparse: true });

const bankAccountSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  accountId: { type: String, required: true, index: true },
  accountName: String,
  bankName: String,
  branchName: String,
  accountNumber: String,
  accountNumberMasked: String,
  ifsc: String,
  accountType: { type: String, default: "SAVINGS" },
  openingBalance: { type: Number, default: 0 },
  openingBalanceType: { type: String, enum: ["DR", "CR"], default: "DR" },
  openingBalanceDate: Date,
  currentBalanceSnapshot: Number,
  currentBalanceAsOf: Date,
  statementImportCount: { type: Number, default: 0 },
  status: { type: String, default: "ACTIVE", index: true },
  notes: String,
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
bankAccountSchema.index({ tenantKey: 1, assesseeId: 1, accountId: 1 }, { unique: true });

const ledgerSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  ledgerId: { type: String, required: true, index: true },
  code: String,
  name: { type: String, required: true, index: true },
  group: String,
  nature: { type: String, enum: ["ASSET", "LIABILITY", "CAPITAL", "INCOME", "EXPENSE"], required: true, index: true },
  statement: { type: String, enum: ["BALANCE_SHEET", "TRADING", "PNL"], required: true, index: true },
  taxCategory: String,
  isBank: { type: Boolean, default: false },
  bankAccountId: String,
  system: { type: Boolean, default: false },
  status: { type: String, default: "ACTIVE", index: true },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
ledgerSchema.index({ tenantKey: 1, assesseeId: 1, ledgerId: 1 }, { unique: true });
ledgerSchema.index({ tenantKey: 1, assesseeId: 1, name: 1 }, { unique: true });

const journalEntrySchema = new Schema({
  ledgerId: { type: String, required: true },
  ledgerName: String,
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  memo: String,
}, { _id: false });

const journalSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  journalId: { type: String, required: true, index: true },
  financialYear: { type: String, required: true, index: true },
  date: { type: Date, required: true, index: true },
  narration: String,
  reference: String,
  source: { type: String, default: "MANUAL", index: true },
  sourceId: String,
  documentId: String,
  entries: [journalEntrySchema],
  totalDebit: Number,
  totalCredit: Number,
  status: { type: String, enum: ["POSTED", "REVERSED", "DRAFT"], default: "POSTED", index: true },
  aiMeta: {
    classification: String,
    confidence: Number,
    ruleId: String,
    explanation: String,
    autoPosted: Boolean,
  },
  createdBy: String,
  reviewedBy: String,
  reviewedAt: Date,
}, { timestamps: true });
journalSchema.index({ tenantKey: 1, assesseeId: 1, journalId: 1 }, { unique: true });
journalSchema.index({ tenantKey: 1, assesseeId: 1, date: 1, sourceId: 1 });

const bankFeedSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  bankAccountId: { type: String, required: true, index: true },
  importId: { type: String, required: true, index: true },
  rowNo: Number,
  financialYear: { type: String, index: true },
  date: { type: Date, required: true, index: true },
  valueDate: Date,
  narration: String,
  reference: String,
  debit: { type: Number, default: 0 },
  credit: { type: Number, default: 0 },
  balance: Number,
  fingerprint: { type: String, required: true, index: true },
  suggestedLedgerId: String,
  suggestedLedgerName: String,
  suggestedClassification: String,
  suggestedBusinessPct: { type: Number, default: 100 },
  aiConfidence: { type: Number, default: 0 },
  aiExplanation: String,
  transferMatchFeedId: String,
  reviewStatus: { type: String, enum: ["PENDING", "SUGGESTED", "APPROVED", "AUTO_POSTED", "IGNORED", "DUPLICATE"], default: "PENDING", index: true },
  postedJournalId: String,
  raw: Schema.Types.Mixed,
  reviewedBy: String,
  reviewedAt: Date,
}, { timestamps: true });
bankFeedSchema.index({ tenantKey: 1, assesseeId: 1, fingerprint: 1 }, { unique: true });
bankFeedSchema.index({ tenantKey: 1, assesseeId: 1, reviewStatus: 1, date: -1 });

const ruleSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  ruleId: { type: String, required: true, index: true },
  pattern: { type: String, required: true, index: true },
  ledgerId: { type: String, required: true },
  ledgerName: String,
  classification: String,
  businessPct: { type: Number, default: 100 },
  approvedCount: { type: Number, default: 1 },
  lastUsedAt: Date,
  active: { type: Boolean, default: true, index: true },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
ruleSchema.index({ tenantKey: 1, assesseeId: 1, pattern: 1 }, { unique: true });

const historicalStatementSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  statementId: { type: String, required: true, index: true },
  financialYear: { type: String, required: true, index: true },
  statementType: { type: String, enum: ["BALANCE_SHEET", "TRADING", "PNL", "TRIAL_BALANCE"], required: true, index: true },
  sourceFileId: String,
  sourceFileName: String,
  extractionEngine: String,
  status: { type: String, enum: ["EXTRACTED", "REVIEWED", "APPLIED"], default: "EXTRACTED", index: true },
  items: [{ section: String, particular: String, amount: Number, side: String, mappedLedgerId: String, mappedLedgerName: String, confidence: Number, _id: false }],
  totals: Schema.Types.Mixed,
  warnings: [String],
  appliedJournalIds: [String],
  createdBy: String,
  reviewedBy: String,
  reviewedAt: Date,
}, { timestamps: true });
historicalStatementSchema.index({ tenantKey: 1, assesseeId: 1, financialYear: 1, statementType: 1, statementId: 1 }, { unique: true });

const taxDocumentSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  documentId: { type: String, required: true, index: true },
  financialYear: { type: String, index: true },
  assessmentYear: String,
  documentType: { type: String, enum: ["AIS", "26AS", "FORM16", "FORM16A", "TAX_CHALLAN", "LOAN_STATEMENT", "DEMAT", "CAPITAL_GAIN", "PROPERTY", "INSURANCE", "OTHER"], required: true, index: true },
  fileId: String,
  fileName: String,
  extractionEngine: String,
  extractedValues: Schema.Types.Mixed,
  items: [Schema.Types.Mixed],
  confidence: Schema.Types.Mixed,
  warnings: [String],
  status: { type: String, enum: ["EXTRACTED", "REVIEWED", "RECONCILED"], default: "EXTRACTED", index: true },
  createdBy: String,
  reviewedBy: String,
  reviewedAt: Date,
}, { timestamps: true });
taxDocumentSchema.index({ tenantKey: 1, assesseeId: 1, documentId: 1 }, { unique: true });

const yearLockSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  assesseeId: { type: String, required: true, index: true },
  financialYear: { type: String, required: true, index: true },
  status: { type: String, enum: ["OPEN", "READY", "FILED", "LOCKED", "REOPENED"], default: "OPEN", index: true },
  itrForm: String,
  acknowledgementNo: String,
  filedAt: Date,
  lockedAt: Date,
  lockedBy: String,
  reopenedAt: Date,
  reopenedBy: String,
  reopenReason: String,
}, { timestamps: true });
yearLockSchema.index({ tenantKey: 1, assesseeId: 1, financialYear: 1 }, { unique: true });

export const PersonalAssessee = getModel("PersonalAssessee", assesseeSchema);
export const PersonalBankAccount = getModel("PersonalBankAccount", bankAccountSchema);
export const PersonalLedger = getModel("PersonalLedger", ledgerSchema);
export const PersonalJournal = getModel("PersonalJournal", journalSchema);
export const PersonalBankFeed = getModel("PersonalBankFeed", bankFeedSchema);
export const PersonalAiRule = getModel("PersonalAiRule", ruleSchema);
export const PersonalHistoricalStatement = getModel("PersonalHistoricalStatement", historicalStatementSchema);
export const PersonalTaxDocument = getModel("PersonalTaxDocument", taxDocumentSchema);
export const PersonalYearLock = getModel("PersonalYearLock", yearLockSchema);
