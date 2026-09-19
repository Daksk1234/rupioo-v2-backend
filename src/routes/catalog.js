import express from "express";
import multer from "multer";
import { CompanyUnit, ProductCategory, CustomerGrade, PriceList, PriceListItem, Product, Unit } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";
import { financialModels } from "../services/accountingService.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import {
  actualProfitPct,
  costBaseOf,
  getMaxActiveGradeDiscount,
  historicalAverageRates,
  priceFromOldDmsLogic,
  purchaseRateOf,
  profitColor,
  recalculateAllProductsForGrades,
  round2,
} from "../services/oldDmsPricingService.js";

const router = express.Router();
router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("dms"))return next();return fail(res,"DMS access required",403);});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});
const upper=v=>cleanText(v).toUpperCase();
const currentFinancialYear=()=>{const now=new Date(),y=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1;return `${y}-${String((y+1)%100).padStart(2,"0")}`;};
const repriceIfGradeChanged=async(resource,tenantKey)=>{if(resource==="grades")await recalculateAllProductsForGrades(tenantKey);};
const cfg={
  units:{Model:CompanyUnit,fields:["code","name","uqc","decimals","status"],required:["code","name"],search:["code","name","uqc"]},
  grades:{Model:CustomerGrade,fields:["code","name","discountPct","description","status"],required:["code","name"],search:["code","name","description"]},
  "price-lists":{Model:PriceList,fields:["code","name","gradeCode","defaultDiscountPct","status"],required:["code","name"],search:["code","name","gradeCode"]}
};

router.get("/master-units",async(_req,res)=>ok(res,await Unit.find({status:"ACTIVE"}).sort({name:1}).lean()));

router.post("/units/import-master",async(req,res)=>{
  const source=await Unit.find({status:"ACTIVE"}).lean();
  if(!source.length)return fail(res,"No MASTER units found",400);
  const ops=source.map(u=>({updateOne:{filter:{tenantKey:req.auth.tenantKey,code:u.code},update:{$setOnInsert:{tenantKey:req.auth.tenantKey,code:u.code,name:u.name,uqc:u.uqc,decimals:u.decimals,status:"ACTIVE"}},upsert:true}}));
  const r=await CompanyUnit.bulkWrite(ops,{ordered:false});
  ok(res,{inserted:r.upsertedCount||0},"MASTER units copied into company units");
});

for(const [resource,c] of Object.entries(cfg)){
  router.get(`/${resource}`,async(req,res)=>{
    const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q);
    const f={tenantKey:req.auth.tenantKey};if(req.query.status)f.status=upper(req.query.status);
    if(q)f.$or=c.search.map(k=>({[k]:new RegExp(q,"i")}));
    const[items,total]=await Promise.all([c.Model.find(f).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),c.Model.countDocuments(f)]);
    ok(res,{items,meta:pageMeta(page,limit,total)});
  });
  router.post(`/${resource}`,async(req,res)=>{
    const body={tenantKey:req.auth.tenantKey};for(const k of c.fields)if(req.body[k]!==undefined)body[k]=req.body[k];
    if(body.code)body.code=upper(body.code);if(body.gradeCode)body.gradeCode=upper(body.gradeCode);if(body.status)body.status=upper(body.status);
    if(body.discountPct!==undefined)body.discountPct=Number(body.discountPct||0);if(body.defaultDiscountPct!==undefined)body.defaultDiscountPct=Number(body.defaultDiscountPct||0);if(body.decimals!==undefined)body.decimals=Number(body.decimals||0);
    for(const k of c.required)if(!cleanText(body[k]))return fail(res,`${k} is required`,400);
    try{const doc=await c.Model.create(body);await repriceIfGradeChanged(resource,req.auth.tenantKey);ok(res,doc,`${resource} created`,201)}catch(e){if(e?.code===11000)return fail(res,"Duplicate code",409);return fail(res,e.message,400)}
  });
  router.put(`/${resource}/:id`,async(req,res)=>{
    const changes={};for(const k of c.fields)if(req.body[k]!==undefined)changes[k]=req.body[k];if(changes.code)changes.code=upper(changes.code);if(changes.gradeCode)changes.gradeCode=upper(changes.gradeCode);if(changes.status)changes.status=upper(changes.status);
    const doc=await c.Model.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},changes,{new:true,runValidators:true});if(!doc)return fail(res,"Record not found",404);await repriceIfGradeChanged(resource,req.auth.tenantKey);ok(res,doc,"Updated");
  });
  router.delete(`/${resource}/:id`,async(req,res)=>{const doc=await c.Model.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{status:"INACTIVE"},{new:true});if(!doc)return fail(res,"Record not found",404);await repriceIfGradeChanged(resource,req.auth.tenantKey);ok(res,doc,"Deactivated");});
  router.post(`/${resource}/bulk-upload`,upload.single("file"),async(req,res)=>{
    if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);let rows;try{rows=readRows(req.file.buffer)}catch{return fail(res,"Unable to read file",400)}if(!rows.length)return fail(res,"No rows found",400);
    const fields=c.fields.map(k=>({key:k,label:k,required:c.required.includes(k),type:["discountPct","defaultDiscountPct","decimals"].includes(k)?"number":undefined}));
    const cols=resolveColumns(rows[0],fields);const missing=fields.filter(f=>f.required&&!cols[f.key]).map(f=>f.key);if(missing.length)return fail(res,`Missing column(s): ${missing.join(", ")}`,400);
    const errors=[],ops=[];rows.forEach((raw,i)=>{const row={tenantKey:req.auth.tenantKey};for(const f of fields){const v=valueFor(raw,cols[f.key],f.type);if(v!==undefined&&v!=="")row[f.key]=v;}if(row.code)row.code=upper(row.code);if(row.gradeCode)row.gradeCode=upper(row.gradeCode);row.status=upper(row.status||"ACTIVE");if(c.required.some(k=>!cleanText(row[k]))){if(errors.length<100)errors.push({row:i+2,error:"Required value missing"});return;}ops.push({updateOne:{filter:{tenantKey:req.auth.tenantKey,code:row.code},update:{$set:row},upsert:true}})});
    if(!ops.length)return fail(res,"No valid rows",400,{errors});const r=await c.Model.bulkWrite(ops,{ordered:false});await repriceIfGradeChanged(resource,req.auth.tenantKey);ok(res,{received:rows.length,valid:ops.length,inserted:r.upsertedCount||0,updated:r.modifiedCount||0,invalid:rows.length-ops.length,errors},"Bulk upload completed");
  });
  router.post(`/${resource}/bulk-edit`,async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean),changes=req.body.changes||{};if(!ids.length)return fail(res,"Select records",400);const safe={};for(const k of c.fields)if(changes[k]!==undefined&&changes[k]!=="")safe[k]=changes[k];if(!Object.keys(safe).length)return fail(res,"Enter values to change",400);const r=await c.Model.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:safe});await repriceIfGradeChanged(resource,req.auth.tenantKey);ok(res,{updated:r.modifiedCount},`${r.modifiedCount} updated`)});
  router.post(`/${resource}/bulk-delete`,async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select records",400);const r=await c.Model.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:{status:"INACTIVE"}});await repriceIfGradeChanged(resource,req.auth.tenantKey);ok(res,{deleted:r.modifiedCount,soft:true},`${r.modifiedCount} deactivated`)});
}

router.get("/categories",async(req,res)=>{const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q);const f={tenantKey:req.auth.tenantKey};if(q)f.$or=[{code:new RegExp(q,"i")},{name:new RegExp(q,"i")},{"subcategories.name":new RegExp(q,"i")}];const[items,total]=await Promise.all([ProductCategory.find(f).sort({name:1}).skip((page-1)*limit).limit(limit).lean(),ProductCategory.countDocuments(f)]);ok(res,{items,meta:pageMeta(page,limit,total)})});
router.post("/categories",async(req,res)=>{try{const doc=await ProductCategory.create({tenantKey:req.auth.tenantKey,code:upper(req.body.code),name:cleanText(req.body.name),subcategories:Array.isArray(req.body.subcategories)?req.body.subcategories:[],status:upper(req.body.status||"ACTIVE")});ok(res,doc,"Category created",201)}catch(e){if(e?.code===11000)return fail(res,"Category code already exists",409);fail(res,e.message,400)}});
router.put("/categories/:id",async(req,res)=>{const doc=await ProductCategory.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{...req.body,code:upper(req.body.code),status:upper(req.body.status||"ACTIVE")},{new:true,runValidators:true});if(!doc)return fail(res,"Category not found",404);ok(res,doc,"Category updated")});
router.delete("/categories/:id",async(req,res)=>{const doc=await ProductCategory.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{status:"INACTIVE"},{new:true});if(!doc)return fail(res,"Category not found",404);ok(res,doc,"Category deactivated")});
router.post("/categories/bulk-upload",upload.single("file"),async(req,res)=>{if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);let rows;try{rows=readRows(req.file.buffer)}catch{return fail(res,"Unable to read file",400)}if(!rows.length)return fail(res,"No rows found",400);const fields=[{key:"code",label:"Code",required:true},{key:"name",label:"Category",aliases:["category name"],required:true},{key:"subcategories",label:"Sub Categories",aliases:["subcategory","sub category"]},{key:"status",label:"Status"}],cols=resolveColumns(rows[0],fields),errors=[],ops=[];rows.forEach((raw,i)=>{const code=upper(valueFor(raw,cols.code)),name=cleanText(valueFor(raw,cols.name));if(!code||!name){if(errors.length<100)errors.push({row:i+2,error:"Code and Category are required"});return;}const subs=cleanText(valueFor(raw,cols.subcategories)).split(/[,;|]/).map(x=>x.trim()).filter(Boolean).map((x,j)=>({code:`${code}-${j+1}`,name:x,status:"ACTIVE"}));ops.push({updateOne:{filter:{tenantKey:req.auth.tenantKey,code},update:{$set:{tenantKey:req.auth.tenantKey,code,name,subcategories:subs,status:upper(valueFor(raw,cols.status)||"ACTIVE")}},upsert:true}})});if(!ops.length)return fail(res,"No valid category rows",400,{errors});const r=await ProductCategory.bulkWrite(ops,{ordered:false});ok(res,{received:rows.length,valid:ops.length,inserted:r.upsertedCount||0,updated:r.modifiedCount||0,invalid:rows.length-ops.length,errors},"Category bulk upload completed")});
router.post("/categories/bulk-edit",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean),raw=req.body.changes||{},changes={};for(const k of ["name","status"])if(raw[k]!==undefined&&raw[k]!=="")changes[k]=k==="status"?upper(raw[k]):raw[k];if(raw.subcategories!==undefined&&raw.subcategories!=="")changes.subcategories=String(raw.subcategories).split(/[,;|]/).map((x,j)=>({code:`SUB-${j+1}`,name:x.trim(),status:"ACTIVE"})).filter(x=>x.name);if(!ids.length)return fail(res,"Select categories",400);if(!Object.keys(changes).length)return fail(res,"Enter changes",400);const r=await ProductCategory.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:changes});ok(res,{updated:r.modifiedCount},`${r.modifiedCount} categories updated`)});
router.post("/categories/bulk-delete",async(req,res)=>{const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select categories",400);const r=await ProductCategory.updateMany({_id:{$in:ids},tenantKey:req.auth.tenantKey},{$set:{status:"INACTIVE"}});ok(res,{deleted:r.modifiedCount,soft:true},`${r.modifiedCount} categories deactivated`)});


/* -------------------------------------------------------------------------- */
/* OLD-DMS PRICE LIST LOGIC                                                    */
/* Product master itself is the price list. Highest active customer grade      */
/* discount builds the MRP; a customer's own grade reverses that loading.      */
/* -------------------------------------------------------------------------- */
router.get("/old-dms-price-list/products", async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(200, Math.max(10, Number(req.query.limit || 50)));
  const q = cleanText(req.query.q);
  const financialYear = cleanText(req.query.financialYear) || currentFinancialYear();
  const filter = { tenantKey: req.auth.tenantKey, status: "ACTIVE" };
  if (q) filter.$or = [
    { sku: new RegExp(q, "i") },
    { name: new RegExp(q, "i") },
    { category: new RegExp(q, "i") },
    { subCategory: new RegExp(q, "i") },
    { hsnCode: new RegExp(q, "i") },
  ];

  const [maxDiscount, products, total] = await Promise.all([
    getMaxActiveGradeDiscount(req.auth.tenantKey),
    Product.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  const packingCodes = Array.from(new Set(products.map((product) => upper(product.packingUnit)).filter(Boolean)));
  const companyUnits = packingCodes.length
    ? await CompanyUnit.find({ tenantKey: req.auth.tenantKey, code: { $in: packingCodes } }).select("code name").lean()
    : [];
  const packingUnitNames = new Map(companyUnits.map((unit) => [upper(unit.code), cleanText(unit.name) || unit.code]));
  const missingPackingCodes = packingCodes.filter((code) => !packingUnitNames.has(code));
  if (missingPackingCodes.length) {
    const masterUnits = await Unit.find({ code: { $in: missingPackingCodes } }).select("code name").lean();
    for (const unit of masterUnits) packingUnitNames.set(upper(unit.code), cleanText(unit.name) || unit.code);
  }

  let history = { sales: new Map(), purchases: new Map() };
  try {
    history = await historicalAverageRates({
      tenantKey: req.auth.tenantKey,
      financialYear,
      productIds: products.map((product) => String(product._id)),
    });
  } catch (error) {
    console.error("price list average-rate lookup failed:", error?.message || error);
  }

  const items = products.map((product) => {
    const id = String(product._id);
    const saleHistory = history.sales.get(id);
    const purchaseHistory = history.purchases.get(id);
    const averageSaleRate = Number(saleHistory?.averageRate || 0);
    const averagePurchaseRate = Number(purchaseHistory?.averageRate || 0);
    const fallbackPurchase = purchaseRateOf(product);
    const saleRate = averageSaleRate > 0 ? averageSaleRate : Number(product.salePrice || 0);
    const purchaseRate = averagePurchaseRate > 0 ? averagePurchaseRate : fallbackPurchase;
    const automaticProfit = purchaseRate > 0 && saleRate > 0
      ? actualProfitPct({ cost: purchaseRate, saleRate })
      : 0;
    const priced = priceFromOldDmsLogic(
      product,
      maxDiscount,
      {
        costOverride: purchaseRate,
        saleRateOverride: saleRate,
        profitOverride: automaticProfit,
      },
    );

    return {
      ...product,
      packingUnitName: product.packingUnit ? packingUnitNames.get(upper(product.packingUnit)) || product.packingUnit : "",
      purchaseRate,
      priceCostBase: purchaseRate,
      averagePurchaseRate: round2(purchaseRate),
      averageSaleRate: round2(saleRate),
      purchaseObservations: Number(purchaseHistory?.observations || 0),
      saleObservations: Number(saleHistory?.observations || 0),
      profitPercentage: round2(automaticProfit),
      salePrice: round2(saleRate),
      maxGradeDiscountPct: priced.maxGradeDiscountPct,
      gradeLoading: priced.gradeLoading,
      gstRate: priced.gstRate,
      mrp: priced.mrp,
      lossStatus: saleRate > 0 && purchaseRate > 0 && saleRate < purchaseRate,
      belowMinimum: saleRate > 0 && purchaseRate > 0 && saleRate < round2(purchaseRate * 1.03),
      profitColorCode: profitColor(automaticProfit),
      pricingSource: averageSaleRate > 0 || averagePurchaseRate > 0 ? "HISTORICAL_AVERAGE" : "PRODUCT_MASTER",
    };
  });

  const admin = isAdminAuth(req.auth);
  const safeItems = admin
    ? items
    : items.map(({ profitPercentage, profitColorCode, lossStatus, belowMinimum, ...item }) => item);
  return ok(res, {
    items: safeItems,
    maxDiscount,
    financialYear,
    meta: pageMeta(page, limit, total),
    ...(admin ? {
      formula: "Profit % = (Average Sale Rate - Average Purchase Rate) / Average Purchase Rate × 100",
      averageMethod: "Simple arithmetic mean of posted invoice line rates; each invoice line is one observation.",
    } : {}),
  });
});

router.put("/old-dms-price-list/products", async (req, res) => {
  const rows = Array.isArray(req.body?.Products) ? req.body.Products : [];
  if (!rows.length) return fail(res, "Products are required", 400);
  const maxDiscount = await getMaxActiveGradeDiscount(req.auth.tenantKey);
  const ids = rows.map((row) => row?.id).filter(Boolean);
  const products = await Product.find({ tenantKey: req.auth.tenantKey, _id: { $in: ids } }).lean();
  const map = new Map(products.map((p) => [String(p._id), p]));
  const ops = [];

  for (const row of rows) {
    const product = map.get(String(row?.id || ""));
    if (!product) continue;
    const cost = costBaseOf(product);
    let profitPercentage = Number(row.profitPercentage);
    let saleRate = Number(row.salePrice ?? row.SalesRate);

    if (row.changedField === "salePrice" && Number.isFinite(saleRate) && saleRate > 0) {
      const minimum = round2(cost * 1.03);
      if (cost > 0 && saleRate < minimum) {
        return fail(res, `${product.name}: Sales Rate cannot be below cost + 3% (minimum ${minimum})`, 400);
      }
      profitPercentage = Math.max(3, actualProfitPct({ cost, saleRate }));
    } else if (Number.isFinite(profitPercentage) && row.profitPercentage !== "") {
      profitPercentage = Math.max(3, profitPercentage);
      saleRate = round2(cost * (1 + profitPercentage / 100));
    } else if (Number.isFinite(saleRate) && saleRate > 0) {
      const minimum = round2(cost * 1.03);
      if (cost > 0 && saleRate < minimum) {
        return fail(res, `${product.name}: Sales Rate cannot be below cost + 3% (minimum ₹${minimum.toFixed(2)})`, 409);
      }
      profitPercentage = Math.max(3, actualProfitPct({ cost, saleRate }));
    } else {
      profitPercentage = Math.max(3, Number(product.profitPercentage || product.minimumProfitPct || 3));
      saleRate = round2(cost * (1 + profitPercentage / 100));
    }

    const priced = priceFromOldDmsLogic({ ...product, salePrice: saleRate, profitPercentage }, maxDiscount);
    ops.push({
      updateOne: {
        filter: { _id: product._id, tenantKey: req.auth.tenantKey },
        update: { $set: {
          profitPercentage: priced.profitPercentage,
          salePrice: priced.saleRate,
          mrp: priced.mrp,
          maxGradeDiscountPct: priced.maxGradeDiscountPct,
          profitColorCode: profitColor(priced.profitPercentage),
        } },
      },
    });
  }

  if (!ops.length) return fail(res, "No valid products found", 404);
  const result = await Product.bulkWrite(ops, { ordered: false });
  return ok(res, { updated: result.modifiedCount || 0, maxDiscount }, "Product prices updated");
});

router.post("/old-dms-price-list/apply-profit", async (req, res) => {
  const threshold = Math.max(3, Number(req.body?.profitPercentage || 0));
  if (!Number.isFinite(threshold)) return fail(res, "Valid profit percentage is required", 400);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  const filter = { tenantKey: req.auth.tenantKey, status: "ACTIVE" };
  if (ids.length) filter._id = { $in: ids };
  const maxDiscount = await getMaxActiveGradeDiscount(req.auth.tenantKey);
  const products = await Product.find(filter).lean();
  const ops = [];
  for (const product of products) {
    const current = Number(product.profitPercentage || product.minimumProfitPct || 3);
    if (current > threshold) continue;
    const cost = costBaseOf(product);
    const saleRate = round2(cost * (1 + threshold / 100));
    const priced = priceFromOldDmsLogic({ ...product, salePrice: saleRate, profitPercentage: threshold }, maxDiscount);
    ops.push({ updateOne: { filter: { _id: product._id, tenantKey: req.auth.tenantKey }, update: { $set: {
      profitPercentage: priced.profitPercentage, salePrice: priced.saleRate, mrp: priced.mrp,
      maxGradeDiscountPct: priced.maxGradeDiscountPct, profitColorCode: profitColor(priced.profitPercentage),
    } } } });
  }
  if (!ops.length) return ok(res, { updated: 0, maxDiscount }, "No products matched the profit threshold");
  const result = await Product.bulkWrite(ops, { ordered: false });
  return ok(res, { updated: result.modifiedCount || 0, maxDiscount }, "Profit percentage applied");
});

router.post("/old-dms-price-list/recalculate", async (req, res) => {
  const result = await recalculateAllProductsForGrades(req.auth.tenantKey);
  return ok(res, result, "Old-DMS price list recalculated");
});

router.get("/price-lists/:code/products",async(req,res)=>{
  const priceList=await PriceList.findOne({tenantKey:req.auth.tenantKey,code:upper(req.params.code),status:"ACTIVE"}).lean();if(!priceList)return fail(res,"Price list not found",404);
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q),f={tenantKey:req.auth.tenantKey,status:"ACTIVE"};if(q)f.$or=[{sku:new RegExp(q,"i")},{name:new RegExp(q,"i")},{category:new RegExp(q,"i")}];
  const[products,total]=await Promise.all([Product.find(f).sort({name:1}).skip((page-1)*limit).limit(limit).lean(),Product.countDocuments(f)]);const overrides=await PriceListItem.find({tenantKey:req.auth.tenantKey,priceListCode:priceList.code,productId:{$in:products.map(p=>String(p._id))}}).lean();const om=new Map(overrides.map(o=>[o.productId,o]));
  const items=products.map(p=>{const o=om.get(String(p._id));const discount=Number(o?.overrideDiscountPct??priceList.defaultDiscountPct??0);const autoPrice=Math.floor((Number(p.mrp||0)/(1+discount/100))*100)/100;return {...p,priceListCode:priceList.code,gradeCode:priceList.gradeCode,discountPct:discount,price:Number(o?.overridePrice??autoPrice),manualOverride:o?.overridePrice!=null};});
  ok(res,{priceList,items,meta:pageMeta(page,limit,total)});
});
router.put("/price-lists/:code/products/:productId",async(req,res)=>{const code=upper(req.params.code);const doc=await PriceListItem.findOneAndUpdate({tenantKey:req.auth.tenantKey,priceListCode:code,productId:req.params.productId},{$set:{overridePrice:req.body.overridePrice===""?undefined:Number(req.body.overridePrice),overrideDiscountPct:req.body.overrideDiscountPct===""?undefined:Number(req.body.overrideDiscountPct)}},{new:true,upsert:true,setDefaultsOnInsert:true});ok(res,doc,"Price override saved")});

export default router;
