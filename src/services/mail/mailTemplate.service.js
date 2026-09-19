const esc = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const money = (value) => {
  const n = Number(value || 0);
  return `₹${Number.isFinite(n) ? n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"}`;
};

const shell = ({ title, greeting, intro, rows, signatureHtml }) => `
<!doctype html>
<html>
  <body style="margin:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
    <div style="max-width:720px;margin:0 auto;padding:24px">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
        <div style="padding:20px 24px;background:#111827;color:white">
          <div style="font-size:20px;font-weight:700">${esc(title)}</div>
        </div>
        <div style="padding:24px">
          <p style="font-size:16px;margin:0 0 14px">${esc(greeting)}</p>
          <p style="line-height:1.6;margin:0 0 18px">${esc(intro)}</p>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
            ${rows
              .filter((r) => r && r[1] !== undefined && r[1] !== null && String(r[1]) !== "")
              .map(
                ([label, value]) => `
                  <tr>
                    <td style="padding:9px 10px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:38%">${esc(label)}</td>
                    <td style="padding:9px 10px;border:1px solid #e5e7eb">${esc(value)}</td>
                  </tr>`,
              )
              .join("")}
          </table>
          <p style="font-size:13px;color:#6b7280">Please refer to the attached document for complete details.</p>
          ${signatureHtml || ""}
        </div>
      </div>
    </div>
  </body>
</html>`;

export const buildDocumentMail = ({ type, fields = {}, signatureHtml = "" }) => {
  const partyName = fields.partyName || fields.customerName || "Customer";
  const greeting = `Dear ${partyName},`;

  if (type === "invoice") {
    return {
      subject: fields.subject || `Sales Invoice ${fields.invoiceId || fields.documentNumber || ""}`.trim(),
      html: shell({
        title: "Sales Invoice",
        greeting,
        intro: fields.title || "Please find your sales invoice attached.",
        rows: [
          ["Invoice No.", fields.invoiceId || fields.documentNumber],
          ["Date", fields.date],
          ["Amount", money(fields.total || fields.amount)],
          ["Address", fields.address],
          ["CN Number", fields.CNNumber],
          ["CN Date", fields.CNDate],
          ["CN Qty", fields.CNQty],
        ],
        signatureHtml,
      }),
    };
  }

  if (type === "ledger" || type === "statement") {
    return {
      subject:
        fields.subject ||
        `${type === "ledger" ? "Ledger" : "Statement of Account"}${fields.period ? ` - ${fields.period}` : ""}`,
      html: shell({
        title: type === "ledger" ? "Customer Ledger" : "Statement of Account",
        greeting,
        intro: "Please find the requested account statement attached.",
        rows: [
          ["Period", fields.period],
          ["Opening Balance", fields.openingBalance],
          ["Closing Balance", fields.closingBalance],
        ],
        signatureHtml,
      }),
    };
  }

  if (type === "payment_request") {
    return {
      subject:
        fields.subject ||
        `Payment Request${fields.invoiceId ? ` - ${fields.invoiceId}` : ""}`,
      html: shell({
        title: "Payment Request",
        greeting,
        intro:
          fields.message ||
          "We request you to kindly arrange payment of the outstanding amount.",
        rows: [
          ["Invoice / Reference", fields.invoiceId || fields.referenceNo],
          ["Outstanding Amount", money(fields.amount || fields.total)],
          ["Due Date", fields.dueDate],
          ["UPI ID", fields.upiId],
        ],
        signatureHtml,
      }),
    };
  }

  if (type === "receipt") {
    return {
      subject: fields.subject || `Payment Receipt ${fields.receiptNo || ""}`.trim(),
      html: shell({
        title: "Payment Receipt",
        greeting,
        intro: "Thank you. Please find your payment receipt attached.",
        rows: [
          ["Receipt No.", fields.receiptNo],
          ["Date", fields.date],
          ["Amount", money(fields.amount)],
          ["Payment Mode", fields.paymentMode],
          ["Reference", fields.referenceNo],
        ],
        signatureHtml,
      }),
    };
  }

  if (type === "credit_note" || type === "debit_note") {
    const label = type === "credit_note" ? "Credit Note" : "Debit Note";
    return {
      subject: fields.subject || `${label} ${fields.documentNumber || fields.referenceNo || ""}`.trim(),
      html: shell({
        title: label,
        greeting,
        intro: `Please find the ${label.toLowerCase()} attached.`,
        rows: [
          ["Document No.", fields.documentNumber || fields.referenceNo],
          ["Date", fields.date],
          ["Amount", money(fields.amount || fields.total)],
        ],
        signatureHtml,
      }),
    };
  }

  if (type === "delivery") {
    return {
      subject: fields.subject || `Delivery Confirmation ${fields.documentNumber || fields.invoiceId || ""}`.trim(),
      html: shell({
        title: "Delivery Confirmation",
        greeting,
        intro: fields.message || "Your delivery has been updated. Please find the related document attached.",
        rows: [
          ["Invoice / Reference", fields.invoiceId || fields.documentNumber || fields.referenceNo],
          ["Date", fields.date],
          ["CN Number", fields.CNNumber],
        ],
        signatureHtml,
      }),
    };
  }

  if (type === "purchase_order" || type === "sales_order") {
    const label = type === "purchase_order" ? "Purchase Order" : "Sales Order";
    return {
      subject: fields.subject || `${label} ${fields.orderNo || fields.documentNumber || ""}`.trim(),
      html: shell({
        title: label,
        greeting,
        intro: `Please find the ${label.toLowerCase()} attached.`,
        rows: [
          ["Order No.", fields.orderNo || fields.documentNumber],
          ["Date", fields.date],
          ["Amount", money(fields.amount || fields.total)],
        ],
        signatureHtml,
      }),
    };
  }

  return {
    subject: fields.subject || "Rupio Document",
    html: shell({
      title: fields.title || "Document",
      greeting,
      intro: fields.message || "Please find the attached document.",
      rows: [["Reference", fields.referenceNo || fields.documentNumber]],
      signatureHtml,
    }),
  };
};
