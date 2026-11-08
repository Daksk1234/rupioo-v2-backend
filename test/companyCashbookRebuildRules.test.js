import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyCashbook } from '../src/services/companyCashbookEngine.js';
import { buildBookMonthSummary } from '../src/services/bookMonthSummary.js';
import { cashbookPeriodSnapshot } from '../src/services/cashbookPeriodService.js';

const row = (id, type, debit, credit, date = '2026-04-10') => ({
  _id:`J-${id}-${type}-${debit}-${credit}`,transactionId:id,transactionType:type,
  date:`${date}T00:00:00.000Z`,createdAt:`${date}T09:00:00.000Z`,debit,credit,
});
const cashSale = (invoiceNo, amount, customerGlobalId = 'SYSTEM_CASH',date='2026-04-10') => ({
  _id:`SI-${invoiceNo}`,invoiceNo,grandTotal:amount,customerGlobalId,status:'POSTED',invoiceType:'INVOICE',date:`${date}T00:00:00.000Z`,
});
const receipt = (receiptNo,amount,{collector=false,posted=true,date='2026-04-10',status='POSTED'}={}) => ({
 _id:`RC-${receiptNo}`,receiptNo,amount,status,mode:'CASH',date:`${date}T00:00:00Z`,
 partyNameSnapshot:'Quality Foods',collectionSource:collector?'SALESPERSON_APP':'DMS_DIRECT',
 receiptWorkflowStatus:collector?(posted?'LEDGER_POSTED':'PENDING_CASHIER'):'DMS_DIRECT',
 ledgerPostedAt:posted?new Date('2026-04-15'):undefined,
});
const payment=(paymentNo,amount,status='POSTED')=>({_id:`PM-${paymentNo}`,paymentNo,amount,status,mode:'CASH',partyNameSnapshot:'Hardware Shop',date:'2026-04-17'});
const strict=(options)=>buildCompanyCashbook({openingBalance:10000,cashPartyIds:['SYSTEM_CASH'],enforceSourceDocuments:true,...options});

test('company cash in hand = opening + all posted receipts - payments (five specified sources)',()=>{
 const book=strict({lines:[
  row('INV-1','SALES_INVOICE',300,0),row('RCT-1','RECEIPT',100,0),row('RC-CLOSE','RECEIPT',200,0),
  row('PAY-1','PAYMENT',0,250),row('CON-BANK','CONTRA',400,0),row('CON-DEPOSIT','CONTRA',0,500),
 ],salesInvoices:[cashSale('INV-1',300)],receipts:[receipt('RCT-1',100),receipt('RC-CLOSE',200,{collector:true})],payments:[payment('PAY-1',250)]});
 assert.equal(book.rows.length,6);
 assert.deepEqual(book.rows.map(x=>x.category).sort(),['CASH_SALE','CASH_RECEIPT','CASHIER_RECEIPT','CASH_PAYMENT','CONTRA_IN','CONTRA_OUT'].sort());
 assert.equal(book.closingBalance,10250);
 assert.equal(book.rows.reduce((s,x)=>s+x.credit,0),1000);
 assert.equal(book.rows.reduce((s,x)=>s+x.debit,0),750);
 assert.equal(book.provisional,false);
});

test('ONLY system managed CASH party invoices count as cash sale',()=>{
 const book=strict({lines:[row('INV-CASH','SALES_INVOICE',500,0),row('INV-OTHER','SALES_INVOICE',700,0)],
  salesInvoices:[cashSale('INV-CASH',500),cashSale('INV-OTHER',700,'OTHER_CUSTOMER')]});
 assert.equal(book.closingBalance,10500);
 const rogue=book.rows.find(x=>x.transactionId==='INV-OTHER');
 assert.equal(rogue.category,'REVIEW');assert.equal(rogue.credit,0);
 assert.equal(book.issues.length,1);
});

test('system CASH invoice projected once if posted invoice missing journal',()=>{
 const book=strict({salesInvoices:[cashSale('INV-NOJ',490)]});
 assert.equal(book.closingBalance,10490);assert.equal(book.rows.length,1);
 assert.equal(book.categoryTotals.CASH_SALE.received,490);
 assert.equal(book.provisional,true);assert.match(book.issues[0].message,/missing/);
});

test('invoice with correct journal must never be counted twice',()=>{
 const book=strict({lines:[row('INV-1','SALES_INVOICE',250,0)],salesInvoices:[cashSale('INV-1',250)]});
 assert.equal(book.rows.length,1);assert.equal(book.closingBalance,10250);
});

test('new collector cash is not company cash until posted at Cashier day close',()=>{
 const book=strict({receipts:[receipt('COLLECTOR-PENDING',750,{collector:true,posted:false})]});
 assert.equal(book.rows.length,0);assert.equal(book.closingBalance,10000);
});

test('Cashier day-close cash receipt appears once and has correct category',()=>{
 const cash=receipt('DAY-CLOSE',750,{collector:true});
 const book=strict({lines:[row('DAY-CLOSE','RECEIPT',750,0)],receipts:[cash]});
 assert.equal(book.closingBalance,10750);assert.equal(book.rows[0].category,'CASHIER_RECEIPT');
});

test('voided/deleted original receipt does NOT become a ghost Cashbook receipt',()=>{
 const book=strict({lines:[row('GHOST','RECEIPT',400,0)],receipts:[]});
 assert.equal(book.closingBalance,10000);assert.equal(book.rows[0].credit,0);
 assert.equal(book.rows[0].category,'REVIEW');assert.equal(book.provisional,true);
});

test('posted DMS cash receipt without journal is provisional but visible',()=>{
 const book=strict({receipts:[receipt('DIRECT-1',120)]});
 assert.equal(book.rows.length,1);assert.equal(book.closingBalance,10120);
 assert.equal(book.rows[0].category,'CASH_RECEIPT');assert.equal(book.provisional,true);
});

test('posted cash payment without journal is provisional but reduces Cash in Hand',()=>{
 const book=strict({payments:[payment('P-MISSING',300)]});
 assert.equal(book.closingBalance,9700);assert.equal(book.rows[0].debit,300);
 assert.equal(book.provisional,true);
});

test('voided CASH payments never decrease Cash in Hand',()=>{
 const book=strict({payments:[payment('P-VOID',200,'VOIDED')]});
 assert.equal(book.closingBalance,10000);assert.equal(book.rows.length,0);
});

test('bank-to-cash withdrawal is Credit/Received and cash-to-bank deposit is Debit/Paid',()=>{
 const book=strict({lines:[row('WITHDRAW','CONTRA',70,0),row('DEPOSIT','CONTRA',0,40)]});
 assert.equal(book.rows.find(x=>x.transactionId==='WITHDRAW').category,'CONTRA_IN');assert.equal(book.rows.find(x=>x.transactionId==='WITHDRAW').credit,70);
 assert.equal(book.rows.find(x=>x.transactionId==='DEPOSIT').category,'CONTRA_OUT');assert.equal(book.rows.find(x=>x.transactionId==='DEPOSIT').debit,40);
 assert.equal(book.closingBalance,10030);
});

test('Cashbook monthly opening and closing continues, even when a category filter is later applied',()=>{
 const book=strict({lines:[row('W1','CONTRA',100,0,'2026-04-20'),row('D1','CONTRA',0,30,'2026-05-10')]});
 const monthly=buildBookMonthSummary({financialYear:'2026-27',openingBalance:10000,rows:book.rows});
 assert.equal(monthly[0].closingBalance,10100);assert.equal(monthly[1].openingBalance,10100);
 assert.equal(monthly[1].closingBalance,10070);
 const may=cashbookPeriodSnapshot({rows:book.rows,openingBalance:10000,fromDate:'2026-05-01',toDate:'2026-05-31'});
 assert.equal(may.periodOpeningBalance,10100);assert.equal(may.periodClosingBalance,10070);
});

test('collector receipt cannot enter company Cashbook before confirmed POSTED Cashier Close even if stale journal exists',()=>{
 const cash=receipt('COLLECTOR-OLD',350,{collector:true,posted:true});
 const book=strict({lines:[row('COLLECTOR-OLD','RECEIPT',350,0)],receipts:[cash],closedCashierReceiptNos:[]});
 assert.equal(book.closingBalance,10000);
 assert.equal(book.rows[0].category,'REVIEW');
 assert.match(book.rows[0].correctionMessage,/Cashier Day Close/);
});

test('same collector receipt joins Cashbook after posted cashier close and only once',()=>{
 const cash=receipt('COLLECTOR-CLOSED',350,{collector:true,posted:true});
 const book=strict({lines:[row('COLLECTOR-CLOSED','RECEIPT',350,0)],receipts:[cash],closedCashierReceiptNos:['COLLECTOR-CLOSED']});
 assert.equal(book.closingBalance,10350);
 assert.equal(book.rows.length,1);assert.equal(book.rows[0].category,'CASHIER_RECEIPT');
 assert.equal(book.provisional,false);
});

test('collector receipt cannot be synthetically projected before Cashier Close',()=>{
 const cash=receipt('COLLECTOR-WAITING',350,{collector:true,posted:true});
 const book=strict({receipts:[cash],closedCashierReceiptNos:[]});
 assert.equal(book.closingBalance,10000);assert.equal(book.rows.length,0);
});
