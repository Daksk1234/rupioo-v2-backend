import { AccountTemplate, CompanyLedger } from "../models/index.js";
import { makeId } from "../utils/ids.js";


const LEGAL_ACCOUNT_TEMPLATES = [
  ["SYS_PROPRIETOR_CAPITAL","Proprietor Capital","EQUITY","SYS_CAPITAL"],
  ["SYS_PARTNER_CAPITAL","Partners Capital","EQUITY","SYS_CAPITAL"],
  ["SYS_PARTNER_CURRENT","Partners Current Accounts","LIABILITY","SYS_CURRENT_LIABILITIES"],
  ["SYS_PARTNER_LOAN","Partner Loans","LIABILITY","SYS_LOAN_LIABILITY"],
  ["SYS_DRAWINGS","Drawings","EQUITY","SYS_CAPITAL"],
  ["SYS_SHARE_CAPITAL","Share Capital","EQUITY","SYS_CAPITAL"],
  ["SYS_DIRECTOR_LOAN","Director Loans","LIABILITY","SYS_LOAN_LIABILITY"],
  ["SYS_DIRECTOR_ADVANCE","Director Advances","ASSET","SYS_LOANS_ADVANCES"],
  ["SYS_DIRECTOR_REMUNERATION","Director Remuneration Payable","LIABILITY","SYS_CURRENT_LIABILITIES"],
  ["SYS_STAFF_ADVANCE","Staff Advances","ASSET","SYS_LOANS_ADVANCES"],
  ["SYS_SALARY_PAYABLE","Salary Payable","LIABILITY","SYS_CURRENT_LIABILITIES"],
  ["SYS_REIMBURSEMENT_PAYABLE","Reimbursement Payable","LIABILITY","SYS_CURRENT_LIABILITIES"]
];

export async function ensureLegalAccountTemplates(){
  for(const [systemCode,name,nature,parentCode] of LEGAL_ACCOUNT_TEMPLATES){
    await AccountTemplate.findOneAndUpdate(
      {systemCode},
      {$set:{systemCode,name,nature,parentCode,locked:true,allowCompanyLedger:true,reportMap:{trading:false,pnl:false,balanceSheet:true,cma:true}}},
      {upsert:true,new:true,setDefaultsOnInsert:true}
    );
  }
}

const SPECIAL_DEFAULTS = {
  PROPRIETOR: [
    { relationshipType: "CAPITAL", systemAccountCode: "SYS_PROPRIETOR_CAPITAL", suffix: "Capital A/c", openingBalanceType: "CR" }
  ],
  PARTNER: [
    { relationshipType: "CAPITAL", systemAccountCode: "SYS_PARTNER_CAPITAL", suffix: "Capital A/c", openingBalanceType: "CR" },
    { relationshipType: "CURRENT", systemAccountCode: "SYS_PARTNER_CURRENT", suffix: "Current A/c", openingBalanceType: "CR" }
  ],
  DESIGNATED_PARTNER: [
    { relationshipType: "CAPITAL", systemAccountCode: "SYS_PARTNER_CAPITAL", suffix: "Capital A/c", openingBalanceType: "CR" },
    { relationshipType: "CURRENT", systemAccountCode: "SYS_PARTNER_CURRENT", suffix: "Current A/c", openingBalanceType: "CR" }
  ]
};

export function defaultStakeholderRelationships(stakeholder = {}, companyType = "") {
  const role = String(stakeholder.roleType || "").toUpperCase();
  const defaults = SPECIAL_DEFAULTS[role] || [];
  if (stakeholder.accountingRelationships?.length) return stakeholder.accountingRelationships;
  if (companyType === "PROPRIETORSHIP" && role === "PROPRIETOR") {
    return defaults.map(x => ({ ...x, ledgerName: `${stakeholder.name} - ${x.suffix}`, openingBalance: Number(stakeholder.openingCapital || 0), financialYear: stakeholder.financialYear || "" }));
  }
  if (["PARTNERSHIP","LLP"].includes(companyType) && ["PARTNER","DESIGNATED_PARTNER"].includes(role)) {
    return defaults.map(x => ({ ...x, ledgerName: `${stakeholder.name} - ${x.suffix}`, openingBalance: x.relationshipType === "CAPITAL" ? Number(stakeholder.openingCapital || stakeholder.contribution || 0) : 0, financialYear: stakeholder.financialYear || "" }));
  }
  return defaults.map(x => ({ ...x, ledgerName: `${stakeholder.name} - ${x.suffix}`, openingBalance: 0, financialYear: stakeholder.financialYear || "" }));
}

export async function upsertCompanyLedger({ tenantKey, ownerType, ownerId, relationshipType, systemAccountCode, name, openingBalance = 0, openingBalanceType = "DR", financialYear = "", createdFrom = "SYSTEM" }) {
  await ensureLegalAccountTemplates();
  const filter = { tenantKey, ownerType, ownerId: String(ownerId), relationshipType, systemAccountCode };
  const existing = await CompanyLedger.findOne(filter);
  if (existing) {
    existing.name = name || existing.name;
    existing.status = "ACTIVE";
    existing.createdFrom = createdFrom || existing.createdFrom;
    if (financialYear) {
      const row = existing.openingBalances.find(x => x.financialYear === financialYear);
      if (row) { row.amount = Number(openingBalance || 0); row.type = openingBalanceType === "CR" ? "CR" : "DR"; }
      else existing.openingBalances.push({ financialYear, amount: Number(openingBalance || 0), type: openingBalanceType === "CR" ? "CR" : "DR" });
    }
    await existing.save();
    return existing;
  }
  return CompanyLedger.create({
    tenantKey,
    ledgerId: makeId("LED"),
    ownerType,
    ownerId: String(ownerId),
    relationshipType,
    systemAccountCode,
    name,
    openingBalances: financialYear ? [{ financialYear, amount: Number(openingBalance || 0), type: openingBalanceType === "CR" ? "CR" : "DR" }] : [],
    status: "ACTIVE",
    createdFrom
  });
}

export async function syncStakeholderLedgers({ tenantKey, companyType, stakeholder, financialYear = "" }) {
  const relations = defaultStakeholderRelationships({ ...stakeholder, financialYear }, companyType);
  const created = [];
  for (const r of relations) {
    if (!r.systemAccountCode || !r.relationshipType) continue;
    created.push(await upsertCompanyLedger({
      tenantKey,
      ownerType: "STAKEHOLDER",
      ownerId: stakeholder.stakeholderId,
      relationshipType: r.relationshipType,
      systemAccountCode: r.systemAccountCode,
      name: r.ledgerName || `${stakeholder.name} - ${r.relationshipType}`,
      openingBalance: r.openingBalance ?? (r.relationshipType === "CAPITAL" ? stakeholder.openingCapital : 0),
      openingBalanceType: r.openingBalanceType || "CR",
      financialYear: r.financialYear || financialYear,
      createdFrom: "COMPANY_SETUP"
    }));
  }
  return created;
}

export async function syncUserLedgers(user) {
  const rows = [];
  for (const r of user.accountingMappings || []) {
    if (!r.systemAccountCode || !r.relationshipType || !r.ledgerName) continue;
    rows.push(await upsertCompanyLedger({
      tenantKey: user.tenantKey,
      ownerType: "USER",
      ownerId: user._id,
      relationshipType: r.relationshipType,
      systemAccountCode: r.systemAccountCode,
      name: r.ledgerName,
      openingBalance: r.openingBalance,
      openingBalanceType: r.openingBalanceType,
      financialYear: r.financialYear,
      createdFrom: "USER_MASTER"
    }));
  }
  return rows;
}

export async function syncCustomerLedger(link) {
  const p = link.accountingProfile || {};
  return upsertCompanyLedger({
    tenantKey: link.tenantKey,
    ownerType: "CUSTOMER",
    ownerId: link.globalCustomerId,
    relationshipType: (p.systemAccountCode || "SYS_SUNDRY_DEBTORS") === "SYS_SUNDRY_CREDITORS" ? "CUSTOMER_PAYABLE" : "CUSTOMER_RECEIVABLE",
    systemAccountCode: p.systemAccountCode || "SYS_SUNDRY_DEBTORS",
    name: p.ledgerName || `${link.localName || link.displayIdentifier} A/c`,
    openingBalance: p.openingBalance || 0,
    openingBalanceType: p.openingBalanceType || "DR",
    financialYear: p.financialYear || "",
    createdFrom: "CUSTOMER_APPROVAL"
  });
}

export async function createCompanyBaseLedgers(profile) {
  const rows = [];
  if (["PRIVATE_LIMITED","PUBLIC_LIMITED","OPC"].includes(profile.companyType)) {
    rows.push(await upsertCompanyLedger({ tenantKey: profile.tenantKey, ownerType: "COMPANY", ownerId: profile.tenantKey, relationshipType: "SHARE_CAPITAL", systemAccountCode: "SYS_SHARE_CAPITAL", name: "Share Capital", createdFrom: "COMPANY_SETUP" }));
  }
  if (["TRUST","SOCIETY","OTHER"].includes(profile.companyType)) {
    rows.push(await upsertCompanyLedger({ tenantKey: profile.tenantKey, ownerType: "COMPANY", ownerId: profile.tenantKey, relationshipType: "CAPITAL_FUND", systemAccountCode: "SYS_CAPITAL", name: `${profile.companyName} Capital / Fund`, createdFrom: "COMPANY_SETUP" }));
  }
  return rows;
}

export async function ensureBankAccountTemplates() {
  const rows = [
    ["SYS_BANK_ACCOUNT", "Bank Accounts", "ASSET", "SYS_CURRENT_ASSETS"],
    ["SYS_BANK_OD", "Bank OD A/c", "LIABILITY", "SYS_LOAN_LIABILITY"],
  ];

  for (const [systemCode, name, nature, parentCode] of rows) {
    await AccountTemplate.findOneAndUpdate(
      { systemCode },
      {
        $set: {
          systemCode,
          name,
          nature,
          parentCode,
          locked: true,
          allowCompanyLedger: true,
          reportMap: {
            trading: false,
            pnl: false,
            balanceSheet: true,
            cma: true,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
}

export async function syncBankAccountLedger(bankAccount) {
  await ensureBankAccountTemplates();
  const systemAccountCode = ["OD", "CC"].includes(
    String(bankAccount.accountType || "").toUpperCase()
  )
    ? "SYS_BANK_OD"
    : "SYS_BANK_ACCOUNT";

  const fyRows = Array.isArray(bankAccount.openingBalances) && bankAccount.openingBalances.length
    ? bankAccount.openingBalances
    : (bankAccount.financialYear ? [{ financialYear: bankAccount.financialYear, amount: bankAccount.openingBalance, type: bankAccount.openingBalanceType }] : []);

  let ledger = null;
  if (!fyRows.length) {
    ledger = await upsertCompanyLedger({
      tenantKey: bankAccount.tenantKey, ownerType: "BANK_ACCOUNT", ownerId: bankAccount.bankAccountId,
      relationshipType: "BANK_ACCOUNT", systemAccountCode, name: `${bankAccount.bankName} - ${bankAccount.accountNumber}`,
      createdFrom: "BANK_ACCOUNT_MASTER"
    });
  } else {
    for (const fyRow of fyRows) {
      if (!fyRow?.financialYear) continue;
      ledger = await upsertCompanyLedger({
        tenantKey: bankAccount.tenantKey, ownerType: "BANK_ACCOUNT", ownerId: bankAccount.bankAccountId,
        relationshipType: "BANK_ACCOUNT", systemAccountCode, name: `${bankAccount.bankName} - ${bankAccount.accountNumber}`,
        openingBalance: Number(fyRow.amount || 0), openingBalanceType: fyRow.type === "CR" ? "CR" : "DR",
        financialYear: fyRow.financialYear, createdFrom: "BANK_ACCOUNT_MASTER"
      });
    }
  }
  return ledger;
}
