import express from "express";
import multer from "multer";
import crypto from "crypto";
import { BankAccount, CompanyLedger, CompanyProfile, CustomerLink, GlobalCustomer, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { syncBankAccountLedger } from "../services/companyAccountingService.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import { bankStatementIdentity, inspectBankLedgerRows } from "../services/bankLedgerIntegrityService.js";
import { resolveBankDetails } from "../services/ifscMasterService.js";
import { financialModels, postBalancedEntries } from "../services/accountingService.js";
import { readRows, resolveColumns, valueFor } from "../utils/bulkSpreadsheet.js";
import { resolvePartyDisplayMap, resolveUserDisplayMap } from "../services/transactionDisplayService.js";
import { financialYearFromDate } from "../utils/financialYear.js";
import { env } from "../config/env.js";

const router = express.Router();
router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();
const normalizeAccount = (value) => clean(value).replace(/\s+/g, "");
const normalizeName = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const nameSimilarity = (a,b) => {
  const x=normalizeName(a),y=normalizeName(b);
  if(!x||!y)return 0;if(x===y)return 1;
  const prev=Array.from({length:y.length+1},(_,i)=>i);
  for(let i=1;i<=x.length;i++){
    let left=i,diag=i-1;
    for(let j=1;j<=y.length;j++){
      const up=prev[j],cost=x[i-1]===y[j-1]?0:1;
      const next=Math.min(up+1,left+1,diag+cost);diag=up;prev[j]=next;left=next;
    }
    prev[0]=i;
  }
  return Math.max(0,1-prev[y.length]/Math.max(x.length,y.length));
};
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

    // Running Balance is deliberately optional. V2 calculates it itself after
    // upload so a bank-exported or manually prepared balance column can never
    // block an otherwise valid statement import.
    const blankRow = !clean(rawDate) && !sourcePartyName && !remarks && !clean(rawDebit) && !clean(rawCredit) && !clean(rawBalance);
    if (blankRow) continue;

    if (isLegacyTemplateSampleRow(row, cols)) { ignoredTemplateRows++; continue; }

    // Backward compatibility with the old template. An old "OPENING BALANCE"
    // line is read only as a hint; it is never used to validate transaction
    // running balances anymore.
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
    const debit = Math.max(0, Number(debitParsed ?? 0));
    const credit = Math.max(0, Number(creditParsed ?? 0));

    if (!date) { errors.push({row:rowNo,error:"Invalid date"}); continue; }
    if ((debit > 0 && credit > 0) || (debit <= 0 && credit <= 0)) { errors.push({row:rowNo,error:"Enter either Debit or Credit, not both"}); continue; }

    out.push({
      rowNo,date,sourcePartyName,partyName:partyHint,partyHint,remarks,mode,
      debit:round2(debit),credit:round2(credit),runningBalance:null,
    });
  }
  return {rows:out,errors,openingBalanceHint,ignoredOpeningRows,ignoredTemplateRows};
}


const normalizeBankAccountKey = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

async function buildSmartPartyMatcher(tenantKey,{excludeBankAccountId=""}={}) {
  const [links,users,userLedgers,customerLedgers,bankAccounts] = await Promise.all([
    CustomerLink.find({tenantKey,status:{$nin:["INACTIVE","DEACTIVATED"]}}).lean(),
    User.find({tenantKey,status:"ACTIVE"})
      .select("name email mobile accountType tallyAccountTypeName tallyAccountTypeCode accountingRequired accountingMappings bankDetails loginEnabled systemManaged systemKey")
      .lean(),
    CompanyLedger.find({tenantKey,ownerType:"USER",status:{$ne:"INACTIVE"}}).lean(),
    CompanyLedger.find({tenantKey,ownerType:"CUSTOMER",status:{$ne:"INACTIVE"}}).lean(),
    BankAccount.find({tenantKey,status:"ACTIVE"}).select("bankAccountId bankName accountHolderName accountNumber accountNumberNormalized accountType ledgerId ifsc").lean()
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
  const ignoredWords=new Set(["NEFT","RTGS","IMPS","UPI","CR","DR","NET","TPT","TRANSFER","TRF","FROM","TO","BY","BANK","A","AN","THE","OF","AC","ACCOUNT","NO","REF","UTR","INWARD","OUTWARD","PAY","PAYMENT","TXN","TRANSACTION","YES"]);
  const tokenise=(value)=>normalizeName(value).split(" ").filter(x=>x.length>=2&&!ignoredWords.has(x));
  const uniqueStrings=(values)=>[...new Set(values.map(normalizeName).filter(Boolean))];

  const registerEntry=(entry)=>{
    entry.aliases=uniqueStrings(entry.aliases||[]);
    entry.accountNumbers=[...new Set((entry.accountNumbers||[]).map(normalizeBankAccountKey).filter(x=>x.length>=6))];
    entries.push(entry);
    byId.set(String(entry.ref),entry);
    for(const acc of entry.accountNumbers){
      if(!accountMap.has(acc))accountMap.set(acc,[]);
      accountMap.get(acc).push(entry);
    }
  };

  for(const link of links){
    const global=gm.get(String(link.globalCustomerId));
    const preferred=clean(link.localName||global?.tradeName||global?.legalName||link.displayIdentifier||link.globalCustomerId);
    const bankDetails=Array.isArray(link.bankDetails)?link.bankDetails:[];
    const aliases=[
      link.localName,link.displayIdentifier,global?.tradeName,global?.legalName,
      ...bankDetails.map(x=>x?.accountName)
    ];
    const accountNumbers=bankDetails.map(x=>x?.accountNumber);
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
    const aliases=[user.name,activeMapping?.ledgerName,ledger?.name,user.bankDetails?.accountName];
    const accountNumbers=[user.bankDetails?.accountNumber];
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

  for(const bank of bankAccounts){
    if(clean(bank.bankAccountId)===clean(excludeBankAccountId))continue;
    const ownerId=clean(bank.bankAccountId);
    if(!ownerId)continue;
    const accountType=upper(bank.accountType);
    registerEntry({
      ref:`BANK:${ownerId}`,
      ownerType:"BANK_ACCOUNT",
      ownerId,
      bank,
      preferred:clean(bank.accountHolderName||bank.bankName||ownerId),
      aliases:[bank.accountHolderName,`${clean(bank.accountHolderName)} ${clean(bank.bankName)}`],
      accountNumbers:[bank.accountNumberNormalized||bank.accountNumber],
      partyAccountCode:["OD","CC"].includes(accountType)?"SYS_BANK_OD":"SYS_BANK_ACCOUNT",
      ledgerId:clean(bank.ledgerId),
      bankAccountId:ownerId,
      accountTypeLabel:`BANK ACCOUNT • ${clean(bank.bankName)}`
    });
  }

  const uniqueEntry=(arr=[])=>{
    const m=new Map(); for(const x of arr)m.set(String(x.ref),x);
    return [...m.values()];
  };

  const scoreAlias=(alias,remarkKey,remarkTokens,partyKey)=>{
    const aliasKey=normalizeName(alias); if(!aliasKey)return 0;
    const aliasTokens=tokenise(aliasKey); if(!aliasTokens.length)return 0;
    let score=0;
    const paddedRemark=` ${remarkKey} `;
    if(paddedRemark.includes(` ${aliasKey} `)){
      score=Math.max(score,90+Math.min(9,aliasTokens.length*3+Math.floor(aliasKey.length/12)));
    }
    const matched=aliasTokens.filter(t=>remarkTokens.has(t)).length;
    const coverage=aliasTokens.length?matched/aliasTokens.length:0;
    if(coverage===1){
      const base=aliasTokens.length>=2?87:aliasKey.length>=6?84:78;
      score=Math.max(score,base+Math.min(9,aliasTokens.length*3));
    }else if(coverage>=0.75&&aliasTokens.length>=2){
      score=Math.max(score,80+Math.round(coverage*10));
    }
    if(partyKey){
      if(partyKey===aliasKey)score=Math.max(score,99);
      else if(partyKey.includes(aliasKey)||aliasKey.includes(partyKey))score=Math.max(score,90);
      else {
        const similarity=nameSimilarity(partyKey,aliasKey);
        if(similarity>=0.92)score=Math.max(score,96);
        else if(similarity>=0.84&&aliasTokens.length>=2)score=Math.max(score,89);
      }
    }
    return Math.min(99,score);
  };

  const rank=(row={})=>{
    const remarks=clean(row.remarks);
    const remarkKey=normalizeName(remarks);
    const remarkTokens=new Set(tokenise(remarkKey));
    const partyKey=normalizeName(clean(row.partyHint||row.partyName));
    const narrationSegments=remarks.split(/\s*-\s*/).map(normalizeName).filter(Boolean);
    const ifscSegmentIndex=narrationSegments.findIndex(seg=>/[A-Z]{4}0[A-Z0-9]{6}/.test(seg.replace(/\s+/g,"")));
    const prioritySegment=ifscSegmentIndex>=0?clean(narrationSegments[ifscSegmentIndex+1]):"";
    const priorityTokens=new Set(tokenise(prioritySegment));
    const compactRemarks=normalizeBankAccountKey(remarks);
    const accountTokens=[...new Set((remarks.toUpperCase().match(/[A-Z0-9]{6,34}/g)||[]).map(normalizeBankAccountKey).filter(x=>x.length>=6))];
    const exactAccountEntries=uniqueEntry([
      ...accountTokens.flatMap(x=>accountMap.get(x)||[]),
      ...entries.filter(e=>e.accountNumbers.some(acc=>compactRemarks.includes(acc)))
    ]);
    if(exactAccountEntries.length){
      return exactAccountEntries.map(entry=>({entry,score:100,source:"ACCOUNT_NO_IN_REMARKS",alias:entry.accountNumbers.find(acc=>compactRemarks.includes(acc))||""}));
    }
    return entries.map(entry=>{
      let bestScore=0,bestAlias="",priority=false;
      let hintExact=false,hintFuzzy=false;
      for(const alias of entry.aliases){
        let score=scoreAlias(alias,remarkKey,remarkTokens,partyKey);
        const aliasKey=normalizeName(alias); const aliasTokens=tokenise(aliasKey);
        const similarity=partyKey?nameSimilarity(partyKey,aliasKey):0;
        const exactHint=Boolean(partyKey&&partyKey===aliasKey);
        const fuzzyHint=Boolean(partyKey&&similarity>=0.92);
        const priorityMatch=Boolean(prioritySegment&&aliasTokens.length&&(
          ` ${prioritySegment} `.includes(` ${aliasKey} `)||aliasTokens.every(t=>priorityTokens.has(t))
        ));
        if(exactHint)score=Math.max(score,99);
        else if(fuzzyHint)score=Math.max(score,96);
        if(priorityMatch)score=Math.max(score,99);
        if(score>bestScore||(score===bestScore&&alias.length>bestAlias.length)){bestScore=score;bestAlias=alias;priority=priorityMatch;hintExact=exactHint;hintFuzzy=fuzzyHint;}
      }
      const ordinarySource=entry.ownerType==="USER"?"USER_NAME_IN_REMARKS":entry.ownerType==="BANK_ACCOUNT"?"BANK_NAME_IN_REMARKS":"NAME_IN_REMARKS";
      const source=hintExact?"PARTY_NAME_PREFIX_EXACT":hintFuzzy?"PARTY_NAME_PREFIX_FUZZY":priority?"STRUCTURED_NARRATION_NAME":ordinarySource;
      return {entry,score:bestScore,source,alias:bestAlias,priority:priority||hintExact};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||String(b.alias||"").length-String(a.alias||"").length);
  };

  const detect=(row={})=>{
    const ranked=rank(row);
    if(!ranked.length)return {entry:null,confidence:0,source:"NO_MATCH",candidateCount:0,candidates:[]};
    const top=ranked[0];
    const second=ranked[1];
    const sameTop=ranked.filter(x=>x.score===top.score);
    if(top.score===100){
      const exact=uniqueEntry(sameTop.map(x=>x.entry));
      if(exact.length===1)return {entry:exact[0],confidence:100,source:"ACCOUNT_NO_IN_REMARKS",candidateCount:1,candidates:ranked.slice(0,6)};
      return {entry:null,confidence:0,source:"AMBIGUOUS_ACCOUNT_NO",candidateCount:exact.length,candidates:ranked.slice(0,6)};
    }
    const gap=top.score-Number(second?.score||0);
    const priorityTies=ranked.filter(x=>x.priority&&x.score===top.score);
    if(top.priority&&top.score>=98&&priorityTies.length===1){
      return {entry:top.entry,confidence:top.score,source:top.source,candidateCount:1,candidates:ranked.slice(0,6)};
    }
    const topAlias=String(top.alias||"");
    const secondAlias=String(second?.alias||"");
    const clearlyMoreSpecific=top.score>=94&&topAlias.length>=secondAlias.length+4;
    if(top.score>=88&&(gap>=3||!second||clearlyMoreSpecific)){
      return {entry:top.entry,confidence:top.score,source:top.source,candidateCount:1,candidates:ranked.slice(0,6)};
    }
    if(top.score>=76&&(!second||gap>=8)){
      return {entry:top.entry,confidence:top.score,source:`${top.source}_FUZZY`,candidateCount:1,candidates:ranked.slice(0,6)};
    }
    return {entry:null,confidence:0,source:ranked.length>1?"AMBIGUOUS_NARRATION":"NO_MATCH",candidateCount:ranked.length,candidates:ranked.slice(0,6)};
  };
  return {detect,rank,byId,entries};
}

async function resolveNarrationsWithAi(rows=[],matcher){
  if(!env.openai?.apiKey||!rows.length)return new Map();
  const selected=new Map();
  for(let offset=0;offset<rows.length;offset+=40){
    const chunk=rows.slice(offset,offset+40).map(row=>({
      rowNo:Number(row.rowNo),
      remarks:clean(row.remarks),
      partyHint:clean(row.partyHint||row.partyName),
      candidates:matcher.rank(row).slice(0,6).map(x=>({ref:x.entry.ref,name:x.entry.preferred,type:x.entry.ownerType,score:x.score}))
    })).filter(x=>x.candidates.length);
    if(!chunk.length)continue;
    try{
      const response=await fetch("https://api.openai.com/v1/responses",{
        method:"POST",
        headers:{Authorization:`Bearer ${env.openai.apiKey}`,"Content-Type":"application/json"},
        body:JSON.stringify({
          model:env.openai.model,
          input:[{role:"user",content:[{type:"input_text",text:[
            "Match each bank narration to exactly one supplied candidate only when the narration clearly identifies that party.",
            "Use the entire narration, including fragmented names and account-number context. Never invent a party. If uncertain, return an empty partyRef.",
            JSON.stringify(chunk)
          ].join("\n")}]}],
          max_output_tokens:4000,
          text:{format:{type:"json_schema",name:"bank_narration_party_match",strict:true,schema:{type:"object",properties:{matches:{type:"array",items:{type:"object",properties:{rowNo:{type:"integer"},partyRef:{type:"string"},confidence:{type:"integer",minimum:0,maximum:100},reason:{type:"string"}},required:["rowNo","partyRef","confidence","reason"],additionalProperties:false}}},required:["matches"],additionalProperties:false}}}
        })
      });
      const payload=await response.json();
      if(!response.ok)continue;
      const text=payload.output_text||(payload.output||[]).flatMap(x=>x.content||[]).find(x=>x.type==="output_text")?.text||"";
      const parsed=JSON.parse(text||"{}");
      for(const match of parsed.matches||[]){
        const ref=clean(match.partyRef); const confidence=Number(match.confidence||0);
        if(ref&&confidence>=88&&matcher.byId.has(ref))selected.set(Number(match.rowNo),{entry:matcher.byId.get(ref),confidence,source:"AI_NARRATION_MATCH",candidateCount:1});
      }
    }catch{}
  }
  return selected;
}

function statementFingerprint(financialYear,bankAccountId,row){
  return crypto.createHash("sha256").update([
    financialYear,bankAccountId,row.date.toISOString().slice(0,10),normalizeName(row.sourcePartyName ?? row.partyName),normalizeName(row.remarks),row.mode,
    Number(row.debit||0).toFixed(2),Number(row.credit||0).toFixed(2),Number(row.rowNo||0)
  ].join("|")).digest("hex");
}

function postedBankFingerprint(financialYear, bankAccountId, row) {
  return crypto.createHash("sha256").update(
    JSON.stringify([financialYear, bankStatementIdentity(bankAccountId, row)]),
  ).digest("hex");
}

async function existingPostedBankRow({ BankStatementRow, tenantKey, financialYear, bankAccountId, row, excludeId }) {
  const identity = postedBankFingerprint(financialYear, bankAccountId, row);
  const filter = {
    tenantKey, financialYear, bankAccountId,
    transactionId: { $nin: [null, ""] },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  };
  const direct = await BankStatementRow.findOne({ ...filter, postingFingerprint: identity }).select("_id").lean();
  if (direct) return direct;
  // Legacy imports predate postingFingerprint; compare the actual bank line
  // without importId or the matched party name, neither identifies a bank line.
  const candidates = await BankStatementRow.find({
    ...filter, date: row.date,
    debit: Number(row.debit || 0), credit: Number(row.credit || 0),
  }).select("_id rowNo date remarks debit credit runningBalance").lean();
  const same = bankStatementIdentity(bankAccountId, row);
  return candidates.find((old) => bankStatementIdentity(bankAccountId, old) === same) || null;
}


const statementDateKey = (value) => {
  const d=value instanceof Date?value:new Date(value);
  return Number.isNaN(d.getTime())?0:d.getTime();
};

function sortStatementRows(rows=[]) {
  return [...rows].sort((a,b)=>
    statementDateKey(a.date)-statementDateKey(b.date)
    || Number(a.rowNo||0)-Number(b.rowNo||0)
  );
}

function signedOpeningValue(opening={}) {
  const amount=Math.abs(Number(opening?.amount||0));
  return opening?.type==="CR"?-amount:amount;
}

function manualTransactionFilter(tenantKey,financialYear,bankAccountId){
  return {
    tenantKey,financialYear,bankAccountId,
    status:{$nin:["DELETED","CANCELLED","REVERSED"]},
    $or:[
      {statementImportId:{$exists:false}},
      {statementImportId:""},
      {statementImportId:null},
    ],
  };
}

function movementSort(a,b){
  return statementDateKey(a.date)-statementDateKey(b.date)
    || Number(a.priority||0)-Number(b.priority||0)
    || statementDateKey(a.createdAt)-statementDateKey(b.createdAt)
    || Number(a.rowNo||0)-Number(b.rowNo||0)
    || String(a.id||"").localeCompare(String(b.id||""));
}

async function loadPostedBankMovements({tenantKey,financialYear,bankAccountId}){
  const {BankStatementRow,Receipt,Payment}=financialModels(tenantKey,financialYear);
  const manualFilter=manualTransactionFilter(tenantKey,financialYear,bankAccountId);
  const [statementRows,receipts,payments]=await Promise.all([
    BankStatementRow.find({
      tenantKey,financialYear,bankAccountId,
      transactionId:{$nin:[null,""]},
      classification:{$nin:["DELETED","CANCELLED","REVERSED"]},
    }).select("_id importId rowNo date debit credit runningBalance transactionId transactionType createdAt").lean(),
    Receipt.find(manualFilter).select("_id receiptNo date amount runningBalance createdAt").lean(),
    Payment.find(manualFilter).select("_id paymentNo date amount runningBalance createdAt").lean(),
  ]);

  return [
    ...statementRows.map(x=>({
      kind:"STATEMENT",id:String(x._id),doc:x,date:x.date,createdAt:x.createdAt,rowNo:x.rowNo,
      debit:Number(x.debit||0),credit:Number(x.credit||0),priority:0,
    })),
    ...receipts.map(x=>({
      kind:"RECEIPT",id:String(x._id),doc:x,date:x.date,createdAt:x.createdAt,rowNo:0,
      debit:0,credit:Number(x.amount||0),priority:0,
    })),
    ...payments.map(x=>({
      kind:"PAYMENT",id:String(x._id),doc:x,date:x.date,createdAt:x.createdAt,rowNo:0,
      debit:Number(x.amount||0),credit:0,priority:0,
    })),
  ].sort(movementSort);
}

async function calculateDraftRunningBalances({tenantKey,financialYear,bankAccountId,openingSigned,draftRows=[]}){
  const posted=await loadPostedBankMovements({tenantKey,financialYear,bankAccountId});
  const drafts=sortStatementRows(draftRows).map(x=>({
    ...x,
    _draft:true,
    kind:"DRAFT",
    id:`DRAFT:${Number(x.rowNo||0)}`,
    createdAt:null,
    priority:1,
  }));
  const merged=[...posted,...drafts].sort(movementSort);
  let running=round2(openingSigned);
  let balanceBeforeFirstDraft=null;
  const calculated=new Map();
  for(const row of merged){
    if(row._draft && balanceBeforeFirstDraft===null)balanceBeforeFirstDraft=running;
    running=round2(running-Number(row.debit||0)+Number(row.credit||0));
    if(row._draft)calculated.set(Number(row.rowNo),running);
  }
  const rows=drafts.map(x=>({
    ...x,
    runningBalance:round2(calculated.get(Number(x.rowNo))??openingSigned),
  })).map(({_draft,kind,id,createdAt,priority,...x})=>x);
  return {
    rows,
    balanceBeforeFirstDraft:round2(balanceBeforeFirstDraft===null?openingSigned:balanceBeforeFirstDraft),
    closingBalance:rows.length?Number(rows[rows.length-1].runningBalance||0):round2(openingSigned),
  };
}

async function recalculatePostedBankRunningBalances({tenantKey,financialYear,bank}){
  const opening=openingForYear(bank,financialYear);
  if(!opening.exists)return {updated:0,closingBalance:0};
  const openingSigned=signedOpeningValue(opening);
  const movements=await loadPostedBankMovements({tenantKey,financialYear,bankAccountId:bank.bankAccountId});
  if(!movements.length)return {updated:0,closingBalance:round2(openingSigned)};

  const {BankStatementRow,Receipt,Payment}=financialModels(tenantKey,financialYear);
  const statementOps=[],receiptOps=[],paymentOps=[];
  let running=round2(openingSigned);

  for(const movement of movements){
    running=round2(running-Number(movement.debit||0)+Number(movement.credit||0));
    if(movement.kind==="STATEMENT"){
      statementOps.push({updateOne:{filter:{_id:movement.doc._id},update:{$set:{runningBalance:running}}}});
      if(clean(movement.doc.transactionId)){
        if(upper(movement.doc.transactionType)==="RECEIPT"){
          receiptOps.push({updateOne:{filter:{tenantKey,financialYear,receiptNo:movement.doc.transactionId},update:{$set:{runningBalance:running}}}});
        }else if(upper(movement.doc.transactionType)==="PAYMENT"){
          paymentOps.push({updateOne:{filter:{tenantKey,financialYear,paymentNo:movement.doc.transactionId},update:{$set:{runningBalance:running}}}});
        }
      }
    }else if(movement.kind==="RECEIPT"){
      receiptOps.push({updateOne:{filter:{_id:movement.doc._id},update:{$set:{runningBalance:running}}}});
    }else if(movement.kind==="PAYMENT"){
      paymentOps.push({updateOne:{filter:{_id:movement.doc._id},update:{$set:{runningBalance:running}}}});
    }
  }

  await Promise.all([
    statementOps.length?BankStatementRow.bulkWrite(statementOps,{ordered:false}):null,
    receiptOps.length?Receipt.bulkWrite(receiptOps,{ordered:false}):null,
    paymentOps.length?Payment.bulkWrite(paymentOps,{ordered:false}):null,
  ]);

  return {updated:movements.length,closingBalance:round2(running)};
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

async function refreshStatementImportAfterDelete({tenantKey,financialYear,importId}){
  if(!importId)return;
  const {BankStatementImport,BankStatementRow}=financialModels(tenantKey,financialYear);
  const rows=await BankStatementRow.find({tenantKey,financialYear,importId}).sort({rowNo:1}).lean();
  if(!rows.length){await BankStatementImport.deleteOne({tenantKey,financialYear,importId});return;}
  const posted=rows.filter(x=>clean(x.transactionId));
  await BankStatementImport.updateOne({tenantKey,financialYear,importId},{$set:{
    totalRows:rows.length,postedRows:posted.length,
    unmatchedRows:rows.filter(x=>!clean(x.matchedPartyGlobalId)).length,
    totalDebit:round2(rows.reduce((sum,x)=>sum+Number(x.debit||0),0)),
    totalCredit:round2(rows.reduce((sum,x)=>sum+Number(x.credit||0),0)),
    closingBalance:Number(rows[rows.length-1]?.runningBalance||0)
  }});
}

async function deleteBankTransactionIds({tenantKey,financialYear,ids=[]}){
  const unique=[...new Set((ids||[]).map(clean).filter(Boolean))];
  if(!unique.length)return {deleted:0,statement:0,receipts:0,payments:0};
  const {BankStatementRow,Receipt,Payment,LedgerEntry}=financialModels(tenantKey,financialYear);
  let deleted=0,statement=0,receipts=0,payments=0;const importIds=new Set(),bankAccountIds=new Set();
  for(const token of unique){
    const [kind,rawId]=token.includes(":")?token.split(/:(.+)/):["",token];
    const id=clean(rawId);if(!id)continue;
    if(kind==="BST"){
      const row=await BankStatementRow.findOne({_id:id,tenantKey,financialYear});if(!row)continue;
      if(clean(row.bankAccountId))bankAccountIds.add(clean(row.bankAccountId));
      const tx=clean(row.transactionId);if(tx){
        if(row.transactionType==="RECEIPT")receipts+=(await Receipt.deleteMany({tenantKey,financialYear,receiptNo:tx})).deletedCount||0;
        else payments+=(await Payment.deleteMany({tenantKey,financialYear,paymentNo:tx})).deletedCount||0;
        await LedgerEntry.deleteMany({tenantKey,financialYear,transactionId:tx});
      }
      if(row.importId)importIds.add(String(row.importId));
      await row.deleteOne();deleted++;statement++;continue;
    }
    if(kind==="RCT"){
      const row=await Receipt.findOne({_id:id,tenantKey,financialYear});if(!row)continue;
      if(clean(row.bankAccountId))bankAccountIds.add(clean(row.bankAccountId));
      const tx=clean(row.receiptNo);if(tx)await LedgerEntry.deleteMany({tenantKey,financialYear,transactionId:tx});
      if(clean(row.statementImportId)){
        const linked=await BankStatementRow.find({tenantKey,financialYear,transactionId:tx}).select("importId").lean();
        for(const linkedRow of linked)if(linkedRow.importId)importIds.add(String(linkedRow.importId));
        await BankStatementRow.deleteMany({tenantKey,financialYear,transactionId:tx});
      }
      await row.deleteOne();deleted++;receipts++;continue;
    }
    if(kind==="PAY"){
      const row=await Payment.findOne({_id:id,tenantKey,financialYear});if(!row)continue;
      if(clean(row.bankAccountId))bankAccountIds.add(clean(row.bankAccountId));
      const tx=clean(row.paymentNo);if(tx)await LedgerEntry.deleteMany({tenantKey,financialYear,transactionId:tx});
      if(clean(row.statementImportId)){
        const linked=await BankStatementRow.find({tenantKey,financialYear,transactionId:tx}).select("importId").lean();
        for(const linkedRow of linked)if(linkedRow.importId)importIds.add(String(linkedRow.importId));
        await BankStatementRow.deleteMany({tenantKey,financialYear,transactionId:tx});
      }
      await row.deleteOne();deleted++;payments++;continue;
    }
  }
  for(const importId of importIds)await refreshStatementImportAfterDelete({tenantKey,financialYear,importId});

  // Any deletion changes every later Running Balance for that bank.
  for(const bankAccountId of bankAccountIds){
    const bank=await BankAccount.findOne({tenantKey,bankAccountId,status:{$ne:"DELETED"}});
    if(bank)await recalculatePostedBankRunningBalances({tenantKey,financialYear,bank});
  }

  return {deleted,statement,receipts,payments};
}

function transactionDateFilter(fromDateValue="",toDateValue=""){
  const fromDate=clean(fromDateValue),toDate=clean(toDateValue);const range={};
  if(fromDate){const d=new Date(`${fromDate}T00:00:00.000Z`);if(!Number.isNaN(d.getTime()))range.$gte=d;}
  if(toDate){const d=new Date(`${toDate}T23:59:59.999Z`);if(!Number.isNaN(d.getTime()))range.$lte=d;}
  return Object.keys(range).length?range:null;
}

async function transactionIdsForDeleteAll({tenantKey,financialYear,fromDate="",toDate="",bankAccountId="",type="ALL",q=""}){
  const {BankStatementRow,Receipt,Payment}=financialModels(tenantKey,financialYear);
  const rx=q?new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"):null;
  const statementFilter={tenantKey,financialYear,transactionId:{$nin:[null,""]},classification:{$in:["POSTED","SUSPENSE","UNMATCHED"]}};
  const dateFilter=transactionDateFilter(fromDate,toDate);if(dateFilter)statementFilter.date=dateFilter;
  if(bankAccountId)statementFilter.bankAccountId=bankAccountId;if(["RECEIPT","PAYMENT"].includes(type))statementFilter.transactionType=type;
  if(rx)statementFilter.$or=[{matchedPartyName:rx},{partyName:rx},{remarks:rx},{mode:rx},{transactionId:rx}];
  const manualBase={tenantKey,financialYear,$or:[{statementImportId:{$exists:false}},{statementImportId:""},{statementImportId:null}]};
  if(dateFilter)manualBase.date=dateFilter;
  if(bankAccountId)manualBase.bankAccountId=bankAccountId;
  const receiptFilter={...manualBase},paymentFilter={...manualBase};
  if(rx){receiptFilter.$and=[{$or:manualBase.$or},{$or:[{partyNameSnapshot:rx},{remarks:rx},{mode:rx},{receiptNo:rx}]}];delete receiptFilter.$or;paymentFilter.$and=[{$or:manualBase.$or},{$or:[{partyNameSnapshot:rx},{remarks:rx},{mode:rx},{paymentNo:rx}]}];delete paymentFilter.$or;}
  const [bst,rct,pay]=await Promise.all([
    BankStatementRow.find(statementFilter).select("_id").lean(),
    type==="PAYMENT"?[]:Receipt.find(receiptFilter).select("_id").lean(),
    type==="RECEIPT"?[]:Payment.find(paymentFilter).select("_id").lean()
  ]);
  return [...bst.map(x=>`BST:${x._id}`),...rct.map(x=>`RCT:${x._id}`),...pay.map(x=>`PAY:${x._id}`)];
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
  await recalculatePostedBankRunningBalances({tenantKey:req.auth.tenantKey,financialYear,bank});
  return ok(res,openingForYear(bank,financialYear),`Opening balance saved for ${financialYear}; Running Balance rebuilt automatically`);
});


router.get("/transactions", async (req,res)=>{
  const financialYear=clean(req.query.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");
  if(!financialYear)return fail(res,"Select Financial Year",400);
  const {BankStatementRow,BankStatementImport,Receipt,Payment}=financialModels(req.auth.tenantKey,financialYear);
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.max(10,Math.min(200,Number(req.query.limit||50)));
  const q=clean(req.query.q),bankAccountId=clean(req.query.bankAccountId),type=upper(req.query.type||"ALL");
  const rx=q?new RegExp(q,"i"):null,dateFilter=transactionDateFilter(req.query.fromDate,req.query.toDate);
  const statementFilter={tenantKey:req.auth.tenantKey,financialYear,transactionId:{$nin:[null,""]},classification:{$in:["POSTED","SUSPENSE","UNMATCHED"]}};
  if(dateFilter)statementFilter.date=dateFilter;
  if(bankAccountId)statementFilter.bankAccountId=bankAccountId;
  if(["RECEIPT","PAYMENT"].includes(type))statementFilter.transactionType=type;
  if(rx)statementFilter.$or=[{matchedPartyName:rx},{partyName:rx},{remarks:rx},{mode:rx},{transactionId:rx}];
  const manualBase={tenantKey:req.auth.tenantKey,financialYear,$or:[{statementImportId:{$exists:false}},{statementImportId:""},{statementImportId:null}]};
  if(dateFilter)manualBase.date=dateFilter;
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
  const enriched=items.map(x=>{const batch=im.get(String(x.importId||x.statementImportId||""));const partyRef=String(x.matchedPartyGlobalId||"");const partyName=x.matchedPartyName||x.partyName||partyMap.get(partyRef)?.name||"";const userId=String(x.submittedBy||batch?.submittedBy||x.createdBy||batch?.importedBy||"");const userName=x.submittedByNameSnapshot||batch?.submittedByNameSnapshot||x.createdByNameSnapshot||batch?.importedByNameSnapshot||userMap.get(userId)||userId;return {...x,matchedPartyName:partyName,partyNameDisplay:partyName,userNameDisplay:userName,bankNameSnapshot:x.bankNameSnapshot||bm.get(String(x.bankAccountId))?.bankName||"",bankAccountNumberSnapshot:bm.get(String(x.bankAccountId))?.accountNumber||""}});
  return ok(res,{items:enriched,meta:{page,limit,total,pages:Math.max(1,Math.ceil(total/limit))}});
});

// Ledger is source-verified on every read. This admin-only reconciliation
// physically removes ONLY verified extra lines / orphan lines, never invoices,
// legitimate bank transactions, or disputed amount/party mismatches.
async function bankLedgerAudit({tenantKey,financialYear}){
  const {LedgerEntry,Receipt,Payment,BankStatementRow}=financialModels(tenantKey,financialYear);
  const rows=await LedgerEntry.find({tenantKey,financialYear,status:"POSTED",transactionType:{$in:["RECEIPT","PAYMENT","BANK_STATEMENT_RECEIPT","BANK_STATEMENT_PAYMENT"]}})
    .sort({createdAt:1,_id:1}).lean();
  const checked=await inspectBankLedgerRows({tenantKey,financialYear,rows});
  const [duplicateReceipts,duplicatePayments,postedStatements]=await Promise.all([
    Receipt.aggregate([{$match:{tenantKey,financialYear}},{$group:{_id:"$receiptNo",count:{$sum:1}}},{$match:{count:{$gt:1}}}]),
    Payment.aggregate([{$match:{tenantKey,financialYear}},{$group:{_id:"$paymentNo",count:{$sum:1}}},{$match:{count:{$gt:1}}}]),
    BankStatementRow.find({tenantKey,financialYear,transactionId:{$nin:[null,""]}})
      .select("_id bankAccountId transactionId rowNo date remarks debit credit runningBalance").sort({createdAt:1,_id:1}).lean(),
  ]);
  const seen=new Map(),duplicateStatements=[];
  for(const row of postedStatements){
    const id=postedBankFingerprint(financialYear,row.bankAccountId,row);
    if(seen.has(id))duplicateStatements.push({rowId:String(row._id),transactionId:row.transactionId,originalTransactionId:seen.get(id)});
    else seen.set(id,row.transactionId);
  }
  const byTransaction=new Map();
  for(const row of checked.rows){
    const id=clean(row.transactionId);
    const current=byTransaction.get(id)||{transactionId:id,debit:0,credit:0,lines:0};
    current.debit+=Number(row.debit||0);current.credit+=Number(row.credit||0);current.lines++;
    byTransaction.set(id,current);
  }
  const unbalancedTransactions=[...byTransaction.values()].filter(x=>Math.abs(x.debit-x.credit)>0.01||x.lines!==2)
    .map(x=>({...x,debit:round2(x.debit),credit:round2(x.credit)}));
  return {
    journalRows:rows.length,unbalancedTransactions,duplicateLedgerLines:checked.duplicateIds.map(String),
    orphanLedgerLines:checked.orphanIds.map(String),inconsistentLedgerLines:checked.inconsistentIds.map(String),
    duplicateStatementTransactions:duplicateStatements,
    duplicateReceiptNumbers:duplicateReceipts.map(x=>({receiptNo:x._id,count:x.count})),
    duplicatePaymentNumbers:duplicatePayments.map(x=>({paymentNo:x._id,count:x.count})),
  };
}

router.get("/transactions/ledger-integrity",async(req,res,next)=>{
  try{
    if(!isAdminAuth(req.auth))return fail(res,"Admin permission required",403);
    const financialYear=clean(req.query.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");
    if(!financialYear)return fail(res,"Select Financial Year",400);
    return ok(res,{financialYear,...await bankLedgerAudit({tenantKey:req.auth.tenantKey,financialYear})});
  }catch(error){return next(error);}
});
router.post("/transactions/ledger-integrity/repair",async(req,res,next)=>{
  try{
    if(!isAdminAuth(req.auth))return fail(res,"Admin permission required",403);
    const financialYear=clean(req.body.financialYear);
    if(!financialYear)return fail(res,"Financial Year is required",400);
    const audit=await bankLedgerAudit({tenantKey:req.auth.tenantKey,financialYear});
    const remove=[...new Set([...audit.duplicateLedgerLines,...audit.orphanLedgerLines])];
    if(req.body.confirm!=="REPAIR_BANK_LEDGER")return ok(res,{financialYear,dryRun:true,wouldRemove:remove.length,...audit},"Preview only. Explicit confirmation is required for repair.");
    const {LedgerEntry}=financialModels(req.auth.tenantKey,financialYear);
    const result=remove.length?await LedgerEntry.deleteMany({tenantKey:req.auth.tenantKey,financialYear,_id:{$in:remove},status:"POSTED"}):{deletedCount:0};
    return ok(res,{financialYear,removedLedgerLines:result.deletedCount||0,remaining:await bankLedgerAudit({tenantKey:req.auth.tenantKey,financialYear})},"Verified duplicate/orphan ledger lines reconciled. Conflicting source documents require manual review.");
  }catch(error){return next(error);}
});

router.post("/transactions/bulk-delete",async(req,res,next)=>{
  try{
    const financialYear=clean(req.body.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");if(!financialYear)return fail(res,"Select Financial Year",400);
    const ids=Array.isArray(req.body.ids)?req.body.ids:[];if(!ids.length)return fail(res,"Select at least one bank transaction",400);
    const result=await deleteBankTransactionIds({tenantKey:req.auth.tenantKey,financialYear,ids});
    return ok(res,result,`${result.deleted} bank transaction(s) deleted`);
  }catch(error){return next(error);}
});

router.post("/transactions/delete-all",async(req,res,next)=>{
  try{
    const financialYear=clean(req.body.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");if(!financialYear)return fail(res,"Select Financial Year",400);
    const ids=await transactionIdsForDeleteAll({tenantKey:req.auth.tenantKey,financialYear,fromDate:clean(req.body.fromDate),toDate:clean(req.body.toDate),bankAccountId:clean(req.body.bankAccountId),type:upper(req.body.type||"ALL"),q:clean(req.body.q)});
    if(!ids.length)return ok(res,{deleted:0},"No bank transactions matched the current filters");
    const result=await deleteBankTransactionIds({tenantKey:req.auth.tenantKey,financialYear,ids});
    return ok(res,result,`${result.deleted} bank transaction(s) deleted`);
  }catch(error){return next(error);}
});

router.post("/:id/statement-preview", upload.single("file"), async (req,res,next)=>{
  try{
    if(!req.file?.buffer)return fail(res,"Bank statement Excel/CSV file is required",400);
    const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:"ACTIVE"});
    if(!bank)return fail(res,"Active bank account not found",404);

    // CSV dates must stay as text here. SheetJS can otherwise auto-parse
    // DD-MM-YYYY values as MM-DD-YYYY.
    const isCsv=/\.csv$/i.test(clean(req.file.originalname))||/csv/i.test(clean(req.file.mimetype));
    let rawRows;
    try{rawRows=readRows(req.file.buffer,{preserveText:isCsv});}
    catch{return fail(res,"Unable to read bank statement file",400);}
    if(!rawRows.length)return fail(res,"Uploaded bank statement has no rows",400);

    const fields=[
      {key:"date",label:"Date",aliases:["txn date","transaction date","value date"],required:true},
      {key:"partyName",label:"Party Name",aliases:["party","particulars","name","beneficiary","description"]},
      {key:"remarks",label:"Remarks",aliases:["remark","narration","details"],required:true},
      {key:"mode",label:"Mode",aliases:["transaction mode","type"]},
      {key:"debit",label:"Debit",aliases:["withdrawal","debit amount"],required:true},
      {key:"credit",label:"Credit",aliases:["deposit","credit amount"],required:true},
      // Legacy bank exports may still contain Balance / Running Balance. We
      // accept it for compatibility but never validate or trust it.
      {key:"runningBalance",label:"Running Balance",aliases:["balance","closing balance"],required:false},
    ];
    const cols=resolveColumns(rawRows[0],fields);
    const missing=fields.filter(f=>f.required&&!cols[f.key]).map(f=>f.label);
    if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);

    const normalized=normalizeStatementRows(rawRows,cols);
    if(normalized.errors.length)return fail(res,"Bank statement has invalid rows",400,{errors:normalized.errors.slice(0,50)});

    let rows=sortStatementRows(normalized.rows);
    if(!rows.length)return fail(res,"Uploaded bank statement has no transaction rows",400);

    const rowYears=[...new Set(rows.map(r=>financialYearFromDate(r.date)).filter(Boolean))];
    if(rowYears.length!==1)return fail(
      res,
      rowYears.length
        ? `Statement contains transactions from multiple financial years (${rowYears.join(", ")}). Upload each financial year separately.`
        : "Could not determine Financial Year from statement dates",
      400,
    );
    const financialYear=rowYears[0];
    const bounds=financialYearBounds(financialYear);
    if(!bounds)return fail(res,"Invalid Financial Year derived from statement dates",400);
    const outside=rows.filter(r=>r.date<bounds.start||r.date>bounds.end);
    if(outside.length)return fail(res,`Statement contains dates outside ${financialYear}`,400,{rows:outside.slice(0,20).map(x=>x.rowNo)});

    // Running balance is now system-generated. The only required base is the
    // bank's FY opening balance, which is maintained in Bank Accounts.
    const opening=openingForYear(bank,financialYear);
    if(!opening.exists){
      return fail(
        res,
        `Set the ${financialYear} opening balance for this bank account once. Running Balance will then be calculated automatically for every upload.`,
        409,
        {financialYear},
      );
    }
    const fyOpeningSigned=signedOpeningValue(opening);

    const {BankStatementImport,BankStatementRow}=financialModels(req.auth.tenantKey,financialYear);

    // Replace this user's abandoned draft for the same bank/FY. Nothing in a
    // draft has been posted.
    const oldDrafts=await BankStatementImport.find({
      tenantKey:req.auth.tenantKey,financialYear,bankAccountId:bank.bankAccountId,
      status:"DRAFT_REVIEW",importedBy:req.auth.sub,
    }).select("importId").lean();
    if(oldDrafts.length){
      const ids=oldDrafts.map(x=>x.importId);
      await BankStatementRow.deleteMany({
        tenantKey:req.auth.tenantKey,financialYear,importId:{$in:ids},
        transactionId:{$in:[null,""]},
      });
      await BankStatementImport.deleteMany({
        tenantKey:req.auth.tenantKey,financialYear,importId:{$in:ids},status:"DRAFT_REVIEW",
      });
    }

    // Detect duplicates BEFORE calculating balances. Running Balance is no
    // longer part of a bank-line identity, so changing/recalculating it can
    // never create false duplicate/mismatch errors.
    const uniqueRows=[];
    let duplicateRows=0;
    const seenInFile=new Set();
    for(const r of rows){
      const identity=postedBankFingerprint(financialYear,bank.bankAccountId,r);
      const duplicate=seenInFile.has(identity)||await existingPostedBankRow({
        BankStatementRow,
        tenantKey:req.auth.tenantKey,
        financialYear,
        bankAccountId:bank.bankAccountId,
        row:r,
      });
      seenInFile.add(identity);
      if(duplicate){duplicateRows++;continue;}
      uniqueRows.push(r);
    }
    if(!uniqueRows.length){
      return fail(res,"All rows in this file are already imported",409,{duplicateRows});
    }

    const calculated=await calculateDraftRunningBalances({
      tenantKey:req.auth.tenantKey,
      financialYear,
      bankAccountId:bank.bankAccountId,
      openingSigned:fyOpeningSigned,
      draftRows:uniqueRows,
    });
    rows=calculated.rows;

    const matcher=await buildSmartPartyMatcher(req.auth.tenantKey,{excludeBankAccountId:bank.bankAccountId});
    const importId=makeId("BST");
    const localMatchByRow=new Map(rows.map(r=>[Number(r.rowNo),matcher.detect(r)]));
    const aiMatchByRow=await resolveNarrationsWithAi(
      rows.filter(r=>!localMatchByRow.get(Number(r.rowNo))?.entry),
      matcher,
    );

    const preview=[];
    let unmatchedRows=0,autoMatchedRows=0;
    for(const r of rows){
      const sourceFingerprint=statementFingerprint(financialYear,bank.bankAccountId,r);
      const found=aiMatchByRow.get(Number(r.rowNo))||localMatchByRow.get(Number(r.rowNo))||matcher.detect(r);
      const entry=found.entry;
      const partyId=entry?.ref||"";
      const partyName=entry?.preferred||"Suspense Account";
      const partyCode=entry?.partyAccountCode||"SYS_SUSPENSE";
      const classification=entry?"AUTO_MATCHED":"SUSPENSE";
      if(entry)autoMatchedRows++;else unmatchedRows++;
      const fingerprint=crypto.createHash("sha256").update(`${importId}|${sourceFingerprint}`).digest("hex");
      const doc=await BankStatementRow.create({
        tenantKey:req.auth.tenantKey,financialYear,importId,
        bankAccountId:bank.bankAccountId,rowNo:r.rowNo,date:r.date,
        partyName,remarks:r.remarks,mode:r.mode,debit:r.debit,credit:r.credit,
        runningBalance:r.runningBalance,fingerprint,sourceFingerprint,
        matchedPartyGlobalId:partyId,matchedPartyName:partyName,partyAccountCode:partyCode,
        transactionType:r.credit>0?"RECEIPT":"PAYMENT",transactionId:"",
        classification,detectionSource:found.source,matchConfidence:found.confidence,
        candidateCount:found.candidateCount,createdBy:req.auth.sub,
        createdByNameSnapshot:req.auth.name||"",
      });
      preview.push({...doc.toObject(),date:r.date.toISOString(),duplicate:false});
    }

    const totalDebit=round2(rows.reduce((s,x)=>s+x.debit,0));
    const totalCredit=round2(rows.reduce((s,x)=>s+x.credit,0));
    const closingBalance=calculated.closingBalance;

    await BankStatementImport.create({
      tenantKey:req.auth.tenantKey,financialYear,importId,
      bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,
      accountNumberSnapshot:bank.accountNumber,fileName:req.file.originalname,
      openingBalance:calculated.balanceBeforeFirstDraft,closingBalance,
      totalDebit,totalCredit,totalRows:rows.length,postedRows:0,unmatchedRows,
      duplicateRows,errorRows:0,status:"DRAFT_REVIEW",importedBy:req.auth.sub,
      importedByNameSnapshot:req.auth.name||"",
    });

    return ok(res,{
      importId,
      bankAccountId:bank.bankAccountId,
      bankName:bank.bankName,
      financialYear,
      totalRows:rows.length,
      reviewRows:preview,
      duplicateRows,
      autoMatchedRows,
      unmatchedRows,
      fyOpeningBalance:fyOpeningSigned,
      openingBalance:calculated.balanceBeforeFirstDraft,
      ignoredOpeningRows:normalized.ignoredOpeningRows,
      ignoredTemplateRows:normalized.ignoredTemplateRows,
      closingBalance,totalDebit,totalCredit,
      runningBalanceCalculated:true,
    },`Statement ready for review: ${autoMatchedRows} auto-matched, ${unmatchedRows} suspense, ${duplicateRows} duplicates skipped. Running Balance calculated automatically.`);
  }catch(error){return next(error);}
});

// v26 compatibility: upload now means preview only; it never posts before review.
router.post("/:id/statement-upload", upload.single("file"), async (req,res,next)=>{
  req.url=req.url.replace(/statement-upload$/,"statement-preview");
  return next();
});


router.put("/:id/statement-review/:importId", async (req,res,next)=>{
  try{
    const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:"ACTIVE"});
    if(!bank)return fail(res,"Active bank account not found",404);

    const financialYear=clean(req.body.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");
    if(!financialYear)return fail(res,"Select Financial Year",400);

    const edits=Array.isArray(req.body.rows)?req.body.rows:[];
    if(!edits.length)return fail(res,"No statement review rows supplied",400);

    const {BankStatementImport,BankStatementRow}=financialModels(req.auth.tenantKey,financialYear);
    const batch=await BankStatementImport.findOne({
      tenantKey:req.auth.tenantKey,financialYear,importId:req.params.importId,
      bankAccountId:bank.bankAccountId,status:"DRAFT_REVIEW",
    });
    if(!batch)return fail(res,"Statement review draft not found or already submitted",404);

    const docs=await BankStatementRow.find({
      tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,
      transactionId:{$in:[null,""]},
    }).sort({rowNo:1});

    const editMap=new Map(edits.map(x=>[Number(x.rowNo),x]));
    const matcher=await buildSmartPartyMatcher(req.auth.tenantKey,{excludeBankAccountId:bank.bankAccountId});
    const validation=[];
    const prepared=[];

    for(const doc of docs){
      const edit=editMap.get(Number(doc.rowNo));
      const has=(key)=>Boolean(edit)&&Object.prototype.hasOwnProperty.call(edit,key);
      const date=has("date")&&clean(edit.date)?parseStatementDate(edit.date):doc.date;
      const remarks=has("remarks")?clean(edit.remarks):clean(doc.remarks);
      const mode=normalizeStatementMode(has("mode")?edit.mode:doc.mode,remarks);
      const debitRaw=has("debit")&&edit.debit!==""&&edit.debit!==null?Number(edit.debit):Number(doc.debit||0);
      const creditRaw=has("credit")&&edit.credit!==""&&edit.credit!==null?Number(edit.credit):Number(doc.credit||0);
      const debit=Number.isFinite(debitRaw)?Math.max(0,debitRaw):NaN;
      const credit=Number.isFinite(creditRaw)?Math.max(0,creditRaw):NaN;

      let requested=has("partyGlobalId")?clean(edit.partyGlobalId):clean(doc.matchedPartyGlobalId);
      if(!date)validation.push({row:doc.rowNo,error:"Invalid date"});
      else if(financialYearFromDate(date)!==financialYear)validation.push({row:doc.rowNo,error:`Date must remain inside ${financialYear}`});
      if(!Number.isFinite(debit)||!Number.isFinite(credit)||(debit>0&&credit>0)||(debit<=0&&credit<=0)){
        validation.push({row:doc.rowNo,error:"Enter either Debit or Credit, not both"});
      }

      let selected=null;
      if(requested&&requested!=="SUSPENSE")selected=matcher.byId.get(requested)||null;
      if(requested&&requested!=="SUSPENSE"&&!selected){
        const recovered=matcher.detect({remarks,partyHint:extractPartyHintFromRemarks(remarks)});
        selected=recovered.entry||null;
        requested=selected?.ref||"SUSPENSE";
      }

      prepared.push({
        doc,date,remarks,mode,
        debit:round2(debit),credit:round2(credit),
        requested,
        originalPartyRef:clean(doc.matchedPartyGlobalId),
        selected,
      });
    }

    if(validation.length)return fail(res,"Some edited bank statement rows are invalid",400,{errors:validation.slice(0,50)});

    // Duplicate checking uses transaction identity only. Running Balance is
    // intentionally excluded because it is derived, not uploaded data.
    const seen=new Set();
    for(const item of prepared){
      const sourceRow={
        rowNo:item.doc.rowNo,date:item.date,sourcePartyName:"",partyName:"",
        remarks:item.remarks,mode:item.mode,debit:item.debit,credit:item.credit,
      };
      const identity=postedBankFingerprint(financialYear,bank.bankAccountId,sourceRow);
      if(seen.has(identity)){
        validation.push({row:item.doc.rowNo,error:"Duplicate transaction inside the uploaded statement"});
        continue;
      }
      seen.add(identity);
      const duplicate=await existingPostedBankRow({
        BankStatementRow,tenantKey:req.auth.tenantKey,financialYear,
        bankAccountId:bank.bankAccountId,row:sourceRow,excludeId:item.doc._id,
      });
      if(duplicate)validation.push({row:item.doc.rowNo,error:"This bank transaction is already posted"});
    }
    if(validation.length)return fail(res,"Some edited bank statement rows are invalid",400,{errors:validation.slice(0,50)});

    for(const item of prepared){
      const {doc,date,remarks,mode,debit,credit}=item;
      const selected=item.selected||null;
      const requested=clean(item.requested);
      const sourceRow={rowNo:doc.rowNo,date,sourcePartyName:"",partyName:"",remarks,mode,debit,credit};
      const editedFingerprint=statementFingerprint(financialYear,bank.bankAccountId,sourceRow);

      doc.date=date;
      doc.remarks=remarks;
      doc.mode=mode;
      doc.debit=debit;
      doc.credit=credit;
      doc.transactionType=credit>0?"RECEIPT":"PAYMENT";
      doc.fingerprint=crypto.createHash("sha256").update(`${batch.importId}|${editedFingerprint}`).digest("hex");
      doc.sourceFingerprint=editedFingerprint;
      doc.matchedPartyGlobalId=selected?.ref||"";
      doc.matchedPartyName=selected?.preferred||"Suspense Account";
      doc.partyName=selected?.preferred||"Suspense Account";
      doc.partyAccountCode=selected?.partyAccountCode||"SYS_SUSPENSE";
      doc.classification=selected?"MANUAL_MATCHED":"SUSPENSE";
      doc.detectionSource=selected
        ? (requested===clean(item.originalPartyRef)?doc.detectionSource||"REVIEW_SAVED":"MANUAL_REVIEW_EDIT")
        : "MANUAL_SUSPENSE";
      doc.matchConfidence=selected?100:0;
      doc.candidateCount=selected?1:0;
      doc.error="";
      await doc.save();
    }

    const opening=openingForYear(bank,financialYear);
    if(!opening.exists)return fail(res,`Set the ${financialYear} opening balance for this bank account`,409);

    const draftDocs=await BankStatementRow.find({
      tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,
      transactionId:{$in:[null,""]},
    }).lean();

    const calculated=await calculateDraftRunningBalances({
      tenantKey:req.auth.tenantKey,
      financialYear,
      bankAccountId:bank.bankAccountId,
      openingSigned:signedOpeningValue(opening),
      draftRows:draftDocs,
    });

    if(calculated.rows.length){
      await BankStatementRow.bulkWrite(
        calculated.rows.map(x=>({
          updateOne:{filter:{_id:x._id},update:{$set:{runningBalance:Number(x.runningBalance||0)}}},
        })),
        {ordered:false},
      );
    }

    const saved=await BankStatementRow.find({
      tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,
      transactionId:{$in:[null,""]},
    }).sort({date:1,rowNo:1}).lean();

    batch.openingBalance=calculated.balanceBeforeFirstDraft;
    batch.closingBalance=saved.length?Number(saved[saved.length-1].runningBalance||0):calculated.balanceBeforeFirstDraft;
    batch.totalDebit=round2(saved.reduce((sum,x)=>sum+Number(x.debit||0),0));
    batch.totalCredit=round2(saved.reduce((sum,x)=>sum+Number(x.credit||0),0));
    batch.unmatchedRows=saved.filter(x=>!clean(x.matchedPartyGlobalId)).length;
    await batch.save();

    return ok(res,{
      reviewRows:saved.map(x=>({...x,date:x.date?.toISOString?.()||x.date})),
      openingBalance:batch.openingBalance,
      closingBalance:batch.closingBalance,
      totalDebit:batch.totalDebit,
      totalCredit:batch.totalCredit,
      unmatchedRows:batch.unmatchedRows,
      runningBalanceCalculated:true,
    },"Review changes saved and Running Balance recalculated automatically");
  }catch(error){return next(error);}
});

router.post("/:id/statement-submit/:importId", async (req,res,next)=>{
  try{
    const bank=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:"ACTIVE"});if(!bank)return fail(res,"Active bank account not found",404);
    const financialYear=clean(req.body.financialYear)||await ensureDefaultFinancialYear(req.auth.tenantKey,"");if(!financialYear)return fail(res,"Select Financial Year",400);
    const {Receipt,Payment,BankStatementImport,BankStatementRow}=financialModels(req.auth.tenantKey,financialYear);
    await Promise.all([Receipt.init(),Payment.init(),BankStatementRow.init()]);
    const batch=await BankStatementImport.findOne({tenantKey:req.auth.tenantKey,financialYear,importId:req.params.importId,bankAccountId:bank.bankAccountId,status:"DRAFT_REVIEW"});
    if(!batch)return fail(res,"Statement review draft not found or already submitted",404);
    let rows=await BankStatementRow.find({tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,transactionId:{$in:[null,""]}}).sort({date:1,rowNo:1});
    const opening=openingForYear(bank,financialYear);
    if(!opening.exists)return fail(res,`Set the ${financialYear} opening balance for this bank account`,409);

    // Recalculate immediately before posting too. If another bank transaction
    // was entered after preview, the submitted statement still receives the
    // correct balances from the latest bank history.
    const preSubmitCalculated=await calculateDraftRunningBalances({
      tenantKey:req.auth.tenantKey,
      financialYear,
      bankAccountId:bank.bankAccountId,
      openingSigned:signedOpeningValue(opening),
      draftRows:rows.map(x=>x.toObject()),
    });
    if(preSubmitCalculated.rows.length){
      await BankStatementRow.bulkWrite(
        preSubmitCalculated.rows.map(x=>({
          updateOne:{filter:{_id:x._id},update:{$set:{runningBalance:Number(x.runningBalance||0)}}},
        })),
        {ordered:false},
      );
    }
    rows=await BankStatementRow.find({tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,transactionId:{$in:[null,""]}}).sort({date:1,rowNo:1});

    const matcher=await buildSmartPartyMatcher(req.auth.tenantKey,{excludeBankAccountId:bank.bankAccountId});
    const assignmentMap=new Map((Array.isArray(req.body.assignments)?req.body.assignments:[]).map(x=>[Number(x.rowNo),clean(x.partyGlobalId)]));
    const bankSystemCode=["OD","CC"].includes(upper(bank.accountType))?"SYS_BANK_OD":"SYS_BANK_ACCOUNT";
    let postedRows=0,unmatchedRows=0,errorRows=0;const errors=[];
    for(const r of rows){
      let createdTransactionId="",createdType="",claimed=false;
      try{
        const requested=assignmentMap.has(Number(r.rowNo))?assignmentMap.get(Number(r.rowNo)):clean(r.matchedPartyGlobalId);
        const selected=requested&&requested!=="SUSPENSE"?matcher.byId.get(String(requested)):null;
        const partyId=selected?.ref||"";const partyName=selected?.preferred||"Suspense Account";const partyCode=selected?.partyAccountCode||"SYS_SUSPENSE";const partyLedgerId=selected?.ledgerId||"";
        if(selected?.ownerType==="USER"&&partyCode==="SYS_SUSPENSE")throw new Error(`Set Accounting Account Type for ${partyName} in User Master before posting this bank row`);
        const duplicate=await existingPostedBankRow({
          BankStatementRow,tenantKey:req.auth.tenantKey,financialYear,bankAccountId:bank.bankAccountId,row:r,excludeId:r._id,
        });
        if(duplicate)throw new Error(`Bank transaction already posted (row ${r.rowNo}); re-import rejected`);
        // Unique partial DB index claims the statement line before creating
        // the receipt/payment; concurrent submissions cannot post it twice.
        const uniqueIdentity=postedBankFingerprint(financialYear,bank.bankAccountId,r);
        const claim=await BankStatementRow.findOneAndUpdate({
          _id:r._id,tenantKey:req.auth.tenantKey,financialYear,
          transactionId:{$in:[null,""]},postingFingerprint:{$exists:false},
        },{$set:{postingFingerprint:uniqueIdentity}},{new:true});
        if(!claim)throw new Error(`Row ${r.rowNo} was already claimed or posted by another submission`);
        claimed=true;
        r.postingFingerprint=uniqueIdentity;
        const isReceipt=r.credit>0,amount=isReceipt?Number(r.credit||0):Number(r.debit||0),transactionId=makeId(isReceipt?"RCT":"PAY");
        createdTransactionId=transactionId;
        createdType=isReceipt?"RECEIPT":"PAYMENT";
        const bankEntry={accountCode:bankSystemCode,ledgerId:bank.ledgerId||"",bankAccountId:bank.bankAccountId};
        if(isReceipt){
          await Receipt.create({tenantKey:req.auth.tenantKey,financialYear,receiptNo:transactionId,sourceKey:transactionId,date:r.date,customerGlobalId:partyId,partyNameSnapshot:partyName,amount,mode:r.mode||"BANK",reference:"",remarks:r.remarks,bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,statementImportId:batch.importId,statementRowNo:r.rowNo,runningBalance:r.runningBalance,bounceStatus:"CLEAR",status:selected?"POSTED":"PENDING_CLASSIFICATION",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId,transactionType:"BANK_STATEMENT_RECEIPT",date:r.date,partyGlobalId:partyId,narration:r.remarks||`Bank receipt - ${partyName}`,entries:[{...bankEntry,debit:amount},{accountCode:partyCode,ledgerId:partyLedgerId,credit:amount}]});
        }else{
          await Payment.create({tenantKey:req.auth.tenantKey,financialYear,paymentNo:transactionId,sourceKey:transactionId,date:r.date,partyGlobalId:partyId,partyNameSnapshot:partyName,amount,mode:r.mode||"BANK",reference:"",remarks:r.remarks,bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,statementImportId:batch.importId,statementRowNo:r.rowNo,runningBalance:r.runningBalance,status:selected?"POSTED":"PENDING_CLASSIFICATION",createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
          await postBalancedEntries({tenantKey:req.auth.tenantKey,financialYear,transactionId,transactionType:"BANK_STATEMENT_PAYMENT",date:r.date,partyGlobalId:partyId,narration:r.remarks||`Bank payment - ${partyName}`,entries:[{accountCode:partyCode,ledgerId:partyLedgerId,debit:amount},{...bankEntry,credit:amount}]});
        }
        r.matchedPartyGlobalId=partyId;r.matchedPartyName=partyName;r.partyAccountCode=partyCode;r.transactionId=transactionId;r.classification=selected?"POSTED":"SUSPENSE";r.submittedAt=new Date();r.submittedBy=req.auth.sub;r.submittedByNameSnapshot=req.auth.name||"";await r.save();
        postedRows++;if(!selected)unmatchedRows++;
      }catch(error){
        // If any step failed, remove this attempt's incomplete voucher + journal
        // before clearing its uniqueness claim, so retry never multiplies entries.
        if(createdTransactionId){
          const {LedgerEntry}=financialModels(req.auth.tenantKey,financialYear);
          await LedgerEntry.deleteMany({tenantKey:req.auth.tenantKey,financialYear,transactionId:createdTransactionId});
          if(createdType==="RECEIPT")await Receipt.deleteMany({tenantKey:req.auth.tenantKey,financialYear,receiptNo:createdTransactionId});
          else await Payment.deleteMany({tenantKey:req.auth.tenantKey,financialYear,paymentNo:createdTransactionId});
        }
        // Never clear another request's active claim: only its owner may
        // roll back the postingFingerprint after cleaning its own voucher.
        if(claimed){
          r.transactionId="";r.postingFingerprint=undefined;r.error=error.message;
          await r.save();
        }
        errorRows++;
        if(errors.length<50)errors.push({row:r.rowNo,error:error.message});
      }
    }
    // Rebuild the complete bank running-balance chain after posting. This
    // repairs later balances too when historical rows are uploaded.
    const rebuilt=await recalculatePostedBankRunningBalances({
      tenantKey:req.auth.tenantKey,
      financialYear,
      bank,
    });

    const submittedRows=await BankStatementRow.find({
      tenantKey:req.auth.tenantKey,financialYear,importId:batch.importId,
      transactionId:{$nin:[null,""]},
    }).sort({date:1,rowNo:1}).lean();

    batch.postedRows=postedRows;
    batch.unmatchedRows=unmatchedRows;
    batch.errorRows=errorRows;
    batch.status=errorRows?"SUBMITTED_WITH_ERRORS":"SUBMITTED";
    batch.submittedBy=req.auth.sub;
    batch.submittedByNameSnapshot=req.auth.name||"";
    batch.submittedAt=new Date();
    if(submittedRows.length)batch.closingBalance=Number(submittedRows[submittedRows.length-1].runningBalance||0);
    await batch.save();

    return ok(res,{
      importId:batch.importId,postedRows,unmatchedRows,errorRows,
      totalRows:batch.totalRows,duplicateRows:batch.duplicateRows,
      closingBalance:batch.closingBalance,
      bankClosingBalance:rebuilt.closingBalance,
      runningBalanceRebuilt:rebuilt.updated,
      errors,
    },`Statement submitted: ${postedRows} transactions posted, ${unmatchedRows} to Suspense. Running Balance rebuilt automatically.`);
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

  // Opening-balance edits affect every later bank transaction in that FY.
  for(const openingRow of openingBalances){
    if(clean(openingRow.financialYear)){
      await recalculatePostedBankRunningBalances({
        tenantKey:req.auth.tenantKey,
        financialYear:clean(openingRow.financialYear),
        bank:row,
      });
    }
  }

  return ok(res,row,"Bank account updated");
});

router.delete("/:id", async (req,res)=>{
  const row=await BankAccount.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:{$ne:"DELETED"}}); if(!row)return fail(res,"Bank account not found",404);
  row.status="DELETED";row.isPrimary=false;row.deletedAt=new Date();row.deletedBy=req.auth.sub;row.updatedBy=req.auth.sub;await row.save();
  await CompanyLedger.updateMany({tenantKey:req.auth.tenantKey,ownerType:"BANK_ACCOUNT",ownerId:row.bankAccountId},{$set:{status:"INACTIVE"}});
  return ok(res,{id:row._id},"Bank account deleted safely");
});

export default router;
