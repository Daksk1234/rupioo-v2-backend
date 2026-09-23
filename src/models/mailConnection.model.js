import mongoose from "mongoose";

const MailAutomationSchema = new mongoose.Schema(
  {
    invoiceAfterDelivery: { type: Boolean, default: false },
    receiptAfterPayment: { type: Boolean, default: false },
    reminderBeforeDueDays: { type: Number, default: 0, min: 0, max: 30 },
    reminderOnDueDate: { type: Boolean, default: false },
    reminderEveryDaysAfterDue: { type: Number, default: 0, min: 0, max: 30 },
  },
  { _id: false },
);

const MailConnectionSchema = new mongoose.Schema(
  {
    database: { type: String, required: true, unique: true, index: true },
    superadminId: { type: String, default: "", index: true },
    email: { type: String, default: "", lowercase: true, trim: true, index: true },
    fromName: { type: String, default: "" },
    replyTo: { type: String, default: "" },
    signatureHtml: { type: String, default: "" },

    provider: {
      type: String,
      enum: ["google", "microsoft", "smtp", ""],
      default: "",
      index: true,
    },
    authMode: {
      type: String,
      enum: ["oauth", "smtp", "smtp_legacy", ""],
      default: "",
    },
    status: {
      type: String,
      enum: ["connected", "pending", "disconnected", "error"],
      default: "disconnected",
      index: true,
    },

    encryptedRefreshToken: { type: String, default: "" },
    encryptedAccessToken: { type: String, default: "" },
    accessTokenExpiresAt: { type: Date },

    smtpHost: { type: String, default: "" },
    smtpPort: { type: Number, default: 587 },
    smtpSecure: { type: Boolean, default: false },
    smtpUser: { type: String, default: "" },
    encryptedSmtpPassword: { type: String, default: "" },

    needsUpgrade: { type: Boolean, default: false, index: true },
    consentAccepted: { type: Boolean, default: false },
    consentAcceptedAt: { type: Date },
    consentVersion: { type: String, default: "3.0" },

    lastHealthAt: { type: Date },
    lastSuccessfulSendAt: { type: Date },
    lastErrorAt: { type: Date },
    lastError: { type: String, default: "" },

    automation: { type: MailAutomationSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export const MailConnection = mongoose.model(
  "mail_connection",
  MailConnectionSchema,
);
