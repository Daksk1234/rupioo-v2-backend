import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {buildCompanyCashbook} from '../src/services/companyCashbookEngine.js';
import {readCashbookRows} from '../src/services/cashbookImport.js';
import {detectCashBulkParty} from '../src/services/cashBulkPartyMatcher.js';
import {cashbookImportVoucherNo} from '../src/services/cashbookImportIdentity.js';
import {validateCashOpening} from '../src/services/cashOpeningRules.js';
import {createCashbookSnapshotStore,cashbookSnapshots,invalidateCashbookAfterMutation} from '../src/services/cashbookSnapshotStore.js';
import {applyCashCorrections,validateBookCorrection} from '../src/services/superadminBookCorrectionRules.js';

const line=(id,type,amount,date='2026-04-10')=>({_id:id+type,transactionId:id,transactionType:type,date,debit:amount,credit:0});
const invoice={_id:'invoice-id',invoiceNo:'CASH-1',customerGlobalId:'SYSTEM_CASH',grandTotal:500,status:'POSTED',date:'2026-04-10'};
const receipt=(id,amount,allocations=[],extra={})=>({_id:id,receiptNo:id,amount,mode:'CASH',status:'POSTED',date:'2026-04-11',
  customerGlobalId:'SYSTEM_CASH',againstInvoices:allocations,...extra});
const book=options=>buildCompanyCashbook({openingBalance:-100,enforceSourceDocuments:true,cashPartyIds:['SYSTEM_CASH'],salesInvoices:[invoice],...options});

test('a system CASH sale and its explicit full settlement increase cash only once',()=>{
  const result=book({lines:[line('CASH-1','SALES_INVOICE',500),line('R-1','RECEIPT',500,'2026-04-11')],
    receipts:[receipt('R-1',500,[{invoiceId:'invoice-id',invoiceNo:'CASH-1',amount:500}])]});
  assert.equal(result.closingBalance,400);assert.equal(result.journalClosingBalance,900);
  assert.equal(result.rows[1].duplicateCashSettlementAmount,500);
  assert.equal(result.rows[1].runningBalance,400);assert.equal(result.provisional,true);
});
test('partial settlements are capped and an unallocated genuine receipt amount stays incoming',()=>{
  const result=book({receipts:[receipt('R-1',200,[{invoiceNo:'CASH-1',amount:200}]),
    receipt('R-2',350,[{invoiceId:'invoice-id',amount:300}])]});
  assert.equal(result.closingBalance,450);
  assert.equal(result.rows.find(r=>r.transactionId==='R-2').credit,50);
});
test('same date/amount, other parties, voided and unclosed collector receipts cannot falsely suppress a cash sale',()=>{
  const result=book({closedCashierReceiptNos:[],receipts:[receipt('R-1',500),
    receipt('R-2',500,[{invoiceNo:'CASH-1',amount:500}],{customerGlobalId:'NORMAL_CUSTOMER'}),
    receipt('R-VOID',500,[{invoiceNo:'CASH-1',amount:500}],{status:'VOID'}),
    receipt('R-PENDING',500,[{invoiceNo:'CASH-1',amount:500}],{collectionSource:'SALESPERSON_APP',ledgerPostedAt:new Date()})]});
  assert.equal(result.closingBalance,1400);
  assert.equal(result.rows.filter(r=>r.duplicateCashSettlementAmount).length,0);
});
test('legacy CASH_SALE journals and duplicated invoice journal aliases are recognized once',()=>{
  const legacy=book({lines:[line('CASH-1','CASH_SALE',500)]});
  assert.equal(legacy.rows.length,1);assert.equal(legacy.closingBalance,400);
  const both=book({lines:[line('CASH-1','CASH_SALE',500),line('CASH-1','SALES_INVOICE',500)]});
  assert.equal(both.closingBalance,400);assert.equal(both.provisional,true);
});
test('cash uploads preserve exact remarks, parse both date formats, and retain physical spreadsheet row identities',()=>{
  const raw=[{Date:'07-11-2026','Party Name':'',Remarks:'  Quality Foods  -\nreceived  cash  ',Mode:'CASH',Debit:'',Credit:'5,000'},
    {Date:'2026-11-08','Party Name':'',Remarks:'Furniture payment',Mode:'CASH',Debit:2000,Credit:''}];
  Object.defineProperty(raw[1],'__rowNum__',{value:4});
  const parsed=readCashbookRows(raw);
  assert.equal(parsed[0].particulars,raw[0].Remarks);assert.equal(parsed[0].date,'2026-11-07');
  assert.equal(parsed[0].credit,5000);assert.equal(parsed[1].rowNo,5);assert.equal(parsed[1].debit,2000);
});
test('bad rows retain editable values without blocking valid rows or rounding invalid precision',()=>{
  const raw=[{Date:'2026-02-30','Party Name':'',Remarks:'  untouched  ',Mode:'CASH',Debit:30,Credit:''},
    {Date:'2026-11-08','Party Name':'',Remarks:'valid',Mode:'CASH',Debit:'30.001',Credit:''},
    {Date:'2026-11-08','Party Name':'',Remarks:'valid',Mode:'CASH',Debit:'',Credit:'0.30'}];
  const rows=readCashbookRows(raw);
  assert.ok(rows[0].error);assert.equal(rows[0].date,'2026-02-30');assert.equal(rows[0].particulars,'  untouched  ');
  assert.match(rows[1].error,/decimal/);assert.equal(rows[2].credit,0.3);
});
test('party matching supports explicit short names/IDs and refuses ambiguous narration',()=>{
  const directory=[{id:'C1',name:'AB',type:'CUSTOMER'},{id:'C2',name:'Quality Foods',type:'CUSTOMER'},
    {id:'U1',name:'Quality Foods',type:'USER'}];
  assert.equal(detectCashBulkParty({partyName:'AB'},directory)?.id,'C1');
  assert.equal(detectCashBulkParty({partyName:'C1'},directory)?.id,'C1');
  assert.equal(detectCashBulkParty({remarks:'Received from Quality Foods'},directory),null);
  assert.equal(detectCashBulkParty({partyName:'Unknown',remarks:'AB'},directory),null);
});
test('upload identity distinguishes equal date/amount rows and files, but is stable across retries',()=>{
  const hash='a'.repeat(64),first=cashbookImportVoucherNo('tenant',hash,2,'RECEIPT');
  assert.equal(first,cashbookImportVoucherNo('tenant',hash,2,'RECEIPT'));
  assert.notEqual(first,cashbookImportVoucherNo('tenant',hash,3,'RECEIPT'));
  assert.notEqual(first,cashbookImportVoucherNo('other',hash,2,'RECEIPT'));
  assert.notEqual(first,cashbookImportVoucherNo('tenant','b'.repeat(64),2,'RECEIPT'));
});
test('negative opening is allowed in an older discovered FY; later openings cannot restart cash',()=>{
  assert.equal(validateCashOpening({financialYear:'2024-25',amount:-100,configured:['2025-26'],discovered:['2024-25']}),-100);
  assert.throws(()=>validateCashOpening({financialYear:'2025-26',amount:100,configured:['2025-26'],discovered:['2024-25']}),/earliest/);
  assert.throws(()=>validateCashOpening({financialYear:'2024-25',amount:0.001,discovered:['2024-25']}),/decimal/);
});
test('party corrections and exact remarks survive projection; clearing remarks does not restore the old narration',()=>{
  const edit=validateBookCorrection({date:'2026-04-10',debit:30,credit:0,remarks:'  preserved\n  ',partyName:'Correct Party'},'2026-27');
  const result=applyCashCorrections([{...line('P-1','PAYMENT',0),debit:30,credit:0,remarks:'Old',particular:'Old',needsCorrection:true}],
    [{...edit,sourceKey:'CB:PAYMENT:P-1',partyGlobalId:'NEW-PARTY',partyType:'CUSTOMER'}],-100);
  assert.equal(result.closingBalance,-130);assert.equal(result.rows[0].remarks,'  preserved\n  ');
  assert.equal(result.rows[0].partyGlobalId,'NEW-PARTY');assert.equal(result.rows[0].journalCorrectionPending,false);
  const blank=applyCashCorrections(result.rows,[{...edit,remarks:'',sourceKey:'CB:PAYMENT:P-1'}],-100);
  assert.equal(blank.rows[0].particular,'');assert.equal(blank.rows[0].remarks,'');
});
test('month snapshots are tenant/FY isolated, bounded, expire, and invalidate on writes including in-flight reads',async()=>{
  let time=0;const store=createCashbookSnapshotStore({now:()=>time,ttl:10,maxEntries:1});
  const one=await store.build('A','2026-27',async()=>({adjusted:{rows:[]},balance:123}));
  assert.equal(store.read(one.snapshotId,'A','2026-27').balance,123);
  assert.equal(store.read(one.snapshotId,'B','2026-27'),null);assert.equal(store.read(one.snapshotId,'A','2025-26'),null);
  const two=await store.build('A','2026-27',async()=>({}));
  assert.equal(store.read(one.snapshotId,'A','2026-27'),null);
  time=10;assert.equal(store.read(two.snapshotId,'A','2026-27'),null);
  let resolve;const pending=store.build('A','2026-27',()=>new Promise(r=>{resolve=r}));
  store.invalidate('A');resolve({balance:456});
  assert.equal((await pending).snapshotId,'');
});
test('an unsuccessful mutating response still invalidates any snapshot of partially written accounting data',async()=>{
  const saved=await cashbookSnapshots.build('A','2026-27',async()=>({}));
  const res=new EventEmitter();invalidateCashbookAfterMutation({method:'POST',auth:{tenantKey:'A'}},res,()=>{});
  res.emit('finish');assert.equal(cashbookSnapshots.read(saved.snapshotId,'A','2026-27'),null);
});
