import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText, Pencil, Plus, RefreshCw, RotateCcw, Search, Send, Trash2 } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "../components/PageHeader.jsx";
import StatusBadge from "../components/StatusBadge.jsx";
import { api, apiBlob, getUser } from "../lib/api.js";
import { fetchTransactionParties, partyOptionLabel } from "../lib/partyDirectory.js";
import { buildInvoiceTaxSummary, computeInvoiceAdjustments } from "../lib/invoiceAdjustments.js";
import { configuredFinancialYear, financialYearFromDate, financialYearOptions, initialDateForFinancialYear } from "../lib/financialYear.js";
import "../document-notes.css";

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymd = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FY_MONTHS = ["April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"];

const CONFIG = {
  CREDIT_NOTE: {
    title: "Credit Note", endpoint: "credit-notes", prefix: "CN", partyLabel: "Customer / Party",
    description: "Goods return, incentive, scheme, discount or other credit adjustment",
    referenceLabel: "Against Sales Invoice", referenceEndpoint: "sales-invoices",
    reasons: [["GOODS_RETURN", "Goods Return"], ["GOODS_NOT_DELIVERED", "Goods Not Delivered"], ["ORDER_CANCELLED", "Order Cancelled / Invoice Reversal"], ["INCENTIVE", "Incentive"], ["SCHEME", "Scheme"], ["DISCOUNT", "Discount"], ["RATE_DIFFERENCE", "Rate Difference"], ["OTHER", "Other"]],
  },
  DEBIT_NOTE: {
    title: "Debit Note", endpoint: "debit-notes", prefix: "DN", partyLabel: "Supplier / Party",
    description: "Purchase return, shortage, damage, charges or other debit adjustment",
    referenceLabel: "Against Purchase Invoice", referenceEndpoint: "purchase-invoices",
    reasons: [["GOODS_RETURN", "Goods Return"], ["SHORTAGE", "Shortage"], ["DAMAGE", "Damage"], ["CHARGES", "Charges / Recovery"], ["RATE_DIFFERENCE", "Rate Difference"], ["OTHER", "Other"]],
  },
  DELIVERY_NOTE: {
    title: "Delivery Note", endpoint: "delivery-notes", prefix: "DLN", partyLabel: "Job Worker / Consignee",
    description: "Job-work goods movement / delivery challan with stock and e-way control",
    referenceLabel: "Reference", referenceEndpoint: "",
    reasons: [["JOB_WORK", "Job Work"], ["PROCESSING", "Processing"], ["REPAIR", "Repair"], ["SAMPLE", "Sample / Approval"], ["OTHER", "Other"]],
  },
};

const newRow = () => ({ productId: "", description: "", hsnCode: "", qty: 1, unit: "PCS", rate: 0, discountPct: 0, gstRate: 0, taxable: 0, tax: 0, lineTotal: 0 });
const isCreditStockReason = (reason) => ["GOODS_RETURN", "GOODS_NOT_DELIVERED", "ORDER_CANCELLED"].includes(String(reason || "").toUpperCase());

async function fetchAllPaged(path, limit = 100) {
  const join = path.includes("?") ? "&" : "?";
  const first = await api(`${path}${join}page=1&limit=${limit}`);
  const items = Array.isArray(first?.items) ? [...first.items] : (Array.isArray(first) ? [...first] : []);
  const pages = Math.max(1, Number(first?.meta?.pages || 1));
  for (let page = 2; page <= pages; page += 1) {
    const result = await api(`${path}${join}page=${page}&limit=${limit}`);
    if (Array.isArray(result?.items)) items.push(...result.items);
  }
  return items;
}

function defaultForm(type, fy) {
  return {
    documentNo: "", date: initialDateForFinancialYear(fy), partyGlobalId: "", referenceDocumentId: "", referenceDocumentNo: "",
    reasonType: type === "DELIVERY_NOTE" ? "JOB_WORK" : "GOODS_RETURN", reason: "", gstType: "CGST_SGST", warehouseId: "",
    billDiscount: 0, otherCharges: 0, remarks: "", jobWorkPurpose: "Job Work", expectedReturnDate: "", transporterName: "", vehicleNo: "", distanceKm: 0,
    eWayBillNo: "", eWayBillDate: "",
  };
}

export default function DocumentNotePage({ documentType = "CREDIT_NOTE" }) {
  const cfg = CONFIG[documentType] || CONFIG.CREDIT_NOTE;
  const sessionUser = getUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const editId = searchParams.get("edit") || "";
  const createMode = searchParams.get("create") === "1" || Boolean(editId);
  const [fy, setFy] = useState(searchParams.get("financialYear") || configuredFinancialYear(sessionUser));
  const [listFy, setListFy] = useState("ALL");
  const [parties, setParties] = useState([]);
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [references, setReferences] = useState([]);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [form, setForm] = useState(() => defaultForm(documentType, fy));
  const [rows, setRows] = useState([newRow()]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [monthOpen, setMonthOpen] = useState({});

  const fyOptions = useMemo(() => financialYearOptions(sessionUser, { count: 10 }), [sessionUser]);
  const partyMap = useMemo(() => new Map(parties.map((p) => [String(p.globalCustomerId), p])), [parties]);
  const productMap = useMemo(() => new Map(products.map((p) => [String(p._id), p])), [products]);

  const recalcRow = (row) => {
    const qty = Math.max(0, Number(row.qty || 0));
    const rate = Math.max(0, Number(row.rate || 0));
    const discount = Math.min(100, Math.max(0, Number(row.discountPct || 0)));
    const taxable = round2(qty * rate * (1 - discount / 100));
    const tax = documentType === "DELIVERY_NOTE" ? 0 : round2(taxable * Math.max(0, Number(row.gstRate || 0)) / 100);
    return { ...row, taxable, tax, lineTotal: round2(taxable + tax) };
  };

  const setRow = (index, patch) => setRows((old) => old.map((row, i) => i === index ? recalcRow({ ...row, ...patch }) : row));
  const selectProduct = (index, productId) => {
    const p = productMap.get(String(productId));
    if (!p) return setRow(index, { productId: "" });
    const defaultRate = documentType === "DEBIT_NOTE"
      ? Number(p.lastPurchasePrice || p.averagePurchasePrice || p.landedCost || p.openingRate || 0)
      : Number(p.salePrice || p.mrp || p.averagePurchasePrice || 0);
    setRow(index, { productId: String(p._id), description: p.name || "", hsnCode: p.hsnCode || "", unit: p.basicUnit || p.unit || "PCS", rate: defaultRate, gstRate: Number(p.gstRate || 0) });
  };

  const base = useMemo(() => round2(rows.reduce((s, r) => s + Number(r.taxable || 0), 0)), [rows]);
  const adjustment = useMemo(() => computeInvoiceAdjustments(base, [
    ...(Number(form.billDiscount || 0) ? [{ type: "Discount", method: "Amount", value: Number(form.billDiscount || 0) }] : []),
    ...(Number(form.otherCharges || 0) ? [{ type: "Charges", method: "Amount", value: Number(form.otherCharges || 0) }] : []),
  ]), [base, form.billDiscount, form.otherCharges]);
  const taxSummary = useMemo(() => buildInvoiceTaxSummary(rows.map((r) => ({ ...r, hsnCode: r.hsnCode || "NA" })), adjustment.discountTotal, adjustment.chargesTotal, form.gstType), [rows, adjustment, form.gstType]);
  const deliveryDeclaredValue = round2(Math.max(0, base - Number(adjustment.discountTotal || 0)) + Number(adjustment.chargesTotal || 0));
  const totals = documentType === "DELIVERY_NOTE"
    ? { subtotal: base, taxable: deliveryDeclaredValue, tax: 0, roundOff: 0, grand: deliveryDeclaredValue }
    : { subtotal: base, taxable: taxSummary.taxableTotal, tax: taxSummary.taxTotal, roundOff: taxSummary.roundOff, grand: taxSummary.grand };
  const selectedParty = partyMap.get(String(form.partyGlobalId || ""));
  const selectedReference = references.find((x) => String(x._id) === String(form.referenceDocumentId || "")) || null;
  const selectedReferenceGross = Number(selectedReference?.grandTotal || 0);
  const selectedReferenceCredited = Number(selectedReference?.creditNoteAmount || 0);
  const selectedReferenceRemaining = Math.max(0, Number(selectedReference?.netInvoiceAmount ?? (selectedReferenceGross - selectedReferenceCredited)));
  const selectedPartyAddresses = Array.isArray(selectedParty?.addresses) ? selectedParty.addresses : [];
  const selectedPartyBilling = selectedPartyAddresses.find((x) => String(x?.type || "BILLING").toUpperCase() === "BILLING") || selectedPartyAddresses[0] || {};
  const companyState = String(sessionUser?.companyProfile?.state || sessionUser?.state || "").trim().toUpperCase();
  const partyState = String(selectedPartyBilling?.state || selectedParty?.state || "").trim().toUpperCase();
  const interstateJobWork = documentType === "DELIVERY_NOTE" && form.reasonType === "JOB_WORK" && Boolean(companyState && partyState && companyState !== partyState);
  const eWayRequired = documentType === "DELIVERY_NOTE" && (totals.grand > 50000 || interstateJobWork);
  const eWayReason = totals.grand > 50000 ? "Consignment value exceeds ₹50,000" : (interstateJobWork ? "Interstate job-work movement" : "");

  const load = async () => {
    setLoading(true);
    try {
      const years = createMode ? [fy] : (listFy === "ALL" ? fyOptions : [listFy]);
      const docPromise = Promise.all(years.map((year) => fetchAllPaged(`/transactions/${cfg.endpoint}?financialYear=${encodeURIComponent(year)}`, 100).catch(() => []))).then((groups) => groups.flat());
      const [partyList, productList, warehouseResult, docs] = await Promise.all([
        fetchTransactionParties(200),
        fetchAllPaged("/products?status=ACTIVE", 100),
        api("/modules/dms/warehouses?status=ACTIVE&limit=200").catch(() => ({ items: [] })),
        docPromise,
      ]);
      setParties(partyList);
      setProducts(productList);
      setWarehouses(Array.isArray(warehouseResult) ? warehouseResult : (warehouseResult?.items || []));
      setDocuments(docs);
      if (createMode && !editId) {
        const next = await api(`/transactions/${cfg.endpoint}/next-number?financialYear=${encodeURIComponent(fy)}`).catch(() => null);
        if (next?.documentNo) setForm((old) => ({ ...old, documentNo: next.documentNo }));
      }
    } catch (e) { setMsg(e.message || `Could not load ${cfg.title}`); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [documentType, fy, listFy, createMode]);

  useEffect(() => {
    let active = true;
    if (!cfg.referenceEndpoint || !form.partyGlobalId || !createMode) {
      setReferences([]);
      setReferenceLoading(false);
      return () => { active = false; };
    }
    const partyParam = documentType === "CREDIT_NOTE" ? "customerGlobalId" : "supplierGlobalId";
    setReferenceLoading(true);
    fetchAllPaged(`/transactions/${cfg.referenceEndpoint}?financialYear=${encodeURIComponent(fy)}&${partyParam}=${encodeURIComponent(form.partyGlobalId)}`, 100)
      .then((items) => { if (active) setReferences(items); })
      .catch((error) => { if (active) { setReferences([]); setMsg(error.message || "Could not load party invoices"); } })
      .finally(() => { if (active) setReferenceLoading(false); });
    return () => { active = false; };
  }, [cfg.referenceEndpoint, createMode, documentType, form.partyGlobalId, fy]);

  useEffect(() => {
    if (!editId) return;
    (async () => {
      try {
        const doc = await api(`/transactions/${cfg.endpoint}/${encodeURIComponent(editId)}?financialYear=${encodeURIComponent(fy)}`);
        setForm({
          ...defaultForm(documentType, fy),
          ...doc,
          documentNo: doc.documentNo || doc.creditNoteNo || "",
          date: ymd(doc.date),
          partyGlobalId: doc.partyGlobalId || doc.customerGlobalId || "",
          referenceDocumentId: doc.referenceDocumentId || doc.invoiceId || "",
          referenceDocumentNo: doc.referenceDocumentNo || doc.invoiceNo || "",
          expectedReturnDate: ymd(doc.expectedReturnDate), eWayBillDate: ymd(doc.eWayBillDate),
        });
        setRows((doc.items || []).map((it) => recalcRow({ ...newRow(), productId: it.productId || "", description: it.nameSnapshot || it.description || "", hsnCode: it.hsnSnapshot || "", qty: Number(it.qty || 0), unit: it.unit || "PCS", rate: Number(it.rate || it.effectiveRate || 0), discountPct: Number(it.discountPct || 0), gstRate: Number(it.gstRateSnapshot || 0) })) || [newRow()]);
      } catch (e) { setMsg(e.message || `Could not load ${cfg.title}`); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const useReference = async (id) => {
    if (!id) {
      setForm((old) => ({ ...old, referenceDocumentId: "", referenceDocumentNo: "" }));
      return;
    }
    const listed = references.find((x) => String(x._id) === String(id));
    if (!listed) return;
    const remaining = Math.max(0, Number(listed.netInvoiceAmount ?? (Number(listed.grandTotal || 0) - Number(listed.creditNoteAmount || 0))));
    if (documentType === "CREDIT_NOTE" && remaining <= 0.01) {
      setMsg(`Invoice ${listed.invoiceNo || ""} is already fully credited.`);
      return;
    }
    setReferenceLoading(true);
    setMsg("");
    try {
      const refFy = listed.financialYear || fy;
      const ref = await api(`/transactions/${cfg.referenceEndpoint}/${encodeURIComponent(id)}?financialYear=${encodeURIComponent(refFy)}`);
      const partyId = documentType === "CREDIT_NOTE" ? ref.customerGlobalId : ref.supplierGlobalId;
      setForm((old) => ({
        ...old,
        referenceDocumentId: String(ref._id),
        referenceDocumentNo: ref.invoiceNo || "",
        partyGlobalId: partyId || old.partyGlobalId,
        gstType: ref.gstType || old.gstType,
        warehouseId: ref.warehouseId || old.warehouseId,
        billDiscount: Number(ref.billDiscount || 0),
        otherCharges: Number(ref.otherCharges || 0),
        remarks: ref.remarks || old.remarks || "",
        addressSnapshot: ref.addressSnapshot || old.addressSnapshot || "",
      }));
      const nextRows = (ref.items || []).map((it) => {
        const discountPct = Number(it.discountPct || 0);
        const effectiveRate = Number(it.effectiveRate ?? (Number(it.qty || 0) > 0 && Number(it.taxable || 0) > 0 ? Number(it.taxable || 0) / Number(it.qty || 1) : it.rate) ?? 0);
        const rate = discountPct > 0 && discountPct < 100 ? effectiveRate / (1 - discountPct / 100) : effectiveRate;
        return recalcRow({
          ...newRow(),
          productId: String(it.productId || ""),
          description: it.nameSnapshot || it.description || it.sku || "",
          hsnCode: it.hsnSnapshot || it.hsnCode || "",
          qty: Number(it.qty || 0),
          unit: it.unit || "PCS",
          rate: Number(rate || 0),
          discountPct,
          gstRate: Number(it.gstRateSnapshot ?? it.gstRate ?? 0),
        });
      });
      setRows(nextRows.length ? nextRows : [newRow()]);
      setMsg(`${cfg.referenceLabel}: ${ref.invoiceNo || "invoice"} loaded with full invoice details`);
    } catch (error) {
      setMsg(error.message || "Could not load invoice details");
    } finally {
      setReferenceLoading(false);
    }
  };

  const save = async (issueNow = documentType !== "DELIVERY_NOTE") => {
    setMsg("");
    if (!form.partyGlobalId) return setMsg(`Select ${cfg.partyLabel}`);
    if (!rows.length || rows.some((r) => !String(r.description || "").trim() || Number(r.qty || 0) <= 0)) return setMsg("Complete every item row");
    if ((documentType === "DELIVERY_NOTE" || (documentType === "CREDIT_NOTE" && isCreditStockReason(form.reasonType)) || (documentType === "DEBIT_NOTE" && form.reasonType === "GOODS_RETURN")) && !form.warehouseId) return setMsg("Warehouse is required for stock movement");
    if (documentType === "CREDIT_NOTE" && isCreditStockReason(form.reasonType) && !form.referenceDocumentId) return setMsg("Select the original Sales Invoice for Goods Return / Goods Not Delivered / Order Cancelled Credit Note");
    if (documentType === "CREDIT_NOTE" && form.referenceDocumentId && selectedReference && totals.grand > selectedReferenceRemaining + 1.01) return setMsg(`Credit Note cannot exceed the remaining invoice value ${money(selectedReferenceRemaining)}`);
    if (documentType === "DELIVERY_NOTE" && issueNow && eWayRequired && !String(form.eWayBillNo || "").trim()) return setMsg(`E-Way Bill number is required before Issue${eWayReason ? `: ${eWayReason}` : ""}`);
    setLoading(true);
    try {
      const postingFy = financialYearFromDate(form.date) || fy;
      const payload = {
        ...form, financialYear: postingFy, sourceFinancialYear: fy, issueNow,
        billDiscount: adjustment.discountTotal, otherCharges: adjustment.chargesTotal,
        items: rows.map((r) => ({ productId: r.productId || "", description: r.description, hsnCode: r.hsnCode, qty: Number(r.qty), unit: r.unit, rate: Number(r.rate), discountPct: Number(r.discountPct), gstRate: Number(r.gstRate) })),
      };
      const doc = await api(editId ? `/transactions/${cfg.endpoint}/${encodeURIComponent(editId)}` : `/transactions/${cfg.endpoint}`, { method: editId ? "PUT" : "POST", body: JSON.stringify(payload) });
      setMsg(`${cfg.title} ${doc.documentNo || doc.creditNoteNo || ""} ${doc.status === "DRAFT" ? "saved as draft" : "issued"}`);
      setSearchParams({ financialYear: postingFy });
      setForm(defaultForm(documentType, postingFy)); setRows([newRow()]);
      await load();
    } catch (e) { setMsg(e.message); }
    finally { setLoading(false); }
  };

  const issue = async (doc) => {
    if (documentType === "DELIVERY_NOTE" && doc.eWayBillRequired && !String(doc.eWayBillNo || "").trim()) {
      const docFy = doc.financialYear || fy;
      setFy(docFy);
      setSearchParams({ edit: doc._id, financialYear: docFy });
      setMsg("Enter the required E-Way Bill number in the Delivery Note draft before issuing it.");
      return;
    }
    try {
      await api(`/transactions/${cfg.endpoint}/${doc._id}/issue`, { method: "POST", body: JSON.stringify({ financialYear: doc.financialYear || fy }) });
      setMsg(`${cfg.title} ${doc.documentNo || doc.creditNoteNo} issued`); await load();
    } catch (e) { setMsg(e.message); }
  };
  const markReturned = async (doc) => {
    if (!window.confirm(`Mark all goods on ${doc.documentNo || doc.creditNoteNo} as returned from job work?`)) return;
    try {
      await api(`/transactions/delivery-notes/${doc._id}/return`, { method: "POST", body: JSON.stringify({ financialYear: doc.financialYear || fy }) });
      setMsg(`Delivery Note ${doc.documentNo || doc.creditNoteNo} returned; stock restored`); await load();
    } catch (e) { setMsg(e.message); }
  };
  const cancel = async (doc) => {
    if (!window.confirm(`Cancel ${cfg.title} ${doc.documentNo || doc.creditNoteNo}? Accounting/stock effects will be reversed.`)) return;
    try { await api(`/transactions/${cfg.endpoint}/${doc._id}?financialYear=${encodeURIComponent(doc.financialYear || fy)}`, { method: "DELETE" }); setMsg(`${cfg.title} cancelled`); await load(); }
    catch (e) { setMsg(e.message); }
  };
  const openPdf = async (doc, download = false) => {
    const viewer = download ? null : window.open("", "_blank");
    try {
      const { blob } = await apiBlob(`/transactions/${cfg.endpoint}/${doc._id}/pdf?financialYear=${encodeURIComponent(doc.financialYear || fy)}${download ? "&download=1" : ""}`);
      const url = URL.createObjectURL(blob);
      if (download) { const a = document.createElement("a"); a.href = url; a.download = `${cfg.prefix}-${doc.documentNo || doc.creditNoteNo}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      else if (viewer) { viewer.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (e) { if (viewer && !viewer.closed) viewer.close(); setMsg(e.message); }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return documents.filter((d) => !q || [d.documentNo, d.creditNoteNo, d.partyNameSnapshot, d.customerNameSnapshot, d.referenceDocumentNo, d.invoiceNo, d.reason, d.reasonType, d.status].some((v) => String(v || "").toLowerCase().includes(q)));
  }, [documents, search]);
  const grouped = useMemo(() => {
    const map = new Map();
    filtered.forEach((d) => {
      const dt = new Date(d.date || d.createdAt || 0); if (Number.isNaN(dt.getTime())) return;
      const month = MONTHS[dt.getMonth()]; const key = `${d.financialYear || fy}-${month}`;
      if (!map.has(key)) map.set(key, { key, month, fy: d.financialYear || fy, rows: [] });
      map.get(key).rows.push(d);
    });
    return [...map.values()].sort((a, b) => Number(String(b.fy).slice(0, 4)) - Number(String(a.fy).slice(0, 4)) || FY_MONTHS.indexOf(a.month) - FY_MONTHS.indexOf(b.month));
  }, [filtered, fy]);

  if (!createMode) return <>
    <PageHeader title={`${cfg.title}s`} description={cfg.description} onAdd={() => { const createFy = listFy === "ALL" ? configuredFinancialYear(sessionUser) : listFy; setFy(createFy); setForm(defaultForm(documentType, createFy)); setRows([newRow()]); setSearchParams({ create: "1", financialYear: createFy }); }} addLabel={`CREATE ${cfg.title.toUpperCase()}`} actions />
    {msg && <div className="resultBanner">{msg}</div>}
    <section className="panel noteListPanel">
      <div className="noteToolbar"><div className="oldDmsSearch"><Search size={15}/><input placeholder={`Search ${cfg.title}...`} value={search} onChange={(e) => setSearch(e.target.value)}/></div><label><span>FY</span><select value={listFy} onChange={(e) => setListFy(e.target.value)}><option value="ALL">All Financial Years</option>{fyOptions.map((x) => <option key={x}>{x}</option>)}</select></label><button className="oldDmsIconBtn" onClick={load} title="Refresh"><RefreshCw size={15}/></button></div>
      {!grouped.length && <div className="noteEmpty">No {cfg.title.toLowerCase()} found.</div>}
      {grouped.map((group) => {
        const open = monthOpen[group.key] === true;
        return <div className="oldDmsMonthGroup" key={group.key}>
          <button className="oldDmsMonthHead" onClick={() => setMonthOpen((old) => ({ ...old, [group.key]: !open }))}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<b>{group.month} • FY {group.fy}</b><span>{group.rows.length}</span><strong>{money(group.rows.reduce((s, x) => s + Number(x.grandTotal || 0), 0))}</strong></button>
          {open && <div className="oldDmsTableWrap"><table className="oldDmsInvoiceListTable noteTable"><thead><tr><th>#</th><th>Status</th><th>{cfg.prefix} No.</th><th>Date</th><th>Party</th><th>Reference</th><th>Reason / Purpose</th><th>Value</th>{documentType === "DELIVERY_NOTE" && <><th>E-Way</th><th>Expected Return</th></>}<th>Actions</th></tr></thead><tbody>{group.rows.map((d, i) => <tr key={d._id}><td>{i + 1}</td><td><StatusBadge value={d.status || "DRAFT"}/></td><td><button className="tableClickLink" onClick={() => openPdf(d)}>{d.documentNo || d.creditNoteNo}</button></td><td>{ymd(d.date)}</td><td>{d.partyNameSnapshot || d.customerNameSnapshot || partyMap.get(String(d.partyGlobalId || d.customerGlobalId))?.localName || "Party"}</td><td>{d.referenceDocumentNo || d.invoiceNo || "-"}</td><td>{d.jobWorkPurpose || d.reason || d.reasonType || "-"}</td><td><b>{money(d.grandTotal)}</b></td>{documentType === "DELIVERY_NOTE" && <><td>{d.eWayBillRequired ? (d.eWayBillNo || "REQUIRED") : (d.eWayBillNo || "Optional")}</td><td>{ymd(d.expectedReturnDate) || "-"}</td></>}<td><div className="oldDmsTableActions">{d.status === "DRAFT" && <button title="Edit Draft" onClick={() => { setFy(d.financialYear || fy); setSearchParams({ edit: d._id, financialYear: d.financialYear || fy }); }}><Pencil size={13}/></button>}{d.status === "DRAFT" && <button title="Issue" onClick={() => issue(d)}><Send size={13}/></button>}{documentType === "DELIVERY_NOTE" && d.status === "ISSUED" && <button title="Mark Returned" onClick={() => markReturned(d)}><RotateCcw size={13}/></button>}<button title="View PDF" onClick={() => openPdf(d)}><FileText size={13}/></button><button title="Download PDF" onClick={() => openPdf(d, true)}><Download size={13}/></button>{!["CANCELLED", "RETURNED"].includes(d.status) && <button className="danger" title="Cancel" onClick={() => cancel(d)}><Trash2 size={13}/></button>}</div></td></tr>)}</tbody></table></div>}
        </div>;
      })}
    </section>
  </>;

  return <>
    <PageHeader title={editId ? `Edit ${cfg.title}` : `Create ${cfg.title}`} description={cfg.description} actions={false}/>
    {msg && <div className="resultBanner">{msg}</div>}
    <section className="panel oldDmsInvoiceComposer noteComposer">
      <div className="oldDmsInvoiceTop"><div className="invoiceTitle"><FileText size={18}/><div><h3>{cfg.title}</h3><span>{documentType === "DELIVERY_NOTE" ? "Job-work movement document • no sales/purchase accounting" : "Invoice-style statutory adjustment document"}</span></div></div><button className="oldDmsBackBtn" onClick={() => setSearchParams({ financialYear: fy })}>Back</button></div>
      <div className="noteMetaGrid">
        <label><span>FY</span><input readOnly value={financialYearFromDate(form.date) || fy}/></label>
        <label><span>{cfg.prefix} No.</span><input readOnly value={form.documentNo}/></label>
        <label><span>Date *</span><input type="date" value={form.date} onChange={(e) => setForm((o) => ({ ...o, date: e.target.value }))}/></label>
        <label className="wide"><span>{cfg.partyLabel} *</span><select value={form.partyGlobalId} onChange={(e) => setForm((o) => ({ ...o, partyGlobalId: e.target.value, referenceDocumentId: "", referenceDocumentNo: "" }))}><option value="">Select Party</option>{parties.map((p) => <option key={p.globalCustomerId} value={p.globalCustomerId}>{partyOptionLabel(p)}</option>)}</select></label>
        {cfg.referenceEndpoint ? <label className="wide"><span>{cfg.referenceLabel}</span><select disabled={!form.partyGlobalId || referenceLoading} value={form.referenceDocumentId} onChange={(e) => useReference(e.target.value)}><option value="">{!form.partyGlobalId ? "Select party first" : referenceLoading ? "Loading invoices..." : references.length ? "Select invoice / manual entry" : "No invoice found / manual entry"}</option>{references.map((r) => { const remaining = Math.max(0, Number(r.netInvoiceAmount ?? (Number(r.grandTotal || 0) - Number(r.creditNoteAmount || 0)))); return <option key={r._id} value={r._id} disabled={documentType === "CREDIT_NOTE" && remaining <= 0.01}>{r.invoiceNo} • {ymd(r.date)} • Bill {money(r.grandTotal)}{documentType === "CREDIT_NOTE" ? ` • Remaining ${money(remaining)}` : ""}</option>; })}</select>{form.partyGlobalId && !referenceLoading && <small>{references.length} invoice{references.length === 1 ? "" : "s"} found for selected party</small>}</label> : <label className="wide"><span>Reference</span><input value={form.referenceDocumentNo} onChange={(e) => setForm((o) => ({ ...o, referenceDocumentNo: e.target.value }))}/></label>}
        <label><span>Reason</span><select value={form.reasonType} onChange={(e) => setForm((o) => ({ ...o, reasonType: e.target.value }))}>{cfg.reasons.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label><span>GST Type</span><select value={form.gstType} onChange={(e) => setForm((o) => ({ ...o, gstType: e.target.value }))}><option value="CGST_SGST">CGST + SGST</option><option value="IGST">IGST</option></select></label>
        {(documentType === "DELIVERY_NOTE" || (documentType === "CREDIT_NOTE" && isCreditStockReason(form.reasonType)) || (documentType === "DEBIT_NOTE" && form.reasonType === "GOODS_RETURN")) && <label><span>Warehouse *</span><select value={form.warehouseId} onChange={(e) => setForm((o) => ({ ...o, warehouseId: e.target.value }))}><option value="">Select Warehouse</option>{warehouses.map((w) => <option key={w._id} value={w._id}>{w.title || w.reference || "Warehouse"}</option>)}</select></label>}
      </div>

      {documentType === "CREDIT_NOTE" && selectedReference && <div className="resultBanner">Against Invoice <b>{selectedReference.invoiceNo}</b> • Original {money(selectedReferenceGross)} • Already Credited {money(selectedReferenceCredited)} • <b>Remaining {money(selectedReferenceRemaining)}</b>{selectedReference.creditNoteStatus && selectedReference.creditNoteStatus !== "NONE" ? ` • ${selectedReference.creditNoteStatus} CREDITED` : ""}</div>}

      {documentType === "DELIVERY_NOTE" && <div className="deliveryMeta">
        <label><span>Job Work Purpose</span><input value={form.jobWorkPurpose} onChange={(e) => setForm((o) => ({ ...o, jobWorkPurpose: e.target.value }))}/></label>
        <label><span>Expected Return</span><input type="date" value={form.expectedReturnDate} onChange={(e) => setForm((o) => ({ ...o, expectedReturnDate: e.target.value }))}/></label>
        <label><span>Transporter</span><input value={form.transporterName} onChange={(e) => setForm((o) => ({ ...o, transporterName: e.target.value }))}/></label>
        <label><span>Vehicle No.</span><input value={form.vehicleNo} onChange={(e) => setForm((o) => ({ ...o, vehicleNo: e.target.value.toUpperCase() }))}/></label>
        <label><span>Distance KM</span><input type="number" min="0" value={form.distanceKm} onChange={(e) => setForm((o) => ({ ...o, distanceKm: e.target.value }))}/></label>
        <label><span>E-Way Bill No.</span><input value={form.eWayBillNo} onChange={(e) => setForm((o) => ({ ...o, eWayBillNo: e.target.value }))} placeholder={eWayRequired ? "Required before Issue" : "Optional"}/></label>
        <label><span>E-Way Bill Date</span><input type="date" value={form.eWayBillDate} onChange={(e) => setForm((o) => ({ ...o, eWayBillDate: e.target.value }))}/></label>
        <div className={`ewayFlag ${eWayRequired ? "required" : "optional"}`}><b>{eWayRequired ? "E-WAY BILL REQUIRED" : "E-WAY BILL OPTIONAL"}</b><span>{eWayRequired && eWayReason ? `${eWayReason} • ` : ""}Declared consignment value {money(totals.grand)}</span></div>
      </div>}

      <div className="noteItemsWrap"><table className="noteItemsTable"><thead><tr><th>#</th><th>Product</th><th>Description</th><th>HSN</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Disc %</th><th>GST %</th><th>Taxable</th><th>Total</th><th></th></tr></thead><tbody>{rows.map((r, i) => <tr key={i}><td>{i + 1}</td><td><select value={r.productId} onChange={(e) => selectProduct(i, e.target.value)}><option value="">Manual</option>{products.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}</select></td><td><input value={r.description} onChange={(e) => setRow(i, { description: e.target.value })}/></td><td><input value={r.hsnCode} onChange={(e) => setRow(i, { hsnCode: e.target.value })}/></td><td><input type="number" min="0" step="0.001" value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })}/></td><td><input value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })}/></td><td><input type="number" min="0" step="0.01" value={r.rate} onChange={(e) => setRow(i, { rate: e.target.value })}/></td><td><input type="number" min="0" max="100" step="0.01" value={r.discountPct} onChange={(e) => setRow(i, { discountPct: e.target.value })}/></td><td><input type="number" min="0" step="0.01" value={r.gstRate} onChange={(e) => setRow(i, { gstRate: e.target.value })}/></td><td>{money(r.taxable)}</td><td><b>{money(r.lineTotal)}</b></td><td><button className="danger" disabled={rows.length === 1} onClick={() => setRows((old) => old.filter((_, idx) => idx !== i))}>×</button></td></tr>)}</tbody></table></div>
      <button className="btn ghost noteAddLine" onClick={() => setRows((old) => [...old, newRow()])}><Plus size={14}/> Add Item</button>

      <div className="noteBottomGrid"><div className="noteDetailsBox"><label><span>Reason / Details</span><textarea value={form.reason} onChange={(e) => setForm((o) => ({ ...o, reason: e.target.value }))}/></label><label><span>Remarks</span><textarea value={form.remarks} onChange={(e) => setForm((o) => ({ ...o, remarks: e.target.value }))}/></label></div><div className="noteTotalsBox"><label><span>Basic</span><b>{money(totals.subtotal)}</b></label><label><span>Bill Discount</span><input type="number" min="0" value={form.billDiscount} onChange={(e) => setForm((o) => ({ ...o, billDiscount: e.target.value }))}/></label><label><span>Other Charges</span><input type="number" min="0" value={form.otherCharges} onChange={(e) => setForm((o) => ({ ...o, otherCharges: e.target.value }))}/></label><label><span>Taxable</span><b>{money(totals.taxable)}</b></label><label><span>GST</span><b>{money(totals.tax)}</b></label><label><span>Round Off</span><b>{money(totals.roundOff)}</b></label><label className="grand"><span>{documentType === "DELIVERY_NOTE" ? "Consignment Value" : "Grand Total"}</span><b>{money(totals.grand)}</b></label></div></div>
      <div className="noteActions"><button className="btn ghost" onClick={() => setSearchParams({ financialYear: fy })}>Cancel</button>{documentType === "DELIVERY_NOTE" ? <><button className="btn ghost" disabled={loading} onClick={() => save(false)}>{editId ? "Update Draft" : "Save Draft"}</button><button className="btn primary" disabled={loading || Boolean(editId)} onClick={() => save(true)}>Save & Issue</button></> : <button className="btn primary" disabled={loading || Boolean(editId)} onClick={() => save(true)}>{loading ? "Saving..." : `Issue ${cfg.title}`}</button>}</div>
    </section>
  </>;
}
