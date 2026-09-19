import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { MailQueue } from "../../model/mailQueue.model.js";
import { encryptBuffer, decryptBuffer } from "./crypto.js";
import { sendCompanyMail } from "./mail.service.js";

const queueRoot = () =>
  path.resolve(process.env.MAIL_QUEUE_STORAGE_DIR || "storage/mail-queue");

const safe = (value) => String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160);

const normalizeList = (value) => {
  const list = Array.isArray(value) ? value : String(value || "").split(/[;,]/);
  return list.map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
};

const saveAttachment = async (database, file) => {
  const buffer = file.buffer || (file.path ? await fs.readFile(file.path) : Buffer.alloc(0));
  const encrypted = encryptBuffer(buffer);
  const folder = path.join(queueRoot(), safe(database));
  await fs.mkdir(folder, { recursive: true });
  const random = crypto.randomBytes(10).toString("hex");
  const encryptedPath = path.join(folder, `${Date.now()}-${random}.rmail`);
  await fs.writeFile(encryptedPath, encrypted, { mode: 0o600 });
  if (file.path) await fs.unlink(file.path).catch(() => {});
  return {
    filename: safe(file.originalname || file.filename || "attachment.bin"),
    mimeType: String(file.mimetype || file.mimeType || "application/octet-stream"),
    encryptedPath,
    size: buffer.length,
  };
};

const loadAttachments = async (items = []) =>
  Promise.all(
    items.map(async (a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      content: decryptBuffer(await fs.readFile(a.encryptedPath)),
    })),
  );

const cleanupAttachments = async (items = []) => {
  await Promise.all(
    items.map((a) => fs.unlink(a.encryptedPath).catch(() => {})),
  );
};

const retryDelayMinutes = (attempt) => {
  const schedule = [1, 2, 5, 10, 20, 30, 60, 120, 240, 360, 720, 1440];
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)];
};

export const enqueueMail = async ({
  database,
  requestedBy,
  type,
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  files = [],
  metadata = {},
}) => {
  const attachments = [];
  for (const file of files) {
    attachments.push(await saveAttachment(database, file));
  }

  return MailQueue.create({
    database,
    requestedBy: requestedBy || "",
    type: type || "generic",
    to: normalizeList(to),
    cc: normalizeList(cc),
    bcc: normalizeList(bcc),
    subject,
    text: text || "",
    html: html || "",
    attachments,
    metadata,
    status: "queued",
    nextAttemptAt: new Date(),
  });
};

export const processMailQueueItem = async (queueId) => {
  const row = await MailQueue.findOneAndUpdate(
    {
      _id: queueId,
      status: { $in: ["queued", "retry"] },
    },
    {
      $set: { status: "sending", lastAttemptAt: new Date() },
      $inc: { attemptCount: 1 },
    },
    { new: true },
  );

  if (!row) return null;

  try {
    const attachments = await loadAttachments(row.attachments);
    const result = await sendCompanyMail({
      database: row.database,
      to: row.to,
      cc: row.cc,
      bcc: row.bcc,
      subject: row.subject,
      text: row.text,
      html: row.html,
      attachments,
    });

    row.status = "sent";
    row.sentAt = new Date();
    row.lastError = "";
    row.provider = result.provider || "";
    row.providerMessageId = result.providerMessageId || "";
    await row.save();
    await cleanupAttachments(row.attachments);
    return row;
  } catch (error) {
    const message = String(
      error?.response?.data?.error?.message || error?.message || "Unable to send email",
    ).slice(0, 1000);
    row.lastError = message;
    if (row.attemptCount >= row.maxAttempts) {
      row.status = "failed";
    } else {
      row.status = "retry";
      row.nextAttemptAt = new Date(
        Date.now() + retryDelayMinutes(row.attemptCount) * 60 * 1000,
      );
    }
    await row.save();
    return row;
  }
};

export const enqueueAndTryMail = async (payload) => {
  const row = await enqueueMail(payload);
  const result = await processMailQueueItem(row._id);
  return result || row;
};

export const retryMailNow = async (queueId, database) => {
  const row = await MailQueue.findOne({ _id: queueId, database });
  if (!row) throw new Error("Email queue item not found");
  row.status = "queued";
  row.nextAttemptAt = new Date();
  row.lastError = "";
  await row.save();
  return processMailQueueItem(row._id);
};
