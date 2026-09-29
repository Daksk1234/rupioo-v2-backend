import express from "express";
import { Product, CustomerLink, CompanyProfile, GenericRecord } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { financialModels, postBalancedEntries, reversePostedTransaction } from "../services/accountingService.js";
import { financialYearFromDate, resolveFinancialYear, transactionDate } from "../utils/financialYear.js";
import { buildDocumentNotePdf } from "../services/documentNotePdfService.js";
import { allocateDocumentNoteNumber, nextDocumentNoteNumber } from "../services/documentNumberService.js";
import { isCreditNoteStockReason, syncSalesInvoiceCreditState, validateCreditNoteAgainstInvoice } from "../services/creditNoteRulesService.js";

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.auth?.role === "MASTER" || (req.auth?.apps || []).includes("dms")) return next();
  return fail(res, "DMS access required", 403);
});

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const round2 = (v) => Number(num(v).toFixed(2));

const CONFIG = {
  CREDIT_NOTE: { path: "credit-notes", prefix: "CN", label: "Credit Note" },
  DEBIT_NOTE: { path: "debit-notes", prefix: "DN", label: "Debit Note" },
  DELIVERY_NOTE: { path: "delivery-notes", prefix: "DLN", label: "Delivery Note" },
};

function documentFilter(type) {
  return type === "CREDIT_NOTE"
    ? { $or: [{ documentType: "CREDIT_NOTE" }, { documentType: { $exists: false } }] }
    : { documentType: type };
}

function partyAccountCode(party) {
  const configured = clean(party?.accountingProfile?.systemAccountCode);
  if (configured) return configured;
  return ["CREDITOR", "SUPPLIER"].includes(upper(party?.partyType)) ? "SYS_SUNDRY_CREDITORS" : "SYS_SUNDRY_DEBTORS";
}

function partyAddress(party = {}) {
  const addresses = Array.isArray(party.addresses) ? party.addresses : [];
  const billing = addresses.find((x) => upper(x?.type || "BILLING") === "BILLING") || addresses[0] || {};
  return clean(billing.address || party.ownerAddress || "");
}

function partyState(party = {}) {
  const addresses = Array.isArray(party.addresses) ? party.addresses : [];
  const billing = addresses.find((x) => upper(x?.type || "BILLING") === "BILLING") || addresses[0] || {};
  return upper(billing.state || party.state || "");
}

function partyGstin(party = {}) {
  const candidate = upper(party.gstin || party.gstNumber || party.displayIdentifier || "");
  return candidate.length === 15 ? candidate : "";
}

function validateDocumentType(type) {
  if (!CONFIG[type]) throw Object.assign(new Error("Unsupported document type"), { statusCode: 400 });
}

async function normalizeDocument({ auth, body, type }) {
  validateDocumentType(type);
  const tenantKey = auth.tenantKey;
  const date = transactionDate(body.date);
  const financialYear = financialYearFromDate(body.date) || financialYearFromDate(date) || await resolveFinancialYear({ tenantKey, requested: body.financialYear });
  const partyGlobalId = clean(body.partyGlobalId || body.customerGlobalId || body.supplierGlobalId);
  if (!partyGlobalId) throw Object.assign(new Error(type === "DELIVERY_NOTE" ? "Select job worker / consignee" : "Select party"), { statusCode: 400 });
  const party = await CustomerLink.findOne({ tenantKey, globalCustomerId: partyGlobalId, status: "ACTIVE" }).lean();
  if (!party) throw Object.assign(new Error("Active party not found"), { statusCode: 404 });

  let referenceInvoice = null;
  const referenceDocumentId = clean(body.referenceDocumentId);
  if (referenceDocumentId && type !== "DELIVERY_NOTE") {
    const referenceModels = financialModels(tenantKey, financialYear);
    if (type === "CREDIT_NOTE") {
      referenceInvoice = await referenceModels.SalesInvoice.findOne({
        _id: referenceDocumentId, tenantKey, financialYear, customerGlobalId: partyGlobalId, status: { $nin: ["DELETED", "CANCELLED"] },
      }).lean();
    } else if (type === "DEBIT_NOTE") {
      referenceInvoice = await referenceModels.PurchaseInvoice.findOne({
        _id: referenceDocumentId, tenantKey, financialYear, supplierGlobalId: partyGlobalId, status: { $ne: "DELETED" },
      }).lean();
    }
    if (!referenceInvoice) {
      throw Object.assign(new Error(`${CONFIG[type].label} reference invoice does not belong to the selected party or financial year`), { statusCode: 409 });
    }
  }

  const requested = Array.isArray(body.items) ? body.items : [];
  if (!requested.length) throw Object.assign(new Error("At least one item row is required"), { statusCode: 400 });
  const productIds = [...new Set(requested.map((row) => clean(row.productId)).filter(Boolean))];
  const products = productIds.length ? await Product.find({ tenantKey, _id: { $in: productIds }, status: "ACTIVE" }).lean() : [];
  const productMap = new Map(products.map((row) => [String(row._id), row]));

  const gstType = upper(body.gstType || "CGST_SGST") === "IGST" ? "IGST" : "CGST_SGST";
  const items = [];
  let rawSubtotal = 0;
  let maxGst = 0;
  for (const row of requested) {
    const productId = clean(row.productId);
    const product = productId ? productMap.get(productId) : null;
    if (productId && !product) throw Object.assign(new Error(`Product not found: ${productId}`), { statusCode: 400 });
    const description = clean(row.description || row.nameSnapshot || product?.name);
    if (!description) throw Object.assign(new Error("Enter product or description for every line"), { statusCode: 400 });
    const qty = num(row.qty);
    const rate = num(row.rate ?? row.basicRate ?? row.effectiveRate);
    const discountPct = Math.min(100, Math.max(0, num(row.discountPct)));
    const gstRate = Math.max(0, num(row.gstRate ?? row.gstRateSnapshot ?? product?.gstRate));
    if (qty <= 0) throw Object.assign(new Error(`${description}: quantity must be greater than zero`), { statusCode: 400 });
    if (rate < 0) throw Object.assign(new Error(`${description}: rate cannot be negative`), { statusCode: 400 });
    const effectiveRate = round2(rate * (1 - discountPct / 100));
    const taxable = round2(effectiveRate * qty);
    const tax = type === "DELIVERY_NOTE" ? 0 : round2(taxable * gstRate / 100);
    rawSubtotal += taxable;
    maxGst = Math.max(maxGst, gstRate);
    items.push({
      productId,
      sku: clean(row.sku || product?.sku),
      nameSnapshot: description,
      description,
      hsnSnapshot: clean(row.hsnSnapshot || row.hsnCode || product?.hsnCode),
      qty,
      unit: clean(row.unit || product?.basicUnit || product?.unit || "PCS"),
      packingUnit: clean(row.packingUnit || product?.packingUnit),
      rate: round2(rate),
      discountPct: round2(discountPct),
      effectiveRate,
      taxable,
      gstRateSnapshot: round2(gstRate),
      cgst: gstType === "IGST" ? 0 : round2(tax / 2),
      sgst: gstType === "IGST" ? 0 : round2(tax / 2),
      igst: gstType === "IGST" ? tax : 0,
      tax,
      lineTotal: round2(taxable + tax),
      condition: clean(row.condition || "SALEABLE"),
    });
  }

  rawSubtotal = round2(rawSubtotal);
  const billDiscount = Math.min(rawSubtotal, Math.max(0, num(body.billDiscount)));
  const otherCharges = Math.max(0, num(body.otherCharges));
  const discountFactor = rawSubtotal > 0 ? (rawSubtotal - billDiscount) / rawSubtotal : 1;
  let itemTax = 0;
  for (const item of items) itemTax += round2(item.taxable * discountFactor * item.gstRateSnapshot / 100);
  const chargesTax = type === "DELIVERY_NOTE" ? 0 : round2(otherCharges * maxGst / 100);
  const taxableTotal = round2(Math.max(0, rawSubtotal - billDiscount) + otherCharges);
  const taxTotal = round2(itemTax + chargesTax);
  const beforeRound = round2(taxableTotal + taxTotal);
  const grandTotal = body.roundGrandTotal === false ? beforeRound : Math.round(beforeRound);
  const roundOff = round2(grandTotal - beforeRound);

  const reasonType = upper(body.reasonType || (type === "DELIVERY_NOTE" ? "JOB_WORK" : "OTHER"));
  const needsStock = type === "CREDIT_NOTE" ? isCreditNoteStockReason(reasonType) : (type === "DEBIT_NOTE" && reasonType === "GOODS_RETURN");
  const warehouseId = clean(body.warehouseId);
  let warehouse = null;
  if (type === "DELIVERY_NOTE" || needsStock) {
    if (!warehouseId) throw Object.assign(new Error("Warehouse is required for stock-moving documents"), { statusCode: 400 });
    warehouse = await GenericRecord.findOne({ _id: warehouseId, tenantKey, app: "dms", resource: "warehouses", status: "ACTIVE" }).lean();
    if (!warehouse) throw Object.assign(new Error("Select a valid active warehouse"), { statusCode: 400 });
  }

  let eWayBillRequired = false;
  let eWayBillReason = "";
  let companyState = "";
  let destinationState = partyState(party);
  if (type === "DELIVERY_NOTE") {
    const company = await CompanyProfile.findOne({ tenantKey }).select("state").lean();
    companyState = upper(company?.state || "");
    const fromState = companyState;
    const toState = destinationState;
    const interstateJobWork = reasonType === "JOB_WORK" && Boolean(fromState && toState && fromState !== toState);
    if (grandTotal > 50000) {
      eWayBillRequired = true;
      eWayBillReason = "CONSIGNMENT_VALUE_ABOVE_50000";
    } else if (interstateJobWork) {
      eWayBillRequired = true;
      eWayBillReason = "INTERSTATE_JOB_WORK";
    }
  }

  return {
    tenantKey, financialYear, date, party, partyGlobalId, gstType, items,
    subtotal: rawSubtotal, billDiscount, otherCharges, taxableTotal, taxTotal, roundOff, grandTotal,
    reasonType, warehouseId, warehouse, eWayBillRequired, eWayBillReason, companyState, destinationState, referenceInvoice,
  };
}

async function assertStockAvailable({ tenantKey, items }) {
  const ids = items.map((x) => clean(x.productId)).filter(Boolean);
  if (ids.length !== items.length) throw Object.assign(new Error("Every stock-moving line must use a Product from Product Master"), { statusCode: 400 });
  const products = await Product.find({ tenantKey, _id: { $in: ids } }).lean();
  const map = new Map(products.map((p) => [String(p._id), p]));
  for (const item of items) {
    const p = map.get(String(item.productId));
    if (!p) throw Object.assign(new Error(`${item.nameSnapshot}: product not found`), { statusCode: 409 });
    if (num(p.currentStock) + 0.000001 < num(item.qty)) throw Object.assign(new Error(`${item.nameSnapshot}: only ${round2(p.currentStock)} ${item.unit || "units"} available`), { statusCode: 409 });
  }
}

async function applyStock({ note, direction, movementType }) {
  if (!note?.items?.length) return;
  const models = financialModels(note.tenantKey, note.financialYear);
  if (direction === "OUT") await assertStockAvailable({ tenantKey: note.tenantKey, items: note.items });
  for (const item of note.items) {
    if (!clean(item.productId)) continue;
    const qty = num(item.qty);
    await Product.updateOne({ _id: item.productId, tenantKey: note.tenantKey }, { $inc: { currentStock: direction === "IN" ? qty : -qty } });
    await models.StockMovement.create({
      tenantKey: note.tenantKey, financialYear: note.financialYear, date: note.date || new Date(),
      productId: String(item.productId), warehouseId: note.warehouseId || "", type: movementType,
      qtyIn: direction === "IN" ? qty : 0, qtyOut: direction === "OUT" ? qty : 0,
      landedCost: 0, referenceId: note.creditNoteNo,
    });
  }
}

async function postNoteAccounting(note, party) {
  const partyCode = partyAccountCode(party);
  if (note.documentType === "CREDIT_NOTE") {
    const baseAccount = ["INCENTIVE", "SCHEME", "DISCOUNT"].includes(upper(note.reasonType)) ? "SYS_INDIRECT_EXPENSE" : "SYS_SALES";
    const entries = [
      { accountCode: baseAccount, debit: note.taxableTotal },
      { accountCode: "SYS_DUTIES_TAXES", debit: note.taxTotal },
      { accountCode: partyCode, credit: note.grandTotal },
    ];
    if (num(note.roundOff) > 0) entries.push({ accountCode: "SYS_INDIRECT_EXPENSE", debit: note.roundOff });
    if (num(note.roundOff) < 0) entries.push({ accountCode: "SYS_INDIRECT_INCOME", credit: Math.abs(note.roundOff) });
    await postBalancedEntries({ tenantKey: note.tenantKey, financialYear: note.financialYear, transactionId: note.creditNoteNo, transactionType: "SALES_CREDIT_NOTE", date: note.date, partyGlobalId: note.partyGlobalId || note.customerGlobalId, narration: `Credit Note ${note.creditNoteNo}${note.referenceDocumentNo ? ` against ${note.referenceDocumentNo}` : ""}`, entries: entries.filter((x) => num(x.debit) || num(x.credit)) });
    return;
  }
  if (note.documentType === "DEBIT_NOTE") {
    const baseAccount = ["CHARGES", "SHORTAGE", "DAMAGE"].includes(upper(note.reasonType)) ? "SYS_INDIRECT_INCOME" : "SYS_PURCHASE";
    const entries = [
      { accountCode: partyCode, debit: note.grandTotal },
      { accountCode: baseAccount, credit: note.taxableTotal },
      { accountCode: "SYS_DUTIES_TAXES", credit: note.taxTotal },
    ];
    if (num(note.roundOff) > 0) entries.push({ accountCode: "SYS_INDIRECT_INCOME", credit: note.roundOff });
    if (num(note.roundOff) < 0) entries.push({ accountCode: "SYS_INDIRECT_EXPENSE", debit: Math.abs(note.roundOff) });
    await postBalancedEntries({ tenantKey: note.tenantKey, financialYear: note.financialYear, transactionId: note.creditNoteNo, transactionType: "PURCHASE_DEBIT_NOTE", date: note.date, partyGlobalId: note.partyGlobalId, narration: `Debit Note ${note.creditNoteNo}${note.referenceDocumentNo ? ` against ${note.referenceDocumentNo}` : ""}`, entries: entries.filter((x) => num(x.debit) || num(x.credit)) });
  }
}

async function issueDocument(note, party) {
  if (note.status === "ISSUED") return note;
  if (note.documentType === "DELIVERY_NOTE") {
    if (note.eWayBillRequired && !clean(note.eWayBillNo)) {
      const why = note.eWayBillReason === "INTERSTATE_JOB_WORK"
        ? "E-Way Bill number is required for interstate job-work movement"
        : "E-Way Bill number is required because consignment value exceeds ₹50,000";
      throw Object.assign(new Error(why), { statusCode: 409, details: { code: "EWAY_BILL_REQUIRED", documentNo: note.creditNoteNo, consignmentValue: note.grandTotal, reason: note.eWayBillReason || "" } });
    }
    if (!note.stockEffectApplied) {
      await applyStock({ note, direction: "OUT", movementType: "JOB_WORK_OUT" });
      note.stockEffectApplied = true;
    }
  } else {
    if (note.documentType === "DEBIT_NOTE" && upper(note.reasonType) === "GOODS_RETURN" && !note.stockEffectApplied) {
      await assertStockAvailable({ tenantKey: note.tenantKey, items: note.items });
    }
    await postNoteAccounting(note, party);
    if (!note.stockEffectApplied) {
      if (note.documentType === "CREDIT_NOTE" && isCreditNoteStockReason(note.reasonType)) {
        const movementType = upper(note.reasonType) === "GOODS_RETURN" ? "CREDIT_NOTE_GOODS_RETURN" : "CREDIT_NOTE_UNDELIVERED_RESTORE";
        await applyStock({ note, direction: "IN", movementType });
        note.stockEffectApplied = true;
      } else if (note.documentType === "DEBIT_NOTE" && upper(note.reasonType) === "GOODS_RETURN") {
        await applyStock({ note, direction: "OUT", movementType: "DEBIT_NOTE_GOODS_RETURN" });
        note.stockEffectApplied = true;
      }
    }
  }
  note.status = "ISSUED";
  note.issuedAt = new Date();
  return note;
}

async function reverseStockEffect(note) {
  if (!note.stockEffectApplied) return;
  const reasonType = upper(note.reasonType);
  if (note.documentType === "CREDIT_NOTE" && isCreditNoteStockReason(reasonType)) {
    await applyStock({ note, direction: "OUT", movementType: "CREDIT_NOTE_CANCEL_REVERSAL" });
  } else if (note.documentType === "DEBIT_NOTE" && reasonType === "GOODS_RETURN") {
    await applyStock({ note, direction: "IN", movementType: "DEBIT_NOTE_CANCEL_REVERSAL" });
  } else if (note.documentType === "DELIVERY_NOTE") {
    await applyStock({ note, direction: "IN", movementType: "JOB_WORK_CANCEL_REVERSAL" });
  }
  note.stockEffectApplied = false;
}

async function createDocument(req, res, type) {
  try {
    const calc = await normalizeDocument({ auth: req.auth, body: req.body, type });
    const models = financialModels(calc.tenantKey, calc.financialYear);
    const documentNo = clean(req.body.documentNo) || await allocateDocumentNoteNumber({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, type });
    if (await models.CreditNote.exists({ tenantKey: calc.tenantKey, financialYear: calc.financialYear, creditNoteNo: documentNo })) return fail(res, `${CONFIG[type].label} number already exists`, 409);
    if (type === "CREDIT_NOTE") {
      await validateCreditNoteAgainstInvoice({
        models, tenantKey: calc.tenantKey, financialYear: calc.financialYear, invoice: calc.referenceInvoice,
        note: { grandTotal: calc.grandTotal, items: calc.items, reasonType: calc.reasonType },
      });
    }
    if (type === "DELIVERY_NOTE" && req.body.issueNow === true && calc.eWayBillRequired && !clean(req.body.eWayBillNo)) {
      const why = calc.eWayBillReason === "INTERSTATE_JOB_WORK"
        ? "E-Way Bill number is required for interstate job-work movement"
        : "E-Way Bill number is required because consignment value exceeds ₹50,000";
      return fail(res, why, 409, { code: "EWAY_BILL_REQUIRED", consignmentValue: calc.grandTotal, reason: calc.eWayBillReason });
    }
    const note = await models.CreditNote.create({
      tenantKey: calc.tenantKey, financialYear: calc.financialYear, documentType: type,
      creditNoteNo: documentNo, documentNo, date: calc.date,
      referenceDocumentId: calc.referenceInvoice ? String(calc.referenceInvoice._id) : clean(req.body.referenceDocumentId), referenceDocumentNo: calc.referenceInvoice?.invoiceNo || clean(req.body.referenceDocumentNo),
      referenceDocumentDate: calc.referenceInvoice?.date || undefined,
      invoiceId: type === "CREDIT_NOTE" && calc.referenceInvoice ? String(calc.referenceInvoice._id) : (type === "CREDIT_NOTE" ? clean(req.body.referenceDocumentId) : ""),
      invoiceNo: type === "CREDIT_NOTE" ? (calc.referenceInvoice?.invoiceNo || clean(req.body.referenceDocumentNo)) : "",
      customerGlobalId: type === "CREDIT_NOTE" ? calc.partyGlobalId : "",
      customerNameSnapshot: type === "CREDIT_NOTE" ? (calc.party.localName || calc.party.displayIdentifier || "Party") : "",
      partyGlobalId: calc.partyGlobalId, partyNameSnapshot: calc.party.localName || calc.party.legalName || calc.party.displayIdentifier || "Party",
      partyGstinSnapshot: partyGstin(calc.party), addressSnapshot: clean(req.body.addressSnapshot) || partyAddress(calc.party),
      reasonType: calc.reasonType, reason: clean(req.body.reason), gstType: calc.gstType,
      items: calc.items, subtotal: calc.subtotal, billDiscount: calc.billDiscount, otherCharges: calc.otherCharges,
      taxableTotal: calc.taxableTotal, taxTotal: calc.taxTotal, roundOff: calc.roundOff, grandTotal: calc.grandTotal,
      warehouseId: calc.warehouseId, warehouseNameSnapshot: clean(calc.warehouse?.title || calc.warehouse?.reference),
      origin: "MANUAL", jobWorkPurpose: clean(req.body.jobWorkPurpose), expectedReturnDate: req.body.expectedReturnDate ? new Date(req.body.expectedReturnDate) : undefined,
      placeOfSupply: calc.destinationState || "", transporterName: clean(req.body.transporterName), vehicleNo: upper(req.body.vehicleNo), distanceKm: Math.max(0, num(req.body.distanceKm)),
      eWayBillRequired: calc.eWayBillRequired, eWayBillReason: calc.eWayBillReason, eWayBillNo: clean(req.body.eWayBillNo), eWayBillDate: req.body.eWayBillDate ? new Date(req.body.eWayBillDate) : undefined,
      remarks: clean(req.body.remarks), status: "DRAFT", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "",
    });
    if (type !== "DELIVERY_NOTE" || req.body.issueNow === true) {
      await issueDocument(note, calc.party);
      note.issuedBy = req.auth.sub;
      await note.save();
      if (type === "CREDIT_NOTE" && note.referenceDocumentId) {
        await syncSalesInvoiceCreditState({ models, tenantKey: note.tenantKey, financialYear: note.financialYear, invoiceId: note.referenceDocumentId });
      }
    }
    return ok(res, note, type === "DELIVERY_NOTE" && note.status === "DRAFT" ? "Delivery Note draft saved" : `${CONFIG[type].label} issued`, 201);
  } catch (error) {
    return fail(res, error.message, error.statusCode || error.status || 400, error.details);
  }
}

async function listDocuments(req, res, type) {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const filter = { tenantKey: req.auth.tenantKey, financialYear, ...documentFilter(type) };
    if (req.query.status) filter.status = upper(req.query.status);
    const [items, total] = await Promise.all([
      CreditNote.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      CreditNote.countDocuments(filter),
    ]);
    return ok(res, { items: items.map((x) => ({ ...x, documentType: x.documentType || "CREDIT_NOTE", documentNo: x.documentNo || x.creditNoteNo, partyGlobalId: x.partyGlobalId || x.customerGlobalId, partyNameSnapshot: x.partyNameSnapshot || x.customerNameSnapshot })), meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400); }
}

async function getDocument(req, res, type) {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const note = await CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, ...documentFilter(type) }).lean();
    if (!note) return fail(res, `${CONFIG[type].label} not found`, 404);
    return ok(res, { ...note, documentType: note.documentType || "CREDIT_NOTE", documentNo: note.documentNo || note.creditNoteNo, partyGlobalId: note.partyGlobalId || note.customerGlobalId, partyNameSnapshot: note.partyNameSnapshot || note.customerNameSnapshot });
  } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400); }
}

async function updateDraft(req, res, type) {
  try {
    const sourceFy = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.sourceFinancialYear || req.query.financialYear || req.body.financialYear });
    const models = financialModels(req.auth.tenantKey, sourceFy);
    const note = await models.CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear: sourceFy, ...documentFilter(type) });
    if (!note) return fail(res, `${CONFIG[type].label} not found`, 404);
    if (note.status !== "DRAFT") return fail(res, `Issued ${CONFIG[type].label}s cannot be edited. Cancel and recreate the document to preserve accounting/stock audit.`, 409);
    const calc = await normalizeDocument({ auth: req.auth, body: req.body, type });
    if (calc.financialYear !== sourceFy) return fail(res, `The selected date belongs to FY ${calc.financialYear}. Draft documents cannot be moved across FY databases.`, 409);
    if (type === "CREDIT_NOTE") {
      await validateCreditNoteAgainstInvoice({ models, tenantKey: calc.tenantKey, financialYear: calc.financialYear, invoice: calc.referenceInvoice, note: { grandTotal: calc.grandTotal, items: calc.items, reasonType: calc.reasonType }, excludeNoteId: note._id });
    }
    Object.assign(note, {
      date: calc.date, referenceDocumentId: calc.referenceInvoice ? String(calc.referenceInvoice._id) : clean(req.body.referenceDocumentId), referenceDocumentNo: calc.referenceInvoice?.invoiceNo || clean(req.body.referenceDocumentNo), referenceDocumentDate: calc.referenceInvoice?.date || undefined,
      invoiceId: type === "CREDIT_NOTE" && calc.referenceInvoice ? String(calc.referenceInvoice._id) : (type === "CREDIT_NOTE" ? clean(req.body.referenceDocumentId) : ""), invoiceNo: type === "CREDIT_NOTE" ? (calc.referenceInvoice?.invoiceNo || clean(req.body.referenceDocumentNo)) : "",
      customerGlobalId: type === "CREDIT_NOTE" ? calc.partyGlobalId : "", customerNameSnapshot: type === "CREDIT_NOTE" ? (calc.party.localName || calc.party.displayIdentifier || "Party") : "",
      partyGlobalId: calc.partyGlobalId, partyNameSnapshot: calc.party.localName || calc.party.legalName || calc.party.displayIdentifier || "Party",
      partyGstinSnapshot: partyGstin(calc.party), addressSnapshot: clean(req.body.addressSnapshot) || partyAddress(calc.party), reasonType: calc.reasonType, reason: clean(req.body.reason), gstType: calc.gstType,
      items: calc.items, subtotal: calc.subtotal, billDiscount: calc.billDiscount, otherCharges: calc.otherCharges, taxableTotal: calc.taxableTotal, taxTotal: calc.taxTotal, roundOff: calc.roundOff, grandTotal: calc.grandTotal,
      warehouseId: calc.warehouseId, warehouseNameSnapshot: clean(calc.warehouse?.title || calc.warehouse?.reference), jobWorkPurpose: clean(req.body.jobWorkPurpose), expectedReturnDate: req.body.expectedReturnDate ? new Date(req.body.expectedReturnDate) : undefined,
      placeOfSupply: calc.destinationState || "", transporterName: clean(req.body.transporterName), vehicleNo: upper(req.body.vehicleNo), distanceKm: Math.max(0, num(req.body.distanceKm)), eWayBillRequired: calc.eWayBillRequired, eWayBillReason: calc.eWayBillReason,
      eWayBillNo: clean(req.body.eWayBillNo), eWayBillDate: req.body.eWayBillDate ? new Date(req.body.eWayBillDate) : undefined, remarks: clean(req.body.remarks),
    });
    await note.save();
    return ok(res, note, `${CONFIG[type].label} draft updated`);
  } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400, error.details); }
}

async function issueSaved(req, res, type) {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.financialYear || req.query.financialYear });
    const { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const note = await CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, ...documentFilter(type) });
    if (!note) return fail(res, `${CONFIG[type].label} not found`, 404);
    if (note.status === "CANCELLED") return fail(res, "Cancelled document cannot be issued", 409);
    if (type === "DELIVERY_NOTE") {
      if (req.body.eWayBillNo !== undefined) note.eWayBillNo = clean(req.body.eWayBillNo);
      if (req.body.eWayBillDate !== undefined) note.eWayBillDate = req.body.eWayBillDate ? new Date(req.body.eWayBillDate) : undefined;
      if (req.body.vehicleNo !== undefined) note.vehicleNo = upper(req.body.vehicleNo);
      if (req.body.transporterName !== undefined) note.transporterName = clean(req.body.transporterName);
    }
    const party = await CustomerLink.findOne({ tenantKey: req.auth.tenantKey, globalCustomerId: note.partyGlobalId || note.customerGlobalId }).lean();
    if (type === "CREDIT_NOTE") {
      const invoiceId = note.referenceDocumentId || note.invoiceId;
      const invoice = invoiceId ? await financialModels(req.auth.tenantKey, financialYear).SalesInvoice.findOne({ _id: invoiceId, tenantKey: req.auth.tenantKey, financialYear }).lean() : null;
      await validateCreditNoteAgainstInvoice({ models: financialModels(req.auth.tenantKey, financialYear), tenantKey: req.auth.tenantKey, financialYear, invoice, note, excludeNoteId: note._id });
    }
    await issueDocument(note, party || {});
    note.issuedBy = req.auth.sub;
    await note.save();
    if (type === "CREDIT_NOTE" && (note.referenceDocumentId || note.invoiceId)) {
      await syncSalesInvoiceCreditState({ models: financialModels(req.auth.tenantKey, financialYear), tenantKey: req.auth.tenantKey, financialYear, invoiceId: note.referenceDocumentId || note.invoiceId });
    }
    return ok(res, note, `${CONFIG[type].label} issued`);
  } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400, error.details); }
}

async function cancelDocument(req, res, type) {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body?.financialYear || req.query.financialYear });
    const { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const note = await CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, ...documentFilter(type) });
    if (!note) return fail(res, `${CONFIG[type].label} not found`, 404);
    if (note.status === "CANCELLED") return ok(res, note, `${CONFIG[type].label} already cancelled`);
    if (note.status === "RETURNED") return fail(res, "Returned Delivery Note cannot be cancelled", 409);
    if (note.status === "ISSUED" && type === "CREDIT_NOTE" && isCreditNoteStockReason(note.reasonType) && note.stockEffectApplied) {
      await assertStockAvailable({ tenantKey: note.tenantKey, items: note.items });
    }
    if (note.status === "ISSUED" && type !== "DELIVERY_NOTE") await reversePostedTransaction({ tenantKey: note.tenantKey, financialYear: note.financialYear, transactionId: note.creditNoteNo, reason: `${CONFIG[type].label} cancelled` });
    await reverseStockEffect(note);
    note.status = "CANCELLED";
    note.remarks = [clean(note.remarks), clean(req.body?.cancelReason) ? `Cancelled: ${clean(req.body.cancelReason)}` : ""].filter(Boolean).join(" | ");
    await note.save();
    if (type === "CREDIT_NOTE" && (note.referenceDocumentId || note.invoiceId)) {
      await syncSalesInvoiceCreditState({ models: financialModels(req.auth.tenantKey, financialYear), tenantKey: req.auth.tenantKey, financialYear, invoiceId: note.referenceDocumentId || note.invoiceId });
    }
    return ok(res, note, `${CONFIG[type].label} cancelled and effects reversed`);
  } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400, error.details); }
}

async function returnDelivery(req, res) {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.body.financialYear || req.query.financialYear });
    const { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const note = await CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, documentType: "DELIVERY_NOTE" });
    if (!note) return fail(res, "Delivery Note not found", 404);
    if (note.status === "RETURNED") return ok(res, note, "Delivery Note already marked returned");
    if (note.status !== "ISSUED") return fail(res, "Only an issued Delivery Note can be marked returned", 409);
    if (note.stockEffectApplied) {
      await applyStock({ note, direction: "IN", movementType: "JOB_WORK_RETURN" });
      note.stockEffectApplied = false;
    }
    note.status = "RETURNED";
    note.returnedAt = req.body.returnedAt ? new Date(req.body.returnedAt) : new Date();
    if (clean(req.body.remarks)) note.remarks = [clean(note.remarks), `Return: ${clean(req.body.remarks)}`].filter(Boolean).join(" | ");
    await note.save();
    return ok(res, note, "Job-work goods marked returned and stock restored");
  } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400, error.details); }
}

async function pdfDocument(req, res, type) {
  try {
    const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
    const { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const note = await CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, ...documentFilter(type) }).lean();
    if (!note) return fail(res, `${CONFIG[type].label} not found`, 404);
    note.documentType = note.documentType || "CREDIT_NOTE";
    note.documentNo = note.documentNo || note.creditNoteNo;
    note.partyGlobalId = note.partyGlobalId || note.customerGlobalId;
    note.partyNameSnapshot = note.partyNameSnapshot || note.customerNameSnapshot;
    const [company, party] = await Promise.all([
      CompanyProfile.findOne({ tenantKey: req.auth.tenantKey }).lean(),
      CustomerLink.findOne({ tenantKey: req.auth.tenantKey, globalCustomerId: note.partyGlobalId }).lean(),
    ]);
    const pdf = await buildDocumentNotePdf({ note, company: company || {}, party: party || {} });
    const safe = clean(note.documentNo || note.creditNoteNo || req.params.id).replace(/[^a-z0-9._-]+/gi, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${CONFIG[type].prefix}-${safe}.pdf"`);
    return res.send(pdf);
  } catch (error) { return fail(res, error.message || "Could not generate PDF", 500); }
}

function register(type) {
  const path = CONFIG[type].path;
  router.get(`/${path}/next-number`, async (req, res) => {
    try {
      const financialYear = await resolveFinancialYear({ tenantKey: req.auth.tenantKey, requested: req.query.financialYear });
      return ok(res, { documentNo: await nextDocumentNoteNumber({ tenantKey: req.auth.tenantKey, financialYear, type }), financialYear });
    } catch (error) { return fail(res, error.message, error.statusCode || error.status || 400); }
  });
  router.get(`/${path}`, (req, res) => listDocuments(req, res, type));
  router.get(`/${path}/:id/pdf`, (req, res) => pdfDocument(req, res, type));
  router.get(`/${path}/:id`, (req, res) => getDocument(req, res, type));
  router.post(`/${path}`, (req, res) => createDocument(req, res, type));
  router.put(`/${path}/:id`, (req, res) => updateDraft(req, res, type));
  router.post(`/${path}/:id/issue`, (req, res) => issueSaved(req, res, type));
  router.delete(`/${path}/:id`, (req, res) => cancelDocument(req, res, type));
}

register("CREDIT_NOTE");
register("DEBIT_NOTE");
register("DELIVERY_NOTE");
router.post("/delivery-notes/:id/return", returnDelivery);

export default router;
