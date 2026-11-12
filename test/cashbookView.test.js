import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCashSalesCashbook} from '../src/services/cashSalesCashbookService.js';
import {buildCashbookView,cashbookOpeningFromProfile,CASHBOOK_RECEIPT_SOURCE} from '../src/services/cashbookViewService.js';
import {buildBookMonthSummary} from '../src/services/bookMonthSummary.js';

const receipt=(id,extra={})=>({_id:id,sourceKey:id,receiptNo:id,date:'2026-05-02',amount:200,mode:'CASH',status:'POSTED',
 receiptWorkflowStatus:'DMS_DIRECT',creationSource:CASHBOOK_RECEIPT_SOURCE,partyNameSnapshot:'Quality Foods',remarks:'Cash received',...extra});
const sales=()=>buildCashSalesCashbook({cashPartyIds:['SYS_CASH_PARTY'],salesInvoices:[
 {_id:'S1',invoiceNo:'INV-1',customerGlobalId:'SYS_CASH_PARTY',grandTotal:500,date:'2026-04-03',status:'POSTED',remarks:'Invoice note'},
]}).rows;
const bankCashLine=(id,extra={})=>({_id:id,transactionId:id,transactionType:'CONTRA',accountCode:'SYS_CASH',
 status:'POSTED',date:'2026-05-03',debit:0,credit:200,narration:'Cash deposited into bank',...extra});
const payment=(id,extra={})=>({_id:id,sourceKey:id,paymentNo:id,date:'2026-05-03',amount:100,mode:'CASH',status:'POSTED',
 partyGlobalId:'SUPPLIER',partyNameSnapshot:'Office Supplier',remarks:'Office supplies',...extra});

test('cash sales are receipts with exact invoice particulars and direct receipts add to profile opening',()=>{
 const result=buildCashbookView({salesRows:sales(),receipts:[receipt('R1')],openingBalance:1000});
 assert.equal(result.rows[0].particular,'Cash Sales - INV-1');assert.equal(result.rows[0].type,'RECEIPT');
 assert.equal(result.rows[0].remarks,'Invoice note');assert.equal(result.rows[0].credit,500);
 assert.deepEqual(result.rows.map(row=>row.runningBalance),[1500,1700]);assert.equal(result.closingBalance,1700);
 assert.equal(result.categoryTotals.CASH_RECEIPT.received,200);assert.equal(result.rows[1].voucherKind,'receipts');
 const months=buildBookMonthSummary({financialYear:'2026-27',openingBalance:1000,rows:result.rows});
 assert.equal(months[0].openingBalance,1000);assert.equal(months[0].closingBalance,1500);
 assert.equal(months[1].openingBalance,1500);assert.equal(months[1].closingBalance,1700);
});

test('bank, voided, draft and unposted collector receipts stay excluded',()=>{
 const rows=[receipt('BANK',{mode:'BANK'}),receipt('VOID',{status:'VOID'}),receipt('DRAFT',{status:'DRAFT'}),
  receipt('COLLECTOR',{collectionSource:'SALESPERSON_APP',cashDepositStatus:'PENDING_TO_DEPOSIT',customerOtpStatus:'VERIFIED'}),
  receipt('LEGACY-COLLECTOR',{collectedBySalespersonId:'employee'})];
 assert.deepEqual(buildCashbookView({receipts:rows}).rows,[]);
});

test('every posted Cash receipt/payment is included regardless of source and with the original particulars',()=>{
 const receipts=[receipt('ORDINARY',{creationSource:undefined}),receipt('BULK',{creationSource:'CASHBOOK_BULK_UPLOAD'}),
  receipt('IMPORTED',{statementImportId:'import'}),receipt('OTHER',{partyType:'OTHER',partyNameSnapshot:'Counter customer',remarks:'  Exact cash receipt\n  '})];
 const payments=[payment('ORDINARY'),payment('BULK',{creationSource:'CASHBOOK_BULK_UPLOAD'}),payment('IMPORTED',{statementImportId:'import'}),
  payment('OTHER',{partyType:'OTHER',partyNameSnapshot:'Counter supplier',remarks:'  Exact cash payment\n  '}),
  payment('BANK',{mode:'BANK'}),payment('VOID',{status:'VOID'}),payment('DRAFT',{status:'DRAFT'})];
 const result=buildCashbookView({receipts,payments,openingBalance:1000});
 assert.equal(result.rows.length,8);assert.equal(result.receiptCount,4);assert.equal(result.paymentCount,4);
 assert.equal(result.categoryTotals.CASH_RECEIPT.received,800);assert.equal(result.categoryTotals.CASH_PAYMENT.paid,400);
 assert.equal(result.closingBalance,1400);
 assert.equal(result.rows.find(row=>row.transactionId==='OTHER'&&row.transactionType==='PAYMENT').particular,'  Exact cash payment\n  ');
 assert.equal(result.rows.find(row=>row.transactionId==='OTHER'&&row.transactionType==='RECEIPT').particular,'  Exact cash receipt\n  ');
 assert.equal(result.rows.find(row=>row.transactionId==='IMPORTED')._directVoucherEditable,false);
});

test('bank-account particulars determine cash transfer category while Cash mode determines the debit/credit side',()=>{
 const result=buildCashbookView({openingBalance:1000,
  receipts:[receipt('WITHDRAW',{partyType:'BANK_ACCOUNT',partyNameSnapshot:'Company Bank'}),receipt('LEGACY-WITHDRAW')],
  payments:[payment('DEPOSIT',{partyType:'BANK_ACCOUNT',partyNameSnapshot:'Company Bank'}),payment('LEGACY-DEPOSIT')],
  bankCashLines:[bankCashLine('LEGACY-WITHDRAW',{transactionType:'RECEIPT',accountCode:'SYS_BANK_ACCOUNT',debit:0,credit:200}),
   bankCashLine('LEGACY-DEPOSIT',{transactionType:'PAYMENT',accountCode:'SYS_BANK_OD',debit:100,credit:0})]});
 assert.equal(result.rows.length,4);
 assert.ok(result.rows.filter(row=>row.transactionType==='RECEIPT').every(row=>row.category==='CONTRA_IN'&&row.credit===200&&row.debit===0));
 assert.ok(result.rows.filter(row=>row.transactionType==='PAYMENT').every(row=>row.category==='CONTRA_OUT'&&row.debit===100&&row.credit===0));
 assert.equal(result.closingBalance,1200);
});

test('only an explicit allocation to the same system-CASH sale prevents double recognition',()=>{
 const result=buildCashbookView({salesRows:sales(),receipts:[receipt('SETTLEMENT',{customerGlobalId:'SYS_CASH_PARTY',amount:600,
  againstInvoices:[{invoiceId:'S1',invoiceNo:'INV-1',amount:500}]}),receipt('UNRELATED',{amount:500})]});
 assert.equal(result.rows.find(row=>row.transactionId==='SETTLEMENT').credit,100);
 assert.equal(result.rows.find(row=>row.transactionId==='SETTLEMENT').duplicateCashSettlementAmount,500);
 assert.equal(result.closingBalance,1100);
});

test('cashier cash appears only with accepted custody and matching posted cash journal and is counted once',()=>{
 const cash=receipt('CASHIER',{creationSource:undefined,collectionSource:'SALESPERSON_APP',receiptWorkflowStatus:'LEDGER_POSTED',
  customerOtpStatus:'VERIFIED',cashDepositStatus:'DEPOSITED_TO_CASHIER',ledgerPostedAt:new Date()});
 assert.equal(buildCashbookView({receipts:[cash]}).rows.length,0);
 assert.equal(buildCashbookView({receipts:[{...cash,ledgerPostedAt:null}],postedCashierReceiptNos:['CASHIER']}).rows.length,0);
 const result=buildCashbookView({receipts:[cash,{...cash,_id:'duplicate-source'}],postedCashierReceiptNos:['CASHIER']});
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].category,'CASHIER_RECEIPT');assert.equal(result.closingBalance,200);
});

test('manual, imported, salesperson and legacy bank deposits debit cashbook and flow through month balances',()=>{
 const bankCashLines=[bankCashLine('MANUAL'),bankCashLine('IMPORTED'),
  bankCashLine('APP',{transactionType:'SALESPERSON_BANK_DEPOSIT'}),
  bankCashLine('LEGACY',{transactionType:'CASH_BANK_DEPOSIT'}),
  bankCashLine('WITHDRAWAL',{transactionType:'BANK_CASH_WITHDRAWAL',debit:50,credit:0,narration:'Cash withdrawn from bank'})];
 const result=buildCashbookView({salesRows:sales(),receipts:[receipt('R1')],bankCashLines,openingBalance:1000});
 const deposits=result.rows.filter(row=>row.category==='CONTRA_OUT');
 assert.equal(deposits.length,4);assert.ok(deposits.every(row=>row.debit===200&&row.credit===0&&row.type==='PAYMENT'));
 assert.equal(result.categoryTotals.CONTRA_OUT.paid,800);assert.equal(result.categoryTotals.CONTRA_IN.received,50);
 assert.equal(result.closingBalance,950);assert.equal(result.invoiceCount,1);assert.equal(result.receiptCount,1);
 const months=buildBookMonthSummary({financialYear:'2026-27',openingBalance:1000,rows:result.rows});
 assert.equal(months[1].openingBalance,1500);assert.equal(months[1].debit,800);
 assert.equal(months[1].credit,250);assert.equal(months[1].closingBalance,950);assert.equal(months[2].openingBalance,950);
});

test('bank cash movements group split journal legs once and exclude bank legs, reversals and unrelated receipts',()=>{
 const bankCashLines=[bankCashLine('DEPOSIT',{_id:'cash-1',credit:120}),bankCashLine('DEPOSIT',{_id:'cash-2',credit:80}),
  bankCashLine('DEPOSIT',{_id:'bank-leg',accountCode:'SYS_BANK_ACCOUNT',debit:200,credit:0}),
  bankCashLine('REVERSED',{status:'REVERSED'}),bankCashLine('PENDING',{status:'PENDING'}),
  bankCashLine('BANK-TRANSFER',{transactionType:'BANK_TRANSFER'}),bankCashLine('RECEIPT',{transactionType:'RECEIPT',debit:200,credit:0})];
 const result=buildCashbookView({bankCashLines,openingBalance:1000});
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].debit,200);assert.equal(result.closingBalance,800);
});

test('bank deposit corrections retain audit identity and deposit debits reduce the next financial-year opening',async()=>{
 const result=buildCashbookView({bankCashLines:[bankCashLine('DEPOSIT')],
  corrections:[{sourceKey:'CB:CONTRA:DEPOSIT',date:'2026-05-03',debit:250,credit:0,remarks:'Corrected deposit'}]});
 assert.equal(result.rows[0].adminCorrected,true);assert.equal(result.rows[0].particular,'Corrected deposit');
 const opening=await cashbookOpeningFromProfile({financialYear:'2027-28',
  profile:{firstCashFinancialYear:'2026-27',firstCashOpeningBalance:1000},discovered:['2026-27'],readYear:async()=>result});
 assert.equal(opening.openingBalance,750);
});

test('audited amount edits/deletions recalculate subsequent balances and retain generated sale particulars',()=>{
 const result=buildCashbookView({salesRows:sales(),receipts:[receipt('R1')],openingBalance:-100,
  corrections:[{sourceKey:'CB:SALES_INVOICE:INV-1',date:'2026-04-03',credit:600,debit:0,remarks:'Edited note'},
   {sourceKey:'CB:RECEIPT:R1',deleted:true}]});
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].particular,'Cash Sales - INV-1');
 assert.equal(result.closingBalance,500);
});

test('first-year opening is read from Profile and subsequent years carry only supported source movements',async()=>{
 const profile={firstCashFinancialYear:'2024-25',firstCashOpeningBalance:-100,financialYears:['2024-25','2025-26','2026-27']};
 const read=[];const reader=async year=>{read.push(year);return {closingBalance:year==='2024-25'?500:200}};
 const first=await cashbookOpeningFromProfile({financialYear:'2024-25',profile,discovered:['2024-25'],readYear:reader});
 assert.equal(first.openingBalance,-100);assert.equal(first.openingSource,'SUPERADMIN_PROFILE');assert.deepEqual(read,[]);
 const later=await cashbookOpeningFromProfile({financialYear:'2026-27',profile,discovered:['2024-25'],readYear:reader});
 assert.equal(later.openingBalance,600);assert.equal(later.openingSource,'PREVIOUS_CASHBOOK_CLOSING');
 assert.deepEqual(read,['2024-25','2025-26']);
 const earlier=await cashbookOpeningFromProfile({financialYear:'2023-24',profile,discovered:['2024-25'],readYear:reader});
 assert.equal(earlier.openingBalance,0);
});
