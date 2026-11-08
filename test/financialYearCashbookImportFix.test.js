import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fiscalYearCandidates,firstDataYear,normalizeYears,validFY} from '../src/services/financialYearDiscoveryRules.js';
import {buildCompanyCashbook} from '../src/services/companyCashbookEngine.js';
import {cashbookPeriodSnapshot} from '../src/services/cashbookPeriodService.js';

const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const payment=(id,amount,remarks)=>({paymentNo:id,_id:id,status:'POSTED',mode:'CASH',amount,remarks,partyNameSnapshot:'Bishnupur Furniture'});
const journal=(id,dr,cr,date)=>({transactionId:id,_id:id+'-'+dr+'-'+cr,transactionType:'PAYMENT',debit:dr,credit:cr,narration:'Generic PAY narration',date:date+'T00:00:00Z',createdAt:date+'T12:00:00Z'});

test('earliest stored FY is used even when only the later FY was configured',()=>{
 assert.equal(firstDataYear({discovered:['2024-25','2025-26'],configured:['2025-26']}),'2024-25');
 assert.deepEqual(fiscalYearCandidates({configured:['2025-26'],discovered:['2024-25']}),['2024-25','2025-26']);
 assert.deepEqual(normalizeYears(['2024-25','2024-25','2026-26','2025-26']),['2024-25','2025-26']);
 assert.ok(validFY('2024-25'));assert.equal(validFY('2024-26'),false);
});
test('historical cash debit uses uploaded remarks, subtracts from running balance',()=>{
 const book=buildCompanyCashbook({enforceSourceDocuments:true,openingBalance:99923.59,
  lines:[journal('PAY-367',0,52360,'2025-05-02')],
  payments:[payment('PAY-367',52360,'Bishnupur -Furniture -Furniture mistri online')]});
 assert.equal(book.rows[0].particular,'Bishnupur -Furniture -Furniture mistri online');
 assert.equal(book.rows[0].debit,52360);
 assert.equal(book.rows[0].runningBalance,47563.59);
 assert.equal(book.closingBalance,47563.59);
});
test('legacy self-offset journal may display payment and issue marker internally without overwriting particulars',()=>{
 const book=buildCompanyCashbook({enforceSourceDocuments:true,openingBalance:60000,
  lines:[journal('PAY-367',52360,0,'2025-05-02'),journal('PAY-367',0,52360,'2025-05-02')],
  payments:[payment('PAY-367',52360,'Original uploaded remark')]});
 assert.equal(book.rows[0].debit,52360);
 assert.equal(book.rows[0].runningBalance,7640);
 assert.equal(book.rows[0].particular,'Original uploaded remark');
 assert.ok(book.rows[0].needsCorrection);
});
test('cashbook no longer prints RECONCILIATION REQUIRED on normal rows',()=>{
 const ui=source('../../frontend/src/pages/CashbookPage.jsx');
 assert.doesNotMatch(ui,/RECONCILIATION REQUIRED/);
 assert.match(ui,/r.particular\|\|r.remarks/);
});
test('Cashbook uploads match exact parties, and unmatched ones default to Suspense',()=>{
 const server=source('../src/routes/transactions.js');
 assert.match(server,/confidence:matched\?'EXACT':'SUSPENSE'/);
 assert.match(server,/partyType:matched\?\.type\|\|'OTHER'/);
 assert.match(server,/auth\.role==='SUPERADMIN'&&input\.source==='SUPERADMIN_BULK'/);
 assert.match(server,/postBalancedEntries/);
});
test('first-year setting respects discovered data years and remains limited to Superadmin',()=>{
 const profile=source('../src/routes/profile.js');
 assert.match(profile,/discoveredYears\.firstDataFinancialYear/);
 assert.match(profile,/assertSuperadmin/);
 assert.doesNotMatch(profile,/Cash opening must be set against the company's first financial year/);
});
test('FY historical cash projection performs simultaneous reads, not N serial database scans',()=>{
 const rollover=source('../src/services/companyCashbookRolloverService.js');
 assert.match(rollover,/Promise\.all\(historicalYears\.map/);
 assert.doesNotMatch(rollover,/await companyCashOpening/);
});
test('stock FY opening can be configured without overwriting live stock movements',()=>{
 const product=source('../src/routes/products.js');
 assert.match(product,/normalizeStockFyOpenings/);
 assert.match(product,/delete changes\.openingStockByFY/);
 const screen=source('../../frontend/src/pages/ProductPage.jsx');
 assert.match(screen,/FY Opening Quantity/);
 assert.match(screen,/FY Opening Rate/);
});

test('Bank Account FY opening selector includes discovered financial years',()=>{
 const page=source('../../frontend/src/pages/BankAccountPage.jsx');
 assert.match(page,/financialYearDiscovery\?\.availableFinancialYears/);
 assert.match(page,/extra: \[selectedFy, \.\.\.discoveredYears\]/);
});
test('Cash journal has index for ordered account-wise daily cashbook',()=>{
 const model=source('../src/models/fyModels.js');
 assert.match(model,/accountCode: 1, status: 1, date: 1, createdAt: 1/);
});
