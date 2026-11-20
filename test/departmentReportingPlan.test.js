import test from "node:test";
import assert from "node:assert/strict";
import {planDepartmentReporting, canDeleteCompanyDepartment} from "../src/services/departmentReportingPlan.js";
import {planDepartmentReporting as frontendPlan} from "../../frontend/src/services/departmentReportingPlan.js";

const role = code => ({_id:code, code, name:code});
const user = (id, role, parent = "", extra = {}) => ({_id:id, roleId:role, assignedToUserId:parent, status:"ACTIVE", ...extra});
const roles = [role("HEAD"), role("MANAGER"), role("STAFF")];

for (const [name, plan] of [["backend", planDepartmentReporting], ["frontend mirror", frontendPlan]]) {
  test(`${name}: rank reversal reassigns reporting without changing user roles or creating cycles`, () => {
    const users = [user("h", "HEAD"), user("m", "MANAGER", "h"), user("s", "STAFF", "m")];
    const snapshot = structuredClone(users);
    const changes = plan([...roles].reverse(), users);
    assert.deepEqual(changes, [
      {userId:"s", parentUserId:""}, {userId:"m", parentUserId:"s"}, {userId:"h", parentUserId:"m"}
    ]);
    assert.deepEqual(users, snapshot);
    const remapped = new Map(users.map(u => [u._id, u.assignedToUserId]));
    for (const change of changes) remapped.set(change.userId, change.parentUserId);
    for (const root of remapped.keys()) {
      let current = root; const seen = new Set();
      while (current) {assert.ok(!seen.has(current)); seen.add(current); current = remapped.get(current);}
    }
  });
  test(`${name}: valid reporting links survive unchanged`, () => {
    assert.deepEqual(plan(roles, [user("h","HEAD"), user("m","MANAGER","h"),user("s","STAFF","m")]), []);
  });
  test(`${name}: swapping ranks preserves existing reporting subtrees`, () => {
    const users = [user("h1","HEAD"),user("h2","HEAD"),user("m1","MANAGER","h1"),user("m2","MANAGER","h2"),user("s1","STAFF","m1"),user("s2","STAFF","m2")];
    const changes = new Map(plan([roles[0],roles[2],roles[1]],users).map(row => [row.userId,row.parentUserId]));
    assert.equal(changes.get("s1"),"h1"); assert.equal(changes.get("s2"),"h2");
    assert.equal(changes.get("m1"),"s1"); assert.equal(changes.get("m2"),"s2");
  });
  test(`${name}: new reporting links prefer the same branch and distribute users`, () => {
    const users = [user("h1","HEAD","",{branchId:"b1"}),user("h2","HEAD","",{branchId:"b2"}),user("m1","MANAGER","",{branchId:"b2"}),user("m2","MANAGER")];
    const changes = new Map(plan(roles,users).map(row => [row.userId,row.parentUserId]));
    assert.equal(changes.get("m1"),"h2"); assert.equal(changes.get("m2"),"h1");
  });
  test(`${name}: missing active parent prevents invalid rank changes`, () => {
    assert.throws(() => plan(roles,[user("h","HEAD","",{status:"INACTIVE"}),user("m","MANAGER")]),error => error.statusCode === 409 && /active HEAD/.test(error.message));
  });
  test(`${name}: legacy users, inactive users, deleted users and independent collectors`, () => {
    const users = [{_id:"h",role:"HEAD",status:"ACTIVE"},user("m","MANAGER","",{status:"INACTIVE"}),user("deleted","STAFF","",{status:"DELETED"}),user("other","OTHER","m")];
    assert.deepEqual(plan(roles,users),[{userId:"m",parentUserId:"h"}]);
    assert.deepEqual(plan([roles[0],role("COLLECTION_EXECUTIVE")],[user("c","COLLECTION_EXECUTIVE","old")]),[{userId:"c",parentUserId:""}]);
  });
}

test("superadmin deletion is limited to own company departments", () => {
  const auth = {role:"SUPERADMIN",tenantKey:"company-a"};
  assert.equal(canDeleteCompanyDepartment(auth,{tenantKey:"company-a"}),true);
  assert.equal(canDeleteCompanyDepartment(auth,{tenantKey:"__MASTER_DEPARTMENTS__"}),false);
  assert.equal(canDeleteCompanyDepartment(auth,{tenantKey:"company-b"}),false);
  assert.equal(canDeleteCompanyDepartment(auth,{tenantKey:"company-a",sourceTemplateCode:"MASTER_COPY"}),false);
  assert.equal(canDeleteCompanyDepartment({...auth,role:"USER"},{tenantKey:"company-a"}),false);
});
