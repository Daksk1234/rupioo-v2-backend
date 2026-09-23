import express from "express";
import { CustomerLink, Product, Transporter, User, GlobalTransporterStation, Pincode } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { financialModels, postBalancedEntries } from "../services/accountingService.js";
import { createOtp, verifyOtp } from "../services/otpService.js";
import { ok, fail, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { resolveFinancialYear, financialYearFromDate } from "../utils/financialYear.js";

const router = express.Router();

// Lightweight deployment check. No tenant or business data is returned.
// If this responds, the running backend has loaded the Order Flow router.
router.get("/health", (_req, res) =>
  res.json({ ok: true, module: "order-flow", mount: "router", build: "2026-09-20-sales-order-flow-v3", time: new Date().toISOString() }),
);

router.use(requireAuth);

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

function shapeOrder(order) {
  const row = order.toObject ? order.toObject() : order;
  const orderedQty = (row.items || []).reduce((s, x) => s + num(x.qty), 0);
  const packedQty = (row.items || []).reduce((s, x) => s + num(x.packedQty), 0);
  const invoicedQty = (row.items || []).reduce((s, x) => s + num(x.invoicedQty), 0);
  return { ...row, orderedQty, packedQty, invoicedQty, nextAction: row.nextAction || nextAction(row.workflowStatus), isOrderBased: true };
}

router.get("/orders", async (req, res) => {
  try {
    const financialYear = await getFy(req);
    const { SalesOrder } = financialModels(req.auth.tenantKey, financialYear);
    const page = Math.max(1, num(req.query.page) || 1), limit = Math.min(200, Math.max(10, num(req.query.limit) || 50));
    const filter = { tenantKey: req.auth.tenantKey, financialYear };
    if (req.query.workflowStatus) filter.workflowStatus = upper(req.query.workflowStatus);
    if (req.query.salespersonId) filter.salespersonId = clean(req.query.salespersonId);
    if (req.query.customerGlobalId) filter.customerGlobalId = clean(req.query.customerGlobalId);
    const search = clean(req.query.search);
    if (search) filter.$or = [{ orderNo: { $regex: search, $options: "i" } }, { customerNameSnapshot: { $regex: search, $options: "i" } }];
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
    const events = await models.OrderEvent.find({ tenantKey: req.auth.tenantKey, financialYear, orderId: String(order._id) }).sort({ occurredAt: 1 }).lean();
    const creditNotes = await models.CreditNote.find({ tenantKey: req.auth.tenantKey, financialYear, orderId: String(order._id) }).sort({ createdAt: -1 }).lean();
    return ok(res, { order: shapeOrder(order), events, creditNotes });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
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
        unit: x.unit, packingUnit: x.packingUnit, qtyInBag: x.qtyInBag, saleRate: x.rate,
        basicRate: x.rate, discountPct: x.discountPct, gstRate: x.gstRateSnapshot,
      };
    }).filter((x) => x.qty > 0);
    if (!items.length) return fail(res, "No newly packed quantity is available to invoice", 409);
    return ok(res, {
      financialYear,
      orderId: String(order._id), orderNo: order.orderNo,
      customerGlobalId: order.customerGlobalId, customerName: order.customerNameSnapshot,
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
    await verifyChallenge({ otpId: req.body.otpId || order.customerOtpId, code: req.body.code, transactionId: String(order._id), allowedActions: ["ORDER_CUSTOMER_CONFIRM"] });
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
    if (upper(order.workflowStatus) !== "PACKING") return fail(res, `Order must be in PACKING status`, 409);
    const supplied = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((x) => [clean(x.productId), x]));
    let totalPacked = 0;
    for (const item of order.items || []) {
      const row = supplied.get(clean(item.productId));
      const packed = row == null ? num(item.packedQty) : clamp(row.packedQty, num(item.invoicedQty), num(item.qty));
      if (packed > num(item.reservedQty)) return fail(res, `${item.nameSnapshot || item.sku}: packed quantity cannot exceed reserved quantity`, 409);
      item.packedQty = packed;
      item.shortageReason = clean(row?.shortageReason);
      totalPacked += packed;
    }
    if (totalPacked <= 0) return fail(res, "At least one product must have a packed quantity", 400);
    order.packing.packageCount = Math.max(0, num(req.body.packageCount));
    order.packing.actualWeight = Math.max(0, num(req.body.actualWeight));
    order.packing.remarks = clean(req.body.remarks);
    order.packing.packedAt = new Date(); order.packing.packedBy = req.auth.sub; order.packing.packedByNameSnapshot = req.auth.name || "";
    await order.save();
    await transitionOrder({ req, models, order, toStatus: "PACKED", note: `Packing completed • ${money(totalPacked)} units • ${order.packing.packageCount || 0} package(s)`, type: "PACKING_COMPLETED", meta: { packageCount: order.packing.packageCount, actualWeight: order.packing.actualWeight } });
    return ok(res, shapeOrder(order), "Packing completed with actual quantities");
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/delivery-boys", async (req, res) => {
  try {
    const rx = /delivery|driver|dispatch/i;
    const items = await User.find({ tenantKey: req.auth.tenantKey, status: "ACTIVE", $or: [{ designation: rx }, { accountType: rx }, { role: rx }, { department: rx }] }).select("_id name mobile designation role warehouseId branchId").sort({ name: 1 }).lean();
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, 500); }
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
    let creditNoteNo = makeId("CN"); while (await models.CreditNote.exists({ tenantKey: req.auth.tenantKey, financialYear, creditNoteNo })) creditNoteNo = makeId("CN");
    const taxableTotal = money(creditItems.reduce((s, x) => s + num(x.taxable), 0));
    const taxTotal = money(creditItems.reduce((s, x) => s + num(x.tax), 0));
    const grandTotal = money(creditItems.reduce((s, x) => s + num(x.lineTotal), 0));
    const creditNote = await models.CreditNote.create({ tenantKey: req.auth.tenantKey, financialYear, creditNoteNo, date: new Date(), orderId: String(order._id), orderNo: order.orderNo, invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo, customerGlobalId: invoice.customerGlobalId, customerNameSnapshot: invoice.customerNameSnapshot, items: creditItems, taxableTotal, taxTotal, grandTotal, reason: stop.failure?.reason || "Undelivered goods returned", status: "DRAFT", createdBy: req.auth.sub, createdByNameSnapshot: req.auth.name || "" });
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
    const filter = { tenantKey: req.auth.tenantKey, financialYear }; if (req.query.status) filter.status = upper(req.query.status);
    const items = await CreditNote.find(filter).sort({ createdAt: -1 }).limit(200).lean(); return ok(res, { financialYear, items });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.post("/credit-notes/:id/issue", async (req, res) => {
  try {
    const financialYear = await getFy(req), models = financialModels(req.auth.tenantKey, financialYear);
    const note = await models.CreditNote.findOne({ _id: req.params.id, tenantKey: req.auth.tenantKey, financialYear }); if (!note) return fail(res, "Credit note not found", 404);
    if (note.status === "ISSUED") return ok(res, note, "Credit note already issued");
    await postBalancedEntries({ tenantKey: req.auth.tenantKey, financialYear, transactionId: note.creditNoteNo, transactionType: "SALES_CREDIT_NOTE", date: note.date, partyGlobalId: note.customerGlobalId, narration: `Credit Note ${note.creditNoteNo} against ${note.invoiceNo}`, entries: [
      { accountCode: "SYS_SALES", debit: note.taxableTotal },
      { accountCode: "SYS_DUTIES_TAXES", debit: note.taxTotal },
      { accountCode: "SYS_SUNDRY_DEBTORS", credit: note.grandTotal },
    ].filter((x) => num(x.debit) || num(x.credit)) });
    note.status = "ISSUED"; note.issuedAt = new Date(); note.issuedBy = req.auth.sub; await note.save();
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
