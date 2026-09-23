import mongoose from "mongoose";

const AttachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    mimeType: { type: String, default: "application/octet-stream" },
    encryptedPath: { type: String, required: true },
    size: { type: Number, default: 0 },
  },
  { _id: false },
);

const MailQueueSchema = new mongoose.Schema(
  {
    database: { type: String, required: true, index: true },
    requestedBy: { type: String, default: "", index: true },
    type: {
      type: String,
      enum: [
        "invoice",
        "ledger",
        "payment_request",
        "receipt",
        "statement",
        "purchase_order",
        "sales_order",
        "credit_note",
        "debit_note",
        "delivery",
        "test",
        "generic",
      ],
      default: "generic",
      index: true,
    },
    to: { type: [String], default: [] },
    cc: { type: [String], default: [] },
    bcc: { type: [String], default: [] },
    subject: { type: String, required: true },
    text: { type: String, default: "" },
    html: { type: String, default: "" },
    attachments: { type: [AttachmentSchema], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: {
      type: String,
      enum: ["queued", "retry", "sending", "sent", "failed", "cancelled"],
      default: "queued",
      index: true,
    },
    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 12 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lastAttemptAt: { type: Date },
    sentAt: { type: Date },
    lastError: { type: String, default: "" },
    provider: { type: String, default: "" },
    providerMessageId: { type: String, default: "" },
  },
  { timestamps: true },
);

MailQueueSchema.index({ status: 1, nextAttemptAt: 1 });
MailQueueSchema.index({ database: 1, createdAt: -1 });

export const MailQueue = mongoose.model("mail_queue", MailQueueSchema);
