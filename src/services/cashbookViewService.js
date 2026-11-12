import {CompanyProfile,BankAccount} from '../models/index.js';
import {financialCollectionExists,financialModels} from './accountingService.js';
import {loadCashSalesCashbook} from './cashSalesCashbookService.js';
import {cashAmount} from './cashbookBalanceMath.js';
import {applyCashCorrections} from './superadminBookCorrectionRules.js';
import {discoverFinancialYears,normalizeYears,validFY} from './financialYearDiscoveryService.js';

export const CASHBOOK_SOURCE_MODE='ALL_POSTED_CASH_VOUCHERS_AND_BANK_MOVEMENTS_V3';
export const CASHBOOK_RECEIPT_SOURCE='CASHBOOK_CREATE_TRANSACTION';
const BANK_CASH_TYPES=['CONTRA','SALESPERSON_BANK_DEPOSIT','CASH_BANK_DEPOSIT','BANK_CASH_WITHDRAWAL'];
const BANK_ACCOUNTS=['SYS_BANK_ACCOUNT','SYS_BANK_OD'];
const isCollectorReceipt=receipt=>receipt.collectionSource==='SALESPERSON_APP'||Boolean(receipt.collectedBySalespersonId||receipt.cashCustodyMovementId);

export function isCashbookReceipt(receipt){
  return receipt.mode==='CASH'&&receipt.status==='POSTED'&&!isCollectorReceipt(receipt);
}

export function isPostedCashierReceipt(receipt,postedCashierReceiptNos=[]){
  return isCollectorReceipt(receipt)&&receipt.mode==='CASH'&&receipt.status==='POSTED'&&
    receipt.customerOtpStatus==='VERIFIED'&&Boolean(receipt.ledgerPostedAt)&&
    ['DEPOSITED_TO_CASHIER','CLOSED'].includes(receipt.cashDepositStatus)&&
    (postedCashierReceiptNos instanceof Set?postedCashierReceiptNos.has(String(receipt.receiptNo)):postedCashierReceiptNos.includes(String(receipt.receiptNo)));
}

export function buildCashbookView({salesRows=[],receipts=[],payments=[],postedCashierReceiptNos=[],bankCashLines=[],corrections=[],openingBalance=0}={}){
  const rows=[...salesRows];
  const bankCounterparties=new Map(bankCashLines.filter(line=>line.status==='POSTED'&&BANK_ACCOUNTS.includes(line.accountCode))
    .map(line=>[`${line.transactionType}:${line.transactionId}`,line]));
  const hasBankParticular=(voucher,kind,key)=>['BANK','BANK_ACCOUNT'].includes(voucher.partyType)||
    bankCounterparties.has(`${kind}:${key}`);
  const seen=new Set(),receiptByNo=new Map(),postedCashierNos=new Set(postedCashierReceiptNos);
  for(const receipt of receipts){
    const key=String(receipt.receiptNo||receipt._id||''),amount=Number(receipt.amount);
    const cashier=isPostedCashierReceipt(receipt,postedCashierNos);
    if(!key||seen.has(key)||(!isCashbookReceipt(receipt)&&!cashier)||!Number.isFinite(amount)||amount<=0||
      !Number.isFinite(new Date(receipt.date).getTime()))continue;
    seen.add(key);
    receiptByNo.set(key,receipt);
    const direct=Boolean(receipt.sourceKey&&!receipt.statementImportId&&!isCollectorReceipt(receipt)&&receipt.receiptWorkflowStatus==='DMS_DIRECT');
    rows.push({_id:String(receipt._id||key),transactionId:String(receipt.receiptNo||receipt._id),transactionType:'RECEIPT',
      date:receipt.date,createdAt:receipt.createdAt,partyGlobalId:receipt.customerGlobalId||'',partyType:receipt.partyType||'',
      partyName:receipt.partyNameSnapshot||'',category:hasBankParticular(receipt,'RECEIPT',key)?'CONTRA_IN':cashier?'CASHIER_RECEIPT':'CASH_RECEIPT',
      particular:receipt.remarks||`Cash Receipt - ${receipt.receiptNo}`,
      remarks:receipt.remarks??'',debit:0,credit:cashAmount(amount),type:'RECEIPT',
      _directVoucherEditable:direct,voucherKind:direct?'receipts':'',voucherId:direct?String(receipt._id||''):''});
  }
  const seenPayments=new Set();
  for(const payment of payments){
    const key=String(payment.paymentNo||payment._id||''),amount=Number(payment.amount);
    if(!key||seenPayments.has(key)||payment.mode!=='CASH'||payment.status!=='POSTED'||!Number.isFinite(amount)||amount<=0||
      !Number.isFinite(new Date(payment.date).getTime()))continue;
    seenPayments.add(key);
    const direct=Boolean(payment.sourceKey&&!payment.statementImportId);
    rows.push({_id:String(payment._id||key),transactionId:key,transactionType:'PAYMENT',date:payment.date,createdAt:payment.createdAt,
      partyGlobalId:payment.partyGlobalId||'',partyType:payment.partyType||'',partyName:payment.partyNameSnapshot||'',
      category:hasBankParticular(payment,'PAYMENT',key)?'CONTRA_OUT':'CASH_PAYMENT',
      particular:payment.remarks||`Cash Payment - ${payment.paymentNo}`,remarks:payment.remarks??'',
      debit:cashAmount(amount),credit:0,type:'PAYMENT',_directVoucherEditable:direct,
      voucherKind:direct?'payments':'',voucherId:direct?String(payment._id||''):''});
  }
  // A receipt explicitly settling a system-CASH sale is the same cash already
  // recognized on that invoice. Equal dates or amounts alone are not a link.
  const cashSales=new Map(salesRows.map(row=>[String(row.transactionId),{row,remaining:Number(row.credit||0)}]));
  const salesById=new Map([...cashSales.values()].filter(sale=>sale.row.invoiceId).map(sale=>[String(sale.row.invoiceId),sale]));
  for(const row of rows){
    if(row.transactionType!=='RECEIPT'||!row.credit)continue;
    const receipt=receiptByNo.get(row.transactionId);let remaining=row.credit;
    for(const allocation of receipt?.againstInvoices||[]){
      const byId=salesById.get(String(allocation.invoiceId||'')),byNo=cashSales.get(String(allocation.invoiceNo||''));
      if(byId&&byNo&&byId!==byNo)continue;
      const sale=byId||byNo;
      if(!sale||String(sale.row.partyGlobalId)!==String(receipt.customerGlobalId))continue;
      const overlap=Math.max(0,Math.min(remaining,Number(allocation.amount)||0,sale.remaining));
      remaining=cashAmount(remaining-overlap);sale.remaining=cashAmount(sale.remaining-overlap);
    }
    row.duplicateCashSettlementAmount=cashAmount(row.credit-remaining);row.credit=remaining;
  }
  // Use the existing posted cash leg once, irrespective of whether the bank
  // movement came from a contra, statement import, or salesperson deposit.
  // Journal cash credits are cashbook debits (cash paid out to the bank).
  const bankMovements=new Map();
  for(const line of bankCashLines){
    if(line.status!=='POSTED'||line.accountCode!=='SYS_CASH'||!BANK_CASH_TYPES.includes(line.transactionType)||
      !line.transactionId||!Number.isFinite(new Date(line.date).getTime()))continue;
    const key=`${line.transactionType}:${line.transactionId}`;
    const movement=bankMovements.get(key)||{...line,net:0};
    movement.net=cashAmount(movement.net+Number(line.credit||0)-Number(line.debit||0));
    bankMovements.set(key,movement);
  }
  for(const movement of bankMovements.values()){
    const debit=Math.max(0,movement.net),credit=Math.max(0,-movement.net);
    if(!debit&&!credit)continue;
    const bank=bankCounterparties.get(`${movement.transactionType}:${movement.transactionId}`);
    rows.push({_id:String(movement._id||`${movement.transactionType}:${movement.transactionId}`),
      transactionId:movement.transactionId,transactionType:movement.transactionType,date:movement.date,createdAt:movement.createdAt,
      partyGlobalId:bank?.bankAccountId||movement.partyGlobalId||'',partyType:'BANK_ACCOUNT',
      partyName:bank?.bankNameSnapshot||'',category:debit?'CONTRA_OUT':'CONTRA_IN',
      particular:movement.narration||(debit?'Cash deposited into bank':'Cash withdrawn from bank'),
      remarks:movement.narration||'',debit,credit,type:debit?'PAYMENT':'RECEIPT',voucherKind:'',voucherId:''});
  }
  const adjusted=applyCashCorrections(rows,corrections,openingBalance);
  // Invoice particulars identify the sale, independently of its remarks.
  adjusted.rows=adjusted.rows.map(row=>row.transactionType==='SALES_INVOICE'?
    {...row,particular:`Cash Sales - ${row.transactionId}`}:row);
  return {...adjusted,openingBalance:cashAmount(openingBalance),sourceMode:CASHBOOK_SOURCE_MODE,
    invoiceCount:adjusted.rows.filter(row=>row.transactionType==='SALES_INVOICE').length,
    receiptCount:adjusted.rows.filter(row=>row.transactionType==='RECEIPT').length,
    paymentCount:adjusted.rows.filter(row=>row.transactionType==='PAYMENT').length};
}

export async function loadCashbookSourceRows({tenantKey,financialYear}){
  const [sales,hasReceipts,hasPayments,hasLedger]=await Promise.all([
    loadCashSalesCashbook({tenantKey,financialYear}),financialCollectionExists(tenantKey,financialYear,'receipts'),
    financialCollectionExists(tenantKey,financialYear,'payments'),
    financialCollectionExists(tenantKey,financialYear,'ledgerentries'),
  ]);
  const models=hasReceipts||hasPayments||hasLedger?financialModels(tenantKey,financialYear):null;
  const [receipts,payments,bankCashLines]=await Promise.all([
    hasReceipts?models.Receipt.find({tenantKey,financialYear,mode:'CASH',status:'POSTED'})
      .select('_id sourceKey receiptNo date createdAt customerGlobalId partyType partyNameSnapshot remarks amount mode status receiptWorkflowStatus creationSource collectionSource statementImportId collectedBySalespersonId cashCustodyMovementId customerOtpStatus cashDepositStatus ledgerPostedAt againstInvoices').lean():[],
    hasPayments?models.Payment.find({tenantKey,financialYear,mode:'CASH',status:'POSTED'})
      .select('_id sourceKey paymentNo date createdAt partyGlobalId partyType partyNameSnapshot remarks amount mode status statementImportId').lean():[],
    hasLedger?models.LedgerEntry.find({tenantKey,financialYear,status:'POSTED',accountCode:{$in:['SYS_CASH',...BANK_ACCOUNTS]},
      transactionType:{$in:[...BANK_CASH_TYPES,'RECEIPT','PAYMENT']}})
      .select('_id transactionId transactionType date createdAt partyGlobalId bankAccountId narration accountCode status debit credit').lean():[],
  ]);
  const bankIds=[...new Set(bankCashLines.filter(line=>BANK_ACCOUNTS.includes(line.accountCode)&&line.bankAccountId).map(line=>line.bankAccountId))];
  const banks=bankIds.length?await BankAccount.find({tenantKey,bankAccountId:{$in:bankIds}})
    .select('bankAccountId bankName accountNumber').lean():[];
  const bankNames=new Map(banks.map(bank=>[bank.bankAccountId,`${bank.bankName}${bank.accountNumber?` · A/C ${bank.accountNumber}`:''}`]));
  const namedBankLines=bankCashLines.map(line=>({...line,bankNameSnapshot:bankNames.get(line.bankAccountId)||''}));
  const cashier=receipts.filter(isCollectorReceipt);
  const cashLines=bankCashLines.filter(line=>line.status==='POSTED'&&line.accountCode==='SYS_CASH'&&line.transactionType==='RECEIPT');
  const journals=new Map();for(const line of cashLines){
    const entry=journals.get(String(line.transactionId))||{net:0,date:line.date};
    entry.net=cashAmount(entry.net+Number(line.debit||0)-Number(line.credit||0));journals.set(String(line.transactionId),entry);
  }
  const postedCashierReceiptNos=cashier.filter(r=>Math.abs(Number(r.amount)-Number(journals.get(String(r.receiptNo))?.net??NaN))<0.005).map(r=>String(r.receiptNo));
  // Accounting date is the posted cash journal date, not collector custody date.
  const confirmed=new Set(postedCashierReceiptNos);
  const datedReceipts=receipts.map(r=>confirmed.has(String(r.receiptNo))?{...r,date:journals.get(String(r.receiptNo)).date}:r);
  return {salesRows:sales.rows,receipts:datedReceipts,payments,postedCashierReceiptNos,bankCashLines:namedBankLines};
}

async function loadYear({tenantKey,financialYear},openingBalance=0){
  const [sources,hasCorrections]=await Promise.all([
    loadCashbookSourceRows({tenantKey,financialYear}),financialCollectionExists(tenantKey,financialYear,'bookcorrections'),
  ]);
  const corrections=hasCorrections?await financialModels(tenantKey,financialYear).BookCorrection.find({tenantKey,financialYear,book:'CASH'}).lean():[];
  return buildCashbookView({...sources,corrections,openingBalance});
}

export async function cashbookOpeningFromProfile({financialYear,profile,discovered=[],readYear}){
  if(!validFY(financialYear))throw new Error('Choose a valid financial year');
  const firstFY=normalizeYears([...discovered,profile?.firstCashFinancialYear])[0]||
    normalizeYears([...(profile?.financialYears||[]),profile?.firstFinancialYear,profile?.financialYear,financialYear])[0];
  const first=Number(firstFY.slice(0,4)),target=Number(financialYear.slice(0,4));
  if(target-first>50)throw new Error('Cashbook opening rollover exceeds the supported range');
  let openingBalance=target>=first?cashAmount(profile?.firstCashOpeningBalance||0):0;
  const previousYears=Array.from({length:Math.max(0,target-first)},(_,index)=>{
    const year=first+index;return `${year}-${String((year+1)%100).padStart(2,'0')}`;
  });
  const previous=await Promise.all(previousYears.map(year=>readYear(year)));
  openingBalance=cashAmount(previous.reduce((balance,year)=>balance+year.closingBalance,openingBalance));
  return {openingBalance,
    openingSource:target>first?'PREVIOUS_CASHBOOK_CLOSING':target===first?'SUPERADMIN_PROFILE':'BEFORE_FIRST_DATA_YEAR',
    openingNeedsSetup:!profile||!validFY(profile.firstCashFinancialYear)||profile.firstCashFinancialYear>firstFY,openingFinancialYear:firstFY};
}

export async function loadCashbookViewSnapshot({tenantKey,financialYear}){
  const profile=await CompanyProfile.findOne({tenantKey})
    .select('firstCashFinancialYear firstCashOpeningBalance firstFinancialYear financialYear financialYears').lean();
  const discovery=await discoverFinancialYears({tenantKey,configured:profile?.financialYears||[]});
  const opening=await cashbookOpeningFromProfile({financialYear,profile,discovered:discovery.discovered,
    readYear:year=>loadYear({tenantKey,financialYear:year})});
  const adjusted=await loadYear({tenantKey,financialYear},opening.openingBalance);
  return {sourceMode:CASHBOOK_SOURCE_MODE,...opening,adjusted};
}
