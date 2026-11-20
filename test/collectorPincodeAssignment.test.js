import test from 'node:test';
import assert from 'node:assert/strict';
import access from '../src/routes/access.js';
import {User,Role,Pincode,PincodeAssignment,CustomerLink} from '../src/models/index.js';
import {validateCollectorPincodes} from '../src/services/collectorTerritoryService.js';
const query=value=>({select(){return this},lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject)}});

test('collector pincode changes persist territory without changing salesperson ownership or individual customers',async t=>{
 const user={_id:'collector',tenantKey:'TERRITORY_TEST',roleId:'role',role:'COLLECTOR',collectorCustomerIds:['former-party'],async save(){}};
 t.mock.method(User,'findOne',filter=>{assert.equal(filter.tenantKey,user.tenantKey);return query(user)});
 t.mock.method(Role,'findOne',()=>query({code:'COLLECTOR'}));
 t.mock.method(Pincode,'aggregate',async()=>[{_id:'781001'},{_id:'781002'}]);
 t.mock.method(PincodeAssignment,'updateMany',()=>assert.fail('Collector territory must not reassign sales ownership'));
 t.mock.method(CustomerLink,'updateMany',()=>assert.fail('Customers must be selected dynamically by pincode'));
 const handler=access.stack.find(layer=>layer.route?.path==='/users/:id/pincodes'&&layer.route.methods.put).route.stack[0].handle;
 const req={auth:{tenantKey:user.tenantKey,role:'SUPERADMIN',permissions:['*']},query:{},params:{id:user._id},body:{pincodes:['781002','781001','781001']}};
 const res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
 await handler(req,res);assert.equal(res.statusCode,200,JSON.stringify(res.payload));
 assert.deepEqual(user.collectorPincodes,['781001','781002']);assert.deepEqual(user.collectorCustomerIds,[]);
});

test('collector assignments reject empty, malformed and unknown MASTER pincodes',async t=>{
 t.mock.method(Pincode,'aggregate',async()=>[{_id:'781001'}]);
 await assert.rejects(validateCollectorPincodes([]),/at least one/);
 await assert.rejects(validateCollectorPincodes(['78100']),/six-digit/);
 await assert.rejects(validateCollectorPincodes(['781001','999999']),/not found in MASTER/);
 assert.deepEqual(await validateCollectorPincodes([781001,'781001']),['781001']);
});

test('DMS reads the persisted collector pincodes back with their actual customer match count',async t=>{
 const user={_id:'collector',tenantKey:'PIN_PREVIEW_TEST',roleId:'role',role:'COLLECTOR',name:'Collector',collectorPincodes:['781001','781002']};
 t.mock.method(User,'findOne',()=>query(user));t.mock.method(Role,'findOne',()=>query({code:'COLLECTOR',name:'Collector'}));
 t.mock.method(CustomerLink,'countDocuments',async filter=>{assert.equal(filter.tenantKey,user.tenantKey);assert.equal(filter.status,'ACTIVE');return 50});
 const handler=access.stack.find(layer=>layer.route?.path==='/users/:id/pincodes'&&layer.route.methods.get).route.stack[0].handle;
 const req={auth:{tenantKey:user.tenantKey,role:'SUPERADMIN',permissions:['*']},params:{id:user._id},query:{}},
  res={statusCode:200,status(code){this.statusCode=code;return this},json(payload){this.payload=payload;return this}};
 await handler(req,res);assert.equal(res.statusCode,200);assert.deepEqual(res.payload.data.pincodes,user.collectorPincodes);
 assert.equal(res.payload.data.assignedCustomerCount,50);assert.equal(res.payload.data.collectorWorkflowVersion,3);
});
