import {BankAccount} from '../models/index.js';
import {financialModels} from './accountingService.js';
import {createHash} from 'node:crypto';

const amount=n=>Math.round((Number(n)||0)*100)/100;
const bankCodes=['SYS_BANK_ACCOUNT','SYS_BANK_OD'];
const types=['RECEIPT','PAYMENT','CONTRA','CASH_BANK_DEPOSIT','BANK_CASH_WITHDRAWAL','SALESPERSON_BANK_DEPOSIT','CHEQUE_CLEARING'];
const key=(transactionId,bankAccountId)=>`${transactionId}\0${bankAccountId}`;

// Journal DR increases the company bank; the statement displays it as CREDIT.
// Project only movements that have no statement/direct voucher/contra/transfer
// display row. Identity, never amount/date, determines whether a row is covered.
export function projectBankJournalRows({lines=[],banks=[],covered=[],bankAccountId=''}={}){
 const byId=new Map(banks.map(bank=>[String(bank.bankAccountId),bank]));
 const byLedger=new Map();
 for(const bank of banks){
  if(!bank.ledgerId)continue;
  const matches=byLedger.get(String(bank.ledgerId))||[];matches.push(bank);byLedger.set(String(bank.ledgerId),matches);
 }
 const represented=new Set(covered.map(row=>key(row.transactionId,String(row.bankAccountId))));
 const groups=new Map();
 for(const line of [...lines].sort((a,b)=>String(a._id).localeCompare(String(b._id)))){
  if(line.status!=='POSTED'||!bankCodes.includes(line.accountCode)||!types.includes(line.transactionType)||!line.transactionId)continue;
  const legacy=byLedger.get(String(line.ledgerId||''));
  const bank=line.bankAccountId?byId.get(String(line.bankAccountId)):legacy?.length===1?legacy[0]:null;
  if(!bank||bankAccountId&&String(bank.bankAccountId)!==String(bankAccountId))continue;
  if(represented.has(key(line.transactionId,String(bank.bankAccountId))))continue;
  const id=`${line.transactionType}\0${key(line.transactionId,String(bank.bankAccountId))}`;
  const row=groups.get(id)||{...line,bank,net:0};
  row.net=amount(row.net+Number(line.debit||0)-Number(line.credit||0));groups.set(id,row);
 }
 return [...groups.values()].filter(row=>Math.abs(row.net)>=0.005).map(row=>{
  const cash=row.transactionType!=='CHEQUE_CLEARING',credit=Math.max(0,row.net),debit=Math.max(0,-row.net);
  const identity=createHash('sha256').update(`${row.transactionType}\0${key(row.transactionId,String(row.bank.bankAccountId))}`).digest('hex').slice(0,40);
  return {_listId:`JRN:${identity}`,_directVoucherEditable:false,date:row.date,createdAt:row.createdAt,
   transactionId:row.transactionId,transactionType:credit?'RECEIPT':'PAYMENT',journalTransactionType:row.transactionType,
   matchedPartyGlobalId:cash?'CASH:COMPANY':row.partyGlobalId||'',matchedPartyName:cash?'Cash-in-Hand':'',
   remarks:row.narration||(cash?(credit?'Cash deposited into bank':'Cash withdrawn from bank'):'Posted bank receipt'),
   mode:cash?'CASH':'CHEQUE',debit,credit,bankAccountId:row.bank.bankAccountId,bankNameSnapshot:row.bank.bankName,
   classification:'POSTED',isContra:cash};
 });
}

export async function loadBankJournalRows({tenantKey,financialYear,bankAccountId=''}){
 const {LedgerEntry,Receipt,Payment,BankStatementRow,ContraVoucher,BankTransfer}=financialModels(tenantKey,financialYear);
 const [lines,banks]=await Promise.all([
  LedgerEntry.find({tenantKey,financialYear,status:'POSTED',accountCode:{$in:['SYS_CASH',...bankCodes]},transactionType:{$in:types}})
   .select('_id transactionId transactionType accountCode ledgerId bankAccountId partyGlobalId date createdAt narration debit credit status').lean(),
  BankAccount.find({tenantKey,status:{$ne:'DELETED'}})
   .select('bankAccountId bankName ledgerId').lean(),
 ]);
 if(!lines.some(line=>bankCodes.includes(line.accountCode)))return [];
 const ids=[...new Set(lines.map(line=>line.transactionId))];
 const scope={tenantKey,financialYear};
 const [statements,receipts,payments,contras,transfers]=await Promise.all([
  BankStatementRow.find({...scope,transactionId:{$in:ids},classification:{$in:['POSTED','SUSPENSE','UNMATCHED']}}).select('transactionId bankAccountId').lean(),
  Receipt.find({...scope,
   $or:[{receiptNo:{$in:ids}},{bankLedgerTransactionId:{$in:ids}}]})
   .select('receiptNo bankLedgerTransactionId bankAccountId collectionSource ledgerPostedAt statementImportId mode status').lean(),
  Payment.find({...scope,paymentNo:{$in:ids}})
   .select('paymentNo bankAccountId statementImportId mode status').lean(),
  ContraVoucher.find({...scope,contraNo:{$in:ids}}).select('contraNo bankAccountId status').lean(),
  BankTransfer.find({...scope,status:'POSTED',transferNo:{$in:ids}}).select('transferNo fromBankAccountId toBankAccountId').lean(),
 ]);
 const covered=[...statements,
  ...receipts.filter(row=>row.status==='POSTED'&&row.mode!=='CASH'&&row.bankAccountId&&!row.statementImportId&&(row.collectionSource!=='SALESPERSON_APP'||row.ledgerPostedAt))
   .map(row=>({transactionId:row.bankLedgerTransactionId||row.receiptNo,bankAccountId:row.bankAccountId})),
  ...payments.filter(row=>row.status==='POSTED'&&row.mode!=='CASH'&&row.bankAccountId&&!row.statementImportId).map(row=>({transactionId:row.paymentNo,bankAccountId:row.bankAccountId})),
  ...contras.filter(row=>row.status==='POSTED').map(row=>({transactionId:row.contraNo,bankAccountId:row.bankAccountId})),
  ...transfers.flatMap(row=>[row.fromBankAccountId,row.toBankAccountId].map(id=>({transactionId:row.transferNo,bankAccountId:id}))),
 ];
 const receiptByNo=new Map(receipts.map(row=>[row.receiptNo,row])),paymentByNo=new Map(payments.map(row=>[row.paymentNo,row]));
 const contraByNo=new Map(contras.map(row=>[row.contraNo,row]));
 const eligible=lines.filter(line=>{
  // Cash vouchers have their own source documents. Never resurrect a deleted,
  // voided or orphaned voucher from a stale journal left behind in the database.
  if(line.transactionType==='RECEIPT'){
   const receipt=receiptByNo.get(line.transactionId);
   return receipt?.status==='POSTED'&&receipt.mode==='CASH'&&(receipt.collectionSource!=='SALESPERSON_APP'||receipt.ledgerPostedAt);
  }
  if(line.transactionType==='PAYMENT'){
   const payment=paymentByNo.get(line.transactionId);return payment?.status==='POSTED'&&payment.mode==='CASH';
  }
  if(line.transactionType==='CONTRA'&&contraByNo.has(line.transactionId))return contraByNo.get(line.transactionId).status==='POSTED';
  return true;
 });
 return projectBankJournalRows({lines:eligible,banks,covered,bankAccountId});
}
