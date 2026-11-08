import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCashbookBulkVoidSelection } from '../src/services/cashbookBulkVoidSelection.js';
const a='6ae35398c35cc5941ccbd5ce';
const b='6ae35399c35cc5941ccbd5d1';
test('accepts cash receipt and payment voucher keys',()=>{
 assert.deepEqual(normalizeCashbookBulkVoidSelection([{kind:'payments',id:a},{kind:'receipts',id:b}]),[{kind:'payments',id:a},{kind:'receipts',id:b}]);
});
test('rejects no selections, malformed selection and duplicates',()=>{
 assert.throws(()=>normalizeCashbookBulkVoidSelection([]),/Select at least/);
 assert.throws(()=>normalizeCashbookBulkVoidSelection([{kind:'contra',id:a}]),/Invalid Cashbook voucher/);
 assert.throws(()=>normalizeCashbookBulkVoidSelection([{kind:'payments',id:'PAY-001'}]),/Invalid Cashbook voucher/);
 assert.throws(()=>normalizeCashbookBulkVoidSelection([{kind:'payments',id:a},{kind:'payments',id:a}]),/Duplicate/);
});
test('applies safe bulk selection limit',()=>{
 assert.throws(()=>normalizeCashbookBulkVoidSelection(Array.from({length:101},(_,i)=>({kind:'payments',id:i.toString(16).padStart(24,'0')}))),/no more than 100/);
});
