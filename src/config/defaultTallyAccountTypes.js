export const DEFAULT_TALLY_ACCOUNT_TYPES = [
  ["SYS_BRANCH_DIVISION","Branch/Divisions","LIABILITY"],
  ["SYS_CAPITAL","Capital Account","EQUITY"],
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
  ["SYS_REIMBURSEMENT_PAYABLE","Reimbursement Payable","LIABILITY","SYS_CURRENT_LIABILITIES"],
  ["SYS_CURRENT_ASSETS","Current Assets","ASSET"],
  ["SYS_CURRENT_LIABILITIES","Current Liabilities","LIABILITY"],
  ["SYS_DIRECT_EXPENSE","Direct Expenses","EXPENSE"],
  ["SYS_DIRECT_INCOME","Direct Incomes","INCOME"],
  ["SYS_FIXED_ASSETS","Fixed Assets","ASSET"],
  ["SYS_INDIRECT_EXPENSE","Indirect Expenses","EXPENSE"],
  ["SYS_INDIRECT_INCOME","Indirect Incomes","INCOME"],
  ["SYS_INVESTMENT","Investments","ASSET"],
  ["SYS_LOAN_LIABILITY","Loans (Liability)","LIABILITY"],
  ["SYS_MISC_EXP_ASSET","Misc. Expenses (Asset)","ASSET"],
  ["SYS_PURCHASE","Purchase Accounts","EXPENSE"],
  ["SYS_SALES","Sales Accounts","INCOME"],
  ["SYS_SUSPENSE","Suspense A/c","ASSET"],
  ["SYS_BANK_ACCOUNT","Bank Accounts","ASSET"],
  ["SYS_BANK_OD","Bank OD A/c","LIABILITY"],
  ["SYS_CASH","Cash-in-hand","ASSET"],
  ["SYS_DEPOSIT_ASSET","Deposits (Asset)","ASSET"],
  ["SYS_DUTIES_TAXES","Duties & Taxes","LIABILITY"],
  ["SYS_LOANS_ADVANCES","Loans & Advances (Asset)","ASSET"],
  ["SYS_PROVISIONS","Provisions","LIABILITY"],
  ["SYS_RESERVES_SURPLUS","Reserves & Surplus","EQUITY"],
  ["SYS_SECURED_LOAN","Secured Loans","LIABILITY"],
  ["SYS_STOCK","Stock-in-hand","ASSET"],
  ["SYS_SUNDRY_CREDITORS","Sundry Creditors","LIABILITY"],
  ["SYS_SUNDRY_DEBTORS","Sundry Debtors","ASSET"],
  ["SYS_UNSECURED_LOAN","Unsecured Loans","LIABILITY"]
].map(([systemCode,name,nature,parentCode])=>({
  systemCode,name,nature,parentCode:parentCode||undefined,
  locked:true,
  allowCompanyLedger:true,
  reportMap:{
    trading:["SYS_SALES","SYS_PURCHASE","SYS_DIRECT_EXPENSE","SYS_DIRECT_INCOME","SYS_STOCK"].includes(systemCode),
    pnl:["INCOME","EXPENSE"].includes(nature),
    balanceSheet:["ASSET","LIABILITY","EQUITY"].includes(nature),
    cma:true
  }
}));

export async function ensureDefaultTallyAccountTypes(AccountTemplate){
  if(!AccountTemplate) return DEFAULT_TALLY_ACCOUNT_TYPES;
  const operations=DEFAULT_TALLY_ACCOUNT_TYPES.map(row=>({
    updateOne:{
      filter:{systemCode:row.systemCode},
      update:{$setOnInsert:row},
      upsert:true
    }
  }));
  if(operations.length) await AccountTemplate.bulkWrite(operations,{ordered:false});
  return AccountTemplate.find({systemCode:{$in:DEFAULT_TALLY_ACCOUNT_TYPES.map(x=>x.systemCode)}}).sort({name:1}).lean();
}
