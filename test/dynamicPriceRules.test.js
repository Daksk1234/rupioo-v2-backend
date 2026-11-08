import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateDynamicPrice,orderedDiscounts} from '../src/services/dynamicPriceEngine.js';
const rules=[
 {code:'DELIVERY',name:'Delivery Incentive',mode:'VARIABLE',defaultPct:8,status:'ACTIVE'},
 {code:'PROMO',name:'Promotional',mode:'VARIABLE',defaultPct:2,status:'ACTIVE'},
 {code:'BASE',name:'Fixed Trade',mode:'FIXED',defaultPct:5,status:'ACTIVE'},
];
test('discounts ordered grade then fixed then variable ascending',()=>{
 const a=orderedDiscounts({gradePct:10,rules});
 assert.deepEqual(a.map(x=>x.code),['GRADE','BASE','PROMO','DELIVERY']);
});
test('sale-to-MRP reverses discount and tax and back',()=>{
 const input={salePrice:850,gstRate:18,gradePct:10,rules};
 const forward=calculateDynamicPrice({...input,mode:'SALE_TO_MRP'});
 const backward=calculateDynamicPrice({...input,mode:'MRP_TO_SALE',mrp:forward.mrp});
 assert.ok(Math.abs(backward.salePrice-850)<0.02);
 assert.ok(forward.mrp>850);
 assert.equal(forward.discountSteps.length,4);
});
test('variable can be disabled, fixed cannot be disabled or overridden',()=>{
 const out=orderedDiscounts({gradePct:5,rules,overrides:{PROMO:{enabled:false},BASE:{enabled:false,percent:99},DELIVERY:{percent:3}}});
 assert.deepEqual(out.map(x=>[x.code,x.percent]),[['GRADE',5],['BASE',5],['DELIVERY',3]]);
});
test('invalid nonreversible discount blocked',()=>assert.throws(()=>calculateDynamicPrice({mode:'SALE_TO_MRP',salePrice:100,gradePct:100}),/below 100/));
test('inactive rules excluded from calculations',()=>assert.equal(orderedDiscounts({rules:[{code:'X',mode:'FIXED',defaultPct:12,status:'INACTIVE'}]}).length,1));
test('grade price is applied after ex GST basic',()=>{
 const a=calculateDynamicPrice({mode:'MRP_TO_SALE',mrp:1180,gstRate:18,gradePct:10});
 assert.equal(a.mrpExGst,1000);assert.equal(a.salePrice,900);assert.equal(a.saleIncludingGst,1062);
});
