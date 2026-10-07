import test from 'node:test';
import assert from 'node:assert/strict';
import { oldDmsReferenceReportCatalog, oldDmsReferenceReportKind } from '../src/services/oldDmsReferenceReportsService.js';

test('all 53 old-DMS report entries are represented by V2-native reference reports', () => {
  assert.equal(oldDmsReferenceReportCatalog.length, 53);
  for (const report of oldDmsReferenceReportCatalog) {
    assert.ok(report.name);
    assert.ok(oldDmsReferenceReportKind(report.name));
    assert.equal(report.implementation, 'V2_OLD_DMS_REFERENCE');
  }
});

test('critical old-DMS financial and stock reports have explicit V2 mappings', () => {
  const expected = [
    'STOCK DIFFERENCE REPORT','Closing Stock Report','WareHouse Stock Report',
    'TAX REPORT','Overdue Report','Party Ledger Report','PartywiseLedger Report',
    'Profit and Loss Report','BalanceSheet','SalesTarget Report','Target Achieved Report','Target Pending Report',
    'Transaction Report','Earning Report'
  ];
  for (const name of expected) assert.ok(oldDmsReferenceReportKind(name), `missing ${name}`);
});
