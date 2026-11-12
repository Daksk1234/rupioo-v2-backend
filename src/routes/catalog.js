import express from "express";
import multer from "multer";
import { CompanyUnit, ProductCategory, CustomerGrade, CustomerLink, PriceList, PriceListItem, PriceDiscountRule, Product, Unit } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { readRows, resolveColumns, valueFor, cleanText } from "../utils/bulkSpreadsheet.js";
import { financialModels } from "../services/accountingService.js";
import { isAdminAuth } from "../utils/adminAccess.js";
import {
  actualProfitPct,
  costBaseOf,
  getMaxActiveGradeDiscount,
  gradeBasicFromMrp,
  gradeSaleIncludingGstFromMrp,
  historicalAverageRates,
  mrpBasicExcludingGst,
  priceFromOldDmsLogic,
  purchaseRateOf,
  profitColor,
  recalculateAllProductsForGrades,
  round2,
} from "../services/oldDmsPricingService.js";

import { calculateDynamicPrice } from "../services/dynamicPriceEngine.js";
const router = express.Router();
router.use(requireAuth);
router.use((req,res,next)=>{if(req.auth?.role==="MASTER"||(req.auth?.apps||[]).includes("dms"))return next();return fail(res,"DMS access required",403);});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:30*1024*1024}});
const upper=v=>cleanText(v).toUpperCase();
const currentFinancialYear=()=>{const now=new Date(),y=now.getMonth()>=3?now.getFullYear():now.getFullYear()-1;return `${y}-${String((y+1)%100).padStart(2,"0")}`;};
const syncCustomerGradeDiscounts = async (tenantKey) => {
  const grades = await CustomerGrade.find({ tenantKey })
    .select("code discountPct status")
    .lean();
  if (!grades.length) return;
  await CustomerLink.bulkWrite(
    grades.map((grade) => ({
      updateMany: {
        filter: { tenantKey, gradeCode: upper(grade.code) },
        update: {
          $set: {
            gradeDiscountPct:
              upper(grade.status) === "ACTIVE" ? Number(grade.discountPct || 0) : 0,
          },
        },
      },
    })),
    { ordered: false },
  );
};
const repriceIfGradeChanged=async(resource,tenantKey)=>{
  if(resource==="grades"){
    await syncCustomerGradeDiscounts(tenantKey);
    await recalculateAllProductsForGrades(tenantKey);
  }
};
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


/* Tenant-owned discounts are listed on both Grade Discounts and Price List. */
router.get("/price-discount-rules", async (req,res) => {
  const items = await PriceDiscountRule.find({tenantKey:req.auth.tenantKey}).sort({mode:1,defaultPct:1,code:1}).lean();
  return ok(res,{items});
});
router.post("/price-discount-rules", async (req,res) => {
  if (!isAdminAuth(req.auth)) return fail(res,"Superadmin access required",403);
  const code=upper(req.body?.code).replace(/[^A-Z0-9_-]/g,"").slice(0,32);
  const name=cleanText(req.body?.name).slice(0,90);
  const mode=upper(req.body?.mode||"VARIABLE");
  const defaultPct=Number(req.body?.defaultPct ?? 0);
  if (!code || !name || !["FIXED","VARIABLE"].includes(mode) || !Number.isFinite(defaultPct) || defaultPct<0 || defaultPct>=100) return fail(res,"Valid code, name, FIXED/VARIABLE and discount 0–99.99% are required",400);
  try { const result=await PriceDiscountRule.create({tenantKey:req.auth.tenantKey,code,name,mode,defaultPct}); return ok(res,result,"Discount created",201); }
  catch(e){return fail(res,e?.code===11000?"Discount code already exists":e.message,400);}
});
router.put("/price-discount-rules/:id",async(req,res)=>{
  if (!isAdminAuth(req.auth)) return fail(res,"Superadmin access required",403);
  const changes={};
  if(req.body.name!==undefined)changes.name=cleanText(req.body.name).slice(0,90);
  if(req.body.defaultPct!==undefined){const pct=Number(req.body.defaultPct);if(!Number.isFinite(pct)||pct<0||pct>=100)return fail(res,"Discount must be below 100%",400);changes.defaultPct=pct;}
  if(req.body.mode!==undefined){const mode=upper(req.body.mode);if(!["FIXED","VARIABLE"].includes(mode))return fail(res,"Invalid discount mode",400);changes.mode=mode;}
  if(req.body.status!==undefined){if(!["ACTIVE","INACTIVE"].includes(upper(req.body.status)))return fail(res,"Invalid status",400);changes.status=upper(req.body.status);}
  const result=await PriceDiscountRule.findOneAndUpdate({_id:req.params.id,tenantKey:req.auth.tenantKey},{$set:changes},{new:true,runValidators:true});
  if(!result)return fail(res,"Discount not found",404);
  return ok(res,result,"Discount updated");
});

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

  const [maxDiscount, products, total, activeGrades, discountRules] = await Promise.all([
    getMaxActiveGradeDiscount(req.auth.tenantKey),
    Product.find(filter).sort({ name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
    CustomerGrade.find({ tenantKey: req.auth.tenantKey, status: "ACTIVE" })
      .sort({ discountPct: 1, code: 1 })
      .select("code name discountPct")
      .lean(),
    PriceDiscountRule.find({tenantKey:req.auth.tenantKey,status:"ACTIVE"}).sort({mode:1,defaultPct:1,code:1}).lean(),
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

    // MARKET SALE PRICE:
    // Simple arithmetic mean of this product's effective selling rate across
    // posted Sales Invoice lines in the selected financial year.
    const marketSalePrice = Number(saleHistory?.averageRate || 0);

    // Keep the existing Average Purchase value exactly as before. It remains a
    // separate Price List column and is not used as Market Sale Price.
    const averagePurchaseRate = Number(purchaseHistory?.averageRate || 0);
    const fallbackPurchase = purchaseRateOf(product);
    const purchaseRate = averagePurchaseRate > 0 ? averagePurchaseRate : fallbackPurchase;

    // LANDED PRICE is the basis for automatic profit calculation. Use the
    // product's stored landedCost first. Older products that do not yet have a
    // landedCost fall back to the existing purchase-rate value.
    const landedPrice = Number(product.landedCost || 0) > 0
      ? Number(product.landedCost)
      : Number(purchaseRate || 0);

    // PROFIT %:
    // ((Market Sale Price - Landed Price) / Landed Price) * 100
    // Minimum allowed automatic profit = 3%.
    // Keep the exact percentage for pricing and truncate only the displayed
    // percentage to 2 decimals so 1400 vs 1200 displays as 16.66%.
    const rawMarketProfitPct = landedPrice > 0 && marketSalePrice > 0
      ? ((marketSalePrice - landedPrice) / landedPrice) * 100
      : 3;
    const exactProfitPercentage = Math.max(3, rawMarketProfitPct);
    const profitPercentage = Math.floor((exactProfitPercentage + Number.EPSILON) * 100) / 100;

    // MINIMUM SALE PRICE:
    // Landed Price + the automatically calculated profit percentage.
    // Use the exact (unrounded) percentage internally so the example
    // Market=1400 and Landed=1200 produces exactly 1400.00.
    const minimumSalePrice = landedPrice > 0
      ? round2(landedPrice * (1 + exactProfitPercentage / 100))
      : 0;

    const actualProfit = landedPrice > 0 && minimumSalePrice > 0
      ? actualProfitPct({ cost: landedPrice, saleRate: minimumSalePrice })
      : 0;

    // Existing MRP / grade logic remains unchanged; Minimum Sale Price now
    // becomes its sale-rate input.
    const priced = priceFromOldDmsLogic(
      { ...product, salePrice: minimumSalePrice, profitPercentage: exactProfitPercentage },
      maxDiscount,
      {
        costOverride: landedPrice,
        saleRateOverride: minimumSalePrice,
        profitOverride: exactProfitPercentage,
      },
    );

    const settings = product.priceListSettings?.enabled ? product.priceListSettings : null;
    let manualPrice = null;
    if (settings) {
      const selectedGrade=activeGrades.find(g=>upper(g.code)===upper(settings.targetGradeCode)) || activeGrades.reduce((best,g)=>!best || g.discountPct>best.discountPct?g:best,null);
      try {
        manualPrice=calculateDynamicPrice({
          mode:settings.mode, salePrice:settings.salePrice ?? product.salePrice,
          mrp:settings.mrp ?? product.mrp,
          gstRate:product.gstRate,
          gradePct:selectedGrade?.discountPct||0,
          rules:discountRules,overrides:settings.discountOverrides||{},pricingStyle:settings.pricingStyle||"LEGACY",
        });
      } catch(e) { console.error("Price List manual price invalid",String(product._id),e.message); }
    }
    return {
      ...product,
      priceListSettings:settings,
      ...(manualPrice ? {
        mrp:manualPrice.mrp, mrpBasicExGst:manualPrice.mrpExGst,
        calculatedSalePrice:manualPrice.salePrice, saleIncludingGst:manualPrice.saleIncludingGst,
        discountSteps:manualPrice.discountSteps,
      } : {}),
      packingUnitName: product.packingUnit ? packingUnitNames.get(upper(product.packingUnit)) || product.packingUnit : "",

      // Existing fields retained for backward compatibility.
      purchaseRate,
      priceCostBase: landedPrice,
      averagePurchaseRate: round2(purchaseRate),
      averageSaleRate: round2(marketSalePrice),
      saleRateIncludingProfit: round2(minimumSalePrice),

      // New names used by the Price List page.
      landedPrice: round2(landedPrice),
      marketSalePrice: round2(marketSalePrice),
      minimumSalePrice: settings?.minimumSalePrice ?? round2(minimumSalePrice),

      purchaseObservations: Number(purchaseHistory?.observations || 0),
      saleObservations: Number(saleHistory?.observations || 0),
      profitPercentage: round2(profitPercentage),
      actualProfitPercentage: round2(actualProfit),

      // Keep salePrice aligned with the new Minimum Sale Price for consumers of
      // this Price List endpoint. MRP remains the authoritative grade-price base.
      salePrice: round2(minimumSalePrice),

      maxGradeDiscountPct: priced.maxGradeDiscountPct,
      gradeLoading: priced.gradeLoading,
      gstRate: priced.gstRate,
      mrp: manualPrice?.mrp ?? priced.mrp,
      mrpBasicExGst: manualPrice?.mrpExGst ?? mrpBasicExcludingGst(priced.mrp, priced.gstRate),
      gradePrices: activeGrades.map((grade) => ({
        code: grade.code,
        name: grade.name,
        discountPct: Number(grade.discountPct || 0),
        basicRate: manualPrice
          ? calculateDynamicPrice({mode:"MRP_TO_SALE",mrp:manualPrice.mrp,gstRate:product.gstRate,gradePct:grade.discountPct,rules:discountRules,overrides:settings.discountOverrides||{},pricingStyle:settings.pricingStyle||"LEGACY"}).salePrice
          : gradeBasicFromMrp(priced.mrp, priced.gstRate, grade.discountPct),
        saleIncludingGst: manualPrice
          ? calculateDynamicPrice({mode:"MRP_TO_SALE",mrp:manualPrice.mrp,gstRate:product.gstRate,gradePct:grade.discountPct,rules:discountRules,overrides:settings.discountOverrides||{},pricingStyle:settings.pricingStyle||"LEGACY"}).saleIncludingGst
          : gradeSaleIncludingGstFromMrp(priced.mrp, grade.discountPct),
      })),
      lossStatus: minimumSalePrice > 0 && landedPrice > 0 && minimumSalePrice < landedPrice,
      belowMinimum: profitPercentage < 3,
      profitColorCode: profitColor(profitPercentage),
      pricingSource: marketSalePrice > 0 ? "SALES_INVOICE_AVERAGE" : "PRODUCT_MASTER",
    };
  });

  const admin = isAdminAuth(req.auth);
  const safeItems = admin
    ? items
    : items.map(({ actualProfitPercentage, profitColorCode, lossStatus, belowMinimum, ...item }) => item);
  return ok(res, {
    items: safeItems,
    maxDiscount,
    discountRules: discountRules.map(({code,name,mode,defaultPct,status})=>({code,name,mode,defaultPct,status})),
    grades: activeGrades.map((grade) => ({
      code: grade.code,
      name: grade.name,
      discountPct: Number(grade.discountPct || 0),
    })),
    financialYear,
    meta: pageMeta(page, limit, total),
    ...(admin ? {
      formula: "Profit % = max(3%, ((Market Sale Price - Landed Price) ÷ Landed Price) × 100). Minimum Sale Price = Landed Price × (1 + Profit %). MRP is reverse-loaded for the highest active grade and customer grade pricing continues from MRP.",
      averageMethod: "Market Sale Price is the simple arithmetic mean of posted Sales Invoice line effective rates for the selected FY. Average Purchase remains the simple arithmetic mean of posted Purchase Invoice line effective rates.",
    } : {}),
  });
});

router.put("/old-dms-price-list/products/:id/manual",async(req,res)=>{
  if(!isAdminAuth(req.auth))return fail(res,"Superadmin access required to edit the Price List",403);
  const product=await Product.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,status:"ACTIVE"});
  if(!product)return fail(res,"Product not found",404);
  const body=req.body||{};
  const mode=upper(body.mode||"SALE_TO_MRP");
  if(!["SALE_TO_MRP","MRP_TO_SALE"].includes(mode))return fail(res,"Choose a valid pricing direction",400);
  const gstRate=Number(body.gstRate??product.gstRate??0);
  const salePrice=Number(mode === "SALE_TO_MRP" ? (body.minimumSalePrice ?? body.salePrice ?? product.salePrice ?? 0) : (body.salePrice ?? product.salePrice ?? 0));
  const mrp=Number(body.mrp ?? product.mrp ?? 0);
  const landedCost=Number(body.landedCost??product.landedCost??0);
  const manualMin=Number(body.minimumSalePrice??0);
  if(![gstRate,salePrice,mrp,landedCost,manualMin].every(n=>Number.isFinite(n)&&n>=0))return fail(res,"Prices and GST must be valid non-negative numbers",400);
  if(!Number.isFinite(gstRate)||gstRate>100)return fail(res,"GST must be 0–100%",400);
  const [grades,rules]=await Promise.all([
    CustomerGrade.find({tenantKey:req.auth.tenantKey,status:"ACTIVE"}).lean(),
    PriceDiscountRule.find({tenantKey:req.auth.tenantKey,status:"ACTIVE"}).lean(),
  ]);
  const selected=grades.find(g=>upper(g.code)===upper(body.targetGradeCode))||grades.reduce((max,g)=>!max||g.discountPct>max.discountPct?g:max,null);
  const discountOverrides={};
  for(const rule of rules){const value=body.discountOverrides?.[rule.code];if(value===undefined)continue;
    const number=Number(value.percent??rule.defaultPct);
    if(!Number.isFinite(number)||number<0||number>=100)return fail(res,`Invalid discount for ${rule.code}`,400);
    discountOverrides[rule.code]={percent:number,enabled:rule.mode==="FIXED"?true:value.enabled!==false};
  }
  let result;
  try{result=calculateDynamicPrice({mode,salePrice,mrp,gstRate,gradePct:selected?.discountPct||0,rules,overrides:discountOverrides,pricingStyle:"ADDITIVE_V2"});}
  catch(e){return fail(res,e.message,400);}
  if(result.salePrice===0&&result.mrp===0)return fail(res,"Enter a sale price or MRP greater than zero",400);
  product.gstRate=gstRate;
  product.landedCost=landedCost;
  product.mrp=result.mrp;
  product.salePrice=result.salePrice;
  if(body.name!==undefined){const name=cleanText(body.name);if(!name)return fail(res,"Product name required",400);product.name=name;}
  if(body.sku!==undefined){const sku=cleanText(body.sku);if(!sku)return fail(res,"SKU required",400);product.sku=sku;}
  product.priceListSettings={enabled:true,mode,pricingStyle:"ADDITIVE_V2", salePrice:result.salePrice,mrp:result.mrp,
    targetGradeCode:selected?.code||"",discountOverrides,
    minimumSalePrice:result.salePrice,updatedBy:String(req.auth.sub||""),updatedAt:new Date()};
  try{await product.save();}catch(e){return fail(res,e?.code===11000?"SKU already exists":e.message,400);}
  return ok(res,{id:product._id,price:result},"Price List updated");
});

router.put("/old-dms-price-list/products", async (req, res) => {
  const rows = Array.isArray(req.body?.Products) ? req.body.Products : [];
  if (!rows.length) return fail(res, "Products are required", 400);
  const maxDiscount = await getMaxActiveGradeDiscount(req.auth.tenantKey);
  const financialYear = cleanText(req.body?.financialYear) || currentFinancialYear();
  const ids = rows.map((row) => row?.id).filter(Boolean);
  const products = await Product.find({ tenantKey: req.auth.tenantKey, _id: { $in: ids } }).lean();
  const map = new Map(products.map((p) => [String(p._id), p]));
  let purchaseHistory = new Map();
  let saleHistory = new Map();
  try {
    const history = await historicalAverageRates({
      tenantKey: req.auth.tenantKey,
      financialYear,
      productIds: products.map((product) => String(product._id)),
    });
    purchaseHistory = history.purchases;
    saleHistory = history.sales;
  } catch (error) {
    console.error("price list profit update average-rate lookup failed:", error?.message || error);
  }
  const ops = [];

  for (const row of rows) {
    const product = map.get(String(row?.id || ""));
    if (!product) continue;
    const historicalPurchase = Number(purchaseHistory.get(String(product._id))?.averageRate || 0);
    const historicalSale = Number(saleHistory.get(String(product._id))?.averageRate || 0);
    const cost = historicalPurchase > 0 ? historicalPurchase : costBaseOf(product);
    let profitPercentage = Number(row.profitPercentage);
    let baseSaleRate = Number(row.salePrice ?? row.SalesRate);
    let updateBaseSaleRate = false;

    if (row.changedField === "salePrice" && Number.isFinite(baseSaleRate) && baseSaleRate > 0) {
      updateBaseSaleRate = true;
      profitPercentage = Math.max(3, Number(product.profitPercentage || product.minimumProfitPct || 3));
    } else {
      // Profit % edits never replace the base Sale Rate.
      // Prefer the selected FY historical Sale Rate; otherwise use Product.salePrice.
      baseSaleRate = historicalSale > 0 ? historicalSale : Number(product.salePrice || 0);
      profitPercentage = Number.isFinite(profitPercentage) && row.profitPercentage !== ""
        ? Math.max(3, profitPercentage)
        : Math.max(3, Number(product.profitPercentage || product.minimumProfitPct || 3));
    }

    const saleRateIncludingProfit = baseSaleRate > 0
      ? round2(baseSaleRate + (baseSaleRate * profitPercentage / 100))
      : 0;

    const priced = priceFromOldDmsLogic(
      { ...product, salePrice: saleRateIncludingProfit, profitPercentage },
      maxDiscount,
      { costOverride: cost, saleRateOverride: saleRateIncludingProfit, profitOverride: profitPercentage },
    );
    const setValues = {
      profitPercentage: priced.profitPercentage,
      mrp: priced.mrp,
      maxGradeDiscountPct: priced.maxGradeDiscountPct,
      profitColorCode: profitColor(priced.profitPercentage),
    };
    if (updateBaseSaleRate) setValues.salePrice = round2(baseSaleRate);
    ops.push({
      updateOne: {
        filter: { _id: product._id, tenantKey: req.auth.tenantKey },
        update: { $set: setValues },
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
    const baseSaleRate = Number(product.salePrice || 0);
    const saleRateIncludingProfit = baseSaleRate > 0
      ? round2(baseSaleRate + (baseSaleRate * threshold / 100))
      : 0;
    const priced = priceFromOldDmsLogic(
      { ...product, salePrice: saleRateIncludingProfit, profitPercentage: threshold },
      maxDiscount,
      { costOverride: cost, saleRateOverride: saleRateIncludingProfit, profitOverride: threshold },
    );
    ops.push({ updateOne: { filter: { _id: product._id, tenantKey: req.auth.tenantKey }, update: { $set: {
      profitPercentage: priced.profitPercentage, mrp: priced.mrp,
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
  const items=products.map(p=>{
    const o=om.get(String(p._id));
    const discount=Number(o?.overrideDiscountPct??priceList.defaultDiscountPct??0);
    const autoPrice=gradeBasicFromMrp(Number(p.mrp||0),Number(p.gstRate||0),discount);
    return {...p,priceListCode:priceList.code,gradeCode:priceList.gradeCode,discountPct:discount,price:Number(o?.overridePrice??autoPrice),manualOverride:o?.overridePrice!=null};
  });
  ok(res,{priceList,items,meta:pageMeta(page,limit,total)});
});
router.put("/price-lists/:code/products/:productId",async(req,res)=>{const code=upper(req.params.code);const doc=await PriceListItem.findOneAndUpdate({tenantKey:req.auth.tenantKey,priceListCode:code,productId:req.params.productId},{$set:{overridePrice:req.body.overridePrice===""?undefined:Number(req.body.overridePrice),overrideDiscountPct:req.body.overrideDiscountPct===""?undefined:Number(req.body.overrideDiscountPct)}},{new:true,upsert:true,setDefaultsOnInsert:true});ok(res,doc,"Price override saved")});

export default router;
