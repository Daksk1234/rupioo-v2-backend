import { MailConnection } from "../models/mailConnection.model.js";
import { MailQueue } from "../models/mailQueue.model.js";
import { buildDocumentMail } from "../services/mail/mailTemplate.service.js";
import { enqueueAndTryMail, retryMailNow } from "../services/mail/mailQueue.service.js";

const parseJson = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
};

const normalizeFiles = (files = []) =>
  (Array.isArray(files) ? files : []).map((file) => ({
    path: file.path,
    buffer: file.buffer,
    originalname: file.originalname || file.filename,
    filename: file.filename,
    mimetype: file.mimetype,
  }));

export const sendDocument = async (req, res) => {
  try {
    const database = String(req.params.database || "").trim();
    const type = String(req.body.type || "generic").trim().toLowerCase();
    const to = req.body.to || req.body.customer || "";
    const cc = req.body.cc || "";
    const bcc = req.body.bcc || "";
    const fields = {
      ...parseJson(req.body.fields, {}),
      title: req.body.title,
      date: req.body.date,
      total: req.body.total,
      amount: req.body.amount,
      invoiceId: req.body.invoiceId,
      partyName: req.body.partyName,
      customerName: req.body.customerName,
      address: req.body.address,
      CNDate: req.body.CNDate,
      CNNumber: req.body.CNNumber,
      CNQty: req.body.CNQty,
      dueDate: req.body.dueDate,
      period: req.body.period,
      closingBalance: req.body.closingBalance,
      openingBalance: req.body.openingBalance,
      upiId: req.body.upiId,
      subject: req.body.subject,
      message: req.body.message,
      referenceNo: req.body.referenceNo,
      receiptNo: req.body.receiptNo,
      paymentMode: req.body.paymentMode,
      orderNo: req.body.orderNo,
      documentNumber: req.body.documentNumber,
    };

    if (!to) return res.status(400).json({ status: false, message: "Recipient email is required" });

    const connection = await MailConnection.findOne({ database }).lean();
    if (!connection || connection.status !== "connected") {
      return res.status(409).json({
        status: false,
        code: "MAIL_NOT_CONNECTED",
        message: "Company email is not connected. Please connect it in Email & Communication settings.",
      });
    }

    const template = buildDocumentMail({
      type,
      fields,
      signatureHtml: connection.signatureHtml || "",
    });

    const queue = await enqueueAndTryMail({
      database,
      requestedBy: req.rupioAuth?.id || "",
      type,
      to,
      cc,
      bcc,
      subject: template.subject,
      html: template.html,
      text: req.body.text || "",
      files: normalizeFiles(req.files),
      metadata: fields,
    });

    const sent = queue.status === "sent";
    return res.status(sent ? 200 : 202).json({
      status: true,
      message: sent
        ? "Email sent successfully"
        : "Email safely queued and will retry automatically",
      mailStatus: queue.status,
      queueId: queue._id,
      lastError: queue.lastError || "",
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const outbox = async (req, res) => {
  try {
    const database = req.params.database;
    const status = String(req.query.status || "").trim();
    const query = { database };
    if (status) query.status = status;
    const rows = await MailQueue.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(200, Number(req.query.limit || 100)))
      .select("type to subject status attemptCount maxAttempts nextAttemptAt sentAt lastError provider providerMessageId createdAt metadata")
      .lean();
    return res.json({ status: true, rows });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const retry = async (req, res) => {
  try {
    const row = await retryMailNow(req.params.id, req.params.database);
    return res.json({
      status: true,
      message: row?.status === "sent" ? "Email sent successfully" : "Email queued for retry",
      mailStatus: row?.status,
    });
  } catch (error) {
    return res.status(400).json({ status: false, message: error.message });
  }
};
