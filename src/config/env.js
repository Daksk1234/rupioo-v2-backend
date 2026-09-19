import dotenv from "dotenv";
dotenv.config();

export const env = {
  port: Number(process.env.PORT || 5050),
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri:
    process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/rupioo_master",
  jwtSecret: process.env.JWT_SECRET || "dev-only-secret-change-me",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  passwordResetTtlMinutes: Number(
    process.env.PASSWORD_RESET_TTL_MINUTES || 30
  ),
  storageDriver: process.env.STORAGE_DRIVER || "local",
  storageRoot: process.env.STORAGE_ROOT || "../storage",
  nasRoot: process.env.NAS_ROOT || "",
  otpTtlSeconds: Number(process.env.OTP_TTL_SECONDS || 300),
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true").toLowerCase() === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "",
  },
  masterGst: {
    baseUrl: process.env.MASTERGST_BASE_URL || "https://api.mastergst.com",
    email: process.env.MASTERGST_EMAIL || "",
    clientId: process.env.MASTERGST_CLIENT_ID || "",
    clientSecret: process.env.MASTERGST_CLIENT_SECRET || "",
    gstin: process.env.MASTERGST_GSTIN || "",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_DOCUMENT_MODEL || "gpt-5.6-luna",
    detail: process.env.OPENAI_DOCUMENT_DETAIL || "original",
  },
  razorpay: {
    baseUrl: process.env.RAZORPAY_BASE_URL || "https://api.razorpay.com/v1",
    keyId: process.env.RAZORPAY_KEY_ID || "",
    keySecret: process.env.RAZORPAY_KEY_SECRET || "",
    currency: process.env.RAZORPAY_CURRENCY || "INR",
  },
};
