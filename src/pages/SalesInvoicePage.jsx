import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Plus,
  Pencil,
  PackageCheck,
  FileText,
  UploadCloud,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import SalesInvoiceLayout from "../components/SalesInvoiceLayout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import CreateLookupButton from "../components/CreateLookupButton.jsx";
import EditMasterLink from "../components/EditMasterLink.jsx";
import { api, apiBlob, getUser } from "../lib/api.js";
import { fetchTransactionParties, partyOptionLabel, partyGstin } from "../lib/partyDirectory.js";
import { buildInvoiceTaxSummary, computeInvoiceAdjustments } from "../lib/invoiceAdjustments.js";
import { isAdminUser } from "../lib/adminVisibility.js";
import { configuredFinancialYear, currentFinancialYear, financialYearFromDate, financialYearOptions, initialDateForFinancialYear } from "../lib/financialYear.js";

const floor2 = (n) => Math.floor((Number(n) || 0) * 100) / 100;
const ceil2 = (n) => Math.ceil((Number(n) || 0) * 100) / 100;
const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cityKey = (v) => String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ymd = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
};
const currentFY = currentFinancialYear;
const fyStart = (fy) => Number(String(fy || currentFY()).slice(0, 4)) || new Date().getFullYear();
const fyLabel = (fy) => `FY ${String(fy || "").replace(/^FY\s*/i, "")}`;
const buildFinancialYears = (count = 10) => financialYearOptions(getUser(), { count });
const saleFromMRPByGrade = (mrp, pct) => floor2(Number(mrp || 0) / (1 + Number(pct || 0) / 100));
const basicFromSaleGST = (sale, gst) => ceil2(Number(sale || 0) / (1 + Number(gst || 0) / 100));
const saleFromBasicGST = (basic, gst) => round2(Number(basic || 0) * (1 + Number(gst || 0) / 100));
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fyMonthOrder = ["April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"];

const newRow = () => ({
  productId: "",
  productName: "",
  hsnCode: "",
  qty: 1,
  availableQty: 0,
  basicUnit: "PCS",
  packingUnit: "",
  qtyInBag: 1,
  grossQty: 1,
  mrp: 0,
  gradeDiscountPct: 0,
  saleRate: 0,
  basicRate: 0,
  discountPct: 0,
  gstRate: 0,
  taxable: 0,
  tax: 0,
  lineTotal: 0,
  landedCost: 0,
  profitPct: 0,
  health: "BLUE",
  qtyError: "",
  billingError: "",
});

const newAdjustment = (type, master = null) => ({
  id: `${type}-${Date.now()}-${Math.random()}`,
  masterId: master?.id || "",
  type,
  title: master?.title || (type === "Discount" ? "Discount" : "Charges"),
  method: master?.method || "Amount",
  value: Number(master?.value || 0),
});

const ADJUSTMENT_MASTER_KEY = "rupio_sales_invoice_adjustment_masters_v1";
const DEFAULT_ADJUSTMENT_MASTERS = [
  { id: "disc-scheme", type: "Discount", title: "Scheme Discount", method: "Percentage", value: 0, active: true },
  { id: "disc-cash", type: "Discount", title: "Cash Discount", method: "Percentage", value: 0, active: true },
  { id: "disc-monthly", type: "Discount", title: "Monthly Offer Discount", method: "Percentage", value: 0, active: true },
  { id: "charge-freight", type: "Charges", title: "Freight", method: "Amount", value: 0, active: true },
  { id: "charge-packing", type: "Charges", title: "Packing Charges", method: "Amount", value: 0, active: true },
  { id: "charge-handling", type: "Charges", title: "Handling Charges", method: "Amount", value: 0, active: true },
];

function readAdjustmentMasters() {
  try {
    const raw = window.localStorage.getItem(ADJUSTMENT_MASTER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return DEFAULT_ADJUSTMENT_MASTERS;
}

function writeAdjustmentMasters(rows) {
  try { window.localStorage.setItem(ADJUSTMENT_MASTER_KEY, JSON.stringify(rows)); } catch {}
}

async function fetchAllPaged(path, limit = 100) {
  const separator = path.includes("?") ? "&" : "?";
  const first = await api(`${path}${separator}page=1&limit=${limit}`);
  const firstItems = Array.isArray(first?.items) ? first.items : [];
  const pages = Math.max(1, Number(first?.meta?.pages || 1));
  if (pages <= 1) return firstItems;

  const remaining = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      api(`${path}${separator}page=${i + 2}&limit=${limit}`),
    ),
  );
  return [
    ...firstItems,
    ...remaining.flatMap((result) =>
      Array.isArray(result?.items) ? result.items : [],
    ),
  ];
}

function classifyRegistration(row, customer) {
  const reg = String(
    row?.registrationType ||
      row?.customerRegistrationType ||
      row?.gstRegistrationType ||
      customer?.registrationType ||
      "",
  ).toLowerCase();
  const gst = String(
    row?.gstinSnapshot ||
      row?.customerGstinSnapshot ||
      row?.gstin ||
      row?.gstNumber ||
      customer?.gstin ||
      (String(customer?.displayIdentifier || "").length === 15
        ? customer.displayIdentifier
        : "") ||
      "",
  ).trim();
  if (reg.includes("unreg")) return "UNREGISTER";
  if (reg.includes("regular") || reg.includes("registered")) return "REGULAR";
  return gst ? "REGULAR" : "REGULAR";
}

function getInvoiceMonth(row) {
  const d = new Date(row?.date || row?.createdAt || 0);
  return Number.isNaN(d.getTime()) ? "Unknown" : monthNames[d.getMonth()];
}

function getInvoiceTaxable(row) {
  if (Number.isFinite(Number(row?.taxableTotal))) return Number(row.taxableTotal);
  if (Number.isFinite(Number(row?.taxable))) return Number(row.taxable);
  const items = Array.isArray(row?.items) ? row.items : [];
  return round2(items.reduce((s, x) => s + Number(x?.taxableAmount || x?.taxable || x?.basicAmount || 0), 0));
}

function getInvoiceTax(row) {
  if (Number.isFinite(Number(row?.gstTotal))) return Number(row.gstTotal);
  if (Number.isFinite(Number(row?.taxTotal))) return Number(row.taxTotal);
  const grand = Number(row?.grandTotal || 0);
  const taxable = getInvoiceTaxable(row);
  return round2(Math.max(0, grand - taxable));
}

function getInvoiceTaxSplit(row) {
  const items = Array.isArray(row?.items) ? row.items : [];
  let cgst = items.reduce((s,x)=>s+Number(x?.cgst||0),0);
  let sgst = items.reduce((s,x)=>s+Number(x?.sgst||0),0);
  let igst = items.reduce((s,x)=>s+Number(x?.igst||0),0);
  if (cgst || sgst || igst) return { cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst) };
  const total = getInvoiceTax(row);
  if (String(row?.gstType||"").toUpperCase() === "IGST") return { cgst:0, sgst:0, igst:round2(total) };
  return { cgst:round2(total/2), sgst:round2(total/2), igst:0 };
}

export default function SalesInvoicePage({ embedded = false, batchIndex = 1, batchKey = "", registerBatchSave: registerBatchSaveProp = null, onRemoveInvoice = null } = {}) {
  const admin = isAdminUser();
  const sessionUser = getUser();
  const companyGstin = String(sessionUser?.companyProfile?.gstin || "").trim().toUpperCase();
  const companyCity = String(sessionUser?.companyProfile?.city || "").trim();
  const [searchParams, setSearchParams] = useSearchParams();
  const editId = embedded ? "" : (searchParams.get("edit") || "");
  const sourceOrderId = embedded ? "" : (searchParams.get("orderId") || "");
  const createMode = embedded ? true : (searchParams.get("create") === "1" || Boolean(editId) || Boolean(sourceOrderId));

  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [rows, setRows] = useState([newRow()]);
  // Keep the raw Basic Total text separate while a user is editing it.
  // If we bind the input directly to the recalculated taxable amount, every
  // keystroke rewrites the DOM value and moves the caret to the end.
  const [basicTotalEdit, setBasicTotalEdit] = useState(null);
  const [adjustments, setAdjustments] = useState([]);
  const [adjustmentMasters, setAdjustmentMasters] = useState(() => readAdjustmentMasters());
  const [selectedAdjustmentMaster, setSelectedAdjustmentMaster] = useState({ Discount: "", Charges: "" });
  const [adjustmentMasterEditor, setAdjustmentMasterEditor] = useState(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [fy, setFy] = useState(searchParams.get("financialYear") || configuredFinancialYear(sessionUser));
  const [listFy, setListFy] = useState("ALL");
  const [nextInvoiceNo, setNextInvoiceNo] = useState("");
  const [seriesMsg, setSeriesMsg] = useState("");
  const [customerFinancial, setCustomerFinancial] = useState({});
  const [editingOriginalGrand, setEditingOriginalGrand] = useState(0);
  const [deliveryTarget, setDeliveryTarget] = useState(null);
  const [deliveryForm, setDeliveryForm] = useState({ deliveredAt: "", deliveredTo: "", deliveryMobile: "", vehicleNo: "", biltyNo: "", deliveryRemarks: "" });
  const [deliveryProof, setDeliveryProof] = useState(null);
  const [biltyCopy, setBiltyCopy] = useState(null);
  const [deliverySaving, setDeliverySaving] = useState(false);
  const [orderDraft, setOrderDraft] = useState(null);

  const [search, setSearch] = useState("");
  const [activeBucket, setActiveBucket] = useState("REGULAR");
  const [periodType, setPeriodType] = useState("YEARLY");
  const [selectedMonth, setSelectedMonth] = useState(fyMonthOrder[new Date().getMonth() >= 3 ? new Date().getMonth() - 3 : new Date().getMonth() + 9] || "April");
  const [selectedQuarter, setSelectedQuarter] = useState("Q1");
  const [selectedHalf, setSelectedHalf] = useState("H1");
  const [monthOpen, setMonthOpen] = useState({});
  const [batchOpen, setBatchOpen] = useState(true);
  const [extraInvoiceKeys, setExtraInvoiceKeys] = useState([]);
  const [batchSaving, setBatchSaving] = useState(false);
  const batchSaveRefs = useRef(new Map());
  const registerBatchSave = useCallback((key, fn) => {
    if (!key) return;
    if (typeof fn === "function") batchSaveRefs.current.set(key, fn);
    else batchSaveRefs.current.delete(key);
  }, []);
  const addMoreInvoice = useCallback(() => {
    if (embedded) return;
    setExtraInvoiceKeys((list) => [...list, `sales-batch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`]);
  }, [embedded]);
  const removeExtraInvoice = useCallback((key) => {
    batchSaveRefs.current.delete(key);
    setExtraInvoiceKeys((list) => list.filter((item) => item !== key));
  }, []);

  const [header, setHeader] = useState({
    invoiceNo: "",
    date: initialDateForFinancialYear(fy),
    orderNo: "",
    arn: "",
    noOfPackages: 0,
    deliveryBoy: "",
    gstType: "CGST_SGST",
    remarks: "",
    warehouseId: "",
    eInvoice: { status: "NOT_GENERATED", irn: "", ackNo: "", ackDate: "", signedQrPayload: "" },
  });

  const recalc = (row) => {
    const taxable = round2(Number(row.basicRate || 0) * (1 - Number(row.discountPct || 0) / 100) * Number(row.qty || 0));
    const tax = round2((taxable * Number(row.gstRate || 0)) / 100);
    const eff = Number(row.qty || 0) ? taxable / Number(row.qty || 1) : 0;
    const purchaseRate = Number(row.landedCost || 0);
    const billingError = row.productId && purchaseRate > 0 && eff + 0.005 < purchaseRate
      ? `Billing ₹${eff.toFixed(2)} below purchase ₹${purchaseRate.toFixed(2)}`
      : "";
    const available = Number(row.availableQty || 0);
    const qty = Number(row.qty || 0);
    return {
      ...row,
      grossQty: Number(row.qtyInBag || 0) > 0 ? round2(qty / Number(row.qtyInBag || 1)) : qty,
      taxable,
      tax,
      lineTotal: round2(taxable + tax),
      billingError,
      qtyError: row.productId && (qty <= 0 || qty > available) ? "Qty not available" : "",
    };
  };

  const resetCreate = () => {
    setCustomerId("");
    setRows([newRow()]);
    setAdjustments([]);
    setCustomerFinancial({});
    setEditingOriginalGrand(0);
    setHeader({
      invoiceNo: "",
      date: initialDateForFinancialYear(fy),
      orderNo: "",
      arn: "",
      noOfPackages: 0,
      deliveryBoy: "",
      gstType: "CGST_SGST",
      remarks: "",
      warehouseId: "",
      eInvoice: { status: "NOT_GENERATED", irn: "", ackNo: "", ackDate: "", signedQrPayload: "" },
    });
  };

  const hydrateEdit = (invoice, productList) => {
    setCustomerId(invoice.customerGlobalId || "");
    setHeader({
      invoiceNo: invoice.invoiceNo || "",
      date: invoice.date ? ymd(invoice.date) : initialDateForFinancialYear(fy),
      orderNo: invoice.orderNo || "",
      arn: invoice.arn || "",
      noOfPackages: Number(invoice.noOfPackages || 0),
      deliveryBoy: invoice.deliveryBoy || "",
      gstType: invoice.gstType || "CGST_SGST",
      remarks: invoice.remarks || "",
      warehouseId: invoice.warehouseId || "",
      eInvoice: {
        status: invoice.eInvoice?.status || "NOT_GENERATED",
        irn: invoice.eInvoice?.irn || "",
        ackNo: invoice.eInvoice?.ackNo || "",
        ackDate: invoice.eInvoice?.ackDate ? ymd(invoice.eInvoice.ackDate) : "",
        signedQrPayload: invoice.eInvoice?.signedQrPayload || "",
      },
    });
    const hydrated = (invoice.items || []).map((item) => {
      const p = productList.find((product) => String(product._id) === String(item.productId));
      const discountPct = Number(item.discountPct || 0);
      const basicRate = discountPct < 100
        ? round2(Number(item.effectiveRate || 0) / Math.max(0.0001, 1 - discountPct / 100))
        : basicFromSaleGST(item.rate || 0, item.gstRateSnapshot || 0);
      return recalc({
        ...newRow(),
        productId: String(item.productId || ""),
        productName: p?.name || item.nameSnapshot || item.productNameSnapshot || "",
        hsnCode: p?.hsnCode || item.hsnSnapshot || item.hsnCodeSnapshot || "",
        qty: Number(item.qty || 0),
        availableQty: Number(p?.currentStock || 0) + Number(item.qty || 0),
        basicUnit: p?.basicUnit || item.unit || "PCS",
        packingUnit: p?.packingUnitName || p?.packingUnit || item.packingUnit || "",
        qtyInBag: Number(p?.qtyInBag || item.qtyInBag || 1),
        mrp: Number(item.mrpSnapshot || p?.mrp || 0),
        gradeDiscountPct: Number(item.gradeDiscountPct || 0),
        saleRate: Number(item.rate || 0),
        basicRate,
        discountPct,
        gstRate: Number(item.gstRateSnapshot || p?.gstRate || 0),
        landedCost: Number(item.averagePurchasePriceSnapshot || item.landedCostSnapshot || p?.averagePurchaseRate || p?.averagePurchasePrice || 0),
      }, productList);
    });
    setRows(hydrated.length ? hydrated : [newRow()]);
    const seeded = [];
    if (Number(invoice.billDiscount || 0)) seeded.push({ ...newAdjustment("Discount"), title: "Bill Discount", value: Number(invoice.billDiscount || 0) });
    if (Number(invoice.otherCharges || 0)) seeded.push({ ...newAdjustment("Charges"), title: "Other Charges", value: Number(invoice.otherCharges || 0) });
    setAdjustments(seeded);
    setEditingOriginalGrand(Number(invoice.grandTotal || 0));
  };

  const hydrateOrderDraft = (draft, productList) => {
    setOrderDraft(draft);
    setCustomerId(draft.customerGlobalId || "");
    setHeader((old) => ({
      ...old,
      orderNo: draft.orderNo || "",
      noOfPackages: Number(draft.packageCount || 0),
      remarks: old.remarks || `Generated from sales order ${draft.orderNo || ""}`,
    }));
    const hydrated = (draft.items || []).map((item) => {
      const p = productList.find((product) => String(product._id) === String(item.productId));
      const basicRate = Number(item.basicRate ?? item.rate ?? 0);
      const gstRate = Number(item.gstRate ?? p?.gstRate ?? 0);
      return recalc({
        ...newRow(),
        productId: String(item.productId || ""),
        productName: p?.name || item.nameSnapshot || "",
        hsnCode: p?.hsnCode || item.hsnCode || item.hsnSnapshot || "",
        qty: Number(item.qty || 0),
        availableQty: Number(p?.currentStock ?? p?.openingStock ?? item.qty ?? 0),
        basicUnit: p?.basicUnit || item.unit || "PCS",
        packingUnit: p?.packingUnitName || p?.packingUnit || item.packingUnit || "",
        qtyInBag: Number(p?.qtyInBag || item.qtyInBag || 1),
        mrp: Number(p?.mrp || 0),
        gradeDiscountPct: Number(item.gradeDiscountPct || 0),
        saleRate: saleFromBasicGST(basicRate, gstRate),
        basicRate,
        discountPct: Number(item.discountPct || 0),
        gstRate,
        landedCost: Number(p?.averagePurchaseRate || p?.averagePurchasePrice || p?.lastPurchasePrice || p?.openingRate || 0),
      });
    });
    setRows(hydrated.length ? hydrated : [newRow()]);
  };

  const load = async () => {
    setLoading(true);
    try {
      const invoiceYears = !createMode
        ? (listFy === "ALL" ? buildFinancialYears(10) : [listFy])
        : [fy];
      const invoicePromise = Promise.all(
        invoiceYears.map((year) =>
          fetchAllPaged(`/transactions/sales-invoices?financialYear=${encodeURIComponent(year)}`, 100)
            .catch(() => []),
        ),
      ).then((groups) => groups.flat());
      const [customerList, productList, invoiceList, warehouseResult] = await Promise.all([
        fetchTransactionParties(200),
        fetchAllPaged(
          `/catalog/old-dms-price-list/products?financialYear=${encodeURIComponent(fy)}`,
          200,
        ),
        invoicePromise,
        api("/modules/dms/warehouses?status=ACTIVE&limit=200").catch(() => ({ items: [] })),
      ]);
      const warehouseList = Array.isArray(warehouseResult) ? warehouseResult : (warehouseResult?.items || []);
      setCustomers(customerList);
      setProducts(productList);
      setInvoices(invoiceList);
      setWarehouses(warehouseList);
      if (!editId && createMode && warehouseList.length === 1) {
        setHeader((h) => ({ ...h, warehouseId: h.warehouseId || String(warehouseList[0]._id) }));
      }

      if (sourceOrderId && !editId) {
        const draft = await api(`/sales-app/order-flow/orders/${encodeURIComponent(sourceOrderId)}/invoice-draft?financialYear=${encodeURIComponent(fy)}`);
        hydrateOrderDraft(draft, productList);
      } else if (!editId) {
        setOrderDraft(null);
      }

      if (editId) {
        const invoice = await api(`/transactions/sales-invoices/${editId}?financialYear=${encodeURIComponent(fy)}`);
        hydrateEdit(invoice, productList);
        setNextInvoiceNo(invoice.invoiceNo || "");
        setSeriesMsg("");
      } else if (createMode) {
        try {
          const n = await api(`/transactions/sales-invoices/next-number?financialYear=${encodeURIComponent(fy)}`);
          setNextInvoiceNo(n.invoiceNo || "");
          setSeriesMsg("");
        } catch (e) {
          setNextInvoiceNo("");
          setSeriesMsg(e.message);
        }
      }
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fy, listFy, editId, createMode, sourceOrderId]);

  useEffect(() => {
    let active = true;
    if (!createMode || editId) return () => { active = false; };
    const customerQuery = customerId ? `&customerGlobalId=${encodeURIComponent(customerId)}` : "";
    api(`/transactions/sales-invoices/next-number?financialYear=${encodeURIComponent(fy)}${customerQuery}`)
      .then((result) => {
        if (!active) return;
        setNextInvoiceNo(result?.invoiceNo || "");
        setSeriesMsg("");
      })
      .catch((error) => {
        if (!active) return;
        setNextInvoiceNo("");
        setSeriesMsg(error.message || "Could not generate invoice number");
      });
    return () => { active = false; };
  }, [customerId, fy, createMode, editId]);

  const customer = customers.find((c) => c.globalCustomerId === customerId);
  const customerTransport = customer?.assignedTransportDetails || null;
  const customerGstin = partyGstin(customer);
  const customerDeliveryAddress = customer?.addresses?.find((a) => String(a?.type || "BILLING").toUpperCase() === "BILLING") || customer?.addresses?.[0] || {};
  const customerDeliveryCity = String(customerDeliveryAddress?.city || "").trim();
  // The system-managed CASH customer is intentionally transporter-free.
  // Use the permanent system identity first; the name fallback is restricted
  // to system-managed records so a normal customer named "Cash" is unaffected.
  const isCashCustomer = Boolean(
    customer && (
      String(customer.systemKey || "").trim().toUpperCase() === "CASH" ||
      (customer.systemManaged === true && String(customer.localName || "").trim().toUpperCase() === "CASH")
    )
  );
  const transportRequiredForCustomer = Boolean(
    !isCashCustomer &&
    cityKey(companyCity) &&
    cityKey(customerDeliveryCity) &&
    cityKey(companyCity) !== cityKey(customerDeliveryCity)
  );
  const companyGstStateCode = companyGstin.match(/^\d{2}/)?.[0] || "";
  const customerGstStateCode = customerGstin.match(/^\d{2}/)?.[0] || "";
  const autoGstType = companyGstStateCode && customerGstStateCode
    ? (companyGstStateCode === customerGstStateCode ? "CGST_SGST" : "IGST")
    : "";
  const customerMap = useMemo(
    () => new Map(customers.map((c) => [String(c.globalCustomerId || ""), c])),
    [customers],
  );
  const setH = (k, v) => {
    setHeader((h) => ({ ...h, [k]: v }));
    if (k === "date" && !editId) {
      const dateFy = financialYearFromDate(v);
      if (dateFy && dateFy !== fy) setFy(dateFy);
    }
  };
  const setEInvoice = (k, v) => setHeader((h) => ({
    ...h,
    eInvoice: { ...(h.eInvoice || {}), [k]: v },
  }));

  useEffect(() => {
    if (autoGstType && createMode && !editId) setHeader((h) => h.gstType === autoGstType ? h : ({ ...h, gstType: autoGstType }));
  }, [autoGstType, createMode, editId]);

  useEffect(() => {
    let alive = true;
    if (!customerId || !createMode) {
      setCustomerFinancial({});
      return () => {
        alive = false;
      };
    }
    api(
      `/customers/${encodeURIComponent(customerId)}/360?financialYear=${encodeURIComponent(fy)}`,
    )
      .then((result) => {
        if (alive) setCustomerFinancial(result?.financial || {});
      })
      .catch(() => {
        if (alive) setCustomerFinancial({});
      });
    return () => {
      alive = false;
    };
  }, [customerId, fy, createMode]);

  const selectProduct = (index, id) => {
    const p = products.find((x) => String(x._id) === String(id));
    if (!p) return;
    const gradePct = Number(customer?.gradeDiscountPct || 0);
    const saleRate = saleFromMRPByGrade(p.mrp || p.salePrice || 0, gradePct);
    const basic = basicFromSaleGST(saleRate, p.gstRate || 0);
    setRows((rs) => rs.map((r, i) => i === index ? recalc({
      ...r,
      productId: id,
      productName: p.name || "",
      hsnCode: p.hsnCode || "",
      availableQty: Number(p.currentStock ?? p.openingStock ?? 0),
      basicUnit: p.basicUnit || p.unit || "PCS",
      packingUnit: p.packingUnitName || p.packingUnit || "",
      qtyInBag: Number(p.qtyInBag || 1),
      mrp: Number(p.mrp || 0),
      gradeDiscountPct: gradePct,
      saleRate,
      basicRate: basic,
      gstRate: Number(p.gstRate || 0),
      landedCost: Number(p.averagePurchaseRate || p.averagePurchasePrice || p.lastPurchasePrice || p.openingRate || 0),
    }) : r));
  };

  const changeRow = (i, k, v) => setRows((rs) => rs.map((r, x) => x === i ? recalc({ ...r, [k]: v }) : r));
  const changeGrossQty = (i, gross) => setRows((rs) => rs.map((r, x) => x === i ? recalc({ ...r, qty: round2(Number(gross || 0) * Number(r.qtyInBag || 1)) }) : r));
  const changeSaleRate = (i, sale) => setRows((rs) => rs.map((r, x) => x === i ? recalc({ ...r, saleRate: sale, basicRate: basicFromSaleGST(sale, r.gstRate) }) : r));
  const changeBasicRate = (i, basic) => setRows((rs) => rs.map((r, x) => x === i ? recalc({ ...r, basicRate: basic, saleRate: saleFromBasicGST(basic, r.gstRate) }) : r));
  const changeBasicTotal = (i, total) => setRows((rs) => rs.map((r, x) => {
    if (x !== i) return r;
    const qty = Number(r.qty || 0);
    const discountFactor = Math.max(0, 1 - Number(r.discountPct || 0) / 100);
    const targetTotal = Math.max(0, Number(total || 0));
    const basicRate = qty > 0 && discountFactor > 0
      ? targetTotal / (qty * discountFactor)
      : qty > 0 ? targetTotal / qty : 0;
    const preciseBasicRate = Number(basicRate.toFixed(6));
    return recalc({
      ...r,
      basicRate: preciseBasicRate,
      saleRate: saleFromBasicGST(preciseBasicRate, r.gstRate),
    });
  }));
  const beginBasicTotalEdit = (i, value) => {
    setBasicTotalEdit({ index: i, value: String(value ?? "") });
  };
  const editBasicTotal = (i, value) => {
    // Text + inputMode keeps normal caret/selection behaviour and also lets
    // users temporarily type values such as "12." without React changing it.
    if (value !== "" && !/^\d*(?:\.\d*)?$/.test(value)) return;
    setBasicTotalEdit({ index: i, value });
    changeBasicTotal(i, value === "" || value === "." ? 0 : Number(value));
  };
  const finishBasicTotalEdit = (i) => {
    setBasicTotalEdit((current) => current?.index === i ? null : current);
  };

  const mastersFor = (type) => adjustmentMasters.filter((x) => x.type === type && x.active !== false);
  const chooseAdjustmentMaster = (type, id) => {
    setSelectedAdjustmentMaster((old) => ({ ...old, [type]: id }));
    const master = adjustmentMasters.find((x) => String(x.id) === String(id));
    if (!master) return;
    setAdjustments((list) => {
      if (list.some((x) => String(x.masterId || "") === String(master.id))) return list;
      return [...list, newAdjustment(type, master)];
    });
  };
  const removeAdjustment = (row) => {
    setAdjustments((list) => list.filter((x) => x.id !== row.id));
    setSelectedAdjustmentMaster((selected) =>
      String(selected?.[row.type] || "") === String(row.masterId || "")
        ? { ...selected, [row.type]: "" }
        : selected,
    );
  };
  const openAdjustmentMasterEditor = (type, id = "") => {
    const row = adjustmentMasters.find((x) => String(x.id) === String(id));
    setAdjustmentMasterEditor(row ? { ...row } : { id: "", type, title: "", method: type === "Discount" ? "Percentage" : "Amount", value: 0, active: true });
  };
  const saveAdjustmentMaster = () => {
    const draft = adjustmentMasterEditor;
    if (!draft || !String(draft.title || "").trim()) return;
    const id = draft.id || `adj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const saved = { ...draft, id, title: String(draft.title).trim(), value: Number(draft.value || 0), active: draft.active !== false };
    setAdjustmentMasters((old) => {
      const next = old.some((x) => String(x.id) === String(id)) ? old.map((x) => String(x.id) === String(id) ? saved : x) : [...old, saved];
      writeAdjustmentMasters(next);
      return next;
    });
    setSelectedAdjustmentMaster((old) => ({ ...old, [saved.type]: id }));
    setAdjustments((list) => {
      const exists = list.some((x) => String(x.masterId || "") === String(id));
      if (!exists) return [...list, newAdjustment(saved.type, saved)];
      return list.map((x) => String(x.masterId || "") === String(id)
        ? { ...x, title: saved.title, method: saved.method, value: Number(saved.value || 0) }
        : x);
    });
    setAdjustmentMasterEditor(null);
  };

  useEffect(() => {
    if (customerId) {
      setRows((rs) => rs.map((r) => r.productId ? r : { ...r, gradeDiscountPct: Number(customer?.gradeDiscountPct || 0) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  const adjustmentCalc = useMemo(() => {
    const base = round2(rows.reduce((s, r) => s + Number(r.taxable || 0), 0));
    return computeInvoiceAdjustments(base, adjustments);
  }, [rows, adjustments]);

  const taxSummary = useMemo(
    () => buildInvoiceTaxSummary(
      rows,
      adjustmentCalc.discountTotal,
      adjustmentCalc.chargesTotal,
      header.gstType,
    ),
    [rows, adjustmentCalc.discountTotal, adjustmentCalc.chargesTotal, header.gstType],
  );

  const totals = useMemo(() => ({
    lineSubtotal: adjustmentCalc.base,
    discountTotal: adjustmentCalc.discountTotal,
    chargesTotal: adjustmentCalc.chargesTotal,
    taxable: taxSummary.taxableTotal,
    tax: taxSummary.taxTotal,
    roundOff: taxSummary.roundOff,
    grand: taxSummary.grand,
  }), [adjustmentCalc, taxSummary]);

  const hsnSummary = taxSummary.rows;

  const billingErrors = useMemo(() => {
    const factor = totals.lineSubtotal > 0
      ? Math.max(0, (totals.lineSubtotal - totals.discountTotal) / totals.lineSubtotal)
      : 1;
    return rows.map((row, index) => {
      if (!row.productId || Number(row.qty || 0) <= 0) return null;
      const purchaseRate = Number(row.landedCost || 0);
      const beforeBillRate = Number(row.qty || 0) ? Number(row.taxable || 0) / Number(row.qty || 1) : 0;
      const billingRate = round2(beforeBillRate * factor);
      if (purchaseRate > 0 && billingRate + 0.005 < purchaseRate) {
        return { index, message: `Billing ₹${billingRate.toFixed(2)} below purchase ₹${purchaseRate.toFixed(2)}` };
      }
      return null;
    }).filter(Boolean);
  }, [rows, totals.lineSubtotal, totals.discountTotal]);
  const billingErrorMap = useMemo(() => new Map(billingErrors.map((x) => [x.index, x.message])), [billingErrors]);

  const credit = useMemo(() => {
    const sanctioned = Number(customer?.creditLimit || customer?.limit || 0);
    const ledgerOutstanding = Number(
      customerFinancial?.outstanding ??
        customer?.outstandingAmount ??
        customer?.ledgerBalance ??
        customer?.balance ??
        0,
    );
    const outstanding = round2(
      ledgerOutstanding - Number(editingOriginalGrand || 0),
    );
    const pending = Number(customer?.pendingSales ?? customer?.pendingAmount ?? 0);
    const balance = round2(sanctioned - outstanding - pending);
    const net = round2(balance - Number(totals.grand || 0));
    return { sanctioned, outstanding, pending, balance, net };
  }, [customer, customerFinancial, editingOriginalGrand, totals.grand]);

  const saveInvoice = async ({ stayOnCreate = embedded } = {}) => {
    setMsg("");
    if (!customerId) { setMsg("Select a buyer / party"); return false; }
    if (!header.warehouseId) { setMsg("Warehouse is mandatory"); return false; }
    if (rows.some((r) => !r.productId || Number(r.qty || 0) <= 0)) { setMsg("Complete every product row"); return false; }
    if (rows.some((r) => r.qtyError)) { setMsg("One or more product rows have insufficient stock"); return false; }
    if (billingErrors.length) { setMsg(`${billingErrors[0].message}. Invoice cannot be posted below purchase price.`); return false; }
    if (totals.grand > 49999 && !String(header.arn || "").trim()) { setMsg("ARN / reference is required above ₹49,999"); return false; }
    if (String(header.eInvoice?.status || "").toUpperCase() === "GENERATED") {
      if (!String(header.eInvoice?.irn || "").trim()) { setMsg("GST e-Invoice IRN is required when status is GENERATED"); return false; }
      if (!String(header.eInvoice?.ackNo || "").trim()) { setMsg("GST e-Invoice Ack No. is required when status is GENERATED"); return false; }
      if (!String(header.eInvoice?.ackDate || "").trim()) { setMsg("GST e-Invoice Ack Date is required when status is GENERATED"); return false; }
    }
    setLoading(true);
    try {
      const postingFy = financialYearFromDate(header.date) || fy;
      const payload = {
        ...header,
        invoiceNo: editId ? header.invoiceNo : nextInvoiceNo,
        financialYear: postingFy,
        sourceFinancialYear: fy,
        sourceOrderId: sourceOrderId || "",
        billingMode: sourceOrderId ? "ORDER" : "DIRECT",
        // The order lifecycle has already performed credit-control verification.
        // Direct invoices continue through the normal invoice credit checks.
        creditOverrideApproved: Boolean(sourceOrderId),
        customerGlobalId: customerId,
        billDiscount: totals.discountTotal,
        otherCharges: totals.chargesTotal,
        items: rows.map((r) => ({
          productId: r.productId,
          qty: Number(r.qty),
          mrp: Number(r.mrp),
          saleRate: Number(r.saleRate),
          basicRate: Number(r.basicRate),
          discountPct: Number(r.discountPct),
          gradeDiscountPct: Number(r.gradeDiscountPct),
          gstRate: Number(r.gstRate),
        })),
      };
      const inv = await api(editId ? `/transactions/sales-invoices/${editId}` : "/transactions/sales-invoices", {
        method: editId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      setMsg(`Sales Invoice ${inv.invoiceNo} ${editId ? "updated" : "posted"}`);
      resetCreate();
      await load();
      if (!stayOnCreate) setSearchParams({ financialYear: postingFy });
      return true;
    } catch (e) {
      setMsg(e.message);
      return false;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!embedded || !registerBatchSaveProp || !batchKey) return undefined;
    registerBatchSaveProp(batchKey, () => saveInvoice({ stayOnCreate: true }));
    return () => registerBatchSaveProp(batchKey, null);
  });

  const submitAllInvoices = async () => {
    if (embedded || editId) return;
    setBatchSaving(true);
    let success = 0;
    let failed = 0;
    const ownOk = await saveInvoice({ stayOnCreate: true });
    ownOk ? success++ : failed++;
    for (const key of extraInvoiceKeys) {
      const fn = batchSaveRefs.current.get(key);
      if (!fn) { failed++; continue; }
      const ok = await fn();
      ok ? success++ : failed++;
    }
    setBatchSaving(false);
    if (!failed) {
      setExtraInvoiceKeys([]);
      setMsg(`${success} Sales Invoices posted successfully`);
      setSearchParams({ financialYear: fy });
      await load();
    } else {
      setMsg(`${success} invoice(s) posted. ${failed} invoice(s) need correction. Open the invoice block showing an error.`);
    }
  };

  const deleteInvoice = async () => {
    if (!editId) return;
    if (!window.confirm(`Delete invoice ${header.invoiceNo}? Stock will be restored and accounting will be reversed.`)) return;
    setLoading(true);
    setMsg("");
    try {
      await api(`/transactions/sales-invoices/${editId}?financialYear=${encodeURIComponent(fy)}`, { method: "DELETE" });
      setMsg(`Sales Invoice ${header.invoiceNo} deleted`);
      setSearchParams({ financialYear: fy });
      resetCreate();
      await load();
    } catch (e) {
      setMsg(e.message);
    } finally {
      setLoading(false);
    }
  };

  const openCreate = () => {
    resetCreate();
    setSearchParams({ create: "1", financialYear: fy });
  };
  const openInvoiceEdit = (row) => {
    const nextFy = row.financialYear || fy;
    setFy(nextFy);
    setSearchParams({ edit: row._id, financialYear: nextFy });
  };
  const backToList = () => {
    setSearchParams({ financialYear: fy });
    resetCreate();
  };

  const periodFiltered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const startYear = listFy === "ALL" ? null : fyStart(listFy);
    return invoices.filter((r) => {
      if (classifyRegistration(r, customerMap.get(String(r.customerGlobalId || ""))) !== activeBucket) return false;
      const d = new Date(r.date || r.createdAt || 0);
      if (Number.isNaN(d.getTime())) return false;
      const m = d.getMonth();
      const y = d.getFullYear();
      const inFy = startYear === null || (m >= 3 && y === startYear) || (m <= 2 && y === startYear + 1);
      if (!inFy) return false;

      if (periodType === "MONTHLY" && monthNames[m] !== selectedMonth) return false;
      if (periodType === "QUARTERLY") {
        const qMap = { Q1: [3, 4, 5], Q2: [6, 7, 8], Q3: [9, 10, 11], Q4: [0, 1, 2] };
        if (!(qMap[selectedQuarter] || []).includes(m)) return false;
      }
      if (periodType === "HALF_YEARLY") {
        const hMap = { H1: [3, 4, 5, 6, 7, 8], H2: [9, 10, 11, 0, 1, 2] };
        if (!(hMap[selectedHalf] || []).includes(m)) return false;
      }

      if (!q) return true;
      return [r.invoiceNo, r.partyNameDisplay || r.customerNameSnapshot, r.userNameDisplay || r.createdByNameSnapshot, r.status, r.remarks, r.orderNo]
        .map((x) => String(x || "").toLowerCase())
        .some((x) => x.includes(q));
    });
  }, [invoices, customerMap, activeBucket, periodType, selectedMonth, selectedQuarter, selectedHalf, search, listFy]);

  const groupedRows = useMemo(() => {
    const map = new Map();
    periodFiltered.forEach((r) => {
      const d = new Date(r.date || r.createdAt || 0);
      if (Number.isNaN(d.getTime())) return;
      const month = monthNames[d.getMonth()];
      const rowFy = r.financialYear || `${d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear()-1}-${String(((d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear()-1)+1)%100).padStart(2,"0")}`;
      const key = listFy === "ALL" ? `${rowFy}-${month}` : month;
      const label = listFy === "ALL" ? `${month} • FY ${rowFy}` : month;
      if (!map.has(key)) map.set(key, { key, month, label, rows: [] });
      map.get(key).rows.push(r);
    });
    return Array.from(map.values())
      .sort((a,b) => {
        const ay = Number(String(a.rows[0]?.financialYear||0).slice(0,4));
        const by = Number(String(b.rows[0]?.financialYear||0).slice(0,4));
        if (ay !== by) return by-ay;
        return fyMonthOrder.indexOf(a.month)-fyMonthOrder.indexOf(b.month);
      })
      .map((g) => ({ ...g, rows: g.rows.sort((a,b) => new Date(b.date||b.createdAt||0)-new Date(a.date||a.createdAt||0)) }));
  }, [periodFiltered, listFy]);

  useEffect(() => {
    if (groupedRows.length) {
      setMonthOpen((prev) => {
        const next = { ...prev };
        groupedRows.forEach((g) => { if (next[g.key] === undefined) next[g.key] = false; });
        return next;
      });
    }
  }, [groupedRows]);

  const listTotals = useMemo(() => periodFiltered.reduce((a, r) => {
    const t = getInvoiceTaxSplit(r);
    return {
      basic: a.basic + Number(r.subtotal ?? r.taxableTotal ?? 0),
      igst: a.igst + t.igst, cgst: a.cgst + t.cgst, sgst: a.sgst + t.sgst,
      roundOff: a.roundOff + Number(r.roundOff || 0),
      grand: a.grand + Number(r.grandTotal || 0),
      net: a.net + Number(r.netInvoiceAmount ?? (Number(r.grandTotal || 0) - Number(r.creditNoteAmount || 0))),
    };
  }, { basic:0, igst:0, cgst:0, sgst:0, roundOff:0, grand:0, net:0 }), [periodFiltered]);

  const openDelivery = (invoice) => {
    setDeliveryTarget(invoice);
    setDeliveryProof(null);
    setBiltyCopy(null);
    setDeliveryForm({
      deliveredAt: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16),
      deliveredTo: "",
      deliveryMobile: "",
      vehicleNo: "",
      biltyNo: "",
      deliveryRemarks: "",
    });
  };

  const deliveryCustomer = deliveryTarget ? customerMap.get(String(deliveryTarget.customerGlobalId || "")) : null;
  const deliveryNonLocal = Boolean(deliveryTarget) && String(deliveryTarget?.transportAssignment?.mode || deliveryCustomer?.regionType || "LOCAL").toUpperCase() !== "LOCAL";

  const markDelivered = async () => {
    if (!deliveryTarget) return;
    if (!deliveryForm.deliveredTo.trim()) return setMsg("Delivered To is required");
    if (!deliveryProof) return setMsg("Delivery proof is required");
    if (deliveryNonLocal && !biltyCopy) return setMsg("Bilty / LR copy is mandatory for a non-local customer");
    setDeliverySaving(true);
    try {
      const body = new FormData();
      body.append("financialYear", fy);
      body.append("toStatus", "DELIVERED");
      Object.entries(deliveryForm).forEach(([key, value]) => body.append(key, value || ""));
      body.append("deliveryProof", deliveryProof);
      if (biltyCopy) body.append("biltyCopy", biltyCopy);
      const updated = await api(`/transactions/sales-invoices/${deliveryTarget._id}/process`, { method: "POST", body });
      const emailStatus = updated?.delivery?.emailStatus;
      setMsg(emailStatus === "SENT"
        ? `Invoice ${deliveryTarget.invoiceNo} delivered and emailed to ${updated.delivery.emailTo}.`
        : `Invoice ${deliveryTarget.invoiceNo} delivered. Email status: ${emailStatus || "not sent"}${updated?.delivery?.emailError ? ` - ${updated.delivery.emailError}` : ""}`);
      setDeliveryTarget(null);
      await load();
    } catch (error) {
      setMsg(error.message);
    } finally {
      setDeliverySaving(false);
    }
  };

  const fyOptions = useMemo(() => buildFinancialYears(10), []);

  const openInvoicePdf = async (invoice, download = false) => {
    if (!invoice?._id) return;
    const viewer = download ? null : window.open("", "_blank");
    try {
      setMsg("");
      if (viewer) {
        viewer.document.title = `Invoice ${invoice.invoiceNo || ""}`;
        viewer.document.body.innerHTML = "<div style='font-family:Arial;padding:24px'>Generating invoice…</div>";
      }
      const pdfFy = invoice.financialYear || fy;
      const { blob } = await apiBlob(`/transactions/sales-invoices/${encodeURIComponent(invoice._id)}/pdf?financialYear=${encodeURIComponent(pdfFy)}${download ? "&download=1" : ""}`);
      const url = URL.createObjectURL(blob);
      if (download) {
        const a = document.createElement("a");
        a.href = url;
        a.download = `Invoice-${String(invoice.invoiceNo || invoice._id).replace(/[^a-z0-9._-]+/gi, "_")}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (viewer) {
        viewer.location.href = url;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        window.location.href = url;
      }
    } catch (e) {
      if (viewer && !viewer.closed) viewer.close();
      setMsg(e.message || "Could not generate invoice PDF");
    }
  };

  const downloadCsv = () => {
    const head = ["Invoice", "Date", "Party", "User", "Taxable", "GST", "Grand Total", "Status"];
    const lines = periodFiltered.map((r) => [
      r.invoiceNo || "",
      ymd(r.date || r.createdAt),
      r.partyNameDisplay || r.customerNameSnapshot || "",
      r.userNameDisplay || r.createdByNameSnapshot || "",
      getInvoiceTaxable(r).toFixed(2),
      getInvoiceTax(r).toFixed(2),
      Number(r.grandTotal || 0).toFixed(2),
      r.status || "",
    ]);
    const csv = [head, ...lines].map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Sales_Invoices_${listFy}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!createMode) {
    return (
      <>
        <PageHeader onAdd={openCreate} addLabel="CREATE SALES INVOICE" actions />
        {msg && <div className={`resultBanner ${msg.includes("posted") || msg.includes("updated") || msg.includes("deleted") ? "good" : "bad"}`}>{msg}</div>}

        <section className="panel oldDmsSalesList">
          <div className="oldDmsToolbar">
            <div className="oldDmsTabs">
              <button className={activeBucket === "REGULAR" ? "active" : ""} onClick={() => setActiveBucket("REGULAR")}>Regular</button>
              <button className={activeBucket === "UNREGISTER" ? "active" : ""} onClick={() => setActiveBucket("UNREGISTER")}>UnRegister</button>
            </div>

            <div className="oldDmsSearch"><Search size={15} /><input placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>

            <label className="oldDmsField"><span>FY</span><select value={listFy} onChange={(e) => setListFy(e.target.value)}><option value="ALL">All Financial Years</option>{fyOptions.map((x) => <option key={x} value={x}>{fyLabel(x)}</option>)}</select></label>
            <label className="oldDmsField"><span>Period</span><select value={periodType} onChange={(e) => setPeriodType(e.target.value)}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="HALF_YEARLY">Half Yearly</option><option value="YEARLY">Yearly</option></select></label>
            {periodType === "MONTHLY" && <label className="oldDmsField"><span>Month</span><select value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}>{fyMonthOrder.map((m) => <option key={m}>{m}</option>)}</select></label>}
            {periodType === "QUARTERLY" && <label className="oldDmsField"><span>Quarter</span><select value={selectedQuarter} onChange={(e) => setSelectedQuarter(e.target.value)}><option value="Q1">Q1 (Apr-Jun)</option><option value="Q2">Q2 (Jul-Sep)</option><option value="Q3">Q3 (Oct-Dec)</option><option value="Q4">Q4 (Jan-Mar)</option></select></label>}
            {periodType === "HALF_YEARLY" && <label className="oldDmsField"><span>Half</span><select value={selectedHalf} onChange={(e) => setSelectedHalf(e.target.value)}><option value="H1">H1 (Apr-Sep)</option><option value="H2">H2 (Oct-Mar)</option></select></label>}

            <span className="oldDmsCount">{periodFiltered.length}</span>
            <button className="oldDmsIconBtn" onClick={load} title="Refresh"><RefreshCw size={15} /></button>
            <button className="oldDmsIconBtn" onClick={downloadCsv} title="Export"><Download size={15} /></button>
          </div>

          <div className="oldDmsTableWrap">
            <table className="oldDmsInvoiceListTable">
              <thead><tr><th>#</th><th>Invoice</th><th>Status</th><th>Invoice No.</th><th>Date</th><th>Party Name</th><th>Party Limit</th><th>User Name</th><th>Basic Total</th><th>IGST</th><th>CGST</th><th>SGST</th><th>Round Off</th><th>Grand Total</th><th>CN Status</th><th>Net After CN</th>{admin&&<th>Margin</th>}</tr></thead>
              <tbody>
                {!groupedRows.length && <tr><td colSpan={admin?17:16} className="oldDmsEmpty">No sales invoice found for this period.</td></tr>}
                {groupedRows.map((group) => (
                  <React.Fragment key={group.key}>
                    <tr className="oldDmsMonthRow" onClick={() => setMonthOpen((p) => ({ ...p, [group.key]: !p[group.key] }))}>
                      <td colSpan={admin?17:16}><span>{monthOpen[group.key] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<b>{group.label}</b><small>{group.rows.length} invoice{group.rows.length === 1 ? "" : "s"} • {money(group.rows.reduce((s, r) => s + Number(r.grandTotal || 0), 0))}</small></span></td>
                    </tr>
                    {monthOpen[group.key] && group.rows.map((r, idx) => (
                      <tr key={r._id}>
                        <td>{idx + 1}</td>
                        <td><div className="invoiceRowActions"><button className="oldDmsEditBtn" onClick={() => openInvoicePdf(r)} title="View / Print Master Invoice"><FileText size={13}/></button><button className="oldDmsEditBtn" onClick={() => openInvoicePdf(r, true)} title="Download Master Invoice"><Download size={13}/></button><button className="oldDmsEditBtn" disabled={String(r.creditNoteStatus || "NONE").toUpperCase() !== "NONE"} onClick={() => openInvoiceEdit(r)} title={String(r.creditNoteStatus || "NONE").toUpperCase() !== "NONE" ? "Cancel issued Credit Note before editing this invoice" : "Edit invoice"}><Pencil size={13}/></button>{String(r.workflowStatus || "").toUpperCase() !== "DELIVERED" && <button className="oldDmsEditBtn deliverAction" onClick={() => openDelivery(r)} title="Mark delivered + email invoice"><PackageCheck size={13}/></button>}</div></td>
                        <td><StatusBadge value={r.workflowStatus || r.status || "POSTED"} /></td>
                        <td><button className="tableClickLink" onClick={() => openInvoicePdf(r)} title="View / Print Master Invoice">{r.invoiceNo || "—"}</button></td>
                        <td>{ymd(r.date || r.createdAt)}</td>
                        <td><EditMasterLink to="/dms/customers" id={r.customerGlobalId} resource="customer">{r.partyNameDisplay || r.customerNameSnapshot || "—"}</EditMasterLink></td>
                        <td>{money(customerMap.get(String(r.customerGlobalId || ""))?.creditLimit || 0)}</td>
                        <td>{r.userNameDisplay || r.createdByNameSnapshot || "—"}</td>
                        <td>{money(r.subtotal ?? r.taxableTotal ?? 0)}</td>
                        <td>{money(getInvoiceTaxSplit(r).igst)}</td>
                        <td>{money(getInvoiceTaxSplit(r).cgst)}</td>
                        <td>{money(getInvoiceTaxSplit(r).sgst)}</td>
                        <td>{money(r.roundOff || 0)}</td>
                        <td><b>{money(r.grandTotal)}</b></td>
                        <td><StatusBadge value={r.creditNoteStatus || "NONE"} /></td>
                        <td><b>{money(r.netInvoiceAmount ?? (Number(r.grandTotal || 0) - Number(r.creditNoteAmount || 0)))}</b>{Number(r.creditNoteAmount || 0) > 0 && <small style={{display:"block"}}>CN {money(r.creditNoteAmount)}</small>}</td>
                        {admin&&<td>{Number(r.grossMarginPct || 0).toFixed(1)}%</td>}
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot><tr><td colSpan="8">TOTAL</td><td>{money(listTotals.basic)}</td><td>{money(listTotals.igst)}</td><td>{money(listTotals.cgst)}</td><td>{money(listTotals.sgst)}</td><td>{money(listTotals.roundOff)}</td><td>{money(listTotals.grand)}</td><td></td><td>{money(listTotals.net)}</td>{admin&&<td />}</tr></tfoot>
            </table>
          </div>
        </section>

        {deliveryTarget && (
          <div className="modalOverlay deliveryProofOverlay">
            <section className="panel modalPanel deliveryProofModal">
              <div className="formTitle">
                <div><h3><PackageCheck size={18}/> Deliver {deliveryTarget.invoiceNo}</h3><span>Saving Delivery automatically emails the invoice PDF to the customer.</span></div>
                <div className="formTitleActions"><button className="iconBtn" type="button" onClick={() => setDeliveryTarget(null)}><X/></button></div>
              </div>
              <div className="deliveryCustomerStrip">
                <strong>{deliveryTarget.customerNameSnapshot}</strong>
                <span>{deliveryNonLocal ? "NON-LOCAL - delivery proof + bilty/LR mandatory" : "LOCAL - delivery proof mandatory"}</span>
                {deliveryTarget.transportAssignment?.mode!=="LOCAL"&&<small>{deliveryTarget.transportAssignment?.transporterNameSnapshot||"Transporter"} • Delivery: {deliveryTarget.transportAssignment?.deliveryStationNameSnapshot||deliveryTarget.transportAssignment?.serviceAreaSnapshot||"Assigned station"}{deliveryTarget.transportAssignment?.deliveryStationPincodeSnapshot?` (${deliveryTarget.transportAssignment.deliveryStationPincodeSnapshot})`:""}</small>}
              </div>
              <div className="formGrid deliveryFormGrid">
                <label>Delivered At<input type="datetime-local" value={deliveryForm.deliveredAt} onChange={(e)=>setDeliveryForm((f)=>({...f,deliveredAt:e.target.value}))}/></label>
                <label>Delivered To *<input value={deliveryForm.deliveredTo} onChange={(e)=>setDeliveryForm((f)=>({...f,deliveredTo:e.target.value}))} placeholder="Receiver name"/></label>
                <label>Receiver Mobile<input value={deliveryForm.deliveryMobile} onChange={(e)=>setDeliveryForm((f)=>({...f,deliveryMobile:e.target.value}))}/></label>
                <label>Vehicle No.<input value={deliveryForm.vehicleNo} onChange={(e)=>setDeliveryForm((f)=>({...f,vehicleNo:e.target.value.toUpperCase()}))}/></label>
                <label>Bilty / LR No.{deliveryNonLocal ? " *" : ""}<input value={deliveryForm.biltyNo} onChange={(e)=>setDeliveryForm((f)=>({...f,biltyNo:e.target.value}))}/></label>
                <label className="wideField">Delivery Details / Remarks<textarea value={deliveryForm.deliveryRemarks} onChange={(e)=>setDeliveryForm((f)=>({...f,deliveryRemarks:e.target.value}))} placeholder="Manual delivery details"/></label>
              </div>
              <div className="deliveryUploadGrid">
                <label className={deliveryProof ? "fileDrop ready" : "fileDrop"}><UploadCloud/><strong>Delivery Proof *</strong><span>{deliveryProof?.name || "Photo or PDF"}</span><input type="file" accept="image/*,.pdf" onChange={(e)=>setDeliveryProof(e.target.files?.[0]||null)}/></label>
                <label className={biltyCopy ? "fileDrop ready" : "fileDrop"}><UploadCloud/><strong>Bilty / LR Copy {deliveryNonLocal ? "*" : ""}</strong><span>{biltyCopy?.name || (deliveryNonLocal ? "Required for non-local customer" : "Optional")}</span><input type="file" accept="image/*,.pdf" onChange={(e)=>setBiltyCopy(e.target.files?.[0]||null)}/></label>
              </div>
              <div className="formActions"><button className="btn ghost" type="button" onClick={()=>setDeliveryTarget(null)}>Cancel</button><button className="btn primary" type="button" disabled={deliverySaving} onClick={markDelivered}>{deliverySaving ? "Saving..." : "Delivered + Send Mail"}</button></div>
            </section>
          </div>
        )}
      </>
    );
  }

  const batchMode = !embedded && !editId && extraInvoiceKeys.length > 0;
  const createForm = (
    <>
      {!embedded && <PageHeader actions={false} />}
      {msg && <div className={`resultBanner ${msg.includes("posted") || msg.includes("updated") || msg.includes("deleted") ? "good" : "bad"}`}>{msg}</div>}
      {seriesMsg && !editId && <div className="resultBanner bad">{seriesMsg}</div>}

      <SalesInvoiceLayout>
      <section className="panel oldDmsInvoiceComposer salesInvoiceFullWidth">
        <div className="oldDmsCreateHead">
          <div><b>{editId ? `EDIT SALES INVOICE ${header.invoiceNo || ""}` : sourceOrderId ? `ORDER INVOICE • ${orderDraft?.orderNo || header.orderNo || ""}` : "CREATE SALES INVOICE"}</b><small>{fyLabel(fy)}</small></div>
          <div>
            {editId && <button className="oldDmsDeleteBtn" disabled={loading} onClick={deleteInvoice} title="Delete Invoice"><Trash2 size={15} /></button>}
            {embedded ? (onRemoveInvoice && <button className="oldDmsCloseBtn" onClick={onRemoveInvoice} title="Remove this invoice"><X size={17} /></button>) : <button className="oldDmsCloseBtn" onClick={backToList} title="Back to Sales Invoice List"><X size={17} /></button>}
          </div>
        </div>

        <div className="oldDmsTopLine">
          <label data-invoice-field="buyer" className="od-wide"><span>Buyer / Party *</span><div className="lookupSelectRow"><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Select Buyer / Party</option>{customers.map((c) => <option key={c.globalCustomerId} value={c.globalCustomerId}>{partyOptionLabel(c)}{c.gradeCode ? ` • Grade ${c.gradeCode}` : ""}</option>)}</select><CreateLookupButton to="/dms/customers" label="Create" resource="customer" selectedValue={customerId} onReturn={load} /></div></label>
          <label data-invoice-field="date"><span>Order Date *</span><input type="date" value={header.date} onChange={(e) => setH("date", e.target.value)} /></label>
          <label data-invoice-field="invoice"><span>Invoice Number *</span><input value={editId ? header.invoiceNo : nextInvoiceNo} readOnly placeholder="Auto" /></label>
          <label data-invoice-field="warehouse" className="od-warehouse"><span>Warehouse *</span><select value={header.warehouseId || ""} onChange={(e) => setH("warehouseId", e.target.value)}><option value="">Select Warehouse</option>{warehouses.map((w) => <option key={w._id} value={w._id}>{w.title || w.reference || "Warehouse"}</option>)}</select></label>
          {totals.grand > 49999 && <label data-invoice-field="arn"><span>ARN Number *</span><input value={header.arn} onChange={(e) => setH("arn", e.target.value)} /></label>}

          {customer && credit.sanctioned > 0 ? (
            <>
              <label data-invoice-field="sanction"><span>Sanction Amount</span><input readOnly value={credit.sanctioned.toFixed(2)} /><small>Ledger B: {credit.outstanding.toFixed(2)}</small></label>
              <label data-invoice-field="pending"><span>Pending Amount</span><input readOnly value={credit.pending.toFixed(2)} /><small>Pending Sales</small></label>
              <label data-invoice-field="balance"><span>Balance Amount</span><input readOnly value={credit.balance.toFixed(2)} /></label>
              <label data-invoice-field="net" className={credit.net < 0 ? "od-net bad" : "od-net good"}><span>Net Balance</span><input readOnly value={credit.net.toFixed(2)} /></label>
            </>
          ) : customer ? <label data-invoice-field="payment"><span>Payment Mode *</span><input readOnly value={customer.paymentType || "CASH"} /></label> : null}
          {customer && transportRequiredForCustomer && <label data-invoice-field="transport" className="od-wide"><span>Assigned Transport</span><input readOnly value={customerTransport?.transporter?.name || "Assign in Customer Master"}/><small>{companyCity} → {customerDeliveryCity || "Customer City"} • {customerTransport?.deliveryStation?.name || customer.serviceArea || "Delivery station required"}{customerTransport?.deliveryStation?.pincode?` • ${customerTransport.deliveryStation.pincode}`:""}</small></label>}
        </div>

        <div className="oldDmsProductArea">
          {rows.map((r, i) => (
            <div className={`oldDmsProductRow ${billingErrorMap.has(i) ? "od-row-error" : ""}`} key={i}>
              <label data-invoice-field="product" className="od-product"><span>Product *</span><div className="lookupSelectRow"><select value={r.productId} onChange={(e) => selectProduct(i, e.target.value)}><option value="">Select Product</option>{products.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select><CreateLookupButton to="/dms/products" label="Create" resource="product" selectedValue={r.productId} onReturn={load} /></div></label>
              <label data-invoice-field="hsn"><span>HSN</span><input readOnly value={r.hsnCode || ""} /></label>
              <label data-invoice-field="grossUnit"><span>Gross Unit</span><input readOnly value={r.packingUnit || r.basicUnit || ""} /></label>
              <label data-invoice-field="grossQty"><span>Gross Qty</span><input type="number" step="any" value={r.grossQty || 0} onChange={(e) => changeGrossQty(i, Number(e.target.value))} /></label>
              <label data-invoice-field="available" className={r.qtyError ? "od-error" : ""}><span>Avail *</span><input readOnly value={r.availableQty || 0} />{r.qtyError && <small>{r.qtyError}</small>}</label>
              <label data-invoice-field="netQty" className={r.qtyError ? "od-error" : ""}><span>Net Qty *</span><input type="number" min="0" value={r.qty} onChange={(e) => changeRow(i, "qty", Number(e.target.value))} /></label>
              <label data-invoice-field="unit"><span>Unit</span><input readOnly value={r.basicUnit || ""} /></label>
              <label data-invoice-field="mrp"><span>MRP</span><input readOnly value={Number(r.mrp || 0).toFixed(3)} /></label>
              <label data-invoice-field="grade"><span>Grade %</span><input readOnly value={r.gradeDiscountPct || 0} /></label>
              <label data-invoice-field="sale"><span>Sale ₹ incl GST</span><input type="number" step="0.01" value={r.saleRate || 0} onChange={(e) => changeSaleRate(i, Number(e.target.value))} /></label>
              <label data-invoice-field="basic" className={billingErrorMap.has(i) ? "od-error" : ""}><span>Basic ₹ ex GST</span><input type="number" step="0.01" value={r.basicRate || 0} onChange={(e) => changeBasicRate(i, Number(e.target.value))} />{billingErrorMap.has(i) && <small>{billingErrorMap.get(i)}</small>}</label>
              <label data-invoice-field="discount"><span>Disc %</span><input type="number" step="0.01" value={r.discountPct || 0} onChange={(e) => changeRow(i, "discountPct", Number(e.target.value))} /></label>
              <label data-invoice-field="gst"><span>GST %</span><input readOnly value={r.gstRate || 0} /></label>
              <label data-invoice-field="total"><span>Basic Total</span><input type="text" inputMode="decimal" value={basicTotalEdit?.index === i ? basicTotalEdit.value : String(r.taxable ?? "")} onFocus={(e) => beginBasicTotalEdit(i, e.currentTarget.value)} onChange={(e) => editBasicTotal(i, e.target.value)} onBlur={() => finishBasicTotalEdit(i)} aria-label="Basic Total" /></label>
              <button className="oldDmsRemoveBtn" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, x) => x !== i))} title="Remove Product"><Trash2 size={14} /></button>
            </div>
          ))}
          <button className="oldDmsAddRowBtn" onClick={() => setRows((rs) => [...rs, newRow()])} title="Add Product"><Plus size={16} /></button>
        </div>

        <div className="oldDmsAdjustHead oldDmsAdjustMasterHead oldDmsAdjustmentOneRow">
          <b className="oldDmsAdjustTitle">Discount / Charges</b>
          {["Discount", "Charges"].map((type) => {
            const selectedId = selectedAdjustmentMaster[type] || "";
            return <div className={`oldDmsAdjustmentInline oldDmsAdjustmentInline${type}`} key={type}>
              <span className="oldDmsAdjustmentInlineLabel">{type}</span>
              <select value={selectedId} onChange={(e) => chooseAdjustmentMaster(type, e.target.value)} aria-label={`Select ${type}`}>
                <option value="">Select {type}</option>
                {mastersFor(type).map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
              <button type="button" className="lookupCreateBtn" onClick={() => openAdjustmentMasterEditor(type)} title={`Create ${type}`} aria-label={`Create ${type}`}><Plus size={14} /></button>
              {selectedId && <button type="button" className="lookupEditBtn" onClick={() => openAdjustmentMasterEditor(type, selectedId)} title={`Edit selected ${type}`} aria-label={`Edit selected ${type}`}><Pencil size={13} /></button>}
            </div>;
          })}
        </div>
        <div className="oldDmsAdjustTableWrap">
          <table className="oldDmsAdjustTable">
            <thead><tr><th>#</th><th>Type</th><th>Title</th><th>Method</th><th>% / Amount</th><th>Applied</th><th></th></tr></thead>
            <tbody>
              {!adjustments.length && <tr><td colSpan="7" className="oldDmsEmpty">No bill-level adjustment.</td></tr>}
              {adjustmentCalc.applied.map((a, i) => <tr key={a.id}><td>{i + 1}</td><td><b>{a.type}</b></td><td><input value={a.title} onChange={(e) => setAdjustments((list) => list.map((x) => x.id === a.id ? { ...x, title: e.target.value } : x))} /></td><td><select value={a.method} onChange={(e) => setAdjustments((list) => list.map((x) => x.id === a.id ? { ...x, method: e.target.value } : x))}><option>Amount</option><option>Percentage</option></select></td><td><input type="number" step="0.01" value={a.value} onChange={(e) => setAdjustments((list) => list.map((x) => x.id === a.id ? { ...x, value: Number(e.target.value) } : x))} /></td><td>{money(a.applied)}</td><td><button className="oldDmsRemoveBtn" onClick={() => removeAdjustment(a)}><Trash2 size={13} /></button></td></tr>)}
            </tbody>
          </table>
        </div>

        {adjustmentMasterEditor && <div className="modalOverlay oldDmsAdjustmentMasterModal">
          <section className="panel modalPanel">
            <div className="formTitle"><div><h3>{adjustmentMasterEditor.id ? "Edit" : "Create"} {adjustmentMasterEditor.type}</h3></div><button className="iconBtn" type="button" onClick={() => setAdjustmentMasterEditor(null)}><X /></button></div>
            <div className="formGrid oldDmsAdjustmentMasterForm">
              <label>Name<input autoFocus value={adjustmentMasterEditor.title} onChange={(e) => setAdjustmentMasterEditor((x) => ({ ...x, title: e.target.value }))} placeholder={adjustmentMasterEditor.type === "Discount" ? "Scheme Discount" : "Freight"} /></label>
              <label>Default Method<select value={adjustmentMasterEditor.method} onChange={(e) => setAdjustmentMasterEditor((x) => ({ ...x, method: e.target.value }))}><option>Amount</option><option>Percentage</option></select></label>
              <label>Default Value<input type="number" step="0.01" value={adjustmentMasterEditor.value} onChange={(e) => setAdjustmentMasterEditor((x) => ({ ...x, value: Number(e.target.value) }))} /></label>
            </div>
            <div className="formActions"><button className="btn ghost" type="button" onClick={() => setAdjustmentMasterEditor(null)}>Cancel</button><button className="btn primary" type="button" disabled={!String(adjustmentMasterEditor.title || "").trim()} onClick={saveAdjustmentMaster}>Save</button></div>
          </section>
        </div>}

        <div className="oldDmsInvoiceFoot">
          <div className="oldDmsHsnBlock">
            <div className="oldDmsMiniFields">
              <label data-invoice-field="gstType"><span>GST Type</span>{autoGstType?<><input readOnly value={header.gstType==="IGST"?"IGST":"CGST + SGST"}/><small>Auto from GST state code</small></>:<select value={header.gstType} onChange={(e) => setH("gstType", e.target.value)}><option value="CGST_SGST">CGST + SGST</option><option value="IGST">IGST</option></select>}</label>
              <label data-invoice-field="order"><span>Order No.</span><input value={header.orderNo} readOnly={Boolean(sourceOrderId)} onChange={(e) => setH("orderNo", e.target.value)} /></label>
              <label data-invoice-field="packages"><span>Packages</span><input type="number" value={header.noOfPackages} onChange={(e) => setH("noOfPackages", Number(e.target.value))} /></label>
              <label data-invoice-field="delivery"><span>Delivery Boy</span><input value={header.deliveryBoy} onChange={(e) => setH("deliveryBoy", e.target.value)} /></label>
              <label data-invoice-field="remarks" className="od-remarks"><span>Remarks</span><input value={header.remarks} onChange={(e) => setH("remarks", e.target.value)} /></label>
            </div>

            <div className="oldDmsMiniFields oldDmsEinvoiceFields">
              <label data-invoice-field="eStatus"><span>GST e-Invoice Status</span><select value={header.eInvoice?.status || "NOT_GENERATED"} onChange={(e) => setEInvoice("status", e.target.value)}><option value="NOT_GENERATED">Not Generated</option><option value="PENDING">Pending</option><option value="GENERATED">Generated</option><option value="CANCELLED">Cancelled</option></select></label>
              <label data-invoice-field="irn" className="od-wide"><span>IRN</span><input value={header.eInvoice?.irn || ""} onChange={(e) => setEInvoice("irn", e.target.value)} placeholder="64-character Invoice Reference Number" /></label>
              <label data-invoice-field="ack"><span>Ack No.</span><input value={header.eInvoice?.ackNo || ""} onChange={(e) => setEInvoice("ackNo", e.target.value)} /></label>
              <label data-invoice-field="ackDate"><span>Ack Date</span><input type="date" value={header.eInvoice?.ackDate || ""} onChange={(e) => setEInvoice("ackDate", e.target.value)} /></label>
              <label data-invoice-field="qr" className="od-wide"><span>Signed QR Payload</span><textarea rows="2" value={header.eInvoice?.signedQrPayload || ""} onChange={(e) => setEInvoice("signedQrPayload", e.target.value)} placeholder="Paste IRP signed QR payload; later GST API will auto-fill this" /></label>
            </div>

            {!!hsnSummary.length && <div className="oldDmsHsnWrap"><table><thead><tr><th>HSN</th><th>Taxable Value</th><th>Rate</th>{header.gstType === "IGST" ? <th>IGST</th> : <><th>CGST</th><th>SGST</th></>}<th>Total</th></tr></thead><tbody>{hsnSummary.map((h) => <tr key={`${h.hsn}-${h.rate}`}><td>{h.hsn}</td><td>{money(h.taxable)}</td><td>{h.rate}%</td>{header.gstType === "IGST" ? <td>{money(h.igst)}</td> : <><td>{money(h.cgst)}</td><td>{money(h.sgst)}</td></>}<td>{money(h.total)}</td></tr>)}<tr className="od-hsn-total"><td>TOTAL (Pre-Round)</td><td>{money(totals.taxable)}</td><td></td>{header.gstType === "IGST" ? <td>{money(totals.tax)}</td> : <><td>{money(totals.tax / 2)}</td><td>{money(totals.tax / 2)}</td></>}<td>{money(totals.taxable + totals.tax)}</td></tr><tr><td colSpan={header.gstType === "IGST" ? 4 : 5}>ROUND OFF</td><td>{money(totals.roundOff)}</td></tr><tr className="od-hsn-grand"><td colSpan={header.gstType === "IGST" ? 4 : 5}>GRAND TOTAL</td><td>{money(totals.grand)}</td></tr></tbody></table></div>}
          </div>

          <div className="oldDmsTotals">
            <div><span>Total</span><b>{money(totals.lineSubtotal)}</b></div>
            <div><span>Discount Total</span><b>{money(totals.discountTotal)}</b></div>
            <div><span>Charges Total</span><b>{money(totals.chargesTotal)}</b></div>
            <div><span>Taxable Value</span><b>{money(totals.taxable)}</b></div>
            {header.gstType === "IGST" ? <div><span>IGST</span><b>{money(totals.tax)}</b></div> : <><div><span>CGST</span><b>{money(totals.tax / 2)}</b></div><div><span>SGST</span><b>{money(totals.tax / 2)}</b></div></>}
            <div><span>Round Off</span><b>{money(totals.roundOff)}</b></div>
            <div className="grand"><span>Grand Total</span><b>{money(totals.grand)}</b></div>
            {!(embedded || batchMode) && <button className="oldDmsSubmitBtn" disabled={loading || !customerId || (!editId && !nextInvoiceNo)} onClick={() => saveInvoice()}>{loading ? "Saving..." : editId ? "Update Sales Invoice" : "Create Sales Invoice"}</button>}
            {(embedded || batchMode) && <div className="oldDmsEmpty">This invoice will be posted with <b>Submit All Invoices</b>.</div>}
          </div>
        </div>
      </section>
      </SalesInvoiceLayout>
    </>
  );

  if (embedded) {
    return (
      <div className="oldDmsMonthGroup">
        <button type="button" className="oldDmsMonthHead" onClick={() => setBatchOpen((open) => !open)}>
          {batchOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
          <b>Sales Invoice {batchIndex}</b>
          <span>{customer?.localName || customer?.displayName || customer?.companyName || "New invoice"}</span>
          <strong>{money(totals.grand)}</strong>
          {onRemoveInvoice && <span className="oldDmsTableActions" onClick={(e) => e.stopPropagation()}><button type="button" className="oldDmsTableActionBtn danger" title="Remove Invoice" onClick={onRemoveInvoice}><Trash2 size={13}/></button></span>}
        </button>
        {batchOpen && createForm}
      </div>
    );
  }

  return (
    <>
      {batchMode && <div className="oldDmsMonthGroup"><button type="button" className="oldDmsMonthHead" onClick={() => setBatchOpen((open) => !open)}>{batchOpen ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<b>Sales Invoice 1</b><span>{customer?.localName || customer?.displayName || customer?.companyName || "New invoice"}</span><strong>{money(totals.grand)}</strong></button></div>}
      {(!batchMode || batchOpen) && createForm}
      {!editId && extraInvoiceKeys.map((key, index) => (
        <SalesInvoicePage
          key={key}
          embedded
          batchIndex={index + 2}
          batchKey={key}
          registerBatchSave={registerBatchSave}
          onRemoveInvoice={() => removeExtraInvoice(key)}
        />
      ))}
      {!editId && <div className="formActions" style={{ justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button type="button" className="btn ghost" onClick={addMoreInvoice}><Plus size={15}/> Add More Invoices</button>
        {batchMode && <button type="button" className="btn primary" disabled={batchSaving} onClick={submitAllInvoices}>{batchSaving ? "Submitting..." : `Submit All Invoices (${extraInvoiceKeys.length + 1})`}</button>}
      </div>}
    </>
  );
}
