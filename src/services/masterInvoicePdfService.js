import PDFDocument from "pdfkit";
import QRCode from "qrcode";

const A4_W = 595.28;
const A4_H = 841.89;
const M = 30;
const W = A4_W - M * 2;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const f2 = (v) => (Math.round(n(v) * 100) / 100).toFixed(2);
const text = (v) => String(v ?? "").trim();
const dateOnly = (v) => {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toLocaleDateString("en-IN");
};
const first = (...values) => values.find((v) => v === 0 || (v !== undefined && v !== null && text(v))) ?? "";

const customerContact = (customer = {}) => {
  const contacts = Array.isArray(customer.contacts) ? customer.contacts : [];
  return contacts.find((x) => x?.primary) || contacts.find((x) => x?.email || x?.mobile) || {};
};
const customerAddress = (customer = {}, invoice = {}) => {
  const addresses = Array.isArray(customer.addresses) ? customer.addresses : [];
  const billing = addresses.find((x) => String(x?.type || "").toUpperCase() === "BILLING") || addresses[0] || {};
  return {
    address: first(invoice.addressSnapshot, billing.address, customer.ownerAddress),
    city: first(billing.city, customer.ownerCity),
    state: first(billing.state, customer.ownerState),
    pincode: first(billing.pincode, customer.ownerPincode),
  };
};

const moneyWordsUnder1000 = (num) => {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  let x = Math.floor(num), out = [];
  if (x >= 100) { out.push(`${ones[Math.floor(x / 100)]} Hundred`); x %= 100; }
  if (x >= 20) { out.push(tens[Math.floor(x / 10)]); x %= 10; }
  if (x > 0) out.push(ones[x]);
  return out.join(" ");
};
const amountInWords = (value) => {
  let x = Math.round(Math.abs(n(value)));
  if (!x) return "Rupees Zero Only";
  const parts = [];
  const crore = Math.floor(x / 10000000); x %= 10000000;
  const lakh = Math.floor(x / 100000); x %= 100000;
  const thousand = Math.floor(x / 1000); x %= 1000;
  if (crore) parts.push(`${moneyWordsUnder1000(crore)} Crore`);
  if (lakh) parts.push(`${moneyWordsUnder1000(lakh)} Lakh`);
  if (thousand) parts.push(`${moneyWordsUnder1000(thousand)} Thousand`);
  if (x) parts.push(moneyWordsUnder1000(x));
  return `Rupees ${parts.join(" ")} Only`;
};

function buildHsnRows(invoice = {}) {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const groups = new Map();
  let basicTotal = 0;
  let maxRate = 0;
  for (const item of items) {
    const hsn = text(first(item.hsnSnapshot, item.hsnCodeSnapshot, item.hsnCode)) || "NA";
    const rate = n(first(item.gstRateSnapshot, item.gstRate));
    const base = n(first(item.taxable, item.taxableAmount, n(item.qty) * n(first(item.basicRate, item.rate))));
    const key = `${hsn}|${rate}`;
    const row = groups.get(key) || { hsn, rate, base: 0 };
    row.base += base;
    groups.set(key, row);
    basicTotal += base;
    maxRate = Math.max(maxRate, rate);
  }
  const discount = Math.max(0, n(invoice.billDiscount));
  const charges = Math.max(0, n(invoice.otherCharges));
  const isIGST = String(invoice.gstType || "").toUpperCase() === "IGST";
  const rows = [];
  for (const g of groups.values()) {
    const share = basicTotal > 0 ? g.base / basicTotal : 0;
    const taxable = Math.max(0, g.base - discount * share);
    if (isIGST) {
      const igst = taxable * g.rate / 100;
      rows.push({ hsn: g.hsn, rate: g.rate, taxable, cgst: 0, sgst: 0, igst, total: taxable + igst });
    } else {
      const cgst = taxable * (g.rate / 2) / 100;
      rows.push({ hsn: g.hsn, rate: g.rate, taxable, cgst, sgst: cgst, igst: 0, total: taxable + cgst * 2 });
    }
  }
  if (charges > 0) {
    if (isIGST) {
      const igst = charges * maxRate / 100;
      rows.push({ hsn: `CHARGES @ ${f2(maxRate)}%`, rate: maxRate, taxable: charges, cgst: 0, sgst: 0, igst, total: charges + igst });
    } else {
      const cgst = charges * (maxRate / 2) / 100;
      rows.push({ hsn: `CHARGES @ ${f2(maxRate)}%`, rate: maxRate, taxable: charges, cgst, sgst: cgst, igst: 0, total: charges + cgst * 2 });
    }
  }
  return { rows, basicTotal, discount, charges, isIGST };
}

function border(doc, x, y, w, h, width = 0.6) {
  doc.lineWidth(width).rect(x, y, w, h).stroke("#000");
}
function vline(doc, x, y, h) { doc.moveTo(x, y).lineTo(x, y + h).stroke(); }
function hline(doc, x, y, w) { doc.moveTo(x, y).lineTo(x + w, y).stroke(); }
function cellText(doc, value, x, y, w, h, opts = {}) {
  const size = opts.size ?? 8;
  doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000");
  const align = opts.align || "left";
  const pad = opts.pad ?? 3;
  const tx = x + pad;
  const tw = Math.max(1, w - pad * 2);
  const textHeight = doc.heightOfString(text(value), { width: tw, align, lineGap: 0 });
  const ty = opts.middle === false ? y + pad : y + Math.max(pad, (h - textHeight) / 2);
  doc.text(text(value), tx, ty, { width: tw, height: Math.max(1, h - pad * 2), align, ellipsis: true, lineBreak: opts.wrap !== false });
}
function drawImageContain(doc, buffer, x, y, w, h) {
  if (!buffer) return false;
  try { doc.image(buffer, x, y, { fit: [w, h], align: "center", valign: "center" }); return true; } catch { return false; }
}

const RUPIO_FOOTER_TEXT = "THIS INVOICE IS GENERATED IN RUPIO  |  rupiooin@gmail.com";

function drawRupioFooter(doc) {
  const lineY = A4_H - 25;
  doc.save();
  doc.opacity(0.72).strokeColor("#777").lineWidth(0.4);
  doc.moveTo(M, lineY).lineTo(A4_W - M, lineY).stroke();
  doc.font("Helvetica-Bold").fontSize(6.8).fillColor("#444");
  doc.text(RUPIO_FOOTER_TEXT, M, lineY + 5, { width: W, align: "center", lineBreak: false });
  doc.restore();
}

function drawEInvoiceBlock(doc, ctx, y) {
  const h = 62;
  const qrW = 62;
  const leftW = W - qrW;
  border(doc, M, y, W, h);
  vline(doc, M + leftW, y, h);

  cellText(doc, "GST E-INVOICE DETAILS", M + 3, y + 2, leftW - 6, 14, { bold: true, size: 7.5, middle: false });
  hline(doc, M, y + 16, leftW);

  const status = ctx.eInvoiceStatus || "NOT GENERATED";
  cellText(doc, `Status: ${status}`, M + 4, y + 18, leftW * 0.27, 15, { bold: true, size: 6.5 });
  cellText(doc, `Ack No: ${ctx.eInvoiceAckNo || "-"}`, M + leftW * 0.27, y + 18, leftW * 0.36, 15, { size: 6.5 });
  cellText(doc, `Ack Date: ${ctx.eInvoiceAckDate || "-"}`, M + leftW * 0.63, y + 18, leftW * 0.37 - 4, 15, { size: 6.5 });
  hline(doc, M, y + 34, leftW);
  cellText(doc, `IRN: ${ctx.eInvoiceIrn || "-"}`, M + 4, y + 36, leftW - 8, 23, { size: 6.2, middle: false, wrap: true });

  const qx = M + leftW;
  cellText(doc, "E-INVOICE QR", qx, y + 2, qrW, 12, { bold: true, size: 6.2, align: "center", middle: false });
  if (!drawImageContain(doc, ctx.eInvoiceQrBuffer, qx + 10, y + 14, qrW - 20, 42)) {
    cellText(doc, "IRP QR", qx, y + 22, qrW, 24, { size: 6.5, align: "center" });
  }
  return y + h;
}

function drawTopNote(doc, appLogo) {
  const y = M - 4;
  const center = M + W / 2;
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#000");
  if (appLogo) {
    doc.text("THIS INVOICE IS GENERATED IN", M, y, { width: W / 2 - 25, align: "right", lineBreak: false });
    drawImageContain(doc, appLogo, center - 19, y - 1, 38, 10);
    doc.text("SOFT", center + 23, y, { width: 60, align: "left", lineBreak: false });
  } else {
    doc.text("THIS INVOICE IS GENERATED IN RUPIOO SOFT", M, y, { width: W, align: "center", lineBreak: false });
  }
}

function drawHeader(doc, ctx, y) {
  const h = 110;
  const c1 = W * 0.25, c2 = W * 0.5, c3 = W * 0.25;
  border(doc, M, y, W, h);
  vline(doc, M + c1, y, h); vline(doc, M + c1 + c2, y, h);

  if (!drawImageContain(doc, ctx.companyLogo, M + 8, y + 8, c1 - 16, h - 16)) {
    cellText(doc, ctx.companyName || "LOGO", M, y, c1, h, { bold: true, size: 11, align: "center" });
  }

  const cx = M + c1;
  cellText(doc, ctx.companyName, cx + 3, y + 8, c2 - 6, 18, { bold: true, size: 13, align: "center", middle: false });
  cellText(doc, [ctx.companyAddress, [ctx.companyCity, ctx.companyState, ctx.companyPincode].filter(Boolean).join(" ")].filter(Boolean).join("\n"), cx + 4, y + 31, c2 - 8, 28, { size: 8.5, align: "center", middle: false });
  cellText(doc, [ctx.companyEmail, ctx.companyMobile].filter(Boolean).join(" | "), cx + 4, y + 62, c2 - 8, 14, { size: 8.5, align: "center" });
  cellText(doc, ctx.companyGstin ? `GSTIN: ${ctx.companyGstin}` : "", cx + 4, y + 80, c2 - 8, 16, { bold: true, size: 9, align: "center" });

  const qx = M + c1 + c2;
  cellText(doc, "QR CODE", qx, y + 3, c3, 14, { bold: true, size: 9, align: "center" });
  if (!drawImageContain(doc, ctx.qrBuffer, qx + 23, y + 18, c3 - 46, 72)) {
    cellText(doc, "NO QR", qx, y + 30, c3, 46, { size: 8, align: "center" });
  }
  cellText(doc, `FOR ${ctx.companyName}`, qx + 2, y + 92, c3 - 4, 14, { size: 7, align: "center" });
  return y + h;
}

function drawPartyMeta(doc, ctx, y) {
  const h = 126;
  const w1 = W * 0.30, w2 = W * 0.30, w3 = W * 0.40;
  border(doc, M, y, W, h);
  vline(doc, M + w1, y, h); vline(doc, M + w1 + w2, y, h);

  const partyLines = [ctx.partyName, ctx.partyAddress, [ctx.partyCity, ctx.partyState, ctx.partyPincode].filter(Boolean).join(" "), ctx.partyEmail, ctx.partyMobile, ctx.partyGstin ? `GSTIN: ${ctx.partyGstin}` : ""].filter(Boolean);
  cellText(doc, `Bill To: ${ctx.partyName}`, M + 4, y + 5, w1 - 8, 16, { bold: true, size: 8, middle: false });
  cellText(doc, partyLines.slice(1).join("\n"), M + 4, y + 24, w1 - 8, h - 29, { size: 7.5, middle: false });

  cellText(doc, `Ship To: ${ctx.partyName}`, M + w1 + 4, y + 5, w2 - 8, 16, { bold: true, size: 8, middle: false });
  cellText(doc, partyLines.slice(1).join("\n"), M + w1 + 4, y + 24, w2 - 8, h - 29, { size: 7.5, middle: false });

  const mx = M + w1 + w2;
  const lineH = 18;
  hline(doc, mx, y + lineH, w3);
  cellText(doc, `Invoice No: ${ctx.invoiceNo}`, mx + 2, y, w3 * .60, lineH, { bold: true, size: 7.5 });
  cellText(doc, `Date: ${ctx.invoiceDate}`, mx + w3 * .60, y, w3 * .40, lineH, { bold: true, size: 7.5 });
  let ry = y + lineH;
  const metaRows = [];
  if (ctx.ewayBill) metaRows.push(`E-Way Bill: ${ctx.ewayBill}`);
  if (ctx.ledgerStr) metaRows.push(`Ledger (Closing): ${ctx.ledgerStr}`);
  if (ctx.lastPaymentText) metaRows.push(`Last Payment: ${ctx.lastPaymentText}`);
  metaRows.push(`TRANSPORTER NAME: ${ctx.transporterName || "-"}`);
  metaRows.push(`ADDRESS: ${ctx.transporterAddress || "-"}`);
  metaRows.push(`MOBILE NO: ${ctx.transporterMobile || "-"}`);
  if (ctx.biltyNo) metaRows.push(`CN / Bilty No: ${ctx.biltyNo}`);
  const remainingH = h - lineH;
  const each = remainingH / metaRows.length;
  for (const row of metaRows) {
    if (ry > y + lineH) hline(doc, mx, ry, w3);
    cellText(doc, row, mx + 2, ry, w3 - 4, each, { bold: true, size: 7.2, middle: true });
    ry += each;
  }
  return y + h;
}

const ITEM_COLS = [0.05, 0.40, 0.10, 0.10, 0.10, 0.10, 0.15];
const ITEM_HEADERS = ["S.NO", "PARTICULARS", "HSN/SAC", "TAX RATE", "QNTY", "PRICE", "AMOUNT"];
function drawItemHeader(doc, y) {
  const h = 18; border(doc, M, y, W, h);
  let x = M;
  ITEM_COLS.forEach((p, i) => { const cw = W * p; if (i) vline(doc, x, y, h); cellText(doc, ITEM_HEADERS[i], x, y, cw, h, { size: 7.2, align: "center" }); x += cw; });
  return y + h;
}
function drawItemRows(doc, items, y, startIndex = 0) {
  const rowH = 18;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]; border(doc, M, y, W, rowH);
    const name = first(item.nameSnapshot, item.productNameSnapshot, item.sku, "-");
    const hsn = first(item.hsnSnapshot, item.hsnCodeSnapshot, item.hsnCode, "-");
    const rate = n(first(item.gstRateSnapshot, item.gstRate));
    const qty = n(item.qty);
    const price = n(first(item.effectiveRate, item.basicRate, item.rate));
    const amount = n(first(item.taxable, item.taxableAmount, qty * price));
    const vals = [startIndex + i + 1, name, hsn, rate ? `${f2(rate)}%` : "0", f2(qty), f2(price), f2(amount)];
    let x = M;
    ITEM_COLS.forEach((p, c) => { const cw = W * p; if (c) vline(doc, x, y, rowH); cellText(doc, vals[c], x, y, cw, rowH, { size: 7.2, align: c === 1 ? "center" : "center" }); x += cw; });
    y += rowH;
  }
  return y;
}

function drawTotals(doc, ctx, y) {
  const leftW = W * .70, rightW = W * .30;
  const { rows, basicTotal, discount, charges, isIGST } = ctx.hsn;
  const rowH = 15;
  const leftNeeded = 16 + rowH * (rows.length + 2) + 42;
  const summaryRows = 4 + (discount > 0 ? 1 : 0) + (charges > 0 ? 1 : 0) + (isIGST ? 1 : 2);
  const rightNeeded = Math.max(leftNeeded, summaryRows * 17 + 12);
  const h = rightNeeded;
  border(doc, M, y, W, h);
  vline(doc, M + leftW, y, h);

  cellText(doc, `Total: ${amountInWords(ctx.grandTotal)}`, M, y, leftW, 16, { bold: true, size: 7.5, align: "center" });
  hline(doc, M, y + 16, leftW);

  const cols = [0.25, 0.18, 0.12, 0.10, 0.10, 0.10, 0.15];
  const heads = ["HSN/SAC", "TAXABLE VALUE", "TAX RATE", "CGST", "SGST", "IGST", "TOTAL"];
  let hy = y + 16, x = M;
  cols.forEach((p, i) => { const cw = leftW * p; if (i) vline(doc, x, hy, rowH); cellText(doc, heads[i], x, hy, cw, rowH, { bold: true, size: 6.5, align: "center" }); x += cw; });
  hline(doc, M, hy + rowH, leftW); hy += rowH;

  let taxSum = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
  for (const row of rows) {
    x = M; const vals = [row.hsn, f2(row.taxable), `${f2(row.rate)}%`, row.cgst ? f2(row.cgst) : "", row.sgst ? f2(row.sgst) : "", row.igst ? f2(row.igst) : "", f2(row.total)];
    cols.forEach((p, i) => { const cw = leftW * p; if (i) vline(doc, x, hy, rowH); cellText(doc, vals[i], x, hy, cw, rowH, { size: 6.6, align: "center" }); x += cw; });
    hline(doc, M, hy + rowH, leftW); hy += rowH;
    taxSum.taxable += n(row.taxable); taxSum.cgst += n(row.cgst); taxSum.sgst += n(row.sgst); taxSum.igst += n(row.igst); taxSum.total += n(row.total);
  }
  x = M; const tvals = ["TOTAL", f2(taxSum.taxable), "", isIGST ? "" : f2(taxSum.cgst), isIGST ? "" : f2(taxSum.sgst), isIGST ? f2(taxSum.igst) : "", f2(taxSum.total)];
  cols.forEach((p, i) => { const cw = leftW * p; if (i) vline(doc, x, hy, rowH); cellText(doc, tvals[i], x, hy, cw, rowH, { bold: true, size: 6.8, align: "center" }); x += cw; });
  hline(doc, M, hy + rowH, leftW); hy += rowH;

  const bankY = y + h - 42;
  hline(doc, M, bankY, leftW);
  const bankCols = ["Bank Name", "A/C No.", "IFSC Code", "MICR No."];
  const bankVals = [ctx.bankName || "-", ctx.accountNumber || "-", ctx.ifsc || "-", ctx.micr || "-"];
  for (let i = 0; i < 4; i++) {
    const bx = M + i * (leftW / 4); if (i) vline(doc, bx, bankY, 42);
    cellText(doc, `${bankCols[i]}:`, bx + 2, bankY + 2, leftW / 4 - 4, 16, { bold: true, size: 6.8, middle: false });
    cellText(doc, bankVals[i], bx + 2, bankY + 18, leftW / 4 - 4, 20, { size: 6.8, middle: false });
  }

  let sy = y + 3;
  const sx = M + leftW + 5, sw = rightW - 10;
  const summary = [["Basic", f2(basicTotal)]];
  if (discount > 0) summary.push(["Discounts", `-${f2(discount)}`]);
  if (charges > 0) summary.push(["Charges", f2(charges)]);
  summary.push(["Taxable Value", f2(taxSum.taxable)]);
  if (isIGST) summary.push(["IGST", f2(taxSum.igst)]); else { summary.push(["CGST", f2(taxSum.cgst)]); summary.push(["SGST", f2(taxSum.sgst)]); }
  summary.push(["RoundOff", f2(ctx.roundOff)]);
  summary.push(["Grand Total", f2(ctx.grandTotal)]);
  for (let i = 0; i < summary.length; i++) {
    const last = i === summary.length - 1;
    if (i) hline(doc, sx, sy, sw);
    cellText(doc, summary[i][0], sx, sy, sw * .60, 17, { bold: last || ["Taxable Value", "CGST", "SGST", "IGST", "RoundOff"].includes(summary[i][0]), size: 7.2 });
    cellText(doc, summary[i][1], sx + sw * .60, sy, sw * .40, 17, { bold: last, size: 7.2, align: "right" });
    sy += 17;
  }
  return y + h;
}

function drawTermsSignature(doc, ctx, y) {
  const h = 100, leftW = W * .70, rightW = W * .30;
  border(doc, M, y, W, h); vline(doc, M + leftW, y, h);
  const textW = leftW * .70;
  cellText(doc, "Terms & Conditions:", M + 4, y + 4, textW - 8, 14, { bold: true, size: 7.2, middle: false });
  cellText(doc, ctx.terms || "GOODS ONCE SOLD CANNOT BE TAKEN BACK, TRANSPORTATION RISK AT BUYER SIDE", M + 4, y + 18, textW - 8, 44, { bold: true, size: 6.8, middle: false });
  cellText(doc, `GPay No: ${ctx.gpayNumber || "-"}   |   UPI ID: ${ctx.upiId || "-"}`, M + 4, y + 67, textW - 8, 20, { size: 7, middle: false });

  const qx = M + textW;
  cellText(doc, "QR CODE", qx, y + 4, leftW - textW, 14, { bold: true, size: 8, align: "center" });
  if (!drawImageContain(doc, ctx.qrBuffer, qx + 10, y + 20, leftW - textW - 20, 68)) cellText(doc, "NO QR", qx, y + 30, leftW - textW, 30, { size: 8, align: "center" });

  const sx = M + leftW;
  cellText(doc, "For", sx + 4, y + 5, rightW - 8, 12, { size: 7, middle: false });
  cellText(doc, ctx.companyName, sx + 4, y + 19, rightW - 8, 15, { size: 7, align: "center" });
  if (!drawImageContain(doc, ctx.signature, sx + 15, y + 37, rightW - 30, 40)) cellText(doc, "SIGNATURE", sx, y + 43, rightW, 28, { size: 8, align: "center" });
  cellText(doc, "AUTHORIZED SIGNATORY", sx + 4, y + 80, rightW - 8, 14, { size: 6.8, align: "right" });
  return y + h;
}

function addContinuationPage(doc, ctx, pageNo) {
  drawRupioFooter(doc);
  doc.addPage({ size: "A4", margin: 0 });
  const y = M;
  border(doc, M, y, W, 44);
  cellText(doc, ctx.companyName, M + 5, y + 4, W * .55, 18, { bold: true, size: 11, middle: false });
  cellText(doc, `${ctx.companyGstin ? `GSTIN: ${ctx.companyGstin}` : ""}\n${ctx.companyAddress}`, M + 5, y + 22, W * .55, 19, { size: 7, middle: false });
  cellText(doc, `Invoice No: ${ctx.invoiceNo}\nDate: ${ctx.invoiceDate}\nPage: ${pageNo}`, M + W * .62, y + 5, W * .36, 34, { bold: true, size: 7.5, align: "right", middle: false });
  return y + 44 + 8;
}

export async function buildMasterSalesInvoicePdf({ invoice = {}, company = {}, customer = {}, bank = {}, ledgerSigned = null, lastPayment = null, companyLogo = null, signature = null, appLogo = null } = {}) {
  const companyName = first(company.companyName, company.tradeName, "Company");
  const upiId = text(bank.upiId);
  let qrBuffer = null;
  if (upiId) {
    const payload = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(companyName)}&am=${encodeURIComponent(f2(invoice.grandTotal))}&cu=INR&tn=${encodeURIComponent(`Invoice ${invoice.invoiceNo || ""}`)}`;
    try { qrBuffer = await QRCode.toBuffer(payload, { type: "png", width: 240, margin: 1, errorCorrectionLevel: "M" }); } catch { qrBuffer = null; }
  }
  const eInvoice = invoice.eInvoice && typeof invoice.eInvoice === "object" ? invoice.eInvoice : {};
  let eInvoiceQrBuffer = null;
  if (text(eInvoice.signedQrPayload)) {
    try { eInvoiceQrBuffer = await QRCode.toBuffer(text(eInvoice.signedQrPayload), { type: "png", width: 180, margin: 1, errorCorrectionLevel: "M" }); } catch { eInvoiceQrBuffer = null; }
  }
  const c = customerContact(customer);
  const a = customerAddress(customer, invoice);
  const ledgerStr = ledgerSigned === null || Number.isNaN(Number(ledgerSigned)) ? "" : `${Math.abs(Number(ledgerSigned)).toFixed(2)} ${Number(ledgerSigned) >= 0 ? "DR" : "CR"}`;
  const lastPaymentText = lastPayment ? `${dateOnly(lastPayment.date)}${n(lastPayment.amount) ? ` — INR ${f2(lastPayment.amount)}` : ""}` : "";
  const transport = invoice.transportAssignment || {};
  const ctx = {
    invoice,
    companyName,
    companyAddress: company.registeredAddress || "",
    companyCity: company.city || "",
    companyState: company.state || "",
    companyPincode: company.pincode || "",
    companyEmail: company.email || "",
    companyMobile: company.mobile || "",
    companyGstin: company.gstin || "",
    companyLogo,
    signature,
    appLogo,
    qrBuffer,
    invoiceNo: invoice.invoiceNo || "",
    invoiceDate: dateOnly(invoice.date),
    ewayBill: first(invoice.arn, invoice.ARN),
    eInvoiceStatus: text(eInvoice.status || "NOT_GENERATED").replaceAll("_", " "),
    eInvoiceIrn: text(eInvoice.irn),
    eInvoiceAckNo: text(eInvoice.ackNo),
    eInvoiceAckDate: dateOnly(eInvoice.ackDate),
    eInvoiceQrBuffer,
    partyName: first(invoice.customerNameSnapshot, customer.localName, customer.companyName),
    partyAddress: a.address,
    partyCity: a.city,
    partyState: a.state,
    partyPincode: a.pincode,
    partyEmail: c.email || customer.email || "",
    partyMobile: c.mobile || customer.companyContactNumber || customer.ownerMobile || "",
    partyGstin: first(invoice.gstinSnapshot, customer.displayIdentifier && String(customer.displayIdentifier).length === 15 ? customer.displayIdentifier : ""),
    ledgerStr,
    lastPaymentText,
    transporterName: transport.transporterNameSnapshot || (transport.mode === "LOCAL" ? "LOCAL" : ""),
    transporterAddress: first(transport.bookingStationAddressSnapshot, transport.deliveryStationAddressSnapshot),
    transporterMobile: "",
    biltyNo: first(invoice.delivery?.biltyNo, invoice.CNNumber),
    bankName: bank.bankName || "",
    accountNumber: bank.accountNumber || "",
    ifsc: bank.ifsc || "",
    micr: bank.micr || "",
    upiId,
    gpayNumber: first(company.gpayNumber, company.mobile),
    terms: company.invoiceTerms || "",
    grandTotal: n(invoice.grandTotal),
    roundOff: n(invoice.roundOff),
    hsn: buildHsnRows(invoice),
  };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: true, info: { Title: `Invoice ${ctx.invoiceNo}`, Author: ctx.companyName, Subject: "Tax Invoice" } });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      if (["CANCELLED", "DELETED"].includes(String(invoice.status || invoice.workflowStatus || "").toUpperCase())) {
        doc.save();
        doc.opacity(0.12).fillColor("#555").font("Helvetica-Bold").fontSize(62);
        doc.rotate(-18, { origin: [A4_W / 2, A4_H / 2] });
        doc.text("CANCELLED", 110, A4_H / 2 - 30, { width: 380, align: "center" });
        doc.restore();
      }

      let y = M;
      y = drawHeader(doc, ctx, y);
      y = drawEInvoiceBlock(doc, ctx, y);
      y = drawPartyMeta(doc, ctx, y);
      y = drawItemHeader(doc, y);

      const items = Array.isArray(invoice.items) ? invoice.items : [];
      const firstPageMax = 12;
      let index = 0;
      const firstItems = items.slice(0, firstPageMax);
      y = drawItemRows(doc, firstItems, y, 0);
      index += firstItems.length;

      // Keep the invoice summary on the final page. Additional item pages use a
      // compact continuation header but exactly the same line-item table.
      let pageNo = 1;
      while (index < items.length) {
        const remaining = items.length - index;
        const isLastChunk = remaining <= 17;
        pageNo += 1;
        y = addContinuationPage(doc, ctx, pageNo);
        y = drawItemHeader(doc, y);
        const max = isLastChunk ? Math.min(17, remaining) : Math.min(28, remaining);
        y = drawItemRows(doc, items.slice(index, index + max), y, index);
        index += max;
      }

      const hsnCount = ctx.hsn.rows.length;
      const totalsEstimate = 16 + 15 * (hsnCount + 2) + 42;
      const termsEstimate = 100;
      if (y + 25 + totalsEstimate + termsEstimate > A4_H - M) {
        pageNo += 1;
        y = addContinuationPage(doc, ctx, pageNo);
      }
      y += 25;
      y = drawTotals(doc, ctx, y);
      drawTermsSignature(doc, ctx, y);
      drawRupioFooter(doc);

      doc.end();
    } catch (error) { reject(error); }
  });
}
