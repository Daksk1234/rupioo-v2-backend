import test from 'node:test';
import assert from 'node:assert/strict';
import { chequePartyFilter, chequePartyRow } from '../src/services/chequePartyDirectory.js';

test('tenant isolation and active debtor/creditor/both party selection', () => {
  const f = chequePartyFilter('COMPANY-1');
  assert.equal(f.tenantKey, 'COMPANY-1');
  assert.deepEqual(f.$and[0].$or[0].partyType.$in, ['DEBITOR','CREDITOR','BOTH']);
  assert.ok(f.status.$nin.includes('DEACTIVATED'));
});
test('search escapes metacharacters and searches entire master by name or identifier', () => {
  const f = chequePartyFilter('COMPANY-1', 'A.B+[bank]');
  const terms = f.$and[1].$or;
  assert.equal(terms[0].localName.$regex, 'A\\.B\\+\\[bank\\]');
  assert.equal(terms[1].displayIdentifier.$options, 'i');
});
test('party rows have stable master ID and readable classification', () => {
  assert.deepEqual(chequePartyRow({globalCustomerId:'ID-5',localName:'ABC',partyType:'CREDITOR',displayIdentifier:'GST-5'}),
    {id:'ID-5',name:'ABC',partyType:'CREDITOR',identifier:'GST-5'});
  assert.equal(chequePartyRow({globalCustomerId:'ID-6',localName:'Old'}).partyType,'DEBITOR');
});
