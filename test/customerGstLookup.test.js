import test from "node:test";
import assert from "node:assert/strict";
import {GlobalCustomer,CustomerLink} from "../src/models/index.js";
import {lookupCustomerGst} from "../src/services/customerGstLookupService.js";

const gstin="18AKRPJ2121L2ZX";
const query = value => ({select(){return this;},async lean(){return value;}});

test("GST lookup uses the global registry first and skips the provider on a match", async t => {
  t.mock.method(GlobalCustomer,"findOne",filter=>{
    assert.deepEqual(filter,{"gstins.value":gstin});
    return query({hiddenId:"GC-1",legalName:"Registered Company",tradeName:"Trade Name",pan:"AKRPJ2121L",registeredAddress:"Registry Address",gstins:[{value:gstin,status:"VERIFIED"}],gstProfile:{taxpayerType:"Regular",constitution:"Proprietorship"},emails:[{value:"office@example.test",primary:true}],mobiles:[]});
  });
  t.mock.method(CustomerLink,"findOne",filter=>{
    assert.equal(filter.tenantKey,"COMPANY-A");assert.equal(filter.globalCustomerId,"GC-1");
    return query({localName:"Company Local Name",ownerName:"Owner",ownerMobile:"9000000000",addresses:[{type:"BILLING",address:"Billing address",pincode:"781001",city:"Guwahati",district:"Kamrup",state:"Assam"}]});
  });
  const result=await lookupCustomerGst(gstin.toLowerCase(),{tenantKey:"COMPANY-A",lookupTaxpayer:()=>assert.fail("The GST provider must not be called for registered customers")});
  assert.equal(result.source,"GLOBAL_CUSTOMER_REGISTRY");assert.equal(result.verified,true);
  assert.equal(result.businessName,"Company Local Name");assert.equal(result.principalAddress,"Billing address");
  assert.equal(result.principalAddressRaw.pncd,"781001");assert.equal(result.ownerName,"Owner");assert.equal(result.email,"office@example.test");
});

test("only a missing customer triggers the GST API, after checking the registry", async t => {
  const calls=[];
  t.mock.method(GlobalCustomer,"findOne",()=>{calls.push("registry");return query(null);});
  t.mock.method(CustomerLink,"findOne",()=>assert.fail("No company data should be read without a registry match"));
  const taxpayer={source:"APPYFLOW",gstin,legalName:"Provider company"};
  const result=await lookupCustomerGst(gstin,{tenantKey:"COMPANY-A",lookupTaxpayer:async value=>{calls.push("api");assert.equal(value,gstin);return taxpayer;}});
  assert.deepEqual(calls,["registry","api"]);assert.equal(result,taxpayer);
});

test("an empty registry identity falls back to GST without exposing company details", async t => {
  t.mock.method(GlobalCustomer,"findOne",()=>query({hiddenId:"GC-EMPTY",gstins:[{value:gstin}]}));
  t.mock.method(CustomerLink,"findOne",()=>assert.fail("No company lookup for an empty registry identity"));
  const result=await lookupCustomerGst(gstin,{lookupTaxpayer:async()=>({source:"APPYFLOW"})});
  assert.equal(result.source,"APPYFLOW");
});

test("registry-only results do not borrow another company's private fields or mark unverified GST as verified", async t => {
  t.mock.method(GlobalCustomer,"findOne",()=>query({hiddenId:"GC-2",legalName:"Shared Company",gstins:[{value:gstin,status:"UNVERIFIED"}],registeredAddress:"Shared registered address"}));
  t.mock.method(CustomerLink,"findOne",filter=>{assert.equal(filter.tenantKey,"COMPANY-B");return query(null);});
  const result=await lookupCustomerGst(gstin,{tenantKey:"COMPANY-B",lookupTaxpayer:()=>assert.fail("Registry match must skip GST API")});
  assert.equal(result.verified,false);assert.equal(result.ownerName,"");assert.equal(result.ownerMobile,"");
  assert.equal(result.principalAddress,"Shared registered address");assert.equal(result.bankDetails,undefined);assert.equal(result.password,undefined);
});

test("malformed GSTIN never reaches the database or provider", async t => {
  t.mock.method(GlobalCustomer,"findOne",()=>assert.fail("Do not query malformed GSTIN"));
  await assert.rejects(lookupCustomerGst("invalid",{lookupTaxpayer:()=>assert.fail("Do not call API")}),error=>error.status===400);
});

test("registry errors propagate and do not cause an unintended provider request", async t => {
  t.mock.method(GlobalCustomer,"findOne",()=>({select(){return this;},async lean(){throw new Error("Registry unavailable");}}));
  await assert.rejects(lookupCustomerGst(gstin,{lookupTaxpayer:()=>assert.fail("Database errors are not registry misses")}),/Registry unavailable/);
});
