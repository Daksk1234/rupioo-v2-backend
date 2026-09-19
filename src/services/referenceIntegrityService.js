import {
  CompanyProfile,
  CustomerLink,
  Employee,
  GenericRecord,
  Lead,
  PincodeAssignment,
  Product,
  Target,
  Territory,
  User,
} from "../models/index.js";
import { financialModels } from "./accountingService.js";

const str = (v) => String(v ?? "").trim();
const unique = (values = []) => Array.from(new Set(values.map(str).filter(Boolean)));

function currentFinancialYear() {
  const d = new Date();
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export async function tenantFinancialYears(tenantKey) {
  const profile = await CompanyProfile.findOne({ tenantKey }).select("financialYear financialYears").lean();
  return unique([
    ...(Array.isArray(profile?.financialYears) ? profile.financialYears : []),
    profile?.financialYear,
    currentFinancialYear(),
  ]);
}

async function addDistinct(set, Model, path, filter) {
  try {
    const values = await Model.distinct(path, filter);
    for (const value of values || []) if (str(value)) set.add(str(value));
  } catch {
    // A historical FY database may pre-date a newer collection/schema. Treat it
    // as having no matching reference rather than making master maintenance fail.
  }
}

export async function referencedProductIds(tenantKey, ids = []) {
  const wanted = unique(ids);
  const found = new Set();
  if (!wanted.length) return found;

  // Inventory itself is a live reference. A stocked/purchased product should not
  // disappear from the master even if an old transaction database is unavailable.
  const inventoryRows = await Product.find({
    tenantKey,
    _id: { $in: wanted },
    $or: [
      { currentStock: { $gt: 0 } }, { currentStock: { $lt: 0 } },
      { openingStock: { $gt: 0 } }, { openingStock: { $lt: 0 } },
      { purchaseQtyAccumulated: { $gt: 0 } }, { purchaseQtyAccumulated: { $lt: 0 } },
      { purchaseValueAccumulated: { $gt: 0 } }, { purchaseValueAccumulated: { $lt: 0 } },
    ],
  }).select("_id").lean();
  inventoryRows.forEach((row) => found.add(str(row._id)));

  const genericRows = await GenericRecord.find({
    tenantKey,
    $or: [
      { "data.productId": { $in: wanted } },
      { "data.productIds": { $in: wanted } },
    ],
  }).select("data.productId data.productIds").lean();
  for (const row of genericRows) {
    if (row?.data?.productId) found.add(str(row.data.productId));
    for (const id of row?.data?.productIds || []) found.add(str(id));
  }

  for (const financialYear of await tenantFinancialYears(tenantKey)) {
    const { SalesInvoice, PurchaseInvoice, StockMovement, Expense } = financialModels(tenantKey, financialYear);
    await Promise.all([
      addDistinct(found, SalesInvoice, "items.productId", { tenantKey, "items.productId": { $in: wanted } }),
      addDistinct(found, PurchaseInvoice, "items.productId", { tenantKey, "items.productId": { $in: wanted } }),
      addDistinct(found, StockMovement, "productId", { tenantKey, productId: { $in: wanted } }),
      addDistinct(found, Expense, "productId", { tenantKey, productId: { $in: wanted } }),
    ]);
  }
  return found;
}

export async function referencedPartyIds(tenantKey, ids = []) {
  const wanted = unique(ids);
  const found = new Set();
  if (!wanted.length) return found;

  const genericRows = await GenericRecord.find({
    tenantKey,
    $or: [
      { "data.customerGlobalId": { $in: wanted } },
      { "data.partyGlobalId": { $in: wanted } },
      { "data.supplierGlobalId": { $in: wanted } },
    ],
  }).select("data.customerGlobalId data.partyGlobalId data.supplierGlobalId").lean();
  for (const row of genericRows) {
    for (const value of [row?.data?.customerGlobalId, row?.data?.partyGlobalId, row?.data?.supplierGlobalId]) {
      if (value) found.add(str(value));
    }
  }

  for (const financialYear of await tenantFinancialYears(tenantKey)) {
    const { SalesInvoice, PurchaseInvoice, Receipt, Payment, LedgerEntry, Expense } = financialModels(tenantKey, financialYear);
    await Promise.all([
      addDistinct(found, SalesInvoice, "customerGlobalId", { tenantKey, customerGlobalId: { $in: wanted } }),
      addDistinct(found, PurchaseInvoice, "supplierGlobalId", { tenantKey, supplierGlobalId: { $in: wanted } }),
      addDistinct(found, Receipt, "customerGlobalId", { tenantKey, customerGlobalId: { $in: wanted } }),
      addDistinct(found, Payment, "partyGlobalId", { tenantKey, partyGlobalId: { $in: wanted } }),
      addDistinct(found, LedgerEntry, "partyGlobalId", { tenantKey, partyGlobalId: { $in: wanted } }),
      addDistinct(found, Expense, "customerGlobalId", { tenantKey, customerGlobalId: { $in: wanted } }),
    ]);
  }
  return found;
}

export async function userReferenceDetails(tenantKey, userId) {
  const id = str(userId);
  if (!id) return [];
  const reasons = [];

  const [children, pincodes, customers, employees, leads, territories, targets, generic] = await Promise.all([
    User.exists({ tenantKey, assignedToUserId: id }),
    PincodeAssignment.exists({ tenantKey, userIds: id }),
    CustomerLink.exists({ tenantKey, salespersonId: id }),
    Employee.exists({ tenantKey, userId: id }),
    Lead.exists({ tenantKey, $or: [{ assignedUserId: id }, { "activities.userId": id }] }),
    Territory.exists({ tenantKey, $or: [{ userId: id }, { managerId: id }] }),
    Target.exists({ tenantKey, level: "USER", entityId: id }),
    GenericRecord.exists({ tenantKey, $or: [{ assignedTo: id }, { createdBy: id }, { updatedBy: id }] }),
  ]);
  if (children) reasons.push("user hierarchy");
  if (pincodes) reasons.push("pincode assignments");
  if (customers) reasons.push("customer assignments");
  if (employees) reasons.push("employee records");
  if (leads) reasons.push("lead/activity records");
  if (territories) reasons.push("territories");
  if (targets) reasons.push("targets");
  if (generic) reasons.push("operational records");

  for (const financialYear of await tenantFinancialYears(tenantKey)) {
    const { SalesInvoice, PurchaseInvoice } = financialModels(tenantKey, financialYear);
    const [sales, purchases] = await Promise.all([
      SalesInvoice.exists({ tenantKey, $or: [{ createdBy: id }, { assignedTo: id }, { warehouseProcessedBy: id }] }),
      PurchaseInvoice.exists({ tenantKey, createdBy: id }),
    ]);
    if (sales) reasons.push(`sales invoices (${financialYear})`);
    if (purchases) reasons.push(`purchase invoices (${financialYear})`);
  }
  return unique(reasons);
}

export async function warehouseReferenceDetails(tenantKey, warehouseId) {
  const id = str(warehouseId);
  if (!id) return [];
  const reasons = [];
  const [products, users] = await Promise.all([
    Product.exists({ tenantKey, warehouseId: id }),
    User.exists({ tenantKey, warehouseId: id }),
  ]);
  if (products) reasons.push("products");
  if (users) reasons.push("users");

  for (const financialYear of await tenantFinancialYears(tenantKey)) {
    const { SalesInvoice, StockMovement } = financialModels(tenantKey, financialYear);
    const [sales, movements] = await Promise.all([
      SalesInvoice.exists({ tenantKey, warehouseId: id }),
      StockMovement.exists({ tenantKey, warehouseId: id }),
    ]);
    if (sales) reasons.push(`sales invoices (${financialYear})`);
    if (movements) reasons.push(`stock movements (${financialYear})`);
  }
  return unique(reasons);
}
