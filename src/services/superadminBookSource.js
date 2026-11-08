import {financialModels} from './accountingService.js';
import {BankAccount} from '../models/index.js';
import {buildCompanyCashbook} from './companyCashbookEngine.js';
import {loadCompanyCashbookSources} from './companyCashbookSources.js';
import {cashKey} from './superadminBookCorrectionRules.js';
const money=n=>Math.round((Number(n)||0)*100)/100;
const error=(message,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const asDate=d=>new Date(d);

export async function resolveSuperadminBookSource({tenantKey,financialYear,book,sourceKey}){
 const models=financialModels(tenantKey,financialYear);
 if(book==='CASH'){
   const lines=await models.LedgerEntry.find({tenantKey,financialYear,status:'POSTED',accountCode:'SYS_CASH',transactionType:{$ne:'SUPERADMIN_BOOK_ADJUSTMENT'}})
    .select('_id transactionId transactionType date createdAt partyGlobalId debit credit narration').lean();
   const sources=await loadCompanyCashbookSources({tenantKey,financialYear,lines});
   const projected=buildCompanyCashbook({lines,...sources,openingBalance:0,enforceSourceDocuments:true});
   const row=projected.rows.find(x=>cashKey(x)===sourceKey);
   if(!row)throw error('Cashbook entry not found or no longer active',404);
   return {row,transactionId:String(row.transactionId),transactionType:String(row.transactionType),
      bankAccountId:'',accountCode:'SYS_CASH',ledgerId:'',originalDate:asDate(row.date),
      originalCredit:money(row.credit),originalDebit:money(row.debit),
      originalRemarks:row.particular||row.remarks||'',originalPartyName:row.partyName||''};
 }
 const parts=String(sourceKey).split(':');const [kind,id,accountFromKey]=parts;
 const modelsByType={BST:models.BankStatementRow,RCT:models.Receipt,PAY:models.Payment,CTR:models.ContraVoucher,BTR:models.BankTransfer};
 const Model=modelsByType[kind];
 if(!Model||!id||parts.length>(kind==='BTR'?3:2))throw error('Unsupported BANK entry identifier',400);
 const record=await Model.findOne({_id:id,tenantKey,financialYear}).lean();
 if(!record)throw error('Bank entry not found',404);
 let bankAccountId='',debit=0,credit=0,transactionId='',transactionType='',partyName='';
 if(kind==='BST'){
   if(!['POSTED','SUSPENSE','UNMATCHED'].includes(String(record.classification)))throw error('Statement entry is no longer posted');
   bankAccountId=record.bankAccountId;debit=record.debit;credit=record.credit;transactionId=record.transactionId;transactionType=record.transactionType;
   partyName=record.matchedPartyName||record.partyName||'';
 }else if(kind==='RCT'){
   if(record.status!=='POSTED'||record.mode==='CASH')throw error('Not a posted BANK receipt');
   bankAccountId=record.bankAccountId;credit=record.amount;transactionId=record.receiptNo;transactionType='RECEIPT';partyName=record.partyNameSnapshot||'';
 }else if(kind==='PAY'){
   if(record.status!=='POSTED'||record.mode==='CASH')throw error('Not a posted BANK payment');
   bankAccountId=record.bankAccountId;debit=record.amount;transactionId=record.paymentNo;transactionType='PAYMENT';partyName=record.partyNameSnapshot||'';
 }else if(kind==='CTR'){
   if(record.status!=='POSTED')throw error('Contra is no longer posted');
   bankAccountId=record.bankAccountId;debit=record.direction==='WITHDRAWAL'?record.amount:0;credit=record.direction==='DEPOSIT'?record.amount:0;
   transactionId=record.contraNo;transactionType='CONTRA';partyName='Cash-in-Hand (Contra)';
 }else if(kind==='BTR'){
   if(record.status!=='POSTED'||![record.fromBankAccountId,record.toBankAccountId].includes(accountFromKey))throw error('Transfer account mismatch');
   bankAccountId=accountFromKey;debit=record.fromBankAccountId===accountFromKey?record.amount:0;credit=record.toBankAccountId===accountFromKey?record.amount:0;
   transactionId=record.transferNo;transactionType='BANK_TRANSFER';partyName=debit?record.toBankNameSnapshot:record.fromBankNameSnapshot;
 }
 if(!bankAccountId||!transactionId)throw error('No bank account or posted transaction found for this entry');
 const bank=await BankAccount.findOne({tenantKey,bankAccountId,status:{$ne:'DELETED'}}).lean();
 if(!bank)throw error('Source bank account missing');
 return {row:record,kind,transactionId,transactionType,bankAccountId,
   accountCode:['OD','CC'].includes(String(bank.accountType||'').toUpperCase())?'SYS_BANK_OD':'SYS_BANK_ACCOUNT',
   ledgerId:bank.ledgerId||'',originalDate:asDate(record.date),originalCredit:money(credit),originalDebit:money(debit),
   originalRemarks:record.remarks||'',originalPartyName:partyName||'',source:record};
}

export async function originalBookJournal({tenantKey,financialYear,source}){
 const {LedgerEntry}=financialModels(tenantKey,financialYear);
 const candidates=await LedgerEntry.find({tenantKey,financialYear,status:'POSTED',transactionId:source.transactionId,
   transactionType:{$ne:'SUPERADMIN_BOOK_ADJUSTMENT'}}).lean();
 const isBookLine = l=>source.accountCode==='SYS_CASH'
   ? l.accountCode==='SYS_CASH'
   : String(l.bankAccountId||'')===String(source.bankAccountId)&&l.accountCode===source.accountCode;
 let bookLines=candidates.filter(isBookLine);
 // Legacy FY journal lines sometimes have the bank ledger but lack an explicit
 // bankAccountId. Only use a legacy match when there is one unambiguous bank
 // line for the source account; never guess between two company banks.
 if(!bookLines.length&&source.accountCode!=='SYS_CASH'){
   const legacy=candidates.filter(x=>x.accountCode===source.accountCode&&!x.bankAccountId&&
     (!source.ledgerId||String(x.ledgerId||'')===String(source.ledgerId)));
   if(legacy.length===1)bookLines=legacy;
 }
 const matchedIds=new Set(bookLines.map(x=>String(x._id)));
 const net=money(bookLines.reduce((n,l)=>n+Number(l.debit||0)-Number(l.credit||0),0));
 const other=candidates.filter(x=>!matchedIds.has(String(x._id)));
 const isInternalMovement=String(source.transactionType||'').toUpperCase().includes('CONTRA')||
   String(source.transactionType||'').toUpperCase().includes('BANK_TRANSFER')||
   ['CTR','BTR'].includes(String(source.kind||''))||
   ['CASH_BANK_DEPOSIT','BANK_CASH_WITHDRAWAL'].includes(String(source.transactionType||'').toUpperCase())||
   other.some(x=>['SYS_CASH','SYS_BANK_ACCOUNT','SYS_BANK_OD'].includes(String(x.accountCode||'')));
 // CASH/BANK contra and transfers touch multiple books; a correction to one
 // displayed leg must NEVER silently alter the other leg's running balance.
 // Offset only this one leg through Suspense unless the actual source voucher
 // is separately corrected in both books.
 // A two-sided voucher can be corrected against the SAME original party
 // ledger. A complex invoice / tax posting is adjusted against suspense
 // rather than silently changing statutory taxable/tax lines.
 let counter={accountCode:'SYS_SUSPENSE',ledgerId:'',partyGlobalId:'',bankAccountId:''};
 if(!isInternalMovement&&bookLines.length===1&&other.length===1&&
    Math.abs(Number(bookLines[0].debit||0)-Number(bookLines[0].credit||0)+Number(other[0].debit||0)-Number(other[0].credit||0))<0.005&&
    other[0].accountCode!==source.accountCode){
   counter={accountCode:other[0].accountCode,ledgerId:other[0].ledgerId||'',partyGlobalId:other[0].partyGlobalId||'',bankAccountId:other[0].bankAccountId||''};
 }
 return {net,counter,bookLines,other};
}
