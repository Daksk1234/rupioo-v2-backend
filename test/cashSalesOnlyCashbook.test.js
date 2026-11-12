import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import transactions from '../src/routes/transactions.js';
import {CustomerLink,CompanyProfile,CompanyLedger,User,BankAccount,Product} from '../src/models/index.js';
import {financialModels} from '../src/services/accountingService.js';
import {buildCashSalesCashbook,CASH_SALES_SOURCE_MODE} from '../src/services/cashSalesCashbookService.js';
import {cashbookSnapshots} from '../src/services/cashbookSnapshotStore.js';
import {invalidateFinancialYearDiscovery} from '../src/services/financialYearDiscoveryService.js';

const invoice=(id,extra={})=>({_id:id,invoiceNo:id,tenantKey:'CASH_SALES_VIEW_TEST',financialYear:'2026-27',
  customerGlobalId:'REAL_SYSTEM_CASH',status:'POSTED',invoiceType:'INVOICE',grandTotal:500,date:'2026-04-10',...extra});
const query=value=>({select(){return this},lean:async()=>value});

test('only the real system CASH party ID qualifies; names and cash payment terms do not',()=>{
  const result=buildCashSalesCashbook({cashPartyIds:['REAL_SYSTEM_CASH'],salesInvoices:[
    invoice('CASH-1'),invoice('SAME-NAME',{customerGlobalId:'MANUAL_CUSTOMER',customerNameSnapshot:'CASH'}),
    invoice('TERMS-CASH',{customerGlobalId:'QUALITY_FOODS',paymentType:'CASH'}),
  ],openingBalance:9000,receipts:[{amount:800}],payments:[{amount:100}],lines:[{debit:5000}],
    corrections:[{sourceKey:'CB:SALES_INVOICE:CASH-1',deleted:true}]});
  assert.equal(result.sourceMode,CASH_SALES_SOURCE_MODE);assert.equal(result.openingBalance,0);
  assert.equal(result.closingBalance,500);assert.equal(result.invoiceCount,1);
  assert.deepEqual(result.rows.map(r=>r.transactionId),['CASH-1']);assert.equal(result.rows[0].partyName,'CASH');
});

test('no matching invoices or system party means a blank cashbook with zero totals',()=>{
  for(const input of [{},{cashPartyIds:['REAL_SYSTEM_CASH'],salesInvoices:[invoice('OTHER',{customerGlobalId:'OTHER'})]},
    {salesInvoices:[invoice('UNVERIFIED')]}]){
    const result=buildCashSalesCashbook(input);
    assert.deepEqual(result.rows,[]);assert.equal(result.openingBalance,0);assert.equal(result.closingBalance,0);
    assert.deepEqual(result.categoryTotals,{});assert.equal(result.invoiceCount,0);
  }
});

test('cash sales come directly from active invoices, once each, with exact remarks and precise totals',()=>{
  const result=buildCashSalesCashbook({cashPartyIds:['REAL_SYSTEM_CASH'],salesInvoices:[
    invoice('B',{date:'2026-05-02',grandTotal:0.2,remarks:'  Cash sale\n  note  '}),
    invoice('A',{grandTotal:0.1}),invoice('A',{grandTotal:0.1}),invoice('ZERO',{date:'2026-05-03',grandTotal:0}),
    ...['DRAFT','DELETED','CANCELLED','VOID','VOIDED'].map(status=>invoice(status,{status})),
    invoice('PERFORMA',{invoiceType:'PERFORMA'}),
  ]});
  assert.deepEqual(result.rows.map(r=>r.transactionId),['A','B','ZERO']);
  assert.deepEqual(result.rows.map(r=>r.runningBalance),[0.1,0.3,0.3]);
  assert.equal(result.rows[1].remarks,'  Cash sale\n  note  ');assert.equal(result.rows.every(r=>r.debit===0),true);
  assert.equal(result.closingBalance,0.3);assert.equal(result.invoiceCount,3);
});

const handler=transactions.stack.find(x=>x.route?.path==='/cashbook').route.stack[0].handle;
const invoke=async query=>{
  const res={status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};
  await handler({auth:{tenantKey:'CASH_SALES_VIEW_TEST',permissions:['*']},query:{financialYear:'2026-27',...query}},res);
  return res;
};

test('cashbook API keeps profile opening while summaries, details and exports exclude unrelated accounting sources',async t=>{
  const tenantKey='CASH_SALES_VIEW_TEST',models=financialModels(tenantKey,'2026-27');
  const all=[invoice('A'),invoice('B',{date:'2026-04-20',grandTotal:100}),invoice('C',{date:'2026-05-02',grandTotal:0.3}),
    invoice('NAMED-CASH',{customerGlobalId:'MANUAL_CASH',customerNameSnapshot:'CASH'}),
    invoice('OTHER-TENANT',{tenantKey:'OTHER'}),invoice('OLDER-YEAR',{financialYear:'2025-26'}),
    invoice('CANCELLED',{status:'CANCELLED'})];
  let salesReads=0;
  t.mock.method(CustomerLink,'find',filter=>{
    if(!filter.systemKey)return query([]);
    assert.deepEqual(filter,{tenantKey,systemKey:'CASH',systemManaged:true});
    return query([{globalCustomerId:'REAL_SYSTEM_CASH'}]);
  });
  t.mock.method(mongoose.connection,'getClient',()=>({db:()=>({admin:()=>({listDatabases:async()=>({databases:[]})}),
    listCollections:filter=>({hasNext:async()=>filter.name==='salesinvoices'})})}));
  for(const model of [CompanyLedger,User,BankAccount,Product])t.mock.method(model,'find',()=>query([]));
  t.mock.method(models.SalesInvoice,'find',filter=>{
    salesReads++;assert.equal(filter.tenantKey,tenantKey);assert.equal(filter.financialYear,'2026-27');
    assert.deepEqual(filter.customerGlobalId.$in,['REAL_SYSTEM_CASH']);
    return query(all.filter(i=>i.tenantKey===filter.tenantKey&&i.financialYear===filter.financialYear&&
      filter.customerGlobalId.$in.includes(i.customerGlobalId)&&!filter.status.$nin.includes(i.status)));
  });
  for(const model of [models.Receipt,models.Payment,models.LedgerEntry,models.BookCorrection])
    t.mock.method(model,'find',()=>{throw new Error('Non-sale accounting source must not be queried')});
  t.mock.method(CompanyProfile,'findOne',()=>query({firstCashFinancialYear:'2026-27',firstCashOpeningBalance:1000,financialYears:['2026-27']}));
  t.after(()=>{cashbookSnapshots.invalidate(tenantKey);invalidateFinancialYearDiscovery(tenantKey)});
  const summary=await invoke({groupByMonth:'1'});
  assert.equal(summary.statusCode,200);const data=summary.body.data;
  assert.equal(data.openingBalance,1000);assert.equal(data.closingBalance,1600.3);assert.equal(data.invoiceCount,3);
  assert.equal(data.monthlySummaries[0].credit,600);assert.equal(data.monthlySummaries[1].openingBalance,1600);
  assert.equal(data.monthlySummaries[1].closingBalance,1600.3);
  const detail=await invoke({snapshotId:data.snapshotId,fromDate:'2026-05-01',toDate:'2026-05-31'});
  assert.deepEqual(detail.body.data.items.map(r=>r.transactionId),['C']);
  assert.equal(detail.body.data.periodOpeningBalance,1600);assert.equal(detail.body.data.periodCreditTotal,0.3);
  const exported=await invoke({snapshotId:data.snapshotId,category:'ALL',limit:200});
  assert.deepEqual(exported.body.data.items.map(r=>r.transactionId),['C','B','A']);
  assert.equal(salesReads,1);
  const old=await cashbookSnapshots.build(tenantKey,'2026-27',async()=>({adjusted:{rows:[{category:'CASH_RECEIPT'}]}}));
  assert.equal((await invoke({snapshotId:old.snapshotId})).statusCode,409);
});
