import test from 'node:test';
import assert from 'node:assert/strict';
import {chequeISODate,chequeSerials,canChequeTransition} from '../src/services/chequeControlRules.js';

test('cheque book preserves leading zeros and sequential numbers',()=>{
  assert.deepEqual(chequeSerials('000501',4),['000501','000502','000503','000504']);
  assert.deepEqual(chequeSerials('999',2),['999','1000']);
});
test('no negative/zero/oversized leaf counts',()=>{
  for(const n of [0,-1,501,1.5])assert.throws(()=>chequeSerials('000100',n));
  assert.throws(()=>chequeSerials('999999999999999999',2));
  assert.throws(()=>chequeSerials('ABC',2));
});
test('validates bank dates and leap year',()=>{
  assert.equal(chequeISODate('2028-02-29'),'2028-02-29');
  assert.throws(()=>chequeISODate('2026-02-29'));
  assert.throws(()=>chequeISODate('31-03-2026'));
});
test('issued leaves clear only after issuance',()=>{
  assert.equal(canChequeTransition('ISSUED','AVAILABLE','CLEARED'),false);
  assert.equal(canChequeTransition('ISSUED','AVAILABLE','ISSUED'),true);
  assert.equal(canChequeTransition('ISSUED','ISSUED','CLEARED'),true);
  assert.equal(canChequeTransition('ISSUED','CLEARED','ISSUED'),false);
});
test('received cheques pass through deposit, allow returned and redeposit',()=>{
  assert.equal(canChequeTransition('RECEIVED','RECEIVED','CLEARED'),false);
  assert.equal(canChequeTransition('RECEIVED','RECEIVED','DEPOSITED'),true);
  assert.equal(canChequeTransition('RECEIVED','DEPOSITED','BOUNCED'),true);
  assert.equal(canChequeTransition('RECEIVED','BOUNCED','REDEPOSITED'),true);
  assert.equal(canChequeTransition('RECEIVED','REDEPOSITED','CLEARED'),true);
});

// Added for the first-available automatic Issue Cheque page.
import {pickFirstAvailableCheque,chequeIssuePurpose,chequeMissingLeafStatus} from '../src/services/chequeControlRules.js';
test('automatic issuance picks first AVAILABLE cheque numerically, ignoring other statuses',()=>{
  const rows=[
    {_id:'b',data:{status:'AVAILABLE',chequeNo:'001002'}},
    {_id:'a',data:{status:'CANCELLED',chequeNo:'000998'}},
    {_id:'c',data:{status:'ISSUED',chequeNo:'000999'}},
    {_id:'d',data:{status:'AVAILABLE',chequeNo:'001000'}},
    {_id:'e',data:{status:'MISTAKEN',chequeNo:'000997'}}
  ];
  assert.equal(pickFirstAvailableCheque(rows)?.data.chequeNo,'001000');
  assert.equal(pickFirstAvailableCheque([{data:{status:'ISSUED',chequeNo:'1000'}}]),null);
});
test('automatic cheque selection compares numeric values, not strings',()=>{
  const rows=[{_id:'a',data:{chequeNo:'1000',status:'AVAILABLE'}},{_id:'b',data:{chequeNo:'00999',status:'AVAILABLE'}}];
  assert.equal(pickFirstAvailableCheque(rows)?.data.chequeNo,'00999');
});
test('issue can be CHEQUE, NEFT or RTGS, no unknown type',()=>{
  for(const mode of ['CHEQUE','NEFT','RTGS'])assert.equal(chequeIssuePurpose(mode),mode);
  assert.equal(chequeIssuePurpose(), 'CHEQUE');
  assert.throws(()=>chequeIssuePurpose('IMPS'));
});
test('unavailable first cheque has mandatory supported status and terminal result',()=>{
  for(const status of ['CANCELLED','STOLEN','MISTAKEN']){
    assert.equal(chequeMissingLeafStatus(status),status);
    assert.equal(canChequeTransition('ISSUED','AVAILABLE',status),true);
    assert.equal(canChequeTransition('ISSUED',status,'ISSUED'),false);
  }
  assert.throws(()=>chequeMissingLeafStatus('ISSUED'));
});
