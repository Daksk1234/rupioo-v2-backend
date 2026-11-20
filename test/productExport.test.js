import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import XLSX from "xlsx";
import products from "../src/routes/products.js";
import {Product} from "../src/models/index.js";
import {createProductExportWorkbook, flattenProductDocument, productListFilter} from "../src/services/productExportService.js";

const {ObjectId, Decimal128, Long, Binary} = mongoose.mongo.BSON;
const roundTrip = documents => XLSX.read(XLSX.write(createProductExportWorkbook(documents), {type:"buffer",bookType:"xlsx"}), {type:"buffer"});
const grid = (book, name = book.SheetNames[0]) => XLSX.utils.sheet_to_json(book.Sheets[name], {header:1,defval:"",raw:true});

test("Excel includes the union of every stored key and all products beyond list pagination", () => {
  const documents = Array.from({length:215},(_,index)=>({_id:`id-${index}`,sku:`SKU-${index}`,name:`Product ${index}`,currentStock:index}));
  documents[214].customLegacyField="Only on the last product";
  documents[0].__v=3;
  documents[0].minimumProfitPct=7;
  const book=roundTrip(documents), [headers,...rows]=grid(book);
  assert.equal(rows.length,215);
  assert.equal(rows[214][headers.indexOf("customLegacyField")],"Only on the last product");
  assert.equal(rows[0][headers.indexOf("__v")],3);
  assert.equal(rows[0][headers.indexOf("minimumProfitPct")],7);
  assert.equal(rows[214][headers.indexOf("currentStock")],214);
  assert.ok(!headers.includes("pricing"));
});

test("nested objects and arrays retain complete JSON and separate indexed field columns", () => {
  const document={_id:"id",purchaseAutomation:{enabled:false,moq:0},imageFileIds:["file-1","file-2"],
    migration:{sourceData:{legacyCode:"00123",custom:{value:9}}},variants:[{name:"Small",price:1},{name:"Large",price:2}],
    emptyObject:{},emptyArray:[],nullable:null};
  const book=roundTrip([document]),[headers,values]=grid(book), value=key=>values[headers.indexOf(key)];
  assert.equal(value("purchaseAutomation.enabled"),false);
  assert.equal(value("purchaseAutomation.moq"),0);
  assert.equal(value("imageFileIds[1]"),"file-2");
  assert.equal(value("migration.sourceData.legacyCode"),"00123");
  assert.equal(value("migration.sourceData.custom.value"),9);
  assert.equal(value("variants[1].price"),2);
  assert.equal(JSON.parse(value("variants"))[1].name,"Large");
  assert.equal(value("emptyObject"),"{}");assert.equal(value("emptyArray"),"[]");assert.equal(value("nullable"),"null");
});

test("IDs, BSON types, dates, exact digits, booleans and formula-like strings round-trip safely", () => {
  const oid=new ObjectId("507f1f77bcf86cd799439011"),date=new Date("2026-11-20T10:11:12.345Z");
  const book=roundTrip([{_id:oid,createdAt:date,barcode:"0001234567890123456789",name:"=HYPERLINK(\"https://example.test\")",
    price:12.75,precise:0.12345678901234567,largeNumber:1234567890123456,enabled:false,
    decimal:Decimal128.fromString("12345678901234567890.12345"),long:Long.fromString("9223372036854775807"),binary:new Binary(Buffer.from([1,2,3]))}]);
  const [headers,values]=grid(book),value=key=>values[headers.indexOf(key)];
  assert.equal(value("_id"),oid.toHexString());assert.equal(value("createdAt"),date.toISOString());
  assert.equal(value("barcode"),"0001234567890123456789");
  assert.equal(value("decimal"),"12345678901234567890.12345");assert.equal(value("long"),"9223372036854775807");
  assert.equal(value("precise"),"0.12345678901234566");assert.equal(value("largeNumber"),"1234567890123456");
  assert.equal(value("price"),12.75);assert.equal(value("enabled"),false);
  const nameCell=book.Sheets.Products[XLSX.utils.encode_cell({r:1,c:headers.indexOf("name")})];
  assert.equal(nameCell.t,"s");assert.equal(nameCell.f,undefined);
  assert.equal(JSON.parse(value("binary")).$binary.base64,"AQID");
});

test("long values continue across cells without truncation or breaking unicode", () => {
  const text="a".repeat(32766)+"😀"+"b".repeat(40000);
  const book=roundTrip([{_id:"id",description:text}]),[headers,values]=grid(book);
  const parts=headers.filter(key=>key==="description"||key.startsWith("description [part "));
  assert.equal(parts.map(key=>values[headers.indexOf(key)]).join(""),text);
  assert.ok(parts.every(key=>values[headers.indexOf(key)].length<=32767));
});

test("literal dotted keys cannot collide with nested paths or array indexes", () => {
  const row=flattenProductDocument({"a.b":1,a:{b:2},"items[0]":3,items:[4]});
  assert.equal(row.get('["a.b"]'),1);assert.equal(row.get("a.b"),2);
  assert.equal(row.get('["items[0]"]'),3);assert.equal(row.get("items[0]"),4);
});

test("an empty collection yields a valid workbook", () => {
  const book=roundTrip([]);assert.deepEqual(book.SheetNames,["Products"]);assert.deepEqual(grid(book),[["_id"]]);
});

test("the list filter always uses the authenticated company and retains list filters", () => {
  const filter=productListFilter("company-a",{tenantKey:"company-b",q:" widget ",status:"INACTIVE",category:"Parts",page:10,limit:10});
  assert.equal(filter.tenantKey,"company-a");assert.equal(filter.status,"INACTIVE");assert.equal(filter.category,"Parts");
  assert.ok(filter.$or.find(condition=>condition.name)?.name.test("WIDGET"));
  assert.equal(filter.limit,undefined);assert.equal(filter.page,undefined);
});

const exportHandler=products.stack.find(layer=>layer.route?.path==="/export-data.xlsx"&&layer.route.methods.get).route.stack[0].handle;
const request=(role="SUPERADMIN")=>({auth:{tenantKey:"company-a",role,permissions:["dms.product.product_creation.download"]},query:{q:"Widget",tenantKey:"company-b",page:2,limit:1}});
const response=()=>({statusCode:200,headers:{},status(code){this.statusCode=code;return this;},json(payload){this.payload=payload;return this;},setHeader(key,value){this.headers[key]=value;},send(body){this.body=body;return this;}});

test("download endpoint queries MongoDB directly and returns every stored admin field in real XLSX", async t => {
  let rawRead=false;
  t.mock.method(Product,"find",()=>assert.fail("Do not export shaped/paginated list data"));
  t.mock.method(Product.collection,"find",filter=>{
    rawRead=true;assert.equal(filter.tenantKey,"company-a");assert.ok(filter.$or[0].name.test("Widget"));assert.equal(filter.limit,undefined);
    return {sort(){return this;},async toArray(){return [{_id:"id",name:"Widget",minimumProfitPct:4,pricingScheme:"CUSTOM",unmodeledKey:{a:5}}];}};
  });
  const res=response();await exportHandler(request(),res);
  assert.equal(res.statusCode,200,JSON.stringify(res.payload));assert.ok(rawRead);assert.ok(Buffer.isBuffer(res.body));
  assert.match(res.headers["Content-Disposition"],/\.xlsx/);assert.match(res.headers["Content-Type"],/spreadsheetml/);
  assert.equal(res.body.subarray(0,2).toString(),"PK");
  const [headers,values]=grid(XLSX.read(res.body,{type:"buffer"}));
  assert.equal(values[headers.indexOf("unmodeledKey.a")],5);assert.equal(values[headers.indexOf("minimumProfitPct")],4);
  assert.equal(values[headers.indexOf("pricingScheme")],"CUSTOM");
});

test("download preserves the existing non-admin management-field restrictions", async t => {
  t.mock.method(Product.collection,"find",()=>({sort(){return this;},async toArray(){return [{name:"Widget",minimumProfitPct:4,pricingScheme:"CUSTOM",customKey:5}];}}));
  const res=response();await exportHandler(request("EMPLOYEE"),res);
  assert.equal(res.statusCode,200);const [headers]=grid(XLSX.read(res.body,{type:"buffer"}));
  assert.ok(!headers.includes("minimumProfitPct"));assert.ok(!headers.includes("pricingScheme"));assert.ok(headers.includes("customKey"));
});

test("download rejects missing permission or tenant before accessing MongoDB", async t => {
  t.mock.method(Product.collection,"find",()=>assert.fail("No unauthorised database access"));
  const req=request();req.auth.permissions=["dms.product.product_creation.view"];
  const res=response();await exportHandler(req,res);assert.equal(res.statusCode,403);
  req.auth.role="MASTER";req.auth.tenantKey="";
  const missing=response();await exportHandler(req,missing);assert.equal(missing.statusCode,403);
});
