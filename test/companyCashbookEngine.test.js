import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanyCashbook } from '../src/services/companyCashbookEngine.js';
const line=(id,type,debit,credit,day='2025-05-31')=>({
 _id:`${id}-${debit}-${credit}`,transactionId:id,transactionType:type,
 date:`${day}T00:00:00.000Z`,debit,credit,narration:`Expense ${id}`,createdAt:'2025-10-01T00:00:00Z'
});
test('Cash Payment appears under Debit and reduces running balance',()=>{
 const r=buildCompanyCashbook({openingBalance:1000,lines:[line('PAY-1','PAYMENT',0,300)]});
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].debit,300);assert.equal(r.rows[0].credit,0);assert.equal(r.closingBalance,700);
});
test('Cash Receipt appears under Credit and increases running balance',()=>{
 const r=buildCompanyCashbook({openingBalance:1000,lines:[line('RCT-1','RECEIPT',250,0)]});
 assert.equal(r.rows[0].debit,0);assert.equal(r.rows[0].credit,250);assert.equal(r.closingBalance,1250);
});
test('Cash to Bank contra appears in Cashbook Debit; withdrawal in Credit',()=>{
 const r=buildCompanyCashbook({openingBalance:1000,lines:[line('CON-1','CONTRA',0,300),line('CON-2','CONTRA',90,0)]});
 assert.equal(r.rows[0].debit,300);assert.equal(r.rows[1].credit,90);assert.equal(r.closingBalance,790);
});
test('Cash Sale credit and Cash Purchase debit',()=>{
 const r=buildCompanyCashbook({openingBalance:1000,lines:[line('S-1','SALES_INVOICE',400,0),line('P-1','PURCHASE_INVOICE',0,125)]});
 assert.equal(r.rows.find(x=>x.transactionId==='S-1').particular,'Cash Sale');assert.equal(r.rows.find(x=>x.transactionId==='S-1').credit,400);
 assert.equal(r.rows.find(x=>x.transactionId==='P-1').particular,'Cash Purchase');assert.equal(r.rows.find(x=>x.transactionId==='P-1').debit,125);
});
test('A historical self-offset cash payment displays only Debit and is flagged provisional',()=>{
 const r=buildCompanyCashbook({openingBalance:50000,lines:[line('PAY-331','PAYMENT',40000,0),line('PAY-331','PAYMENT',0,40000)],
  payments:[{_id:'p1',paymentNo:'PAY-331',status:'POSTED',mode:'CASH',partyNameSnapshot:'CASH',amount:40000}]});
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].debit,40000);assert.equal(r.rows[0].credit,0);
 assert.equal(r.closingBalance,10000);assert.equal(r.journalClosingBalance,50000);assert.equal(r.provisional,true);
});
test('232 historical cash payments remain one row each and only Debit',()=>{
 const lines=[],payments=[];
 for(let i=1;i<=232;i++){
  const id=`PAY-${i}`;lines.push(line(id,'PAYMENT',100,0),line(id,'PAYMENT',0,100));
  payments.push({_id:String(i),paymentNo:id,status:'POSTED',mode:'CASH',amount:100});
 }
 const r=buildCompanyCashbook({openingBalance:25000,lines,payments});
 assert.equal(r.rows.length,232);
 assert.equal(r.rows.reduce((n,x)=>n+x.debit,0),23200);
 assert.equal(r.rows.reduce((n,x)=>n+x.credit,0),0);
 assert.equal(r.closingBalance,1800);assert.equal(r.provisional,true);
});
