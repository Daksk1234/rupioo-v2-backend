import PDFDocument from "pdfkit";

const M = 30;
const A4_W = 595.28;
const A4_H = 841.89;
const W = A4_W - M * 2;
const clean = (v) => String(v ?? "").trim();
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const money = (v) => num(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateOnly = (v) => {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString("en-IN");
};
const titleFor = (type) => type === "DEBIT_NOTE" ? "DEBIT NOTE" : type === "DELIVERY_NOTE" ? "DELIVERY NOTE / DELIVERY CHALLAN" : "CREDIT NOTE";

function collectPdf(fn) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try { fn(doc); doc.end(); } catch (e) { reject(e); }
  });
}

function box(doc, x, y, w, h) { doc.rect(x, y, w, h).lineWidth(0.6).stroke(); }
function cell(doc, value, x, y, w, h, { bold = false, size = 8, align = "left" } = {}) {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000");
  doc.text(clean(value), x + 3, y + 3, { width: Math.max(1, w - 6), height: Math.max(1, h - 6), align, ellipsis: true });
}
function rowLines(doc, xs, y, h) {
  doc.moveTo(xs[0], y).lineTo(xs[xs.length - 1], y).stroke();
  doc.moveTo(xs[0], y + h).lineTo(xs[xs.length - 1], y + h).stroke();
  xs.forEach((x) => doc.moveTo(x, y).lineTo(x, y + h).stroke());
}

function drawOne(doc, { note, company, party, copyLabel = "" }) {
  doc.addPage();
  const type = clean(note.documentType || "CREDIT_NOTE").toUpperCase();
  const title = titleFor(type);
  let y = M;

  doc.font("Helvetica-Bold").fontSize(15).text(title, M, y, { width: W, align: "center" });
  y += 20;
  if (copyLabel) {
    doc.font("Helvetica-Bold").fontSize(7).text(copyLabel, M, y, { width: W, align: "center" });
    y += 12;
  }
  if (type === "DELIVERY_NOTE") {
    doc.font("Helvetica-Bold").fontSize(7).text("MOVEMENT FOR JOB WORK / REASONS OTHER THAN SUPPLY — NOT A TAX INVOICE", M, y, { width: W, align: "center" });
    y += 14;
  }

  box(doc, M, y, W, 82);
  cell(doc, company?.companyName || company?.tradeName || "Company", M, y, W * 0.58, 18, { bold: true, size: 11 });
  cell(doc, `GSTIN: ${company?.gstin || "-"}`, M, y + 20, W * 0.58, 14, { bold: true });
  cell(doc, company?.registeredAddress || [company?.area, company?.city, company?.district, company?.state, company?.pincode].filter(Boolean).join(", "), M, y + 34, W * 0.58, 42, { size: 7.4 });
  const no = note.documentNo || note.creditNoteNo || "";
  cell(doc, `${title.replace(" / DELIVERY CHALLAN", "")} No.\n${no}`, M + W * 0.60, y + 6, W * 0.38, 32, { bold: true, size: 9 });
  cell(doc, `Date: ${dateOnly(note.date)}\nFY: ${note.financialYear || ""}`, M + W * 0.60, y + 42, W * 0.38, 30, { bold: true, size: 8 });
  y += 88;

  box(doc, M, y, W, 74);
  cell(doc, type === "DELIVERY_NOTE" ? "JOB WORKER / CONSIGNEE" : "PARTY", M + 3, y + 3, W - 6, 14, { bold: true, size: 7 });
  cell(doc, note.partyNameSnapshot || note.customerNameSnapshot || party?.localName || party?.legalName || "Party", M + 3, y + 18, W * 0.62, 18, { bold: true, size: 9 });
  cell(doc, `GSTIN: ${note.partyGstinSnapshot || party?.displayIdentifier || "-"}`, M + 3, y + 38, W * 0.62, 14, { size: 7.5 });
  cell(doc, note.addressSnapshot || "", M + 3, y + 52, W * 0.62, 18, { size: 7 });
  const ref = note.referenceDocumentNo || note.invoiceNo || "-";
  const reason = note.jobWorkPurpose || note.reason || note.reasonType || "-";
  const refDate = note.referenceDocumentDate ? dateOnly(note.referenceDocumentDate) : "";
  cell(doc, `Against: ${ref}${refDate ? ` • ${refDate}` : ""}\nReason / Purpose: ${reason}`, M + W * 0.64, y + 15, W * 0.34, 50, { size: 7.5 });
  y += 80;

  const cols = [M, M + 26, M + 205, M + 260, M + 304, M + 348, M + 408, M + 458, M + W];
  const heads = ["#", "Description", "HSN", "Qty", "Unit", "Rate", "GST %", "Amount"];
  rowLines(doc, cols, y, 24);
  heads.forEach((h, i) => cell(doc, h, cols[i], y, cols[i + 1] - cols[i], 24, { bold: true, size: 6.8, align: i >= 3 ? "right" : "left" }));
  y += 24;

  const items = Array.isArray(note.items) ? note.items : [];
  for (let i = 0; i < items.length; i++) {
    if (y > A4_H - 185) {
      doc.font("Helvetica").fontSize(6).text("Continued…", M, y + 4, { width: W, align: "right" });
      doc.addPage(); y = M;
      rowLines(doc, cols, y, 24);
      heads.forEach((h, j) => cell(doc, h, cols[j], y, cols[j + 1] - cols[j], 24, { bold: true, size: 6.8, align: j >= 3 ? "right" : "left" }));
      y += 24;
    }
    const it = items[i];
    const vals = [String(i + 1), it.nameSnapshot || it.description || "Item", it.hsnSnapshot || "", money(it.qty), it.unit || "", money(it.effectiveRate ?? it.rate), money(it.gstRateSnapshot), money(it.lineTotal ?? it.taxable)];
    rowLines(doc, cols, y, 24);
    vals.forEach((v, j) => cell(doc, v, cols[j], y, cols[j + 1] - cols[j], 24, { size: 6.8, align: j >= 3 ? "right" : "left" }));
    y += 24;
  }
  if (!items.length) {
    rowLines(doc, cols, y, 28);
    cell(doc, "No item rows", M, y, W, 28, { size: 7, align: "center" }); y += 28;
  }

  y += 6;
  const totalsH = type === "DELIVERY_NOTE" ? 54 : 78;
  box(doc, M + W * 0.54, y, W * 0.46, totalsH);
  let ty = y + 4;
  const totalRows = type === "DELIVERY_NOTE"
    ? [["Declared Consignment Value", note.grandTotal || note.taxableTotal]]
    : [["Taxable Value", note.taxableTotal], ["GST", note.taxTotal], ["Round Off", note.roundOff], ["Grand Total", note.grandTotal]];
  totalRows.forEach(([label, val]) => {
    cell(doc, label, M + W * 0.55, ty, W * 0.25, 16, { bold: true, size: 7 });
    cell(doc, `₹ ${money(val)}`, M + W * 0.80, ty, W * 0.18, 16, { bold: true, size: 7.5, align: "right" });
    ty += 17;
  });
  y += totalsH + 8;

  if (type === "DELIVERY_NOTE") {
    box(doc, M, y, W, 76);
    cell(doc, `Warehouse: ${note.warehouseNameSnapshot || "-"}\nExpected Return: ${dateOnly(note.expectedReturnDate) || "-"}\nTransporter: ${note.transporterName || "-"}\nVehicle No.: ${note.vehicleNo || "-"}`, M + 3, y + 3, W * 0.48, 68, { size: 7.2 });
    cell(doc, `E-Way Bill Required: ${note.eWayBillRequired ? "YES" : "NO"}\nE-Way Bill No.: ${note.eWayBillNo || "-"}\nE-Way Bill Date: ${dateOnly(note.eWayBillDate) || "-"}\nDistance: ${num(note.distanceKm) || "-"} km`, M + W * 0.51, y + 3, W * 0.46, 68, { size: 7.2, bold: note.eWayBillRequired });
    y += 84;
  }

  if (clean(note.remarks)) {
    box(doc, M, y, W, 42);
    cell(doc, `Remarks: ${note.remarks}`, M + 3, y + 3, W - 6, 36, { size: 7.2 });
    y += 48;
  }

  const signY = Math.min(A4_H - 80, Math.max(y + 10, A4_H - 120));
  doc.font("Helvetica").fontSize(7).text("Receiver's Signature", M + 10, signY, { width: 150, align: "left" });
  doc.font("Helvetica-Bold").fontSize(7).text(`For ${company?.companyName || company?.tradeName || "Company"}`, A4_W - M - 180, signY, { width: 170, align: "right" });
  doc.font("Helvetica").fontSize(7).text("Authorised Signatory", A4_W - M - 180, signY + 35, { width: 170, align: "right" });
  doc.font("Helvetica").fontSize(6).fillColor("#555").text("Generated in Rupio DMS", M, A4_H - 24, { width: W, align: "center" });
}

export async function buildDocumentNotePdf({ note = {}, company = {}, party = {} } = {}) {
  const type = clean(note.documentType || "CREDIT_NOTE").toUpperCase();
  return collectPdf((doc) => {
    if (type === "DELIVERY_NOTE") {
      ["ORIGINAL FOR CONSIGNEE", "DUPLICATE FOR TRANSPORTER", "TRIPLICATE FOR CONSIGNER"].forEach((copyLabel) => drawOne(doc, { note, company, party, copyLabel }));
    } else {
      drawOne(doc, { note, company, party });
    }
  });
}
