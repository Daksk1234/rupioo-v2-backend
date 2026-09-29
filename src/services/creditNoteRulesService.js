const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const round2 = (v) => Number(num(v).toFixed(2));

export const CREDIT_NOTE_STOCK_REASONS = new Set(["GOODS_RETURN", "GOODS_NOT_DELIVERED", "ORDER_CANCELLED"]);
export const isCreditNoteStockReason = (reason) => CREDIT_NOTE_STOCK_REASONS.has(upper(reason));

function creditFilter({ tenantKey, financialYear, invoiceId, excludeNoteId = "", statuses = ["DRAFT", "ISSUED"] }) {
  const invoiceKey = clean(invoiceId);
  const filter = {
    tenantKey,
    financialYear,
    status: { $in: statuses },
    $and: [
      { $or: [{ documentType: "CREDIT_NOTE" }, { documentType: { $exists: false } }] },
      { $or: [{ invoiceId: invoiceKey }, { referenceDocumentId: invoiceKey }] },
    ],
  };
  if (excludeNoteId) filter._id = { $ne: excludeNoteId };
  return filter;
}

export async function creditNoteUsage({ models, tenantKey, financialYear, invoiceId, excludeNoteId = "" }) {
  const notes = await models.CreditNote.find(creditFilter({ tenantKey, financialYear, invoiceId, excludeNoteId })).lean();
  let reservedAmount = 0;
  let issuedAmount = 0;
  const reservedStockQty = new Map();
  const issuedNotes = [];
  for (const note of notes) {
    const amount = Math.max(0, num(note.grandTotal));
    reservedAmount += amount;
    if (upper(note.status) === "ISSUED") {
      issuedAmount += amount;
      issuedNotes.push(note);
    }
    if (isCreditNoteStockReason(note.reasonType)) {
      for (const item of note.items || []) {
        const id = clean(item.productId);
        if (!id) continue;
        reservedStockQty.set(id, round2(num(reservedStockQty.get(id)) + Math.max(0, num(item.qty))));
      }
    }
  }
  return { notes, issuedNotes, reservedAmount: round2(reservedAmount), issuedAmount: round2(issuedAmount), reservedStockQty };
}

export async function validateCreditNoteAgainstInvoice({ models, tenantKey, financialYear, invoice, note, excludeNoteId = "" }) {
  if (!invoice?._id) {
    if (isCreditNoteStockReason(note?.reasonType)) {
      throw Object.assign(new Error("Goods Return / Goods Not Delivered / Order Cancelled Credit Note must be linked to the original Sales Invoice"), { statusCode: 409 });
    }
    return { invoice: null, remainingAmount: null };
  }
  if (["DELETED", "CANCELLED"].includes(upper(invoice.status))) {
    throw Object.assign(new Error("Credit Note cannot be issued against a deleted/cancelled Sales Invoice"), { statusCode: 409 });
  }
  if (["GOODS_NOT_DELIVERED", "ORDER_CANCELLED"].includes(upper(note?.reasonType))) {
    const delivered = Boolean(invoice?.delivery?.deliveredAt) || ["DELIVERED", "COMPLETED"].includes(upper(invoice?.workflowStatus));
    if (delivered) {
      throw Object.assign(new Error("This invoice is already marked delivered. Use Goods Return instead of Goods Not Delivered / Order Cancelled."), { statusCode: 409, details: { code: "INVOICE_ALREADY_DELIVERED" } });
    }
  }
  const usage = await creditNoteUsage({ models, tenantKey, financialYear, invoiceId: String(invoice._id), excludeNoteId });
  const invoiceTotal = round2(invoice.grandTotal);
  const remainingAmount = round2(Math.max(0, invoiceTotal - usage.reservedAmount));
  const noteAmount = round2(note?.grandTotal);
  if (noteAmount <= 0) throw Object.assign(new Error("Credit Note amount must be greater than zero"), { statusCode: 400 });
  if (noteAmount > remainingAmount + 1.01) {
    throw Object.assign(new Error(`Credit Note exceeds the remaining invoice value. Invoice ₹${invoiceTotal.toFixed(2)}, already credited/reserved ₹${usage.reservedAmount.toFixed(2)}, remaining ₹${remainingAmount.toFixed(2)}.`), {
      statusCode: 409,
      details: { code: "CREDIT_NOTE_EXCEEDS_INVOICE", invoiceTotal, creditedOrReserved: usage.reservedAmount, remainingAmount, requestedAmount: noteAmount },
    });
  }

  if (isCreditNoteStockReason(note?.reasonType)) {
    const originalQty = new Map();
    for (const item of invoice.items || []) {
      const id = clean(item.productId);
      if (!id) continue;
      originalQty.set(id, round2(num(originalQty.get(id)) + Math.max(0, num(item.qty))));
    }
    for (const item of note?.items || []) {
      const id = clean(item.productId);
      if (!id) throw Object.assign(new Error("Every stock-restoring Credit Note line must be linked to a product from the original invoice"), { statusCode: 409 });
      const sold = round2(originalQty.get(id));
      const already = round2(usage.reservedStockQty.get(id));
      const remainingQty = round2(Math.max(0, sold - already));
      const requestedQty = round2(item.qty);
      if (!sold || requestedQty > remainingQty + 0.000001) {
        throw Object.assign(new Error(`${item.nameSnapshot || item.description || "Product"}: Credit Note quantity ${requestedQty} exceeds remaining invoice quantity ${remainingQty}.`), {
          statusCode: 409,
          details: { code: "CREDIT_NOTE_QTY_EXCEEDS_INVOICE", productId: id, soldQty: sold, alreadyCreditedQty: already, remainingQty, requestedQty },
        });
      }
    }
  }
  return { usage, invoiceTotal, remainingAmount };
}

export async function syncSalesInvoiceCreditState({ models, tenantKey, financialYear, invoiceId }) {
  if (!invoiceId) return null;
  const invoice = await models.SalesInvoice.findOne({ _id: invoiceId, tenantKey, financialYear });
  if (!invoice) return null;
  const usage = await creditNoteUsage({ models, tenantKey, financialYear, invoiceId: String(invoice._id), statuses: ["ISSUED"] });
  const creditedAmount = round2(Math.min(Math.max(0, num(invoice.grandTotal)), usage.issuedAmount));
  const netInvoiceAmount = round2(Math.max(0, num(invoice.grandTotal) - creditedAmount));
  const creditNoteStatus = creditedAmount <= 0.005 ? "NONE" : netInvoiceAmount <= 0.01 ? "FULL" : "PARTIAL";
  const latest = [...usage.issuedNotes].sort((a, b) => new Date(b.issuedAt || b.updatedAt || b.createdAt || 0) - new Date(a.issuedAt || a.updatedAt || a.createdAt || 0))[0];
  invoice.creditNoteAmount = creditedAmount;
  invoice.netInvoiceAmount = netInvoiceAmount;
  invoice.creditNoteStatus = creditNoteStatus;
  invoice.lastCreditNoteNo = latest?.creditNoteNo || "";
  invoice.lastCreditNoteAt = latest?.issuedAt || latest?.updatedAt || null;
  await invoice.save();
  return invoice;
}

export async function enrichSalesInvoicesWithCreditState({ models, tenantKey, financialYear, invoices = [] }) {
  if (!invoices.length) return invoices;
  const ids = invoices.map((x) => String(x._id));
  const notes = await models.CreditNote.find({
    tenantKey, financialYear, status: "ISSUED",
    $and: [
      { $or: [{ documentType: "CREDIT_NOTE" }, { documentType: { $exists: false } }] },
      { $or: [{ invoiceId: { $in: ids } }, { referenceDocumentId: { $in: ids } }] },
    ],
  }).select("invoiceId referenceDocumentId grandTotal creditNoteNo issuedAt updatedAt createdAt").lean();
  const byInvoice = new Map();
  for (const note of notes) {
    const id = clean(note.invoiceId || note.referenceDocumentId);
    if (!id) continue;
    const row = byInvoice.get(id) || { amount: 0, lastNo: "", lastAt: null };
    row.amount = round2(row.amount + Math.max(0, num(note.grandTotal)));
    const at = note.issuedAt || note.updatedAt || note.createdAt;
    if (!row.lastAt || new Date(at) > new Date(row.lastAt)) { row.lastAt = at; row.lastNo = note.creditNoteNo || ""; }
    byInvoice.set(id, row);
  }
  return invoices.map((invoice) => {
    const row = byInvoice.get(String(invoice._id)) || { amount: 0, lastNo: "", lastAt: null };
    const total = round2(invoice.grandTotal);
    const credited = round2(Math.min(total, row.amount));
    const net = round2(Math.max(0, total - credited));
    return {
      ...invoice,
      creditNoteAmount: credited,
      netInvoiceAmount: net,
      creditNoteStatus: credited <= 0.005 ? "NONE" : net <= 0.01 ? "FULL" : "PARTIAL",
      lastCreditNoteNo: row.lastNo || invoice.lastCreditNoteNo || "",
      lastCreditNoteAt: row.lastAt || invoice.lastCreditNoteAt || null,
    };
  });
}
