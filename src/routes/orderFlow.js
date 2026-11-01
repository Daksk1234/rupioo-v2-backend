import express from "express";
import { CustomerLink, Product, Transporter, User, GlobalTransporterStation, Pincode, GenericRecord } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { financialModels, postBalancedEntries, reversePostedTransaction } from "../services/accountingService.js";
import { createOtp, verifyOtp } from "../services/otpService.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { resolveFinancialYear, financialYearFromDate } from "../utils/financialYear.js";
import { allocateDocumentNoteNumber } from "../services/documentNumberService.js";
import { syncSalesInvoiceCreditState, validateCreditNoteAgainstInvoice } from "../services/creditNoteRulesService.js";
import { warehouseStockSnapshot,ensureWarehouseMonthlyClosing,previousMonth } from "../services/warehouseStockService.js";
import { orderItemInvoicePrice } from "../services/orderInvoicePricing.js";

const router = express.Router();

// Lightweight deployment check. No tenant or business data is returned.
// If this responds, the running backend has loaded the Order Flow router.
router.get("/health", (_req, res) =>
  res.json({ ok: true, module: "order-flow", mount: "router", build: "2026-09-20-sales-order-flow-v3", time: new Date().toISOString() }),
);

router.use(requireAuth);
// Warehouse tokens are scoped to their app and a fixed set of order/stock actions.
router.use((req,res,next)=>{
  if (upper(req.auth?.role) !== "WAREHOUSE") return next();
  const path=req.path;
  const allowed = (req.method==="GET" && (/^\/orders$/.test(path) || /^\/orders\/[^/]+$/.test(path) || ["/delivery-boys","/warehouse-stock","/transfers","/monthly-closings"].includes(path)))
    || (req.method==="POST" && (/^\/orders\/[^/]+\/packing\/complete$/.test(path) || /^\/orders\/[^/]+\/assign-delivery$/.test(path) || /^\/orders\/[^/]+\/packing\/confirm$/.test(path) || ["/transfers","/monthly-closings"].includes(path) || /^\/transfers\/[^/]+\/receive$/.test(path)));
  if(!allowed)return fail(res,"Warehouse login cannot perform this Order Desk action",403);
  next();
});

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const money = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const clamp = (v, min, max) => Math.max(min, Math.min(max, num(v)));
const isAdmin = (auth) => ["MASTER", "SUPERADMIN"].includes(upper(auth?.role));
const validCoord = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;

const WORKFLOW_LABELS = {
  CREDIT_HOLD: "Credit approval required",
  OTP_PENDING: "Customer OTP verification required",
  ORDER_PLACED: "Verify order",
  VERIFIED: "Reserve stock",
  STOCK_RESERVED: "Send to warehouse",
  SENT_TO_WAREHOUSE: "Start picking",
  PICKING: "Start packing",
  PACKING: "Complete packing",
  PACKED: "Send to order desk",
  SENT_TO_ORDER_DESK: "Generate invoice",
  INVOICED_PARTIAL: "Pack / invoice remaining quantity",
  INVOICED: "Prepare dispatch",
  READY_FOR_DISPATCH: "Assign delivery run",
  DELIVERY_ASSIGNED: "Start delivery run",
  OUT_FOR_DELIVERY: "Complete delivery",
  HANDED_TO_TRANSPORTER: "In transit with transporter",
  DELIVERED: "Close order",
  DELIVERY_FAILED: "Retry or start return",
  RETURN_IN_TRANSIT: "Receive back at warehouse",
  RETURNED_TO_WAREHOUSE: "Issue credit note",
  CREDIT_NOTE_PENDING: "Issue credit note",
  CLOSED: "Completed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
};

const ALLOWED_TRANSITIONS = {
  OTP_PENDING: ["ORDER_PLACED", "CANCELLED"],
  ORDER_PLACED: ["VERIFIED", "CANCELLED", "REJECTED", "CREDIT_HOLD"],
  CREDIT_HOLD: ["ORDER_PLACED", "REJECTED", "CANCELLED"],
  VERIFIED: ["STOCK_RESERVED", "CANCELLED"],
  STOCK_RESERVED: ["SENT_TO_WAREHOUSE", "CANCELLED"],
  SENT_TO_WAREHOUSE: ["PICKING", "CANCELLED"],
  PICKING: ["PACKING", "CANCELLED"],
  PACKING: ["PACKED", "CANCELLED"],
  PACKED: ["SENT_TO_ORDER_DESK", "SENT_TO_WAREHOUSE", "CANCELLED"],
  SENT_TO_ORDER_DESK: ["INVOICED", "INVOICED_PARTIAL", "CANCELLED"],
  INVOICED_PARTIAL: ["SENT_TO_WAREHOUSE", "READY_FOR_DISPATCH", "CANCELLED"],
  INVOICED: ["READY_FOR_DISPATCH", "CANCELLED"],
  READY_FOR_DISPATCH: ["DELIVERY_ASSIGNED", "CANCELLED"],
  DELIVERY_ASSIGNED: ["OUT_FOR_DELIVERY", "READY_FOR_DISPATCH", "CANCELLED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "HANDED_TO_TRANSPORTER", "DELIVERY_FAILED", "RETURN_IN_TRANSIT"],
  DELIVERY_FAILED: ["READY_FOR_DISPATCH", "RETURN_IN_TRANSIT", "CANCELLED"],
  RETURN_IN_TRANSIT: ["RETURNED_TO_WAREHOUSE"],
  RETURNED_TO_WAREHOUSE: ["CREDIT_NOTE_PENDING", "CLOSED"],
  CREDIT_NOTE_PENDING: ["CLOSED"],
  HANDED_TO_TRANSPORTER: ["DELIVERED", "CLOSED"],
  DELIVERED: ["CLOSED"],
};

function nextAction(status) {
  return WORKFLOW_LABELS[upper(status)] || "Review order";
}

function haversineMeters(a, b) {
  if (!validCoord(a?.lat, a?.lng) || !validCoord(b?.lat, b?.lng)) return Infinity;
  const R = 6371000;
  const toRad = (x) => (Number(x) * Math.PI) / 180;
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const dLat = lat2 - lat1, dLng = toRad(b.lng) - toRad(a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function roadMeters(a, b) {
  const direct = haversineMeters(a, b);
  return Number.isFinite(direct) ? Math.round(direct * 1.22) : 0;
}

function travelMinutes(meters) {
  return Math.max(1, Math.round((Math.max(0, num(meters)) / 1000) / 24 * 60));
}

function routeDistance(start, stops) {
  let total = 0;
  let cursor = start;
  for (const stop of stops) {
    total += roadMeters(cursor, stop.location);
    cursor = stop.location;
  }
  return total;
}

// Greedy nearest-neighbour followed by 2-opt. It is deterministic, fast for a
// delivery boy's normal 5-25 stops, and can later be replaced by a live road API
// without changing the DeliveryRun contract.
function optimizeStops(stops, start) {
  const remaining = [...stops];
  const ordered = [];
  let cursor = start;
  while (remaining.length) {
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const distance = roadMeters(cursor, remaining[i].location);
      const priorityBoost = upper(remaining[i].priority) === "URGENT" ? -6000 : upper(remaining[i].priority) === "HIGH" ? -2500 : 0;
      const score = distance + priorityBoost;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    const [chosen] = remaining.splice(best, 1);
    ordered.push(chosen);
    cursor = chosen.location;
  }

  let improved = true;
  let passes = 0;
  while (improved && passes < 8 && ordered.length > 3) {
    improved = false;
    passes += 1;
    const base = routeDistance(start, ordered);
    for (let i = 0; i < ordered.length - 2; i += 1) {
      for (let j = i + 2; j < ordered.length; j += 1) {
        const candidate = [...ordered];
        candidate.splice(i, j - i + 1, ...candidate.slice(i, j + 1).reverse());
        if (routeDistance(start, candidate) + 5 < base) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  let eta = new Date();
  cursor = start;
  return ordered.map((stop, index) => {
    const leg = roadMeters(cursor, stop.location);
    const mins = travelMinutes(leg);
    eta = new Date(eta.getTime() + mins * 60000);
    const result = {
      ...stop,
      sequence: index + 1,
      estimatedDistanceFromPreviousMeters: leg,
      estimatedTravelMinutes: mins,
      estimatedArrivalAt: new Date(eta),
    };
    eta = new Date(eta.getTime() + 12 * 60000);
    cursor = stop.location;
    return result;
  });
}

function localCustomerPoint(customer) {
  const addresses = Array.isArray(customer?.addresses) ? customer.addresses : [];
  const delivery = addresses.find((x) => upper(x?.type) === "DELIVERY" && validCoord(x?.latitude, x?.longitude));
  const billing = addresses.find((x) => upper(x?.type) === "BILLING" && validCoord(x?.latitude, x?.longitude));
  const any = addresses.find((x) => validCoord(x?.latitude, x?.longitude));
  const address = delivery || billing || any || addresses[0] || {};
  const lat = address.latitude ?? customer?.location?.latitude;
  const lng = address.longitude ?? customer?.location?.longitude;
  return {
    address,
    point: validCoord(lat, lng) ? { lat: Number(lat), lng: Number(lng) } : null,
  };
}

async function getFy(req) {
  return resolveFinancialYear({
    tenantKey: req.auth.tenantKey,
    date: req.body?.date,
    requested: req.body?.financialYear || req.query?.financialYear,
  });
}

async function requireOrder(req, id, models) {
  const order = await models.SalesOrder.findOne({ _id: id, tenantKey: req.auth.tenantKey });
  if (!order) throw Object.assign(new Error("Sales order not found"), { statusCode: 404 });
  return order;
}

async function createEvent({ req, models, order, fromStatus, toStatus, type = "STATUS_CHANGED", note = "", meta = {}, audience = ["DMS", "CUSTOMER", "SALESPERSON"] }) {
  let eventNo = makeId("EVT");
  while (await models.OrderEvent.exists({ tenantKey: req.auth.tenantKey, eventNo })) eventNo = makeId("EVT");
  const event = await models.OrderEvent.create({
    tenantKey: req.auth.tenantKey,
    financialYear: order.financialYear,
    eventNo,
    orderId: String(order._id),
    orderNo: order.orderNo,
    invoiceId: order.invoice?.invoiceId || "",
    invoiceNo: order.invoice?.invoiceNo || "",
    deliveryRunId: order.deliveryRunId || "",
    type,
    fromStatus,
    toStatus,
    note,
    meta,
    audience,
    actorId: req.auth.sub,
    actorNameSnapshot: req.auth.name || "",
    actorRole: req.auth.role || "",
    occurredAt: new Date(),
  });

  const notificationRows = [];
  const title = `Order ${order.orderNo}: ${toStatus.replaceAll("_", " ")}`;
  const body = note || nextAction(toStatus);
  if (audience.includes("CUSTOMER") && order.customerGlobalId) {
    notificationRows.push({ recipientType: "CUSTOMER", recipientId: order.customerGlobalId });
  }
  if (audience.includes("SALESPERSON") && order.salespersonId) {
    notificationRows.push({ recipientType: "SALESPERSON", recipientId: order.salespersonId });
  }
  if (notificationRows.length) {
    await models.OrderNotification.insertMany(notificationRows.map((row) => ({
      tenantKey: req.auth.tenantKey,
      financialYear: order.financialYear,
      notificationNo: makeId("NTF"),
      orderId: String(order._id),
      orderNo: order.orderNo,
      eventNo,
      ...row,
      channel: "IN_APP",
      title,
      body,
      data: { workflowStatus: toStatus, ...meta },
      status: "PENDING",
    })));
  }
  return event;
}

async function transitionOrder({ req, models, order, toStatus, note = "", meta = {}, force = false, type = "STATUS_CHANGED", audience }) {
  const fromStatus = upper(order.workflowStatus || (order.status === "CREDIT_HOLD" ? "CREDIT_HOLD" : "ORDER_PLACED"));
  const to = upper(toStatus);
  if (!force && !(ALLOWED_TRANSITIONS[fromStatus] || []).includes(to)) {
    throw Object.assign(new Error(`Order cannot move from ${fromStatus} to ${to}`), { statusCode: 409 });
  }
  order.workflowStatus = to;
  order.lastWorkflowAt = new Date();
  order.nextAction = nextAction(to);
  if (["SENT_TO_WAREHOUSE", "PICKING", "PACKING", "PACKED", "SENT_TO_ORDER_DESK", "INVOICED", "INVOICED_PARTIAL", "READY_FOR_DISPATCH", "DELIVERY_ASSIGNED", "OUT_FOR_DELIVERY", "RETURN_IN_TRANSIT", "RETURNED_TO_WAREHOUSE", "CREDIT_NOTE_PENDING"].includes(to)) {
    order.status = "PROCESSING";
  }
  if (["DELIVERED", "HANDED_TO_TRANSPORTER", "CLOSED"].includes(to)) order.status = "CONVERTED";
  if (to === "CANCELLED") order.status = "CANCELLED";
  if (to === "REJECTED") order.status = "REJECTED";
  if (to === "ORDER_PLACED" && order.status === "CREDIT_HOLD") order.status = "APPROVED";
  await order.save();
  await createEvent({ req, models, order, fromStatus, toStatus: to, type, note, meta, audience: audience || ["DMS", "CUSTOMER", "SALESPERSON"] });
  return order;
}

async function reserveOrderStock(order, tenantKey) {
  const reserved = [];
  try {
    for (const item of order.items || []) {
      const already = num(item.reservedQty);
      const invoiced = num(item.invoicedQty);
      const desired = Math.max(0, num(item.qty) - invoiced);
      const need = Math.max(0, desired - already);
      if (!need) continue;
      const product = await Product.findOneAndUpdate(
        {
          _id: item.productId,
          tenantKey,
          status: "ACTIVE",
          $expr: { $gte: [{ $subtract: [{ $ifNull: ["$currentStock", 0] }, { $ifNull: ["$reservedStock", 0] }] }, need] },
        },
        { $inc: { reservedStock: need } },
        { new: true },
      );
      if (!product) {
        const snapshot = await Product.findOne({ _id: item.productId, tenantKey }).select("name currentStock reservedStock").lean();
        const available = Math.max(0, num(snapshot?.currentStock) - num(snapshot?.reservedStock));
        throw Object.assign(new Error(`Insufficient available stock for ${snapshot?.name || item.nameSnapshot || item.sku}. Required ${need}, available ${available}`), { statusCode: 409 });
      }
      item.reservedQty = already + need;
      reserved.push({ productId: item.productId, qty: need });
    }
    order.reservation = { status: "RESERVED", reservedAt: new Date(), releasedAt: null, releasedReason: "" };
    await order.save();
  } catch (error) {
    for (const row of reserved) {
      await Product.updateOne({ _id: row.productId, tenantKey }, { $inc: { reservedStock: -row.qty } }).catch(() => {});
    }
    throw error;
  }
}

async function releaseOrderReservation(order, tenantKey, reason = "Order cancelled") {
  let released = 0;
  for (const item of order.items || []) {
    const qty = Math.max(0, num(item.reservedQty));
    if (!qty) continue;
    await Product.updateOne({ _id: item.productId, tenantKey }, { $inc: { reservedStock: -qty } });
    await Product.updateOne({ _id: item.productId, tenantKey, reservedStock: { $lt: 0 } }, { $set: { reservedStock: 0 } });
    item.reservedQty = 0;
    released += qty;
  }
  order.reservation = { status: "RELEASED", releasedAt: new Date(), releasedReason: reason };
  await order.save();
  return released;
}

async function verifyChallenge({ otpId, code, transactionId, allowedActions }) {
  if (!otpId || !code) throw Object.assign(new Error("OTP ID and code are required"), { statusCode: 400 });
  const result = await verifyOtp({ otpId, code });
  if (!result.ok) throw Object.assign(new Error(result.reason), { statusCode: 400 });
  if (clean(result.challenge.transactionId) !== clean(transactionId)) throw Object.assign(new Error("OTP does not belong to this transaction"), { statusCode: 409 });
  if (allowedActions?.length && !allowedActions.includes(upper(result.challenge.actionType))) throw Object.assign(new Error("OTP action does not match this operation"), { statusCode: 409 });
  return result.challenge;
}

async function customerAndInvoice(models, order) {
  const customer = await CustomerLink.findOne({ tenantKey: order.tenantKey, globalCustomerId: order.customerGlobalId }).lean();
  const invoiceId = clean(order.invoice?.invoiceId) || clean((order.invoices || []).at?.(-1)?.invoiceId);
  const invoice = invoiceId ? await models.SalesInvoice.findOne({ _id: invoiceId, tenantKey: order.tenantKey }).lean() : null;
  return { customer, invoice };
}

async function destinationForOrder(models, order) {
  const { customer, invoice } = await customerAndInvoice(models, order);
  if (!invoice) throw Object.assign(new Error(`Order ${order.orderNo} has no posted invoice`), { statusCode: 409 });
  if (!customer) throw Object.assign(new Error(`Customer not found for order ${order.orderNo}`), { statusCode: 404 });
  const nonLocal = upper(invoice.transportAssignment?.mode || customer.regionType || order.deliveryType || "LOCAL") !== "LOCAL";
  if (!nonLocal) {
    const { address, point } = localCustomerPoint(customer);
    if (!point) throw Object.assign(new Error(`${order.customerNameSnapshot || order.orderNo} has no saved latitude/longitude`), { statusCode: 409 });
    return {
      invoice,
      stop: {
        stopId: makeId("DST"), orderId: String(order._id), orderNo: order.orderNo, invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo,
        customerGlobalId: order.customerGlobalId, customerNameSnapshot: order.customerNameSnapshot, mobileSnapshot: clean(customer.companyContactNumber || customer.ownerMobile || customer.contacts?.[0]?.mobile), salespersonId: order.salespersonId || "", warehouseId: invoice.warehouseId || "",
        destinationType: "CUSTOMER", destinationNameSnapshot: order.customerNameSnapshot,
        addressSnapshot: clean(address.address || invoice.addressSnapshot), citySnapshot: clean(address.city), pincodeSnapshot: clean(address.pincode), location: point,
        packageCount: num(order.packing?.packageCount || invoice.noOfPackages), actualWeight: num(order.packing?.actualWeight), status: "PENDING",
      },
    };
  }

  const tId = clean(invoice.transportAssignment?.transporterId);
  const transporter = tId ? await Transporter.findOne({ _id: tId, tenantKey: order.tenantKey }).lean() : null;
  const stationId = clean(invoice.transportAssignment?.bookingStationId);
  const stations = Array.isArray(transporter?.stations) ? transporter.stations : [];
  const station = stations.find((s) => String(s._id) === stationId)
    || stations.find((s) => clean(s.name) === clean(invoice.transportAssignment?.bookingStationNameSnapshot))
    || stations.find((s) => validCoord(s.latitude, s.longitude));
  const globalStation = stationId ? await GlobalTransporterStation.findOne({ stationId, status: "ACTIVE" }).lean() : null;
  const stationPincode = clean(station?.pincode || globalStation?.pincode || invoice.transportAssignment?.bookingStationPincodeSnapshot);
  const pinPoint = stationPincode ? await Pincode.findOne({ pincode: stationPincode, status: "ACTIVE", latitude: { $ne: null }, longitude: { $ne: null } }).select("latitude longitude").lean() : null;
  const lat = station?.latitude ?? globalStation?.latitude ?? pinPoint?.latitude;
  const lng = station?.longitude ?? globalStation?.longitude ?? pinPoint?.longitude;
  if (!validCoord(lat, lng)) {
    throw Object.assign(new Error(`${invoice.transportAssignment?.transporterNameSnapshot || "Transporter"} booking station has no latitude/longitude. Save transporter GPS or pincode coordinates before dispatch.`), { statusCode: 409 });
  }
  return {
    invoice,
    stop: {
      stopId: makeId("DST"), orderId: String(order._id), orderNo: order.orderNo, invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo,
      customerGlobalId: order.customerGlobalId, customerNameSnapshot: order.customerNameSnapshot, mobileSnapshot: clean(customer.companyContactNumber || customer.ownerMobile || customer.contacts?.[0]?.mobile), salespersonId: order.salespersonId || "", warehouseId: invoice.warehouseId || "",
      destinationType: "TRANSPORTER", destinationNameSnapshot: invoice.transportAssignment?.transporterNameSnapshot || transporter?.name || "Transporter",
      addressSnapshot: station?.address || globalStation?.address || invoice.transportAssignment?.bookingStationAddressSnapshot || "", citySnapshot: station?.city || globalStation?.city || invoice.transportAssignment?.bookingStationCitySnapshot || "", pincodeSnapshot: station?.pincode || globalStation?.pincode || invoice.transportAssignment?.bookingStationPincodeSnapshot || "",
      location: { lat: Number(lat), lng: Number(lng) },
      transporterId: tId, transporterNameSnapshot: invoice.transportAssignment?.transporterNameSnapshot || transporter?.name || "", transporterStationId: stationId || String(station?._id || ""), transporterStationNameSnapshot: station?.name || globalStation?.name || invoice.transportAssignment?.bookingStationNameSnapshot || "",
      packageCount: num(order.packing?.packageCount || invoice.noOfPackages), actualWeight: num(order.packing?.actualWeight), status: "PENDING",
    },
  };
}

function warehouseMaySee(req,order){
  if (upper(req.auth.role)!=="WAREHOUSE") return true;
  const id=clean(req.auth.warehouseId);
  return id && (clean(order.mainWarehouseId)===id || (order.items||[]).some(x=>clean(x.warehouseId)===id || clean(x.currentWarehouseId)===id));
}
async function mainWarehouse(tenantKey){
  return GenericRecord.findOne({tenantKey,app:"dms",resource:"warehouses",status:"ACTIVE","data.isMainWarehouse":true}).select("_id title").lean();
}
async function completePackingWhenReady(req,models,order){
  const allPacked=(order.items||[]).length>0 && (order.items||[]).every(x=>upper(x.warehouseStatus)==="PACKED" && num(x.packedQty)>0 && (!order.mainWarehouseId || clean(x.currentWarehouseId||x.warehouseId)===clean(order.mainWarehouseId)));
  if(!allPacked)return false;
  if(!["SENT_TO_WAREHOUSE","PICKING","PACKING"].includes(upper(order.workflowStatus)))return false;
  if(upper(order.workflowStatus)==="SENT_TO_WAREHOUSE")await transitionOrder({req,models,order,toStatus:"PICKING",note:"Packing in progress"});
  if(upper(order.workflowStatus)==="PICKING")await transitionOrder({req,models,order,toStatus:"PACKING",note:"Packing in progress"});
  order.packing.packedAt=new Date();await order.save();
  await transitionOrder({req,models,order,toStatus:"PACKED",type:"PACKING_COMPLETED",note:"All warehouse packing and transfers confirmed"});
  await transitionOrder({req,models,order,toStatus:"SENT_TO_ORDER_DESK",note:"Ready for invoice generation at Order Desk"});
  return true;
}
function shapeOrder(order) {
  const row = order.toObject ? order.toObject() : order;
  const orderedQty = (row.items || []).reduce((s, x) => s + num(x.qty), 0);
  const packedQty = (row.items || []).reduce((s, x) => s + num(x.packedQty), 0);
  const invoicedQty = (row.items || []).reduce((s, x) => s + num(x.invoicedQty), 0);
  return { ...row, orderedQty, packedQty, invoicedQty, nextAction: row.nextAction || nextAction(row.workflowStatus), isOrderBased: true };
}

router.get("/warehouse-stock",async(req,res)=>{
  try{
    const fy=await getFy(req);
    const warehouseId=upper(req.auth.role)==="WAREHOUSE"?clean(req.auth.warehouseId):clean(req.query.warehouseId);
    if(!warehouseId)return fail(res,"Warehouse is required",400);
    return ok(res,await warehouseStockSnapshot({tenantKey:req.auth.tenantKey,financialYear:fy,warehouseId}));
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});
router.get("/monthly-closings",async(req,res)=>{
  try{
    if(upper(req.auth.role)!=="WAREHOUSE"&&!isAdmin(req.auth))return fail(res,"Only the warehouse or Superadmin can access warehouse reconciliation",403);
    const monthKey=clean(req.query.monthKey)||previousMonth(),warehouseId=upper(req.auth.role)==="WAREHOUSE"?clean(req.auth.warehouseId):clean(req.query.warehouseId);
    if(!warehouseId)return fail(res,"Select a warehouse",400);
    const report=await ensureWarehouseMonthlyClosing({tenantKey:req.auth.tenantKey,warehouseId,monthKey});
    return ok(res,report);
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});
router.post("/monthly-closings",async(req,res)=>{
  try{
    if(upper(req.auth.role)!=="WAREHOUSE")return fail(res,"Warehouse login required to submit actual stock",403);
    const warehouseId=clean(req.auth.warehouseId),monthKey=clean(req.body.monthKey)||previousMonth();
    const report=await ensureWarehouseMonthlyClosing({tenantKey:req.auth.tenantKey,warehouseId,monthKey});
    if(report.status!=="OPEN")return fail(res,"Monthly report was already submitted",409);
    const supplied=new Map((Array.isArray(req.body.rows)?req.body.rows:[]).map(x=>[clean(x.productId),x]));
    for(const row of report.rows){
      const input=supplied.get(clean(row.productId));
      if(!input||input.actual===""||input.actual===null||!Number.isFinite(Number(input.actual))||num(input.actual)<0)return fail(res,`Enter actual quantity for ${row.productName}`,400);
      row.actual=num(input.actual);row.variance=money(row.actual-num(row.expected));row.reason=clean(input.reason);
      if(Math.abs(row.variance)>0.0001&&!row.reason)return fail(res,`Reason for shortage/excess is required: ${row.productName}`,400);
    }
    report.status="SUBMITTED";report.submittedAt=new Date();report.submittedBy=req.auth.sub;
    await report.save();return ok(res,report,"Closing report submitted to Superadmin");
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});
router.post("/monthly-closings/:id/review",async(req,res)=>{
  try{
    if(!isAdmin(req.auth))return fail(res,"Superadmin review only",403);
    const monthKey=clean(req.body.monthKey)||previousMonth();
    const fy=financialYearFromDate(`${monthKey}-01`);
    const report=await financialModels(req.auth.tenantKey,fy).WarehouseClosing.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy});
    if(!report||report.status!=="SUBMITTED")return fail(res,"Submitted report not found",404);
    report.status="REVIEWED";report.reviewedAt=new Date();report.reviewedBy=req.auth.sub;report.reviewRemarks=clean(req.body.remarks);
    await report.save();return ok(res,report,"Monthly stock report reviewed");
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});

// Order-bound transfers. Origin warehouse sends; destination confirms physical receipt.
router.get("/transfers",async(req,res)=>{
  try{
    const fy=await getFy(req),{WarehouseTransfer}=financialModels(req.auth.tenantKey,fy);
    const filter={tenantKey:req.auth.tenantKey,financialYear:fy};
    if(upper(req.auth.role)==="WAREHOUSE")filter.$or=[{fromWarehouseId:clean(req.auth.warehouseId)},{toWarehouseId:clean(req.auth.warehouseId)}];
    if(req.query.orderId)filter.orderId=clean(req.query.orderId);
    return ok(res,{items:await WarehouseTransfer.find(filter).sort({createdAt:-1}).limit(200).lean()});
  }catch(e){return fail(res,e.message,500)}
});
router.post("/transfers",async(req,res)=>{
  try{
    const fy=await getFy(req),models=financialModels(req.auth.tenantKey,fy),order=await requireOrder(req,req.body.orderId,models);
    if(!["SENT_TO_WAREHOUSE","PICKING","PACKING"].includes(upper(order.workflowStatus)))return fail(res,"This order is not available for packing transfers",409);
    const mainId=clean(order.mainWarehouseId);
    if(!mainId)return fail(res,"Permanent Main Warehouse is required",409);
    const fromId=clean(req.body.fromWarehouseId||req.auth.warehouseId),toId=mainId;
    if(!fromId||fromId===toId)return fail(res,"Transfer must originate from another warehouse",400);
    if(upper(req.auth.role)==="WAREHOUSE"&&fromId!==clean(req.auth.warehouseId))return fail(res,"Only source warehouse can transfer these products",403);
    const mode=upper(req.body.mode);
    if(!["PACKED","UNPACKED"].includes(mode))return fail(res,"Select PACKED or UNPACKED transfer",400);
    const rows=Array.isArray(req.body.items)?req.body.items:[];
    if(!rows.length)return fail(res,"Select products with their packages and weight",400);
    const productIds=new Set(),transferItems=[];
    for(const r of rows){
      const id=clean(r.productId),item=(order.items||[]).find(x=>clean(x.productId)===id);
      if(!item||clean(item.warehouseId)!==fromId||clean(item.currentWarehouseId||item.warehouseId)!==fromId)return fail(res,"A selected product does not belong to the source warehouse",403);
      if(productIds.has(id))return fail(res,"Duplicate product in transfer",400);
      productIds.add(id);
      if((mode==="PACKED"&&upper(item.warehouseStatus)!=="PACKED") || (mode==="UNPACKED"&&!['SENT_TO_WAREHOUSE','PICKING','PACKING'].includes(upper(item.warehouseStatus))))return fail(res,`${item.nameSnapshot}: unsuitable packing status for ${mode} transfer`,409);
      if(!Number.isFinite(Number(r.packageCount))||num(r.packageCount)<=0||!Number.isFinite(Number(r.weight))||num(r.weight)<=0)return fail(res,"Product-wise packages and weight must both be greater than zero",400);
      const qty=num(item.qty);
      if(num(r.qty)!==qty)return fail(res,`${item.nameSnapshot}: transfer must contain the entire order-allocated quantity (${qty})`,409);
      transferItems.push({productId:id,productName:item.nameSnapshot,qty,packageCount:num(r.packageCount),weight:num(r.weight)});
    }
    let transferNo=makeId("WTR");while(await models.WarehouseTransfer.exists({tenantKey:req.auth.tenantKey,financialYear:fy,transferNo}))transferNo=makeId("WTR");
    const transfer=await models.WarehouseTransfer.create({tenantKey:req.auth.tenantKey,financialYear:fy,transferNo,orderId:String(order._id),orderNo:order.orderNo,fromWarehouseId:fromId,toWarehouseId:toId,mode,status:"REQUESTED",items:transferItems,requestedAt:new Date(),requestedBy:req.auth.sub});
    for(const item of order.items||[])if(productIds.has(clean(item.productId)))item.warehouseStatus="TRANSFER_REQUESTED";
    await order.save();
    await createEvent({req,models,order,fromStatus:order.workflowStatus,toStatus:order.workflowStatus,type:"TRANSFER_REQUESTED",note:`${mode} transfer ${transferNo} requested`,meta:{transferNo,fromId,toId}});
    return ok(res,transfer,"Stock transfer initiated",201);
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});
router.post("/transfers/:id/receive",async(req,res)=>{
  try{
    const fy=await getFy(req),models=financialModels(req.auth.tenantKey,fy);
    const transfer=await models.WarehouseTransfer.findOne({_id:req.params.id,tenantKey:req.auth.tenantKey,financialYear:fy});
    if(!transfer)return fail(res,"Stock transfer not found",404);
    if(upper(req.auth.role)==="WAREHOUSE"&&clean(req.auth.warehouseId)!==clean(transfer.toWarehouseId))return fail(res,"Only receiving warehouse can confirm receipt",403);
    if(transfer.status!=="REQUESTED")return fail(res,"Transfer is already received",409);
    const order=await requireOrder(req,transfer.orderId,models);
    if(!["SENT_TO_WAREHOUSE","PICKING","PACKING"].includes(upper(order.workflowStatus)))return fail(res,"Order is not in transfer stage",409);
    for(const moved of transfer.items){
      const item=(order.items||[]).find(x=>clean(x.productId)===clean(moved.productId));
      if(!item||upper(item.warehouseStatus)!=="TRANSFER_REQUESTED")return fail(res,"Transfer item no longer awaiting receipt",409);
    }
    for(const moved of transfer.items){
      const item=order.items.find(x=>clean(x.productId)===clean(moved.productId));
      item.currentWarehouseId=clean(transfer.toWarehouseId);
      item.transferReceivedAt=new Date();item.transferMode=transfer.mode;
      item.packageCount=num(moved.packageCount);item.actualWeight=num(moved.weight);
      item.warehouseStatus=transfer.mode==="PACKED"?"PACKED":"TRANSFER_RECEIVED_UNPACKED";
      await models.StockMovement.create({tenantKey:req.auth.tenantKey,financialYear:fy,date:new Date(),productId:moved.productId,warehouseId:transfer.fromWarehouseId,type:"TRANSFER_OUT",qtyOut:moved.qty,qtyIn:0,referenceId:transfer.transferNo});
      await models.StockMovement.create({tenantKey:req.auth.tenantKey,financialYear:fy,date:new Date(),productId:moved.productId,warehouseId:transfer.toWarehouseId,type:"TRANSFER_IN",qtyOut:0,qtyIn:moved.qty,referenceId:transfer.transferNo});
    }
    transfer.status="RECEIVED";transfer.receivedAt=new Date();transfer.receivedBy=req.auth.sub;
    await transfer.save();await order.save();
    // Do not auto-finalize a multi-warehouse order on receipt. The Main Warehouse
    // must first acknowledge the completed collection/packing. No re-entry of
    // packages or weights from earlier PACKED items is required.
    return ok(res,{transfer,order:shapeOrder(order)},"Stock received. Main Warehouse must confirm final packing once all items are packed");
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});

router.get("/orders", async (req, res) => {
  try {
    const financialYear = await getFy(req);
    const { SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const page = Math.max(1, num(req.query.page) || 1), limit = Math.min(200, Math.max(10, num(req.query.limit) || 50));
    const filter = { tenantKey: req.auth.tenantKey, financialYear };
    if (req.query.workflowStatus) filter.workflowStatus = upper(req.query.workflowStatus);
    if (req.query.salespersonId) filter.salespersonId = clean(req.query.salespersonId);
    if (req.query.customerGlobalId) filter.customerGlobalId = clean(req.query.customerGlobalId);
    // Warehouse-role users only see orders containing products routed to their warehouse.
    if (upper(req.auth?.role) === "WAREHOUSE") {
      filter.$or = [{"items.warehouseId":clean(req.auth.warehouseId)},{mainWarehouseId:clean(req.auth.warehouseId)},{"items.currentWarehouseId":clean(req.auth.warehouseId)}];
    }
    const search = clean(req.query.search);
    if (search) filter.$and=[{$or:[{orderNo:{$regex:search,$options:"i"}},{customerNameSnapshot:{$regex:search,$options:"i"}}]}];
    const [items, total] = await Promise.all([
      SalesOrder.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      SalesOrder.countDocuments(filter),
    ]);
    return ok(res, { financialYear, items: items.map(shapeOrder), meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const order = await requireOrder(req, req.params.id, models);
    if (upper(req.auth.role)==="WAREHOUSE" && !warehouseMaySee(req,order)) return fail(res,"Order is not assigned to your warehouse",403);
    const events = await models.OrderEvent.find({ tenantKey: req.auth.tenantKey, financialYear, orderId: String(order._id) }).sort({ occurredAt: 1 }).lean();
    const creditNotes = await models.CreditNote.find({ tenantKey: req.auth.tenantKey, financialYear, orderId: String(order._id) }).sort({ createdAt: -1 }).lean();
    return ok(res, { order: shapeOrder(order), events, creditNotes });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/orders/:id/warehouse-preview", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const order = await requireOrder(req, req.params.id, models);
    if (["DELIVERED", "CLOSED", "CANCELLED", "REJECTED"].includes(upper(order.workflowStatus))) return fail(res, "This order cannot be released to warehouse", 409);
    if (order.invoice?.invoiceId || (order.invoices || []).some((x) => x?.invoiceId)) return fail(res, "This order is already invoiced", 409);

    const [warehouseRows, productRows] = await Promise.all([
      GenericRecord.find({ tenantKey: req.auth.tenantKey, app: "dms", resource: "warehouses", status: "ACTIVE" })
        .select("_id title reference name value")
        .sort({ title: 1, reference: 1 })
        .lean(),
      Product.find({ tenantKey: req.auth.tenantKey, _id: { $in: (order.items || []).map((x) => x.productId) } })
        .select("_id warehouseId")
        .lean(),
    ]);
    const productWarehouse = new Map(productRows.map((x) => [String(x._id), clean(x.warehouseId)]));
    const whMap = new Map(warehouseRows.map((w) => [String(w._id), clean(w.title || w.reference || w.name || w.value || "Warehouse")]));
    const items = (order.items || []).map((x) => {
      const defaultWarehouseId = clean(x.warehouseId) || productWarehouse.get(String(x.productId)) || clean(order.warehouseId);
      return {
        productId: x.productId,
        productName: x.nameSnapshot || x.sku || "Product",
        productHsn: x.hsnSnapshot || "",
        qty: num(x.qty),
        basicRate: money(x.rate),
        warehouseId: defaultWarehouseId,
        warehouseName: clean(x.warehouseNameSnapshot) || whMap.get(defaultWarehouseId) || "",
      };
    });
    return ok(res, {
      financialYear,
      orderId: String(order._id),
      orderNo: order.orderNo,
      customerGlobalId: order.customerGlobalId,
      partyName: order.customerNameSnapshot || "Customer",
      // The statutory invoice number is allocated only when Order Desk posts the invoice.
      // Showing AUTO here avoids reserving/reusing an invoice number before posting.
      invoiceNo: order.invoice?.invoiceNo || "AUTO ON GENERATE",
      date: order.date || order.createdAt,
      items,
      warehouses: warehouseRows.map((w) => ({ _id: String(w._id), name: clean(w.title || w.reference || w.name || w.value || "Warehouse") })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/release-to-warehouse", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const order = await requireOrder(req, req.params.id, models);
    const status = upper(order.workflowStatus || "ORDER_PLACED");
    if (["CREDIT_HOLD", "OTP_PENDING"].includes(status)) return fail(res, `Order cannot be sent to warehouse while ${status.replaceAll("_", " ")}`, 409);
    if (["INVOICED", "INVOICED_PARTIAL", "DELIVERED", "CLOSED", "CANCELLED", "REJECTED"].includes(status)) return fail(res, `Order cannot be sent to warehouse from ${status}`, 409);
    if (order.customerOtpRequired && !order.customerOtpVerifiedAt) return fail(res, "Customer OTP verification is pending", 409);

    const supplied = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((x) => [clean(x.productId), clean(x.warehouseId)]));
    const warehouseIds = [...new Set((order.items || []).map((x) => supplied.get(clean(x.productId))).filter(Boolean))];
    if ((order.items || []).some((x) => !supplied.get(clean(x.productId)))) return fail(res, "Select a warehouse for every product", 400);
    const warehouses = await GenericRecord.find({ _id: { $in: warehouseIds }, tenantKey: req.auth.tenantKey, app: "dms", resource: "warehouses", status: "ACTIVE" })
      .select("_id title reference name value")
      .lean();
    if (warehouses.length !== warehouseIds.length) return fail(res, "One or more selected warehouses are not active", 400);
    const whMap = new Map(warehouses.map((w) => [String(w._id), clean(w.title || w.reference || w.name || w.value || "Warehouse")]));
    const designatedMain = await mainWarehouse(req.auth.tenantKey);
    if (warehouseIds.length>1 && !designatedMain) return fail(res,"Set the permanent Main Warehouse before forwarding multi-warehouse orders",409);

    // Customer App orders may already be atomically reserved at order placement.
    // Legacy/DMS orders are reserved here before warehouse routing.
    if (upper(order.reservation?.status) !== "RESERVED") await reserveOrderStock(order, req.auth.tenantKey);
    if (upper(order.workflowStatus) === "ORDER_PLACED") await transitionOrder({ req, models, order, toStatus: "VERIFIED", note: "Order verified for warehouse release" });
    if (upper(order.workflowStatus) === "VERIFIED") await transitionOrder({ req, models, order, toStatus: "STOCK_RESERVED", note: "Stock reserved for warehouse release", type: "STOCK_RESERVED" });
    if (upper(order.workflowStatus) !== "STOCK_RESERVED" && upper(order.workflowStatus) !== "SENT_TO_WAREHOUSE") return fail(res, `Order cannot be released to warehouse from ${order.workflowStatus}`, 409);

    const assignedIds = [];
    for (const item of order.items || []) {
      const warehouseId = supplied.get(clean(item.productId));
      item.warehouseId = warehouseId;
      item.warehouseNameSnapshot = whMap.get(warehouseId) || "Warehouse";
      item.warehouseStatus = "SENT_TO_WAREHOUSE";
      item.currentWarehouseId = warehouseId;
      assignedIds.push(warehouseId);
    }
    const uniqueAssigned = [...new Set(assignedIds)];
    order.mainWarehouseId = uniqueAssigned.length>1 ? clean(designatedMain?._id) : uniqueAssigned[0];
    order.warehouseId = uniqueAssigned.length === 1 ? uniqueAssigned[0] : "";
    order.warehouseNameSnapshot = uniqueAssigned.length === 1 ? whMap.get(uniqueAssigned[0]) : "MULTIPLE WAREHOUSES";
    await order.save();

    if (upper(order.workflowStatus) !== "SENT_TO_WAREHOUSE") {
      await transitionOrder({
        req, models, order, toStatus: "SENT_TO_WAREHOUSE",
        note: uniqueAssigned.length === 1 ? `Order sent to ${whMap.get(uniqueAssigned[0])}` : `Order split across ${uniqueAssigned.length} warehouses`,
        type: "WAREHOUSE_RELEASED",
        meta: { warehouses: uniqueAssigned.map((id) => ({ warehouseId: id, warehouseName: whMap.get(id) })) },
      });
    }
    return ok(res, shapeOrder(order), "Order sent to warehouse");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.delete("/orders/:id", async (req, res) => {
  try {
    const financialYear = await getFy(req);
    const models = financialModels(req.auth.tenantKey, financialYear);
    const order = await requireOrder(req, req.params.id, models);
    const terminal = upper(order.workflowStatus);
    if (["DELIVERED", "CLOSED"].includes(terminal)) return fail(res, "A delivered/completed order cannot be deleted", 409);
    if (order.invoice?.invoiceId || (order.invoices || []).some((x) => x?.invoiceId)) return fail(res, "This order already has a posted invoice. Cancel/reverse the invoice instead of deleting the order.", 409);
    const orderId = String(order._id);
    const orderNo = order.orderNo;

    // Deleting an order is a true hard delete. First release any stock still
    // reserved by the order so Product.reservedStock does not become orphaned.
    const releasedQty = await releaseOrderReservation(
      order,
      req.auth.tenantKey,
      "Sales order permanently deleted",
    );

    // Remove order-only workflow history/notifications and detach the order from
    // any delivery run. Posted invoices / credit notes remain independent records.
    await Promise.all([
      models.OrderEvent.deleteMany({ tenantKey: req.auth.tenantKey, financialYear, orderId }),
      models.OrderNotification.deleteMany({ tenantKey: req.auth.tenantKey, financialYear, orderId }),
      models.DeliveryRun.updateMany(
        { tenantKey: req.auth.tenantKey, financialYear, "stops.orderId": orderId },
        { $pull: { stops: { orderId } } },
      ),
    ]);

    await models.SalesOrder.deleteOne({
      _id: order._id,
      tenantKey: req.auth.tenantKey,
      financialYear,
    });

    return ok(
      res,
      { _id: orderId, orderNo, deleted: true, hardDeleted: true, releasedReservedQty: releasedQty },
      "Sales order permanently deleted from database",
    );
  } catch (error) {
    return fail(res, error.message, error.statusCode || 500);
  }
});

router.get("/orders/:id/invoice-draft", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const order = await requireOrder(req, req.params.id, models);
    if (!["SENT_TO_ORDER_DESK", "INVOICED_PARTIAL", "PACKED"].includes(upper(order.workflowStatus))) return fail(res, `Order ${order.orderNo} is not ready for invoicing`, 409);
    const items = (order.items || []).map((x) => {
      const available = Math.max(0, num(x.packedQty) - num(x.invoicedQty));
      return {
        productId: x.productId, sku: x.sku, nameSnapshot: x.nameSnapshot, qty: available,
        unit: x.unit, packingUnit: x.packingUnit, qtyInBag: x.qtyInBag,
        saleRate: x.rate, // retain the previous field for existing API consumers
        // Grade and optional Disc are independent. The basic rate sent to
        // Invoice already reflects the grade exactly once.
        ...orderItemInvoicePrice(x), gstRate: x.gstRateSnapshot,
      };
    }).filter((x) => x.qty > 0);
    if (!items.length) return fail(res, "No newly packed quantity is available to invoice", 409);
    return ok(res, {
      financialYear,
      orderId: String(order._id), orderNo: order.orderNo,
      customerGlobalId: order.customerGlobalId, customerName: order.customerNameSnapshot,
      warehouseId: clean(order.mainWarehouseId||order.warehouseId), warehouseName: clean(order.warehouseNameSnapshot),
      packageCount: num(order.packing?.packageCount), actualWeight: num(order.packing?.actualWeight),
      items,
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/customer-otp", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const order = await requireOrder(req, req.params.id, models);
    const customer = await CustomerLink.findOne({ tenantKey: req.auth.tenantKey, globalCustomerId: order.customerGlobalId }).lean();
    const recipientId = order.customerGlobalId;
    const result = await createOtp({ tenantKey: req.auth.tenantKey, transactionId: String(order._id), actionType: "ORDER_CUSTOMER_CONFIRM", recipientId, context: { orderNo: order.orderNo, mobile: clean(customer?.companyContactNumber || customer?.ownerMobile || customer?.contacts?.[0]?.mobile) } });
    order.customerOtpRequired = true; order.customerOtpId = result.otpId; order.workflowStatus = "OTP_PENDING"; order.nextAction = nextAction("OTP_PENDING"); order.lastWorkflowAt = new Date(); await order.save();
    await createEvent({ req, models, order, fromStatus: "ORDER_PLACED", toStatus: "OTP_PENDING", type: "OTP_REQUESTED", note: "Customer confirmation OTP requested" });
    return ok(res, { otpId: result.otpId, expiresAt: result.expiresAt, devCode: process.env.NODE_ENV === "production" ? undefined : result.code }, "Customer OTP created");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/customer-otp/verify", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear), order = await requireOrder(req, req.params.id, models);
    if (!isAdmin(req.auth) && (upper(req.auth.role) !== "SALESPERSON" && upper(req.auth.role) !== "SALES_PERSON" || clean(order.salespersonId) !== clean(req.auth.sub)))
      return fail(res,"Only the assigned Salesperson or Superadmin can verify this order OTP",403);
    if (req.body.otpId && clean(req.body.otpId)!==clean(order.customerOtpId)) return fail(res,"This OTP was replaced; ask the customer for their latest code",409);
    await verifyChallenge({ otpId: order.customerOtpId, code: req.body.code, transactionId: String(order._id), allowedActions: ["ORDER_CUSTOMER_CONFIRM"] });
    order.customerOtpVerifiedAt = new Date(); order.customerOtpId = req.body.otpId || order.customerOtpId; await order.save();
    await transitionOrder({ req, models, order, toStatus: "ORDER_PLACED", note: "Customer verified the order by OTP", type: "CUSTOMER_OTP_VERIFIED" });
    return ok(res, shapeOrder(order), "Customer order verification completed");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/verify-and-reserve", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear), order = await requireOrder(req, req.params.id, models);
    const status = upper(order.workflowStatus || "ORDER_PLACED");
    if (order.customerOtpRequired && !order.customerOtpVerifiedAt) return fail(res, "Customer OTP verification is pending", 409);
    if (!["ORDER_PLACED", "VERIFIED"].includes(status)) return fail(res, `Order cannot be verified from ${status}`, 409);
    if (status === "ORDER_PLACED") await transitionOrder({ req, models, order, toStatus: "VERIFIED", note: clean(req.body.remarks) || "Order verified" });
    await reserveOrderStock(order, req.auth.tenantKey);
    await transitionOrder({ req, models, order, toStatus: "STOCK_RESERVED", note: "Available-to-Promise stock reserved for this order", type: "STOCK_RESERVED", meta: { items: (order.items || []).map((x) => ({ productId: x.productId, qty: x.reservedQty })) } });
    return ok(res, shapeOrder(order), "Order verified and stock reserved");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/transition", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear), order = await requireOrder(req, req.params.id, models);
    const to = upper(req.body.toStatus);
    if (!to) return fail(res, "toStatus is required", 400);
    if (to === "CANCELLED") return fail(res,"Use Order Cancellation (Phase 2) to enforce OTP, stock handover, Credit Note and ledger credit",409);
    if (to === "CANCELLED") {
      if (["DELIVERED", "CLOSED"].includes(upper(order.workflowStatus))) return fail(res, "A delivered/completed order cannot be cancelled", 409);
      if (order.deliveryRunId || ["DELIVERY_ASSIGNED","OUT_FOR_DELIVERY","DELIVERY_FAILED","RETURN_IN_TRANSIT"].includes(upper(order.workflowStatus))) return fail(res,"Delivery Boy handover and cancellation OTP are required; this cancellation stage is not enabled yet",409);
      const transferredStock = await models.WarehouseTransfer.exists({tenantKey:req.auth.tenantKey,financialYear,orderId:String(order._id),status:{$in:["REQUESTED","RECEIVED"]}});
      if(transferredStock)return fail(res,"This order has warehouse transfers. Reverse transfer and verified cancellation must be completed before cancelling; this stage is not enabled yet",409);

      // If Order Desk has already posted an invoice but it has NOT been delivered,
      // cancel it safely: reverse accounting + stock, retain the invoice as a
      // CANCELLED audit document, then cancel the order. A delivered invoice/order
      // is never reversible from this action.
      const linkedIds = [...new Set([
        clean(order.invoice?.invoiceId),
        ...(order.invoices || []).map((x) => clean(x?.invoiceId)),
      ].filter(Boolean))];
      if (linkedIds.length) {
        const linkedInvoices = await models.SalesInvoice.find({ _id: { $in: linkedIds }, tenantKey: req.auth.tenantKey, financialYear });
        for (const invoice of linkedInvoices) {
          if (upper(invoice.workflowStatus) === "DELIVERED" || invoice.delivery?.deliveredAt) return fail(res, `Invoice ${invoice.invoiceNo} is already delivered; the order cannot be cancelled`, 409);
          const issuedNote = await models.CreditNote.exists({
            tenantKey: req.auth.tenantKey,
            financialYear,
            status: "ISSUED",
            $or: [{ invoiceId: String(invoice._id) }, { referenceDocumentId: String(invoice._id) }],
          });
          if (issuedNote) return fail(res, `Invoice ${invoice.invoiceNo} has an issued credit note and cannot be cancelled from the order`, 409);
        }
        for (const invoice of linkedInvoices) {
          if (upper(invoice.status) !== "CANCELLED") {
            await reversePostedTransaction({ tenantKey: req.auth.tenantKey, financialYear, transactionId: invoice.invoiceNo, reason: `Order ${order.orderNo} cancelled` });
            // The order-linked invoice did not reduce physical stock at posting.
            // Therefore cancelling it BEFORE delivery must not increase stock.
            // Physical return handling and CN workflow are a separate later phase.
            invoice.status = "CANCELLED";
            invoice.workflowStatus = "CANCELLED";
            await invoice.save();
          }
        }
      }
    }
    if (["CANCELLED", "REJECTED"].includes(to)) await releaseOrderReservation(order, req.auth.tenantKey, clean(req.body.remarks) || to);
    await transitionOrder({ req, models, order, toStatus: to, note: clean(req.body.remarks) });
    return ok(res, shapeOrder(order), `Order moved to ${to}`);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/packing/start", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear), order = await requireOrder(req, req.params.id, models);
    const status = upper(order.workflowStatus);
    if (status === "STOCK_RESERVED") await transitionOrder({ req, models, order, toStatus: "SENT_TO_WAREHOUSE", note: "Order released to warehouse" });
    if (upper(order.workflowStatus) === "SENT_TO_WAREHOUSE") await transitionOrder({ req, models, order, toStatus: "PICKING", note: "Warehouse picking started" });
    if (upper(order.workflowStatus) === "PICKING") await transitionOrder({ req, models, order, toStatus: "PACKING", note: "Packing started" });
    if (upper(order.workflowStatus) !== "PACKING") return fail(res, `Order cannot start packing from ${order.workflowStatus}`, 409);
    order.packing.startedAt = order.packing.startedAt || new Date(); await order.save();
    return ok(res, shapeOrder(order), "Packing started");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/orders/:id/packing/complete", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear), order = await requireOrder(req, req.params.id, models);

    // A warehouse should only need one action: MARK PACKED. If packing was not
    // explicitly started first, advance the order into PACKING automatically.
    if (upper(order.workflowStatus) === "SENT_TO_WAREHOUSE") {
      await transitionOrder({ req, models, order, toStatus: "PICKING", note: "Warehouse picking started" });
    }
    if (upper(order.workflowStatus) === "PICKING") {
      await transitionOrder({ req, models, order, toStatus: "PACKING", note: "Warehouse packing started" });
    }
    if (upper(order.workflowStatus) !== "PACKING") return fail(res, `Order must be in warehouse packing status`, 409);
    // Main Warehouse may pack its OWN products while other warehouse transfers
    // are still in transit. The final order-wide confirmation is a later action.

    const rows = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rows.length) return fail(res, "At least one packed product is required", 400);
    const supplied = new Map(rows.map((x) => [clean(x.productId), x]));
    const scopedWarehouseId = req.auth?.dataScope === "WAREHOUSE"
      ? clean(req.auth?.warehouseId)
      : clean(req.body.warehouseId);
    const now = new Date();
    let changedPacked = 0;

    for (const item of order.items || []) {
      const row = supplied.get(clean(item.productId));
      if (!row) continue; // Products routed to another warehouse stay untouched.
      if (scopedWarehouseId && clean(item.currentWarehouseId||item.warehouseId) !== scopedWarehouseId) {
        return fail(res, `${item.nameSnapshot || item.sku} is physically assigned to another warehouse`, 403);
      }
      if (["TRANSFER_REQUESTED","PACKED"].includes(upper(item.warehouseStatus))) return fail(res,`${item.nameSnapshot||item.sku} is already packed/in transfer`,409);
      if (!clean(item.warehouseId)) return fail(res, `${item.nameSnapshot || item.sku} has no warehouse assignment`, 409);

      const packed = clamp(row.packedQty, num(item.invoicedQty), num(item.qty));
      if (packed > num(item.reservedQty)) return fail(res, `${item.nameSnapshot || item.sku}: packed quantity cannot exceed reserved quantity`, 409);
      item.packedQty = packed;
      item.shortageReason = clean(row?.shortageReason);
      if (!Number.isFinite(Number(row.packageCount)) || num(row.packageCount)<0 || !Number.isFinite(Number(row.actualWeight)) || num(row.actualWeight)<0) return fail(res,"Valid product-wise packages and weight are required",400);
      if (num(row.damagedQty)>0 && !clean(row.shortageReason)) return fail(res,"Damaged/short product requires a remark",400);
      item.packageCount = num(row.packageCount);
      item.actualWeight = num(row.actualWeight);
      item.damagedQty = num(row.damagedQty);
      item.warehouseStatus = "PACKED";
      item.warehousePackedAt = now;
      item.warehousePackedBy = req.auth.sub;
      item.warehousePackedByNameSnapshot = req.auth.name || "";
      changedPacked += packed;
    }
    if (changedPacked <= 0) return fail(res, "At least one product must have a packed quantity", 400);

    order.packing.packageCount = (order.items||[]).reduce((s,x)=>s+num(x.packageCount),0);
    order.packing.actualWeight = (order.items||[]).reduce((s,x)=>s+num(x.actualWeight),0);
    order.packing.remarks = clean(req.body.remarks) || clean(order.packing?.remarks);
    order.packing.startedAt = order.packing.startedAt || now;
    order.packing.packedBy = req.auth.sub;
    order.packing.packedByNameSnapshot = req.auth.name || "";

    // Multi-warehouse orders stay in PACKING until every routed product is marked
    // PACKED. The last warehouse to finish automatically sends it to Order Desk.
    const allWarehousePacked = (order.items || []).length > 0 && (order.items || []).every((item) =>
      clean(item.warehouseId) && upper(item.warehouseStatus) === "PACKED" &&
      (!order.mainWarehouseId || clean(item.currentWarehouseId||item.warehouseId)===clean(order.mainWarehouseId))
    );
    if (allWarehousePacked && new Set((order.items||[]).map(x=>clean(x.warehouseId))).size===1) order.packing.packedAt = now;
    await order.save();

    if (allWarehousePacked && new Set((order.items||[]).map(x=>clean(x.warehouseId))).size===1) {
      const totalPacked = (order.items || []).reduce((sum, item) => sum + num(item.packedQty), 0);
      await transitionOrder({
        req, models, order, toStatus: "PACKED",
        note: `All warehouses completed packing • ${money(totalPacked)} units • ${order.packing.packageCount || 0} package(s)`,
        type: "PACKING_COMPLETED",
        meta: { packageCount: order.packing.packageCount, actualWeight: order.packing.actualWeight },
      });
      await transitionOrder({
        req, models, order, toStatus: "SENT_TO_ORDER_DESK",
        note: "Packing completed and order sent to Order Desk for invoice generation",
        type: "SENT_TO_ORDER_DESK",
      });
      return ok(res, shapeOrder(order), "Packing completed and sent to Order Desk");
    }

    return ok(res, shapeOrder(order), allWarehousePacked ? "All packed. Confirm at Main Warehouse to send the order to Order Desk" : "Warehouse packing saved; waiting for remaining packing / transfers");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// No re-packing and no duplicated packages/weights: an order-wide confirmation
// after all incoming PACKED transfers have physically reached Main Warehouse.
router.post("/orders/:id/packing/confirm",async(req,res)=>{
  try{
    const fy=await getFy(req),models=financialModels(req.auth.tenantKey,fy);
    const order=await requireOrder(req,req.params.id,models);
    const mainId=clean(order.mainWarehouseId);
    if(!mainId)return fail(res,"Main Warehouse is not configured",409);
    if(upper(req.auth.role)==="WAREHOUSE" && clean(req.auth.warehouseId)!==mainId)
      return fail(res,"Only the Main Warehouse can confirm packing",403);
    if(upper(req.auth.role)!=="WAREHOUSE"&&!isAdmin(req.auth))return fail(res,"Main Warehouse authorization required",403);
    const origins=new Set((order.items||[]).map(x=>clean(x.warehouseId)));
    if(origins.size<2)return fail(res,"Packing confirmation without re-entry is for multi-warehouse orders",409);
    if((order.items||[]).some(x=>clean(x.currentWarehouseId||x.warehouseId)!==mainId || upper(x.warehouseStatus)!=="PACKED" || num(x.packedQty)<=0))
      return fail(res,"Every product must be received at Main Warehouse and marked packed before confirmation",409);
    const waiting=await models.WarehouseTransfer.exists({tenantKey:req.auth.tenantKey,financialYear:fy,orderId:String(order._id),status:"REQUESTED"});
    if(waiting)return fail(res,"Receive every pending stock transfer first",409);
    const changed=await completePackingWhenReady(req,models,order);
    if(!changed)return fail(res,"Order is not in a confirmable packing stage",409);
    return ok(res,shapeOrder(order),"All previously packed items confirmed. Order returned to Order Desk for invoicing");
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});

router.get("/delivery-boys", async (req, res) => {
  try {
    const items = await User.find({tenantKey:req.auth.tenantKey,status:"ACTIVE",loginEnabled:{$ne:false},role:"DELIVERY_BOY"}).select("_id name mobile designation role roleId warehouseId branchId").sort({name:1}).lean();
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, 500); }
});

router.post("/orders/:id/assign-delivery",async(req,res)=>{
  try{
    const fy=await getFy(req),models=financialModels(req.auth.tenantKey,fy),order=await requireOrder(req,req.params.id,models);
    if(upper(order.workflowStatus)!=="INVOICED")return fail(res,"Order must have its complete invoice before delivery assignment",409);
    if(order.deliveryRunId)return fail(res,"This order is already assigned",409);
    const mainId=clean(order.mainWarehouseId);
    if(!mainId)return fail(res,"Order has no designated dispatch warehouse",409);
    if(upper(req.auth.role)==="WAREHOUSE" && clean(req.auth.warehouseId)!==mainId)return fail(res,"Only the Main/dispatch Warehouse can assign delivery",403);
    if(!["MASTER","SUPERADMIN","WAREHOUSE"].includes(upper(req.auth.role)))return fail(res,"Delivery assignment requires warehouse or admin access",403);
    if((order.items||[]).some(x=>upper(x.warehouseStatus)!=="PACKED" || clean(x.currentWarehouseId||x.warehouseId)!==mainId))return fail(res,"All packed products must be received by the dispatch Warehouse",409);
    const boy=await User.findOne({_id:clean(req.body.deliveryBoyId),tenantKey:req.auth.tenantKey,status:"ACTIVE",loginEnabled:{$ne:false},role:"DELIVERY_BOY"}).select("_id name mobile").lean();
    if(!boy)return fail(res,"Select an active user having Delivery Boy role",400);
    // A warehouse assignment is not route optimization: coordinates are optional.
    // Do not block Delivery Boy assignment because an address lacks GPS details.
    const {customer,invoice}=await customerAndInvoice(models,order);
    if(!invoice)return fail(res,"The full order invoice must be posted first",409);
    const remote=upper(invoice.transportAssignment?.mode||customer?.regionType||order.deliveryType||"LOCAL")!=="LOCAL";
    const {address,point}=localCustomerPoint(customer||{});
    const stop={
      stopId:makeId("DST"),orderId:String(order._id),orderNo:order.orderNo,
      invoiceId:String(invoice._id),invoiceNo:invoice.invoiceNo,
      customerGlobalId:order.customerGlobalId,customerNameSnapshot:order.customerNameSnapshot,
      mobileSnapshot:clean(customer?.companyContactNumber||customer?.ownerMobile||customer?.contacts?.[0]?.mobile),
      salespersonId:order.salespersonId||"",warehouseId:mainId,
      destinationType:remote?"TRANSPORTER":"CUSTOMER",
      destinationNameSnapshot:remote?(invoice.transportAssignment?.transporterNameSnapshot||"Transporter"):order.customerNameSnapshot,
      addressSnapshot:remote?(invoice.transportAssignment?.bookingStationAddressSnapshot||""):clean(address?.address||invoice.addressSnapshot),
      citySnapshot:remote?(invoice.transportAssignment?.bookingStationCitySnapshot||""):clean(address?.city),
      pincodeSnapshot:remote?(invoice.transportAssignment?.bookingStationPincodeSnapshot||""):clean(address?.pincode),
      ...(point&&!remote?{location:point}:{}),
      transporterId:remote?clean(invoice.transportAssignment?.transporterId):"",
      transporterNameSnapshot:remote?clean(invoice.transportAssignment?.transporterNameSnapshot):"",
      transporterStationId:remote?clean(invoice.transportAssignment?.bookingStationId):"",
      transporterStationNameSnapshot:remote?clean(invoice.transportAssignment?.bookingStationNameSnapshot):"",
      packageCount:num(order.packing?.packageCount||invoice.noOfPackages),
      actualWeight:num(order.packing?.actualWeight),status:"PENDING"
    };
    let runNo=makeId("RUN");while(await models.DeliveryRun.exists({tenantKey:req.auth.tenantKey,financialYear:fy,runNo}))runNo=makeId("RUN");
    const run=await models.DeliveryRun.create({tenantKey:req.auth.tenantKey,financialYear:fy,runNo,date:new Date(),deliveryBoyId:String(boy._id),deliveryBoyNameSnapshot:boy.name,status:"PLANNED",stops:[stop],createdBy:req.auth.sub,createdByNameSnapshot:req.auth.name||""});
    // Physical stock leaves Main Warehouse custody at assignment; invoice remains Pending.
    // Delivery then settles custody and records SALES OUTWARD exactly once.
    if(!order.dispatchCustody?.recordedAt){
      for(const it of order.items||[]){
        const qty=num(it.packedQty)||num(it.qty);
        if(qty>0)await models.StockMovement.create({tenantKey:req.auth.tenantKey,financialYear:fy,date:new Date(),productId:it.productId,warehouseId:mainId,type:"DELIVERY_CUSTODY_OUT",qtyIn:0,qtyOut:qty,referenceId:order.orderNo});
      }
      order.dispatchCustody={recordedAt:new Date()};
    }
    order.deliveryRunId=String(run._id);
    order.deliveryType=stop.destinationType==="TRANSPORTER"?"TRANSPORTER":"LOCAL";
    await order.save();
    await transitionOrder({req,models,order,toStatus:"READY_FOR_DISPATCH",type:"READY_FOR_DISPATCH",note:"Invoice returned to Main Warehouse for delivery assignment"});
    await transitionOrder({req,models,order,toStatus:"DELIVERY_ASSIGNED",type:"DELIVERY_ASSIGNED",note:`Assigned to ${boy.name}`,meta:{deliveryBoyId:String(boy._id),runNo}});
    return ok(res,{order:shapeOrder(order),run},"Delivery Boy assigned successfully");
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});

router.get("/warehouse-users", async (req, res) => {
  try {
    const rx = /warehouse|store|dispatch/i;
    const warehouseId = clean(req.query.warehouseId);
    const base = { tenantKey: req.auth.tenantKey, status: "ACTIVE", $or: [{ designation: rx }, { accountType: rx }, { role: rx }, { department: rx }] };
    if (warehouseId) base.warehouseId = warehouseId;
    let items = await User.find(base).select("_id name mobile designation role warehouseId branchId").sort({ name: 1 }).lean();
    if (!items.length && warehouseId) items = await User.find({ tenantKey: req.auth.tenantKey, status: "ACTIVE", warehouseId }).select("_id name mobile designation role warehouseId branchId").sort({ name: 1 }).lean();
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, 500); }
});

router.post("/delivery-runs", async (req, res) => {
  try {
    // New order-linked invoices are assigned only from the Main Warehouse App.
    // Legacy optimized-route creation cannot bypass the custody handoff.
    return fail(res,"Assign Delivery Boy in the Main Warehouse App",409);
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const orderIds = [...new Set((Array.isArray(req.body.orderIds) ? req.body.orderIds : []).map(clean).filter(Boolean))];
    if (!orderIds.length) return fail(res, "Select at least one invoiced order", 400);
    const start = { lat: Number(req.body.startLocation?.lat), lng: Number(req.body.startLocation?.lng) };
    if (!validCoord(start.lat, start.lng)) return fail(res, "Dispatch start latitude and longitude are required", 400);
    const deliveryBoyId = clean(req.body.deliveryBoyId);
    if (!deliveryBoyId) return fail(res, "Delivery boy is required", 400);
    const deliveryBoy = await User.findOne({ _id: deliveryBoyId, tenantKey: req.auth.tenantKey, status: "ACTIVE" }).lean();
    if (!deliveryBoy) return fail(res, "Delivery boy not found", 404);
    const orders = await models.SalesOrder.find({ _id: { $in: orderIds }, tenantKey: req.auth.tenantKey, financialYear });
    if (orders.length !== orderIds.length) return fail(res, "One or more orders were not found in this financial year", 404);
    const stops = [];
    for (const order of orders) {
      if (!["INVOICED", "INVOICED_PARTIAL", "READY_FOR_DISPATCH"].includes(upper(order.workflowStatus))) return fail(res, `${order.orderNo} is not ready for dispatch`, 409);
      const { stop } = await destinationForOrder(models, order);
      stops.push(stop);
    }
    const optimized = optimizeStops(stops, start);
    let runNo = makeId("RUN"); while (await models.DeliveryRun.exists({ tenantKey: req.auth.tenantKey, financialYear, runNo })) runNo = makeId("RUN");
    const run = await models.DeliveryRun.create({ tenantKey: req.auth.tenantKey, financialYear, runNo, date: new Date(), deliveryBoyId, deliveryBoyNameSnapshot: deliveryBoy.name, vehicleNo: clean(req.body.vehicleNo), status: "PLANNED", startLocation: start, currentLocation: start, estimatedDistanceMeters: optimized.reduce((s, x) => s + num(x.estimatedDistanceFromPreviousMeters), 0), estimatedTravelMinutes: optimized.reduce((s, x) => s + num(x.estimatedTravelMinutes), 0), stops: optimized, createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "", updatedBy: req.auth.sub });
    for (const order of orders) {
      order.deliveryRunId = String(run._id); order.deliveryType = optimized.find((x) => x.orderId === String(order._id))?.destinationType === "TRANSPORTER" ? "TRANSPORTER" : "LOCAL"; await order.save();
      await transitionOrder({ req, models, order, toStatus: "DELIVERY_ASSIGNED", note: `Assigned to ${deliveryBoy.name} on ${runNo}`, type: "DELIVERY_ASSIGNED", meta: { runId: String(run._id), runNo, deliveryBoyId, deliveryBoyName: deliveryBoy.name } });
    }
    return ok(res, run, "Delivery route optimized and assigned", 201);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/delivery-runs", async (req, res) => {
  try {
    const financialYear = await getFy(req), { DeliveryRun } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear };
    if (!isAdmin(req.auth)) filter.deliveryBoyId = clean(req.auth.sub);
    else if (req.query.deliveryBoyId) filter.deliveryBoyId = clean(req.query.deliveryBoyId);
    if (req.query.status) filter.status = upper(req.query.status);
    const items = await DeliveryRun.find(filter).sort({ date: -1, createdAt: -1 }).limit(100).lean();
    return ok(res, { financialYear, items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/delivery-runs/:id", async (req, res) => {
  try {
    const financialYear = await getFy(req), { DeliveryRun } = financialModels(req.auth.tenantKey, financialYear);
    const run = await DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }).lean();
    if (!run) return fail(res, "Delivery run not found", 404);
    if (!isAdmin(req.auth) && clean(run.deliveryBoyId) !== clean(req.auth.sub)) return fail(res, "This delivery run is not assigned to you", 403);
    return ok(res, run);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/start", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const run = await models.DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!run) return fail(res, "Delivery run not found", 404);
    if (!isAdmin(req.auth) && clean(run.deliveryBoyId) !== clean(req.auth.sub)) return fail(res, "This delivery run is not assigned to you", 403);
    if (run.status === "COMPLETED") return fail(res, "Delivery run is already completed", 409);
    run.status = "IN_PROGRESS"; run.startedAt = run.startedAt || new Date(); run.updatedBy = req.auth.sub; await run.save();
    for (const stop of run.stops || []) {
      const order = await models.SalesOrder.findOne({ _id: stop.orderId, tenantKey: req.auth.tenantKey, financialYear });
      if (order && upper(order.workflowStatus) === "DELIVERY_ASSIGNED") await transitionOrder({ req, models, order, toStatus: "OUT_FOR_DELIVERY", note: `${run.runNo} started`, type: "OUT_FOR_DELIVERY" });
    }
    return ok(res, run, "Delivery run started");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/location", async (req, res) => {
  try {
    const financialYear = await getFy(req), { DeliveryRun } = financialModels(req.auth.tenantKey, financialYear);
    const run = await DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!run) return fail(res, "Delivery run not found", 404);
    if (!isAdmin(req.auth) && clean(run.deliveryBoyId) !== clean(req.auth.sub)) return fail(res, "This delivery run is not assigned to you", 403);
    if (!validCoord(req.body.lat, req.body.lng)) return fail(res, "Valid latitude and longitude are required", 400);
    run.currentLocation = { lat: Number(req.body.lat), lng: Number(req.body.lng), accuracy: num(req.body.accuracy) }; run.updatedBy = req.auth.sub; await run.save();
    return ok(res, { currentLocation: run.currentLocation });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/reoptimize", async (req, res) => {
  try {
    const financialYear = await getFy(req), { DeliveryRun } = financialModels(req.auth.tenantKey, financialYear);
    const run = await DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!run) return fail(res, "Delivery run not found", 404);
    if (!isAdmin(req.auth) && clean(run.deliveryBoyId) !== clean(req.auth.sub)) return fail(res, "This delivery run is not assigned to you", 403);
    const start = validCoord(req.body.lat, req.body.lng) ? { lat: Number(req.body.lat), lng: Number(req.body.lng) } : { lat: run.currentLocation?.lat, lng: run.currentLocation?.lng };
    if (!validCoord(start.lat, start.lng)) return fail(res, "Current location is required", 400);
    const fixed = (run.stops || []).filter((x) => ["DELIVERED", "HANDED_TO_TRANSPORTER", "RETURNED_TO_WAREHOUSE", "SKIPPED"].includes(x.status));
    const returning = (run.stops || []).filter((x) => x.status === "RETURN_IN_TRANSIT");
    const open = (run.stops || []).filter((x) => !fixed.some((f) => f.stopId === x.stopId) && !returning.some((r) => r.stopId === x.stopId));
    const optimized = optimizeStops(open.map((x) => x.toObject ? x.toObject() : x), start);
    fixed.forEach((x, i) => { x.sequence = i + 1; });
    optimized.forEach((x, i) => { x.sequence = fixed.length + i + 1; });
    returning.forEach((x, i) => { x.sequence = fixed.length + optimized.length + i + 1; });
    run.stops = [...fixed, ...optimized, ...returning]; run.currentLocation = start; run.routeVersion = num(run.routeVersion) + 1; run.estimatedDistanceMeters = optimized.reduce((s, x) => s + num(x.estimatedDistanceFromPreviousMeters), 0); run.estimatedTravelMinutes = optimized.reduce((s, x) => s + num(x.estimatedTravelMinutes), 0); run.updatedBy = req.auth.sub; await run.save();
    return ok(res, run, "Remaining delivery route re-optimized");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/stops/:stopId/otp", async (req, res) => {
  try {
    const financialYear = await getFy(req), { DeliveryRun } = financialModels(req.auth.tenantKey, financialYear);
    const run = await DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!run) return fail(res, "Delivery run not found", 404);
    const stop = run.stops.find((x) => x.stopId === req.params.stopId); if (!stop) return fail(res, "Delivery stop not found", 404);
    const action = upper(req.body.action);
    const allowed = ["CUSTOMER_DELIVERY", "SALESPERSON_CANCEL", "WAREHOUSE_RETURN"];
    if (!allowed.includes(action)) return fail(res, `action must be one of ${allowed.join(", ")}`, 400);
    const recipientId = action === "CUSTOMER_DELIVERY" ? stop.customerGlobalId : action === "WAREHOUSE_RETURN" ? clean(req.body.warehouseRecipientId || req.auth.sub) : clean(stop.salespersonId || req.body.salespersonId);
    if (!recipientId) return fail(res, "OTP recipient is required", 400);
    const result = await createOtp({ tenantKey: req.auth.tenantKey, transactionId: `${run._id}:${stop.stopId}`, actionType: action, recipientId, context: { runNo: run.runNo, invoiceNo: stop.invoiceNo, orderNo: stop.orderNo } });
    return ok(res, { otpId: result.otpId, expiresAt: result.expiresAt, devCode: process.env.NODE_ENV === "production" ? undefined : result.code }, "OTP created");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/stops/:stopId/arrive", async (req, res) => {
  try {
    const financialYear = await getFy(req), { DeliveryRun } = financialModels(req.auth.tenantKey, financialYear);
    const run = await DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!run) return fail(res, "Delivery run not found", 404);
    if (!isAdmin(req.auth) && clean(run.deliveryBoyId) !== clean(req.auth.sub)) return fail(res, "This delivery run is not assigned to you", 403);
    const stop = run.stops.find((x) => x.stopId === req.params.stopId); if (!stop) return fail(res, "Delivery stop not found", 404);
    const lat = Number(req.body.lat), lng = Number(req.body.lng), accuracy = num(req.body.accuracy);
    if (!validCoord(lat, lng)) return fail(res, "Current latitude and longitude are required", 400);
    const distance = haversineMeters({ lat, lng }, stop.location);
    const radius = Math.max(50, num(req.body.geofenceMeters) || 250);
    if (Number.isFinite(distance) && distance > radius && !isAdmin(req.auth)) return fail(res, `You are ${Math.round(distance)} m away from the delivery point. Move within ${radius} m or request an admin override.`, 409);
    stop.status = "ARRIVED"; stop.arrivedAt = new Date(); stop.gps = { lat, lng, accuracy }; run.currentLocation = { lat, lng, accuracy }; run.updatedBy = req.auth.sub; await run.save();
    return ok(res, { stop, distanceMeters: Math.round(distance) }, "Arrival verified");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/stops/:stopId/complete", async (req, res) => {
  return fail(res,"Use Phase 2 delivery/cancellation endpoints; legacy delivery route disabled to prevent incorrect stock or Credit Note posting",409);
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const run = await models.DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear });
    if (!run) return fail(res, "Delivery run not found", 404);
    if (!isAdmin(req.auth) && clean(run.deliveryBoyId) !== clean(req.auth.sub)) return fail(res, "This delivery run is not assigned to you", 403);
    const stop = run.stops.find((x) => x.stopId === req.params.stopId); if (!stop) return fail(res, "Delivery stop not found", 404);
    const order = await models.SalesOrder.findOne({ _id: stop.orderId, tenantKey: req.auth.tenantKey, financialYear }); if (!order) return fail(res, "Order not found", 404);
    if (!["ARRIVED", "STARTED", "PENDING"].includes(stop.status)) return fail(res, `Stop cannot be completed from ${stop.status}`, 409);

    if (stop.destinationType === "CUSTOMER") {
      const challenge = await verifyChallenge({ otpId: req.body.otpId, code: req.body.code, transactionId: `${run._id}:${stop.stopId}`, allowedActions: ["CUSTOMER_DELIVERY"] });
      stop.customerOtp = { otpId: challenge.otpId, verifiedAt: new Date() };
      stop.status = "DELIVERED"; stop.completedAt = new Date();
      await models.SalesInvoice.updateOne({ _id: stop.invoiceId, tenantKey: req.auth.tenantKey, financialYear }, { $set: { workflowStatus: "DELIVERED", "delivery.deliveredAt": stop.completedAt, "delivery.deliveredTo": stop.customerNameSnapshot, "delivery.deliveryMode": "CUSTOMER_OTP", "delivery.remarks": `Delivered by ${run.deliveryBoyNameSnapshot}; customer OTP verified` } });
      await transitionOrder({ req, models, order, toStatus: "DELIVERED", note: `Delivered successfully by ${run.deliveryBoyNameSnapshot}; customer OTP verified`, type: "DELIVERED", meta: { runNo: run.runNo, stopId: stop.stopId, deliveredAt: stop.completedAt } });
    } else {
      const cnNo = clean(req.body.cnNo), proofFileId = clean(req.body.proofFileId);
      if (!cnNo) return fail(res, "CN / LR / Bilty number is required", 400);
      if (!proofFileId) return fail(res, "CN / LR / Bilty copy image is mandatory", 400);
      const packages = Math.max(0, num(req.body.packages));
      if (num(stop.packageCount) && packages && packages !== num(stop.packageCount)) return fail(res, `Package mismatch: warehouse dispatched ${stop.packageCount}, transporter receipt says ${packages}`, 409);
      stop.transporterHandover = {
        cnNo, cnDate: req.body.cnDate ? new Date(req.body.cnDate) : new Date(), packages: packages || num(stop.packageCount), weight: Math.max(0, num(req.body.weight)), freightAmount: money(req.body.freightAmount), freightMode: upper(req.body.freightMode || "TO_PAY"), contactPerson: clean(req.body.contactPerson), mobile: clean(req.body.mobile), vehicleNo: clean(req.body.vehicleNo), proofFileId, destinationSnapshot: clean(req.body.destination), capturedAt: new Date(),
      };
      stop.status = "HANDED_TO_TRANSPORTER"; stop.completedAt = new Date();
      await models.SalesInvoice.updateOne({ _id: stop.invoiceId, tenantKey: req.auth.tenantKey, financialYear }, { $set: { workflowStatus: "HANDED_TO_TRANSPORTER", "delivery.deliveredAt": stop.completedAt, "delivery.deliveredTo": stop.transporterNameSnapshot, "delivery.biltyNo": cnNo, "delivery.vehicleNo": stop.transporterHandover.vehicleNo || "", "delivery.deliveryMode": "TRANSPORTER_HANDOVER", "delivery.remarks": `Handed to transporter ${stop.transporterNameSnapshot}` }, $addToSet: { "delivery.proofFileIds": proofFileId } });
      await transitionOrder({ req, models, order, toStatus: "HANDED_TO_TRANSPORTER", note: `Successfully handed to ${stop.transporterNameSnapshot}. CN ${cnNo}. ${stop.transporterHandover.packages || 0} package(s).`, type: "TRANSPORTER_HANDOVER", meta: { transporter: stop.transporterNameSnapshot, station: stop.transporterStationNameSnapshot, cnNo, cnDate: stop.transporterHandover.cnDate, packages: stop.transporterHandover.packages, weight: stop.transporterHandover.weight, freightAmount: stop.transporterHandover.freightAmount, freightMode: stop.transporterHandover.freightMode, proofFileId } });
    }

    const unfinished = run.stops.filter((x) => !["DELIVERED", "HANDED_TO_TRANSPORTER", "RETURNED_TO_WAREHOUSE", "SKIPPED"].includes(x.status));
    if (!unfinished.length) { run.status = "COMPLETED"; run.completedAt = new Date(); }
    run.updatedBy = req.auth.sub; await run.save();
    return ok(res, { run, stop }, stop.destinationType === "CUSTOMER" ? "Customer delivery completed" : "Transporter handover completed and customer alert queued");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/stops/:stopId/fail", async (req, res) => {
  return fail(res,"Use Phase 2 delivery/cancellation endpoints; legacy delivery route disabled to prevent incorrect stock or Credit Note posting",409);
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const run = await models.DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }); if (!run) return fail(res, "Delivery run not found", 404);
    const stop = run.stops.find((x) => x.stopId === req.params.stopId); if (!stop) return fail(res, "Delivery stop not found", 404);
    const order = await models.SalesOrder.findOne({ _id: stop.orderId, tenantKey: req.auth.tenantKey, financialYear }); if (!order) return fail(res, "Order not found", 404);
    const challenge = await verifyChallenge({ otpId: req.body.otpId, code: req.body.code, transactionId: `${run._id}:${stop.stopId}`, allowedActions: ["SALESPERSON_CANCEL"] });
    const reason = clean(req.body.reason); if (!reason) return fail(res, "Delivery failure reason is required", 400);
    const cancelAndReturn = req.body.cancelAndReturn !== false;
    stop.failure = { reason, remarks: clean(req.body.remarks), salespersonOtpId: challenge.otpId, verifiedAt: new Date(), failedAt: new Date() };
    if (cancelAndReturn) {
      stop.status = "RETURN_IN_TRANSIT";
      await transitionOrder({ req, models, order, toStatus: "RETURN_IN_TRANSIT", note: `Delivery failed: ${reason}. Salesperson OTP verified; goods return started.`, type: "DELIVERY_FAILED", meta: { reason, cancelAndReturn: true } });
    } else {
      // A retry stays on the same active route. Keep the order OUT_FOR_DELIVERY and
      // record the failed attempt as an event rather than forcing a terminal state.
      stop.status = "PENDING";
      await createEvent({ req, models, order, fromStatus: upper(order.workflowStatus), toStatus: upper(order.workflowStatus), type: "DELIVERY_ATTEMPT_FAILED", note: `Delivery attempt failed: ${reason}. Retry requested; salesperson OTP verified.`, meta: { reason, cancelAndReturn: false, runNo: run.runNo, stopId: stop.stopId } });
    }
    await run.save();
    return ok(res, { run, stop }, cancelAndReturn ? "Failed delivery verified; goods return started" : "Delivery attempt recorded and kept active for retry");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/delivery-runs/:id/stops/:stopId/return-to-warehouse", async (req, res) => {
  return fail(res,"Use Phase 2 delivery/cancellation endpoints; legacy delivery route disabled to prevent incorrect stock or Credit Note posting",409);
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const run = await models.DeliveryRun.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }); if (!run) return fail(res, "Delivery run not found", 404);
    const stop = run.stops.find((x) => x.stopId === req.params.stopId); if (!stop) return fail(res, "Delivery stop not found", 404);
    const order = await models.SalesOrder.findOne({ _id: stop.orderId, tenantKey: req.auth.tenantKey, financialYear }); if (!order) return fail(res, "Order not found", 404);
    if (upper(order.workflowStatus) !== "RETURN_IN_TRANSIT") return fail(res, "Order is not currently returning to warehouse", 409);
    const challenge = await verifyChallenge({ otpId: req.body.otpId, code: req.body.code, transactionId: `${run._id}:${stop.stopId}`, allowedActions: ["WAREHOUSE_RETURN"] });
    const invoice = await models.SalesInvoice.findOne({ _id: stop.invoiceId, tenantKey: req.auth.tenantKey, financialYear }); if (!invoice) return fail(res, "Original invoice not found", 404);
    const returned = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((x) => [clean(x.productId), x]));
    const creditItems = [];
    for (const invItem of invoice.items || []) {
      const row = returned.get(clean(invItem.productId));
      if (!row) continue;
      const qty = clamp(row.qty, 0, num(invItem.qty)); if (!qty) continue;
      const ratio = num(invItem.qty) ? qty / num(invItem.qty) : 0;
      const condition = upper(row.condition || "SALEABLE");
      creditItems.push({ productId: invItem.productId, sku: invItem.sku, nameSnapshot: invItem.nameSnapshot, qty, unit: invItem.unit, rate: num(invItem.rate), taxable: money(num(invItem.taxable) * ratio), tax: money(num(invItem.tax) * ratio), lineTotal: money(num(invItem.lineTotal) * ratio), condition });
      if (condition === "SALEABLE") {
        await Product.updateOne({ _id: invItem.productId, tenantKey: req.auth.tenantKey }, { $inc: { currentStock: qty } });
        await models.StockMovement.create({ tenantKey: req.auth.tenantKey, financialYear, date: new Date(), productId: invItem.productId, warehouseId: invoice.warehouseId || "", type: "SALES_RETURN_RECEIVED", qtyIn: qty, qtyOut: 0, landedCost: num(invItem.landedCostSnapshot), referenceId: invoice.invoiceNo });
      } else {
        await models.StockMovement.create({ tenantKey: req.auth.tenantKey, financialYear, date: new Date(), productId: invItem.productId, warehouseId: invoice.warehouseId || "", type: `SALES_RETURN_${condition}`, qtyIn: 0, qtyOut: 0, landedCost: num(invItem.landedCostSnapshot), referenceId: invoice.invoiceNo });
      }
    }
    if (!creditItems.length) return fail(res, "Enter at least one returned product quantity", 400);
    const creditNoteNo = await allocateDocumentNoteNumber({ tenantKey: req.auth.tenantKey, financialYear, type: "CREDIT_NOTE" });
    const taxableTotal = money(creditItems.reduce((s, x) => s + num(x.taxable), 0));
    const taxTotal = money(creditItems.reduce((s, x) => s + num(x.tax), 0));
    const grandTotal = money(creditItems.reduce((s, x) => s + num(x.lineTotal), 0));
    await validateCreditNoteAgainstInvoice({ models, tenantKey: req.auth.tenantKey, financialYear, invoice, note: { grandTotal, items: creditItems, reasonType: "GOODS_RETURN" } });
    const creditNote = await models.CreditNote.create({ tenantKey: req.auth.tenantKey, financialYear, documentType: "CREDIT_NOTE", creditNoteNo, documentNo: creditNoteNo, date: new Date(), orderId: String(order._id), orderNo: order.orderNo, invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo, referenceDocumentId: String(invoice._id), referenceDocumentNo: invoice.invoiceNo, customerGlobalId: invoice.customerGlobalId, customerNameSnapshot: invoice.customerNameSnapshot, partyGlobalId: invoice.customerGlobalId, partyNameSnapshot: invoice.customerNameSnapshot, items: creditItems, taxableTotal, taxTotal, grandTotal, reasonType: "GOODS_RETURN", reason: stop.failure?.reason || "Undelivered goods returned", stockEffectApplied: true, origin: "ORDER_RETURN", status: "DRAFT", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "" });
    stop.status = "RETURNED_TO_WAREHOUSE"; stop.warehouseReturn = { otpId: challenge.otpId, verifiedAt: new Date(), receivedBy: req.auth.sub, receivedByNameSnapshot: req.auth.name || "", receivedAt: new Date(), remarks: clean(req.body.remarks) }; await run.save();
    await models.SalesInvoice.updateOne({ _id: invoice._id, tenantKey: req.auth.tenantKey, financialYear }, { $set: { workflowStatus: "RETURNED_TO_WAREHOUSE" } });
    await transitionOrder({ req, models, order, toStatus: "RETURNED_TO_WAREHOUSE", note: `Returned goods received at warehouse. Draft credit note ${creditNoteNo} created.`, type: "RETURN_RECEIVED", meta: { creditNoteId: String(creditNote._id), creditNoteNo } });
    await transitionOrder({ req, models, order, toStatus: "CREDIT_NOTE_PENDING", note: `Credit note ${creditNoteNo} is waiting for Order Desk / Accounts issue`, type: "CREDIT_NOTE_DRAFTED", meta: { creditNoteId: String(creditNote._id), creditNoteNo }, audience: ["DMS", "SALESPERSON"] });
    const unfinished = run.stops.filter((x) => !["DELIVERED", "HANDED_TO_TRANSPORTER", "RETURNED_TO_WAREHOUSE", "SKIPPED"].includes(x.status));
    if (!unfinished.length) { run.status = "COMPLETED"; run.completedAt = new Date(); await run.save(); }
    return ok(res, { run, stop, creditNote }, "Warehouse return verified and credit note draft created");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/credit-notes", async (req, res) => {
  try {
    const financialYear = await getFy(req), { CreditNote } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear, $or: [{ documentType: "CREDIT_NOTE" }, { documentType: { $exists: false } }] }; if (req.query.status) filter.status = upper(req.query.status);
    const items = await CreditNote.find(filter).sort({ createdAt: -1 }).limit(200).lean(); return ok(res, { financialYear, items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/credit-notes/:id/issue", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const note = await models.CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear, $or: [{ documentType: "CREDIT_NOTE" }, { documentType: { $exists: false } }] }); if (!note) return fail(res, "Credit note not found", 404);
    if (note.status === "ISSUED") return ok(res, note, "Credit note already issued");
    const invoice = await models.SalesInvoice.findOne({ _id: note.invoiceId || note.referenceDocumentId, tenantKey: req.auth.tenantKey, financialYear }).lean();
    await validateCreditNoteAgainstInvoice({ models, tenantKey: req.auth.tenantKey, financialYear, invoice, note, excludeNoteId: note._id });
    await postBalancedEntries({ tenantKey: req.auth.tenantKey, financialYear, transactionId: note.creditNoteNo, transactionType: "SALES_CREDIT_NOTE", date: note.date, partyGlobalId: note.customerGlobalId, narration: `Credit Note ${note.creditNoteNo} against ${note.invoiceNo}`, entries: [
      { accountCode: "SYS_SALES", debit: note.taxableTotal },
      { accountCode: "SYS_DUTIES_TAXES", debit: note.taxTotal },
      { accountCode: "SYS_SUNDRY_DEBTORS", credit: note.grandTotal },
    ].filter((x) => num(x.debit) || num(x.credit)) });
    note.status = "ISSUED"; note.issuedAt = new Date(); note.issuedBy = req.auth.sub; await note.save();
    if (note.invoiceId || note.referenceDocumentId) await syncSalesInvoiceCreditState({ models, tenantKey: req.auth.tenantKey, financialYear, invoiceId: note.invoiceId || note.referenceDocumentId });
    const order = await models.SalesOrder.findOne({ _id: note.orderId, tenantKey: req.auth.tenantKey, financialYear });
    if (order && upper(order.workflowStatus) === "CREDIT_NOTE_PENDING") await transitionOrder({ req, models, order, toStatus: "CLOSED", note: `Credit note ${note.creditNoteNo} issued against invoice ${note.invoiceNo}`, type: "CREDIT_NOTE_ISSUED", meta: { creditNoteNo: note.creditNoteNo, amount: note.grandTotal } });
    return ok(res, note, "Credit note issued and accounting posted");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/notifications", async (req, res) => {
  try {
    const financialYear = await getFy(req), { OrderNotification } = financialModels(req.auth.tenantKey, financialYear);
    const filter = { tenantKey: req.auth.tenantKey, financialYear };
    if (req.query.recipientType) filter.recipientType = upper(req.query.recipientType);
    if (req.query.recipientId) filter.recipientId = clean(req.query.recipientId);
    if (req.query.status) filter.status = upper(req.query.status);
    const items = await OrderNotification.find(filter).sort({ createdAt: -1 }).limit(Math.min(200, Math.max(10, num(req.query.limit) || 50))).lean();
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.patch("/notifications/:id/read", async (req, res) => {
  try {
    const financialYear = await getFy(req), { OrderNotification } = financialModels(req.auth.tenantKey, financialYear);
    const row = await OrderNotification.findOneAndUpdate({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }, { $set: { status: "READ", readAt: new Date() } }, { new: true });
    if (!row) return fail(res, "Notification not found", 404); return ok(res, row);
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

export default router;
