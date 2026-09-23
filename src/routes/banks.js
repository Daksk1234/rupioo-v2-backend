import express from "express";
import multer from "multer";
import crypto from "crypto";
import { BankAccount, CompanyLedger, CompanyProfile, CustomerLink, GlobalCustomer, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { syncBankAccountLedger } from "../services/companyAccountingService.js";
import { resolveBankDetails } from "../services/ifscMasterService.js";
import { financialModels, postBalancedEntries } from "../services/accountingService.js";
import { readRows, resolveColumns, valueFor } from "../utils/bulkSpreadsheet.js";
import { resolvePartyDisplayMap, resolveUserDisplayMap } from "../services/transactionDisplayService.js";
import { financialYearFromDate } from "../utils/financialYear.js";

const router = express.Router();
router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();
const normalizeAccount = (value) => clean(value).replace(/\s+/g, "");
const normalizeName = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const allowedTypes = new Set(["CURRENT", "SAVINGS", "OD", "CC", "OTHER"]);
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const objectIdText = (v) => /^[a-fA-F0-9]{24}$/.test(clean(v));

async function loadGlobalsForRefs(ids = []) {
  const refs=[...new Set(ids.map(clean).filter(Boolean))];
  if(!refs.length)return [];
  const objectIds=refs.filter(objectIdText);
  return GlobalCustomer.find({$or:[{hiddenId:{$in:refs}},...(objectIds.length?[{_id:{$in:objectIds}}]:[])]}).select("hiddenId legalName tradeName").lean();
}

function validateBody(body = {}) {
  const accountHolderName = clean(body.accountHolderName);
  const accountNumber = normalizeAccount(body.accountNumber);
  const ifsc = upper(body.ifsc);
  const accountType = upper(body.accountType || "CURRENT");
  if (!ifsc) return "IFSC code is mandatory";
  if (!accountHolderName) return "Account holder name is required";
  if (!accountNumber) return "Account number is required";
  if (accountNumber.length < 6 || accountNumber.length > 34) return "Account number must be between 6 and 34 characters";
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return "Enter a valid IFSC code";
  if (!allowedTypes.has(accountType)) return "Select a valid account type";
  return "";
}

async function ensureDefaultFinancialYear(tenantKey, financialYear) {
  if (financialYear) return financialYear;
  const profile = await CompanyProfile.findOne({ tenantKey }).select("financialYear financialYears").lean();
  return profile?.financialYear || profile?.financialYears?.[0] || "";
}

function normalizedOpeningRows(body = {}, fallback = []) {
  const incoming = Array.isArray(body.openingBalances) ? body.openingBalances : [];
  const map = new Map();
  for (const row of [...fallback, ...incoming]) {
    const fy = clean(row?.financialYear);
    if (!fy) continue;
    map.set(fy, {
      financialYear: fy,
      amount: Math.abs(Number(row?.amount || 0)),
      type: upper(row?.type) === "CR" ? "CR" : "DR",
      source: upper(row?.source || "MANUAL"),
      updatedAt: row?.updatedAt || new Date(),
      updatedBy: clean(row?.updatedBy || body.updatedBy),
    });
  }
  const legacyFy = clean(body.financialYear);
  if (legacyFy && !map.has(legacyFy)) {
    map.set(legacyFy, {
      financialYear: legacyFy,
      amount: Math.abs(Number(body.openingBalance || 0)),
      type: upper(body.openingBalanceType) === "CR" ? "CR" : "DR",
      source: "MANUAL",
      updatedAt: new Date(),
      updatedBy: clean(body.updatedBy),
    });
  }
  return [...map.values()].sort((a,b)=>String(a.financialYear).localeCompare(String(b.financialYear)));
}

function openingForYear(bank, financialYear) {
  const row = (bank?.openingBalances || []).find(x => clean(x.financialYear) === clean(financialYear));
  if (row) return { exists:true, amount:Number(row.amount || 0), type:row.type === "CR" ? "CR" : "DR", source:row.source || "MANUAL" };
  if (clean(bank?.financialYear) === clean(financialYear)) return { exists:true, amount:Number(bank.openingBalance || 0), type:bank.openingBalanceType === "CR" ? "CR" : "DR", source:"LEGACY" };
  return { exists:false, amount:0, type:"DR", source:"" };
}

function financialYearBounds(financialYear) {
  const m = /^(\d{4})-(\d{2}|\d{4})$/.exec(clean(financialYear));
  if (!m) return null;
  const startYear = Number(m[1]);
  const endYear = m[2].length === 2 ? Math.floor(startYear / 100) * 100 + Number(m[2]) : Number(m[2]);
  return { start:new Date(startYear,3,1,0,0,0,0), end:new Date(endYear,2,31,23,59,59,999) };
}

function parseStatementDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const text = clean(value);
  if (!text) return null;
  let m = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(text);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  m = /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/.exec(text);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function validateRunningOrder(rows) {
  if (!rows.length) return { ok:true, rows, statementOpening:0 };
  const first = rows[0];
  const statementOpening = round2(first.runningBalance + first.debit - first.credit);
  let previous = first.runningBalance;
  const errors = [];
  for (let i=1;i<rows.length;i++) {
    const expected = round2(previous - rows[i].debit + rows[i].credit);
    if (Math.abs(expected - rows[i].runningBalance) > 0.06) errors.push({ row:rows[i].rowNo, expected, actual:rows[i].runningBalance });
    previous = rows[i].runningBalance;
  }
  return { ok:!errors.length, rows, statementOpening, errors };
}

function parseStatementAmount(value,{signedBalance=false}={}) {
  if (value === null || value === undefined || clean(value) === "") return null;
  const raw = clean(value).replace(/,/g, "").replace(/[₹$]/g, "");
  const paren = /^\((.*)\)$/.exec(raw);
  const text = paren ? paren[1] : raw;
  const match = text.match(/[-+]?\d+(?:\.\d+)?/);
  if (!match) return null;
  let amount = Number(match[0]);
  if (!Number.isFinite(amount)) return null;
  if (paren) amount = -Math.abs(amount);
  if (signedBalance) {
    if (/\bDR\b/i.test(text)) amount = -Math.abs(amount);
    else if (/\bCR\b/i.test(text)) amount = Math.abs(amount);
  }
  return amount;
}

function normalizeStatementMode(rawMode, remarks) {
  const modeText = upper(rawMode);
  const remarkText = upper(remarks);
  if (modeText.includes("CASH") || /(^|[^A-Z])CASH([^A-Z]|$)/.test(remarkText)) return "CASH";
  return "BANK";
}

function extractPartyHintFromRemarks(remarks) {
  const text = clean(remarks).replace(/\r?\n/g, " ").replace(/\s+/g, " ");
  if (!text) return "";
  const dash = text.search(/\s+-\s+/);
  if (dash > 0) return clean(text.slice(0,dash));
  return "";
}

function isLegacyTemplateSampleRow(row, cols) {
  const remarks = normalizeName(valueFor(row, cols.remarks));
  return remarks === "NEFT FROM ABC TRADERS A C 1234567890" || remarks === "RTGS TO XYZ SUPPLIER A C 9876543210";
}

function normalizeStatementRows(rawRows, cols) {
  const out=[];
  const errors=[];
  let openingBalanceHint=null;
  let ignoredOpeningRows=0;
  let ignoredTemplateRows=0;
  for (let i=0;i<rawRows.length;i++) {
    const row=rawRows[i];
    const rowNo=i+2;
    const sourcePartyName = clean(valueFor(row, cols.partyName));
    const remarks = clean(valueFor(row, cols.remarks));
    const rawDate = valueFor(row, cols.date);
    const rawDebit = cols.debit ? row[cols.debit] : "";
    const rawCredit = cols.credit ? row[cols.credit] : "";
    const rawBalance = cols.runningBalance ? row[cols.runningBalance] : "";

    const blankRow = !clean(rawDate) && !sourcePartyName && !remarks && !clean(rawDebit) && !clean(rawCredit) && !clean(rawBalance);
    if (blankRow) continue;

    if (isLegacyTemplateSampleRow(row, cols)) { ignoredTemplateRows++; continue; }

    const openingRow = !clean(rawDate) && /^OPENING\s+BALANCE\b/i.test(remarks);
    if (openingRow) {
      const parsedOpening = parseStatementAmount(rawBalance,{signedBalance:true});
      if (parsedOpening !== null) openingBalanceHint=round2(parsedOpening);
      ignoredOpeningRows++;
      continue;
    }

    const date = parseStatementDate(rawDate);
    const partyHint = sourcePartyName || extractPartyHintFromRemarks(remarks);
    const mode = normalizeStatementMode(valueFor(row, cols.mode), remarks);
    const debitParsed = parseStatementAmount(rawDebit);
    const creditParsed = parseStatementAmount(rawCredit);
    const balanceParsed = parseStatementAmount(rawBalance,{signedBalance:true});
    const debit = Math.max(0, Number(debitParsed ?? 0));
    const credit = Math.max(0, Number(creditParsed ?? 0));

    if (!date) { errors.push({row:rowNo,error:"Invalid date"}); continue; }
    if ((debit > 0 && credit > 0) || (debit <= 0 && credit <= 0)) { errors.push({row:rowNo,error:"Enter either Debit or Credit, not both"}); continue; }
    if (balanceParsed === null || !Number.isFinite(Number(balanceParsed))) { errors.push({row:rowNo,error:"Running Balance is required"}); continue; }
    out.push({rowNo,date,sourcePartyName,partyName:partyHint,partyHint,remarks,mode,debit:round2(debit),credit:round2(credit),runningBalance:round2(balanceParsed)});
  }
  return {rows:out,errors,openingBalanceHint,ignoredOpeningRows,ignoredTemplateRows};
}


const normalizeBankAccountKey = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

async function buildSmartPartyMatcher(tenantKey) {
  const [links,users,userLedgers,customerLedgers] = await Promise.all([
    CustomerLink.find({tenantKey,status:{$nin:["INACTIVE","DEACTIVATED"]}}).lean(),
    User.find({tenantKey,status:"ACTIVE"})
      .select("name email mobile accountType tallyAccountTypeName tallyAccountTypeCode accountingRequired accountingMappings bankDetails loginEnabled systemManaged systemKey")
      .lean(),
    CompanyLedger.find({tenantKey,ownerType:"USER",status:{$ne:"INACTIVE"}}).lean(),
    CompanyLedger.find({tenantKey,ownerType:"CUSTOMER",status:{$ne:"INACTIVE"}}).lean()
  ]);

  const ids=[...new Set(links.map(x=>x.globalCustomerId).filter(Boolean))];
  const globals=ids.length?await loadGlobalsForRefs(ids):[];
  const gm=new Map();for(const x of globals){if(x.hiddenId)gm.set(String(x.hiddenId),x);if(x._id)gm.set(String(x._id),x);}

  const userLedgerByOwner=new Map();
  for(const ledger of userLedgers){
    const key=String(ledger.ownerId||"");
    if(!userLedgerByOwner.has(key))userLedgerByOwner.set(key,[]);
    userLedgerByOwner.get(key).push(ledger);
  }
  const customerLedgerByOwner=new Map();
  for(const ledger of customerLedgers){
    const key=String(ledger.ownerId||"");
    if(!customerLedgerByOwner.has(key))customerLedgerByOwner.set(key,[]);
    customerLedgerByOwner.get(key).push(ledger);
  }

  const entries=[];
  const byId=new Map();
  const accountMap=new Map();

  const registerEntry=(entry)=>{
    entries.push(entry);
    byId.set(String(entry.ref),entry);
    for(const acc of entry.accountNumbers||[]){
      if(!accountMap.has(acc))accountMap.set(acc,[]);
      accountMap.get(acc).push(entry);
    }
  };

  for(const link of links){
    const global=gm.get(String(link.globalCustomerId));
    const preferred=clean(link.localName||global?.tradeName||global?.legalName||link.displayIdentifier||link.globalCustomerId);
    const aliases=[link.localName,link.displayIdentifier,global?.tradeName,global?.legalName]
      .map(normalizeName).filter(Boolean);
    const accountNumbers=(Array.isArray(link.bankDetails)?link.bankDetails:[])
      .map(x=>normalizeBankAccountKey(x?.accountNumber)).filter(x=>x.length>=6);
    const partyAccountCode=clean(link.accountingProfile?.systemAccountCode) || (["CREDITOR","SUPPLIER"].includes(upper(link.partyType))?"SYS_SUNDRY_CREDITORS":"SYS_SUNDRY_DEBTORS");
    const ledger=(customerLedgerByOwner.get(String(link.globalCustomerId))||[]).find(x=>String(x.systemAccountCode||"")===partyAccountCode)
      ||(customerLedgerByOwner.get(String(link.globalCustomerId))||[])[0]
      ||null;
    registerEntry({
      ref:String(link.globalCustomerId),
      ownerType:"CUSTOMER",
      ownerId:String(link.globalCustomerId),
      link,
      preferred,
      aliases,
      accountNumbers,
      partyAccountCode,
      ledgerId:clean(ledger?.ledgerId),
      accountTypeLabel:clean(link.partyType)||"CUSTOMER"
    });
  }

  const hasSystemCashCustomer=links.some(link=>String(link.systemKey||"").toUpperCase()==="CASH");

  for(const user of users){
    if(hasSystemCashCustomer && String(user.systemKey||"").toUpperCase()==="CASH")continue;
    const ownerId=String(user._id||"");
    if(!ownerId)continue;
    const activeMapping=(user.accountingMappings||[]).find(x=>upper(x?.status)!=="INACTIVE")
      ||(user.accountingMappings||[])[0]
      ||null;
    const userLedgersForOwner=userLedgerByOwner.get(ownerId)||[];
    const desiredCode=clean(activeMapping?.systemAccountCode||user.tallyAccountTypeCode);
    const ledger=userLedgersForOwner.find(x=>!desiredCode||String(x.systemAccountCode||"")===desiredCode)
      ||userLedgersForOwner[0]
      ||null;
    const partyAccountCode=clean(ledger?.systemAccountCode||activeMapping?.systemAccountCode||user.tallyAccountTypeCode)||"SYS_SUSPENSE";
    const preferred=clean(user.name||activeMapping?.ledgerName||ledger?.name||ownerId);
    const aliases=[
      user.name,
      activeMapping?.ledgerName,
      ledger?.name
    ].map(normalizeName).filter(Boolean);
    const accountNumbers=[normalizeBankAccountKey(user.bankDetails?.accountNumber)]
      .filter(x=>x.length>=6);
    registerEntry({
      ref:`USER:${ownerId}`,
      ownerType:"USER",
      ownerId,
      user,
      preferred,
      aliases,
      accountNumbers,
      partyAccountCode,
      ledgerId:clean(ledger?.ledgerId),
      accountTypeLabel:clean(user.tallyAccountTypeName||user.accountType||partyAccountCode||"USER")
    });
  }

  const uniqueEntry=(arr=[])=>{
    const m=new Map(); for(const x of arr)m.set(String(x.ref),x);
    return [...m.values()];
  };

  const detect=(row={})=>{
    const remarks=clean(row.remarks); const partyName=clean(row.partyHint||row.partyName);
    const accountTokens=[...new Set((remarks.toUpperCase().match(/[A-Z0-9]{6,34}/g)||[]).map(normalizeBankAccountKey).filter(x=>x.length>=6))];
    const compactRemarks=normalizeBankAccountKey(remarks);
    const accountMatches=uniqueEntry([
      ...accountTokens.flatMap(x=>accountMap.get(x)||[]),
      ...entries.filter(e=>e.accountNumbers.some(acc=>compactRemarks.includes(acc)))
    ]);
    if(accountMatches.length===1)return {entry:accountMatches[0],confidence:100,source:"ACCOUNT_NO_IN_REMARKS",candidateCount:1};
    if(accountMatches.length>1)return {entry:null,confidence:0,source:"AMBIGUOUS_ACCOUNT_NO",candidateCount:accountMatches.length};

    const remarkKey=normalizeName(remarks);
    if(remarkKey){
      const nameMatches=uniqueEntry(entries.filter(e=>e.aliases.some(a=>a.length>=4&&remarkKey.includes(a))));
      if(nameMatches.length===1)return {entry:nameMatches[0],confidence:94,source:nameMatches[0].ownerType==="USER"?"USER_NAME_IN_REMARKS":"NAME_IN_REMARKS",candidateCount:1};
      if(nameMatches.length>1)return {entry:null,confidence:0,source:"AMBIGUOUS_NAME_IN_REMARKS",candidateCount:nameMatches.length};
    }

    const partyKey=normalizeName(partyName);
    if(partyKey){
      const exact=uniqueEntry(entries.filter(e=>e.aliases.includes(partyKey)));
      if(exact.length===1)return {entry:exact[0],confidence:90,source:exact[0].ownerType==="USER"?"USER_COLUMN_EXACT":"PARTY_COLUMN_EXACT",candidateCount:1};
      if(exact.length>1)return {entry:null,confidence:0,source:"AMBIGUOUS_PARTY_COLUMN",candidateCount:exact.length};
      const fuzzy=uniqueEntry(entries.filter(e=>e.aliases.some(a=>a.length>=5&&(partyKey.includes(a)||a.includes(partyKey)))));
      if(fuzzy.length===1)return {entry:fuzzy[0],confidence:76,source:fuzzy[0].ownerType==="USER"?"USER_COLUMN_FUZZY":"PARTY_COLUMN_FUZZY",candidateCount:1};
      if(fuzzy.length>1)return {entry:null,confidence:0,source:"AMBIGUOUS_PARTY_COLUMN",candidateCount:fuzzy.length};
    }
    return {entry:null,confidence:0,source:"NO_MATCH",candidateCount:0};
  };
  return {detect,byId,entries};
}
function statementFingerprint(financialYear,bankAccountId,row){
  return crypto.createHash("sha256").update([
    financialYear,bankAccountId,row.date.toISOString().slice(0,10),normalizeName(row.sourcePartyName ?? row.partyName),normalizeName(row.remarks),row.mode,
    Number(row.debit||0).toFixed(2),Number(row.credit||0).toFixed(2),Number(row.runningBalance||0).toFixed(2)
  ].join("|")).digest("hex");
}

async function buildPartyMatcher(tenantKey) {
  const links = await CustomerLink.find({tenantKey,status:{$nin:["INACTIVE","DEACTIVATED"]}}).lean();
  const ids=[...new Set(links.map(x=>x.globalCustomerId).filter(Boolean))];
  const globals=ids.length?await loadGlobalsForRefs(ids):[];
  const gm=new Map();for(const x of globals){if(x.hiddenId)gm.set(String(x.hiddenId),x);if(x._id)gm.set(String(x._id),x);}
  const aliasMap=new Map();
  const entries=[];
  for(const link of links){
    const global=gm.get(String(link.globalCustomerId));
    const preferred=clean(link.localName||global?.tradeName||global?.legalName||link.displayIdentifier||link.globalCustomerId);
    const aliases=[link.localName,link.displayIdentifier,global?.tradeName,global?.legalName].map(normalizeName).filter(Boolean);
    const partyAccountCode=clean(link.accountingProfile?.systemAccountCode) || (["CREDITOR","SUPPLIER"].includes(upper(link.partyType))?"SYS_SUNDRY_CREDITORS":"SYS_SUNDRY_DEBTORS");
    const entry={link,preferred,aliases,partyAccountCode}; entries.push(entry);
    for(const alias of aliases){ if(!aliasMap.has(alias))aliasMap.set(alias,[]); aliasMap.get(alias).push(entry); }
  }
  return (rawName)=>{
    const key=normalizeName(rawName); if(!key)return null;
    const exact=aliasMap.get(key)||[]; if(exact.length===1)return exact[0];
    const candidates=entries.filter(e=>e.aliases.some(a=>a.length>=5&&(key.includes(a)||a.includes(key))));
    const unique=[...new Set(candidates.map(x=>x.link.globalCustomerId))];
    if(unique.length===1)return candidates.sort((a,b)=>Math.max(...b.aliases.map(x=>x.length))-Math.max(...a.aliases.map(x=>x.length)))[0];
    return null;
  };
}

async function upsertOpeningBalance(bank, financialYear, amount, type, source, userId) {
  const rows = normalizedOpeningRows({openingBalances:[{financialYear,amount,type,source,updatedAt:new Date(),updatedBy:userId}],updatedBy:userId}, bank.openingBalances || []);
  bank.openingBalances = rows;
  bank.financialYear = financialYear;
  bank.openingBalance = Math.abs(Number(amount || 0));
  bank.openingBalanceType = type === "CR" ? "CR" : "DR";
  bank.updatedBy = userId;
  await bank.save();
  const ledger=await syncBankAccountLedger(bank);
  if(ledger && !bank.ledgerId){bank.ledgerId=ledger.ledgerId;await bank.save();}
  return bank;
}

router.get("/", async (req, res) => {
  const tenantKey = req.auth.tenantKey;
  const q = clean(req.query.q);
  const status = upper(req.query.status || "ACTIVE");
  const financialYear = clean(req.query.financialYear);
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.max(10, Math.min(200, Number(req.query.limit || 50)));
  const filter = { tenantKey };
  if (status && status !== "ALL") filter.status = status; else filter.status = { $ne: "DELETED" };
  if (q) filter.$or = [{ bankName:new RegExp(q,"i") },{ branchName:new RegExp(q,"i") },{ accountHolderName:new RegExp(q,"i") },{ accountNumber:new RegExp(q,"i") },{ ifsc:new RegExp(q,"i") }];
  const [rawItems,total]=await Promise.all([BankAccount.find(filter).sort({isPrimary:-1,bankName:1,createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),BankAccount.countDocuments(filter)]);
  const items=rawItems.map(row=>{const fy=financialYear?openingForYear(row,financialYear):null;return fy?{...row,fyOpeningBalance:fy.amount,fyOpeningBalanceType:fy.type,fyOpeningConfigured:fy.exists}:row;});
  return ok(res,{items,meta:{page,limit,total,pages:Math.max(1,Math.ceil(total/limit))}});
});

router.get("/:id/statement-imports", async (req,res)=>{
  const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:{$ne:"DELETED"}}).lean();
  if(!bank)return fail(res,"Bank account not found",404);
  const fy=clean(req.query.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");
  const {BankStatementImport}=financialModels(req.auth.tenantKey,fy);
  const rows=await BankStatementImport.find({tenantKey:req.auth.tenantKey,financialYear:fy,bankAccountId:bank.bankAccountId}).sort({createdAt:-1}).limit(25).lean();
  return ok(res,rows);
});

router.put("/:id/opening-balance", async (req,res)=>{
  const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:{$ne:"DELETED"}});
  if(!bank)return fail(res,"Bank account not found",404);
  const financialYear=clean(req.body.financialYear); if(!financialYear)return fail(res,"Financial Year is required",400);
  const amount=Math.abs(Number(req.body.amount||0)); if(!Number.isFinite(amount))return fail(res,"Enter a valid opening balance",400);
  const type=upper(req.body.type)==="CR"?"CR":"DR";
  await upsertOpeningBalance(bank,financialYear,amount,type,"MANUAL",req.auth.sub);
  return ok(res,openingForYear(bank,financialYear),`Opening balance saved for ${financialYear}`);
});


router.get("/transactions", async (req,res)=>{
  const financialYear=clean(req.query.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");
  if(!financialYear)return fail(res,"Select Financial Year",400);
  const {BankStatementRow,BankStatementImport,Receipt,Payment}=financialModels(req.auth.tenantKey,financialYear);
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.max(10,Math.min(200,Number(req.query.limit||50)));
  const q=clean(req.query.q),bankAccountId=clean(req.query.bankAccountId),type=upper(req.query.type||"ALL");
  const rx=q?new RegExp(q,"i"):null;
  const statementFilter={tenantKey:req.auth.tenantKey,financialYear,transactionId:{$nin:[null,""]},classification:{$in:["POSTED","SUSPENSE","UNMATCHED"]}};
  if(bankAccountId)statementFilter.bankAccountId=bankAccountId;
  if(["RECEIPT","PAYMENT"].includes(type))statementFilter.transactionType=type;
  if(rx)statementFilter.$or=[{matchedPartyName:rx},{partyName:rx},{remarks:rx},{mode:rx},{transactionId:rx}];
  const manualBase={tenantKey:req.auth.tenantKey,financialYear,$or:[{statementImportId:{$exists:false}},{statementImportId:""},{statementImportId:null}]};
  if(bankAccountId)manualBase.bankAccountId=bankAccountId;
  const receiptFilter={...manualBase},paymentFilter={...manualBase};
  if(rx){receiptFilter.$and=[{$or:manualBase.$or},{$or:[{partyNameSnapshot:rx},{remarks:rx},{mode:rx},{receiptNo:rx}]}];delete receiptFilter.$or;paymentFilter.$and=[{$or:manualBase.$or},{$or:[{partyNameSnapshot:rx},{remarks:rx},{mode:rx},{paymentNo:rx}]}];delete paymentFilter.$or;}
  const [statementRows,manualReceipts,manualPayments]=await Promise.all([
    BankStatementRow.find(statementFilter).sort({date:-1,rowNo:-1}).limit(5000).lean(),
    type==="PAYMENT"?[]:Receipt.find(receiptFilter).sort({date:-1,createdAt:-1}).limit(5000).lean(),
    type==="RECEIPT"?[]:Payment.find(paymentFilter).sort({date:-1,createdAt:-1}).limit(5000).lean(),
  ]);
  const merged=[
    ...statementRows.map(x=>({...x,_listId:`BST:${x._id}`})),
    ...manualReceipts.map(x=>({_listId:`RCT:${x._id}`,date:x.date,transactionType:"RECEIPT",transactionId:x.receiptNo,matchedPartyGlobalId:x.customerGlobalId,matchedPartyName:x.partyNameSnapshot||x.customerGlobalId||"",remarks:x.remarks||x.reference||"",mode:x.mode,debit:0,credit:Number(x.amount||0),runningBalance:x.runningBalance,bankAccountId:x.bankAccountId,bankNameSnapshot:x.bankNameSnapshot,classification:x.status==="PENDING_CLASSIFICATION"?"SUSPENSE":"POSTED"})),
    ...manualPayments.map(x=>({_listId:`PAY:${x._id}`,date:x.date,transactionType:"PAYMENT",transactionId:x.paymentNo,matchedPartyGlobalId:x.partyGlobalId,matchedPartyName:x.partyNameSnapshot||x.partyGlobalId||"",remarks:x.remarks||x.reference||"",mode:x.mode,debit:Number(x.amount||0),credit:0,runningBalance:x.runningBalance,bankAccountId:x.bankAccountId,bankNameSnapshot:x.bankNameSnapshot,classification:x.status==="PENDING_CLASSIFICATION"?"SUSPENSE":"POSTED"})),
  ].sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
  const total=merged.length,items=merged.slice((page-1)*limit,page*limit);
  const bankIds=[...new Set(items.map(x=>x.bankAccountId).filter(Boolean))];
  const banks=bankIds.length?await BankAccount.find({tenantKey:req.auth.tenantKey,bankAccountId:{$in:bankIds}}).select("bankAccountId bankName accountNumber").lean():[];
  const bm=new Map(banks.map(x=>[String(x.bankAccountId),x]));
  const importIds=[...new Set(items.map(x=>x.importId||x.statementImportId).filter(Boolean))];
  const imports=importIds.length?await BankStatementImport.find({tenantKey:req.auth.tenantKey,financialYear,importId:{$in:importIds}}).select("importId importedBy importedByNameSnapshot submittedBy submittedByNameSnapshot").lean():[];
  const im=new Map(imports.map(x=>[String(x.importId),x]));
  const partyRefs=[...new Set(items.map(x=>x.matchedPartyGlobalId).filter(x=>x&&x!=="SUSPENSE"))];
  const userIds=[...new Set(items.flatMap(x=>{const batch=im.get(String(x.importId||x.statementImportId||""));return [x.createdBy,x.submittedBy,batch?.submittedBy,batch?.importedBy].filter(Boolean)}))];
  const [partyMap,userMap]=await Promise.all([resolvePartyDisplayMap(req.auth.tenantKey,partyRefs),resolveUserDisplayMap(req.auth.tenantKey,userIds)]);
  const enriched=items.map(x=>{const batch=im.get(String(x.importId||x.statementImportId||""));const partyRef=String(x.matchedPartyGlobalId||"");const partyName=partyMap.get(partyRef)?.name||x.matchedPartyName||x.partyName||"";const userId=String(x.submittedBy||batch?.submittedBy||x.createdBy||batch?.importedBy||"");const userName=x.submittedByNameSnapshot||batch?.submittedByNameSnapshot||x.createdByNameSnapshot||batch?.importedByNameSnapshot||userMap.get(userId)||userId;return {...x,matchedPartyName:partyName,partyNameDisplay:partyName,userNameDisplay:userName,bankNameSnapshot:x.bankNameSnapshot||bm.get(String(x.bankAccountId))?.bankName||"",bankAccountNumberSnapshot:bm.get(String(x.bankAccountId))?.accountNumber||""}});
  return ok(res,{items:enriched,meta:{page,limit,total,pages:Math.max(1,Math.ceil(total/limit))}});
});

router.post("/:id/statement-preview", upload.single("file"), async (req,res,next)=>{
  try{
    if(!req.file?.buffer)return fail(res,"Bank statement Excel/CSV file is required",400);
    const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:"ACTIVE"});
    if(!bank)return fail(res,"Active bank account not found",404);
    let rawRows; try{rawRows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read bank statement file",400);}
    if(!rawRows.length)return fail(res,"Uploaded bank statement has no rows",400);
    const fields=[
      {key:"date",label:"Date",aliases:["txn date","transaction date","value date"],required:true},
      {key:"partyName",label:"Party Name",aliases:["party","particulars","name","beneficiary","description"]},
      {key:"remarks",label:"Remarks",aliases:["remark","narration","details"],required:true},
      {key:"mode",label:"Mode",aliases:["transaction mode","type"]},
      {key:"debit",label:"Debit",aliases:["withdrawal","debit amount"],required:true},
      {key:"credit",label:"Credit",aliases:["deposit","credit amount"],required:true},
      {key:"runningBalance",label:"Running Balance",aliases:["balance","closing balance"],required:true},
    ];
    const cols=resolveColumns(rawRows[0],fields);
    const missing=fields.filter(f=>f.required&&!cols[f.key]).map(f=>f.label); if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);
    const normalized=normalizeStatementRows(rawRows,cols); if(normalized.errors.length)return fail(res,"Bank statement has invalid rows",400,{errors:normalized.errors.slice(0,50)});
    let rows=normalized.rows;
    if(!rows.length)return fail(res,"Uploaded bank statement has no transaction rows",400);
    const rowYears=[...new Set(rows.map(r=>financialYearFromDate(r.date)).filter(Boolean))];
    if(rowYears.length!==1)return fail(res,rowYears.length?`Statement contains transactions from multiple financial years (${rowYears.join(", ")}). Upload each financial year separately.`:"Could not determine Financial Year from statement dates",400);
    const financialYear=rowYears[0];
    const bounds=financialYearBounds(financialYear); if(!bounds)return fail(res,"Invalid Financial Year derived from statement dates",400);
    const outside=rows.filter(r=>r.date<bounds.start||r.date>bounds.end); if(outside.length)return fail(res,`Statement contains dates outside ${financialYear}`,400,{rows:outside.slice(0,20).map(x=>x.rowNo)});
    let running=validateRunningOrder(rows);
    if(!running.ok){const reversed=validateRunningOrder([...rows].reverse());if(reversed.ok){rows=[...rows].reverse();running=reversed;}else return fail(res,"Running Balance does not reconcile with Debit/Credit rows",400,{errors:running.errors.slice(0,20)});}

    let opening=openingForYear(bank,financialYear); const firstDate=rows[0].date;
    const beginsOnFyStart=firstDate.getFullYear()===bounds.start.getFullYear()&&firstDate.getMonth()===bounds.start.getMonth()&&firstDate.getDate()===bounds.start.getDate();
    if(!opening.exists){
      if(!beginsOnFyStart)return fail(res,`Set the ${financialYear} opening balance for this bank account before reviewing a mid-year statement`,409,{statementOpening:running.statementOpening});
      const signed=running.statementOpening;await upsertOpeningBalance(bank,financialYear,Math.abs(signed),signed<0?"CR":"DR","STATEMENT",req.auth.sub);opening=openingForYear(bank,financialYear);
    }else if(beginsOnFyStart){
      const savedSigned=opening.type==="CR"?-Math.abs(opening.amount):Math.abs(opening.amount);
      if(Math.abs(savedSigned-running.statementOpening)>0.06)return fail(res,`Statement opening ${running.statementOpening.toFixed(2)} does not match saved ${financialYear} opening ${savedSigned.toFixed(2)}`,409,{savedOpening:savedSigned,statementOpening:running.statementOpening});
    }

    const {BankStatementImport,BankStatementRow}=financialModels(req.auth.tenantKey,financialYear);
    // Replace this user's abandoned draft for the same bank/FY. Nothing in a draft has been posted.
    const oldDrafts=await BankStatementImport.find({tenantKey:req.auth.tenantKey,financialYear,bankAccountId:bank.bankAccountId,status:"DRAFT_REVIEW",importedBy:req.auth.sub}).select("importId").lean();
    if(oldDrafts.length){const ids=oldDrafts.map(x=>x.importId);await BankStatementRow.deleteMany({tenantKey:req.auth.tenantKey,financialYear,importId:{$in:ids},transactionId:{$in:[null,""]}});await BankStatementImport.deleteMany({tenantKey:req.auth.tenantKey,financialYear,importId:{$in:ids},status:"DRAFT_REVIEW"});}

    const matcher=await buildSmartPartyMatcher(req.auth.tenantKey); const importId=makeId("BST");
    const preview=[];let unmatchedRows=0,duplicateRows=0,autoMatchedRows=0;
    for(const r of rows){
      const sourceFingerprint=statementFingerprint(financialYear,bank.bankAccountId,r);
      const duplicate=await BankStatementRow.exists({tenantKey:req.auth.tenantKey,financialYear,bankAccountId:bank.bankAccountId,transactionId:{$nin:[null,""]},$or:[{sourceFingerprint},{fingerprint:sourceFingerprint}]});
      if(duplicate){duplicateRows++;preview.push({...r,date:r.date.toISOString(),transactionType:r.credit>0?"RECEIPT":"PAYMENT",classification:"DUPLICATE",duplicate:true,sourceFingerprint,matchedPartyGlobalId:"",matchedPartyName:"Already imported",detectionSource:"DUPLICATE",matchConfidence:100,candidateCount:1});continue;}
      const found=matcher.detect(r); const entry=found.entry;
      const partyId=entry?.ref||""; const partyName=entry?.preferred||"Suspense Account"; const partyCode=entry?.partyAccountCode||"SYS_SUSPENSE";
      const classification=entry?"AUTO_MATCHED":"SUSPENSE"; if(entry)autoMatchedRows++;else unmatchedRows++;
      const fingerprint=crypto.createHash("sha256").update(`${importId}|${sourceFingerprint}`).digest("hex");
      const doc=await BankStatementRow.create({tenantKey:req.auth.tenantKey,financialYear,importId,bankAccountId:bank.bankAccountId,rowNo:r.rowNo,date:r.date,partyName:partyName,remarks:r.remarks,mode:r.mode,debit:r.debit,credit:r.credit,runningBalance:r.runningBalance,fingerprint,sourceFingerprint,matchedPartyGlobalId:partyId,matchedPartyName:partyName,partyAccountCode:partyCode,transactionType:r.credit>0?"RECEIPT":"PAYMENT",transactionId:"",classification,detectionSource:found.source,matchConfidence:found.confidence,candidateCount:found.candidateCount,createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
      preview.push({...doc.toObject(),date:r.date.toISOString(),duplicate:false});
    }
    const totalDebit=round2(rows.reduce((s,x)=>s+x.debit,0)),totalCredit=round2(rows.reduce((s,x)=>s+x.credit,0)),closingBalance=rows.length?rows[rows.length-1].runningBalance:0;
    await BankStatementImport.create({tenantKey:req.auth.tenantKey,financialYear,importId,bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,accountNumberSnapshot:bank.accountNumber,fileName:req.file.originalname,openingBalance:running.statementOpening,closingBalance,totalDebit,totalCredit,totalRows:rows.length,postedRows:0,unmatchedRows,duplicateRows,errorRows:0,status:"DRAFT_REVIEW",importedBy:req.auth.sub,importedByNameSnapshot:req.auth.name||""});
    return ok(res,{importId,bankAccountId:bank.bankAccountId,bankName:bank.bankName,financialYear,totalRows:rows.length,reviewRows:preview.filter(x=>!x.duplicate),duplicateRows,autoMatchedRows,unmatchedRows,openingBalance:running.statementOpening,openingBalanceHint:normalized.openingBalanceHint,ignoredOpeningRows:normalized.ignoredOpeningRows,ignoredTemplateRows:normalized.ignoredTemplateRows,closingBalance,totalDebit,totalCredit},`Statement ready for review: ${autoMatchedRows} auto-matched, ${unmatchedRows} suspense, ${duplicateRows} duplicates`);
  }catch(error){return next(error);}
});

// v26 compatibility: upload now means preview only; it never posts before review.
router.post("/:id/statement-upload", upload.single("file"), async (req,res,next)=>{
  req.url=req.url.replace(/statement-upload$/,"statement-preview");
  return next();
});

router.post("/:id/statement-submit/:importId", async (req,res,next)=>{
  try{
    const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:"ACTIVE"});if(!bank)return fail(res,"Active bank account not found",404);
    const financialYear=clean(req.body.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");if(!financialYear)return fail(res,"Select Financial Year",400);
    const {Receipt,Payment,BankStatementImport,BankStatementRow}=financialModels(req.auth.tenantKey,financialYear);
    const batch=await BankStatementImport.findOne({tenantKey:req.auth.tenantKey,financialYear,importId:req.params.importId,bankAccountId:bank.bankAccountId,status:"DRAFT_REVIEW"});
    if(!batch)return fail(res,"Statement review draft not found or already submitted",404);
    const rows=await BankStatementRow.find({tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,transactionId:{$in:[null,""]}}).sort({date:1,rowNo:1});
    const matcher=await buildSmartPartyMatcher(req.auth.tenantKey);
    const assignmentMap=new Map((Array.isArray(req.body.assignments)?req.body.assignments:[]).map(x=>[Number(x.rowNo),clean(x.partyGlobalId)]));
    const bankSystemCode=["OD","CC"].includes(upper(bank.accountType))?"SYS_BANK_OD":"SYS_BANK_ACCOUNT";
    let postedRows=0,unmatchedRows=0,errorRows=0;const errors=[];
    for(const r of rows){
      try{
        const requested=assignmentMap.has(Number(r.rowNo))?assignmentMap.get(Number(r.rowNo)):clean(r.matchedPartyGlobalId);
        const selected=requested&&requested!=="SUSPENSE"?matcher.byId.get(String(requested)):null;
        const partyId=selected?.ref||"";const partyName=selected?.preferred||"Suspense Account";const partyCode=selected?.partyAccountCode||"SYS_SUSPENSE";const partyLedgerId=selected?.ledgerId||"";
        if(selected?.ownerType==="USER"&&partyCode==="SYS_SUSPENSE")throw new Error(`Set Accounting Account Type for ${partyName} in User Master before posting this bank row`);
        const isReceipt=r.credit>0,amount=isReceipt?Number(r.credit||0):Number(r.debit||0),transactionId=makeId(isReceipt?"RCT":"PAY");
        const bankEntry={accountCode:bankSystemCode,ledgerId:bank.ledgerId||"",bankAccountId:bank.bankAccountId};
        if(isReceipt){
          await Receipt.create({tenantKey:req.auth.tenantKey,financialYear,receiptNo:transactionId,date:r.date,customerGlobalId:partyId,partyNameSnapshot:partyName,amount,mode:r.mode||"BANK",reference:"",remarks:r.remarks,bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,statementImportId:batch.importId,statementRowNo:r.rowNo,runningBalance:r.runningBalance,bounceStatus:"CLEAR",status:selected?"POSTED":"PENDING_CLASSIFICATION",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId,transactionType:"BANK_STATEMENT_RECEIPT",date:r.date,partyGlobalId:partyId,narration:r.remarks||`Bank receipt - ${partyName}`,entries:[{...bankEntry,debit:amount},{accountCode:partyCode,ledgerId:partyLedgerId,credit:amount}]});
        }else{
          await Payment.create({tenantKey:req.auth.tenantKey,financialYear,paymentNo:transactionId,date:r.date,partyGlobalId:partyId,partyNameSnapshot:partyName,amount,mode:r.mode||"BANK",reference:"",remarks:r.remarks,bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,statementImportId:batch.importId,statementRowNo:r.rowNo,runningBalance:r.runningBalance,status:selected?"POSTED":"PENDING_CLASSIFICATION",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId,transactionType:"BANK_STATEMENT_PAYMENT",date:r.date,partyGlobalId:partyId,narration:r.remarks||`Bank payment - ${partyName}`,entries:[{accountCode:partyCode,ledgerId:partyLedgerId,debit:amount},{...bankEntry,credit:amount}]});
        }
        r.matchedPartyGlobalId=partyId;r.matchedPartyName=partyName;r.partyAccountCode=partyCode;r.transactionId=transactionId;r.classification=selected?"POSTED":"SUSPENSE";r.submittedAt=new Date();r.submittedBy=req.auth.sub;r.submittedByNameSnapshot=req.auth.name||"";await r.save();
        postedRows++;if(!selected)unmatchedRows++;
      }catch(error){errorRows++;r.error=error.message;await r.save();if(errors.length<50)errors.push({row:r.rowNo,error:error.message});}
    }
    batch.postedRows=postedRows;batch.unmatchedRows=unmatchedRows;batch.errorRows=errorRows;batch.status=errorRows?"SUBMITTED_WITH_ERRORS":"SUBMITTED";batch.submittedBy=req.auth.sub;batch.submittedByNameSnapshot=req.auth.name||"";batch.submittedAt=new Date();await batch.save();
    return ok(res,{importId:batch.importId,postedRows,unmatchedRows,errorRows,totalRows:batch.totalRows,duplicateRows:batch.duplicateRows,closingBalance:batch.closingBalance,errors},`Statement submitted: ${postedRows} transactions posted, ${unmatchedRows} to Suspense`);
  }catch(error){return next(error);}
});

router.get("/:id", async (req,res)=>{
  const row=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey}).lean();
  if(!row)return fail(res,"Bank account not found",404);
  return ok(res,row);
});

router.post("/", async (req,res)=>{
  const error=validateBody(req.body); if(error)return fail(res,error,400);
  let bankMaster; try{bankMaster=await resolveBankDetails(req.body,{optional:false});}catch(error){return fail(res,error.message,error.statusCode||400);}
  const tenantKey=req.auth.tenantKey,accountNumber=normalizeAccount(req.body.accountNumber);
  if(await BankAccount.exists({tenantKey,accountNumberNormalized:accountNumber,status:{$ne:"DELETED"}}))return fail(res,"This bank account already exists",409);
  const financialYear=await ensureDefaultFinancialYear(tenantKey,clean(req.body.financialYear));
  if(req.body.isPrimary)await BankAccount.updateMany({tenantKey,status:{$ne:"DELETED"}},{$set:{isPrimary:false}});
  const openingBalances=normalizedOpeningRows({...req.body,financialYear,updatedBy:req.auth.sub},[]);
  const current=openingBalances.find(x=>x.financialYear===financialYear)||{amount:Number(req.body.openingBalance||0),type:upper(req.body.openingBalanceType)==="CR"?"CR":"DR"};
  const row=await BankAccount.create({tenantKey,bankAccountId:makeId("BANK"),bankName:bankMaster.bankName,branchName:bankMaster.branchName,branchAddress:bankMaster.bankAddress,city:bankMaster.city,state:bankMaster.state,stdCode:bankMaster.stdCode,phone:bankMaster.phone,contactNo:bankMaster.contactNo,accountHolderName:clean(req.body.accountHolderName),accountNumber,accountNumberNormalized:accountNumber,ifsc:bankMaster.ifsc,micr:clean(req.body.micr),swiftCode:upper(req.body.swiftCode),upiId:clean(req.body.upiId),accountType:upper(req.body.accountType||"CURRENT"),openingBalance:Number(current.amount||0),openingBalanceType:current.type==="CR"?"CR":"DR",financialYear,openingBalances,isPrimary:Boolean(req.body.isPrimary),status:"ACTIVE",remarks:clean(req.body.remarks),createdBy:req.auth.sub,updatedBy:req.auth.sub});
  const ledger=await syncBankAccountLedger(row); if(ledger){row.ledgerId=ledger.ledgerId;await row.save();}
  return ok(res,row,"Bank account created",201);
});

router.put("/:id", async (req,res)=>{
  const row=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:{$ne:"DELETED"}}); if(!row)return fail(res,"Bank account not found",404);
  const merged={...row.toObject(),...req.body}; const error=validateBody(merged); if(error)return fail(res,error,400);
  let bankMaster; try{bankMaster=await resolveBankDetails(merged,{optional:false});}catch(error){return fail(res,error.message,error.statusCode||400);}
  const accountNumber=normalizeAccount(merged.accountNumber);
  if(await BankAccount.exists({tenantKey:req.auth.tenantKey,accountNumberNormalized:accountNumber,_id:{$ne:row._id},status:{$ne:"DELETED"}}))return fail(res,"This bank account already exists",409);
  if(req.body.isPrimary===true)await BankAccount.updateMany({tenantKey:req.auth.tenantKey,_id:{$ne:row._id},status:{$ne:"DELETED"}},{$set:{isPrimary:false}});
  const openingBalances=normalizedOpeningRows({...merged,openingBalances:req.body.openingBalances||row.openingBalances,updatedBy:req.auth.sub},row.openingBalances||[]);
  const fy=clean(merged.financialYear); const current=openingBalances.find(x=>x.financialYear===fy)||{amount:Number(merged.openingBalance||0),type:upper(merged.openingBalanceType)==="CR"?"CR":"DR"};
  Object.assign(row,{bankName:bankMaster.bankName,branchName:bankMaster.branchName,branchAddress:bankMaster.bankAddress,city:bankMaster.city,state:bankMaster.state,stdCode:bankMaster.stdCode,phone:bankMaster.phone,contactNo:bankMaster.contactNo,accountHolderName:clean(merged.accountHolderName),accountNumber,accountNumberNormalized:accountNumber,ifsc:bankMaster.ifsc,micr:clean(merged.micr),swiftCode:upper(merged.swiftCode),upiId:clean(merged.upiId),accountType:upper(merged.accountType||"CURRENT"),openingBalance:Number(current.amount||0),openingBalanceType:current.type==="CR"?"CR":"DR",financialYear:fy,openingBalances,isPrimary:Boolean(merged.isPrimary),status:upper(merged.status||"ACTIVE")==="INACTIVE"?"INACTIVE":"ACTIVE",remarks:clean(merged.remarks),updatedBy:req.auth.sub});
  await row.save(); const ledger=await syncBankAccountLedger(row); if(ledger){ledger.status=row.status==="ACTIVE"?"ACTIVE":"INACTIVE";await ledger.save();row.ledgerId=ledger.ledgerId;await row.save();}
  return ok(res,row,"Bank account updated");
});

router.delete("/:id", async (req,res)=>{
  const row=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:{$ne:"DELETED"}}); if(!row)return fail(res,"Bank account not found",404);
  row.status="DELETED";row.isPrimary=false;row.deletedAt=new Date();row.deletedBy=req.auth.sub;row.updatedBy=req.auth.sub;await row.save();
  await CompanyLedger.updateMany({tenantKey:req.auth.tenantKey,ownerType:"BANK_ACCOUNT",ownerId:row.bankAccountId},{$set:{status:"INACTIVE"}});
  return ok(res,{id:row._id},"Bank account deleted safely");
});

export default router;
