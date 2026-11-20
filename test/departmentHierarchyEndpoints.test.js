import test from "node:test";
import assert from "node:assert/strict";
import access from "../src/routes/access.js";
import {Department, Role, User, PincodeAssignment, CompanyProfile} from "../src/models/index.js";

const did="507f1f77bcf86cd799439011", a="507f1f77bcf86cd799439012", b="507f1f77bcf86cd799439013";
const tenantKey="DEPARTMENT_TEST";
const query=value=>({select(){return this;},sort(){return this;},lean:async()=>value,then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
const handler=(path,method)=>access.stack.find(layer=>layer.route?.path===path&&layer.route.methods[method]).route.stack[0].handle;
const req=()=>({auth:{role:"SUPERADMIN",tenantKey,sub:"admin"},params:{id:did,departmentId:did},query:{},body:{}});
const res=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(payload){this.payload=payload;return this;}});

test("delete endpoint rejects MASTER departments before any writes",async t=>{
  t.mock.method(Department,"findOne",()=>query({_id:did,tenantKey:"__MASTER_DEPARTMENTS__"}));
  t.mock.method(Role,"updateMany",()=>assert.fail("MASTER department roles must remain unchanged"));
  const response=res(); await handler("/departments/:id","delete")(req(),response);
  assert.equal(response.statusCode,403); assert.match(response.payload.message,/created by MASTER/);
});

test("delete endpoint prevents deleting a company department containing users",async t=>{
  t.mock.method(Department,"findOne",()=>query({_id:did,tenantKey}));
  t.mock.method(Role,"find",()=>query([{_id:a,code:"HEAD"}]));
  t.mock.method(User,"countDocuments",async filter=>{assert.equal(filter.tenantKey,tenantKey);assert.deepEqual(filter.status,{$ne:"DELETED"});return 1;});
  t.mock.method(Role,"updateMany",()=>assert.fail("Do not detach occupied roles"));
  const response=res(); await handler("/departments/:id","delete")(req(),response);
  assert.equal(response.statusCode,409); assert.match(response.payload.message,/Move existing users/);
});

test("delete endpoint deactivates own empty department and releases its roles",async t=>{
  let saved=false,detached=false,deactivated=false;
  const department={_id:did,tenantKey,async save(){saved=true;}};
  t.mock.method(Department,"findOne",()=>query(department));
  t.mock.method(Role,"find",()=>query([{_id:a,code:"HEAD"}]));
  t.mock.method(User,"countDocuments",async()=>0);
  t.mock.method(Role,"updateMany",async(filter,update)=>{assert.equal(filter.tenantKey,tenantKey);assert.equal(update.$set.hierarchyOrder,0);detached=true;});
  t.mock.method(PincodeAssignment,"updateMany",async(filter,update)=>{assert.equal(filter.tenantKey,tenantKey);assert.deepEqual(update.$set,{status:"INACTIVE",userIds:[]});deactivated=true;});
  const response=res(); await handler("/departments/:id","delete")(req(),response);
  assert.equal(response.statusCode,200); assert.equal(department.status,"INACTIVE"); assert.ok(saved&&detached&&deactivated);
});

function mockHierarchy(t,users){
  const writes=[];
  const department={_id:did,tenantKey,name:"Operations",permissions:[],permissionConfigured:false};
  const roles=[{_id:a,code:"HEAD",name:"Head",departmentId:did,hierarchyOrder:1,permissions:[],async save(){writes.push(["role",this._id,this.hierarchyOrder]);}},
    {_id:b,code:"STAFF",name:"Staff",departmentId:did,hierarchyOrder:2,permissions:[],async save(){writes.push(["role",this._id,this.hierarchyOrder]);}}];
  t.mock.method(Department,"find",()=>query([])); // No legacy tenant departments to migrate.
  t.mock.method(Department,"findOne",()=>query(department));
  t.mock.method(Role,"findOneAndUpdate",async()=>null); // Template maintenance, unrelated to ranked roles.
  t.mock.method(Role,"find",filter=>query(filter.tenantKey!==tenantKey?[]:roles));
  t.mock.method(User,"find",filter=>{assert.equal(filter.tenantKey,tenantKey);return query(users);});
  t.mock.method(User,"updateMany",async(filter)=>{assert.equal(filter.tenantKey,tenantKey);writes.push(["users"]);});
  t.mock.method(User,"bulkWrite",async operations=>{writes.push(["reporting",operations]);});
  t.mock.method(CompanyProfile,"findOne",()=>query(null));
  t.mock.method(PincodeAssignment,"find",()=>query([]));
  return {roles,writes};
}

test("saving reversed hierarchy persists new ranks and reporting links",async t=>{
  const users=[{_id:"head-user",roleId:a,status:"ACTIVE"},{_id:"staff-user",roleId:b,assignedToUserId:"head-user",status:"ACTIVE"}];
  const {roles,writes}=mockHierarchy(t,users);
  const request=req(),response=res();request.body.roleIds=[b,a];
  await handler("/department-role-assignment/:departmentId","put")(request,response);
  assert.equal(response.statusCode,200,JSON.stringify(response.payload));
  assert.equal(roles[0].hierarchyOrder,2);assert.equal(roles[1].hierarchyOrder,1);
  assert.equal(response.payload.data.reportingAssignmentsChanged,2);
  const operations=writes.find(row=>row[0]==="reporting")[1];
  assert.deepEqual(operations.map(row=>row.updateOne),[
    {filter:{_id:"staff-user",tenantKey},update:{$unset:{assignedToUserId:1}}},
    {filter:{_id:"head-user",tenantKey},update:{$set:{assignedToUserId:"staff-user"}}}
  ]);
});

test("missing parent rejects a rank change before any rank or user writes",async t=>{
  const {writes}=mockHierarchy(t,[{_id:"head-user",roleId:a,status:"ACTIVE"}]);
  const request=req(),response=res();request.body.roleIds=[b,a];
  await handler("/department-role-assignment/:departmentId","put")(request,response);
  assert.equal(response.statusCode,409); assert.match(response.payload.message,/active Staff/);assert.deepEqual(writes,[]);
});
