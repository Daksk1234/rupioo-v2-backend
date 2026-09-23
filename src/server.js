import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { errorHandler } from "./middleware/error.js";
import { optionalAuth } from "./middleware/auth.js";
import { companyPermissionGuard } from "./middleware/companyPermissionGuard.js";
import authRoutes from "./routes/auth.js";
import masterRoutes from "./routes/master.js";
import customerRoutes from "./routes/customers.js";
import productRoutes from "./routes/products.js";
import leadRoutes from "./routes/leads.js";
import targetRoutes from "./routes/targets.js";
import dashboardRoutes from "./routes/dashboard.js";
import reportRoutes from "./routes/reports.js";
import otpRoutes from "./routes/otp.js";
import fileRoutes from "./routes/files.js";
import genericRoutes from "./routes/generic.js";
import transactionRoutes from "./routes/transactions.js";
import salesInvoiceBulkRoutes from "./routes/salesInvoiceBulk.js";
import referenceRoutes from "./routes/reference.js";
import accessRoutes from "./routes/access.js";
import employeeRoutes from "./routes/employees.js";
import recruitmentRoutes from "./routes/recruitment.js";
import operationsRoutes from "./routes/operations.js";
import companyRoutes from "./routes/company.js";
import catalogRoutes from "./routes/catalog.js";
import groupRoutes from "./routes/groups.js";
import registrationRoutes from "./routes/registration.js";
import bankRoutes from "./routes/banks.js";
import profileRoutes from "./routes/profile.js";
import documentAiRoutes from "./routes/documentAi.js";
import migrationRoutes from "./routes/migration.js";
import storageRoutes from "./routes/storage.js";
import salesAppRoutes from "./routes/salesApp.js";
import orderFlowRoutes from "./routes/orderFlow.js";
import purchaseAiRoutes, { vendorRouter as purchaseAiVendorRoutes, startPurchaseAiAutomation } from "./routes/purchaseAi.js";

await connectDb();
const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: env.corsOrigin.split(","), credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "rupioo-global-v2", time: new Date() }),
);
app.use("/api/auth", authRoutes);
app.use("/api/registration", registrationRoutes);
app.use("/api/profile", optionalAuth, profileRoutes);
// Storage OAuth callbacks and Superadmin/Master storage setup use their own auth guard.
app.use("/api/storage", storageRoutes);

// IMPORTANT: Order Flow is mounted BEFORE the generic /api permission middleware
// and BEFORE the broad /api/sales-app router. This guarantees that requests like
// GET /api/sales-app/order-flow/orders reach this router first. The orderFlow
// router still performs its own requireAuth check for all business endpoints.
app.get("/api/sales-app/order-flow/health", (_req, res) =>
  res.json({
    ok: true,
    module: "order-flow",
    mount: "server-priority",
    build: "2026-09-20-priority-mount",
    time: new Date().toISOString(),
  }),
);
app.use("/api/sales-app/order-flow", orderFlowRoutes);
// Backward-compatible alias for older frontend/mobile builds.
app.use("/api/order-flow", orderFlowRoutes);
// Vendor Portal is public only through its signed vendor token. It must be mounted before company auth guards.
app.use("/api/purchase-ai/vendor", purchaseAiVendorRoutes);

// Sales Invoice Bulk is mounted before the generic /api guard and before the large
// transactions router. The bulk router performs its own authentication and DMS checks.
// This keeps LOAD XLS / MANUAL MAPPING available through one deterministic route.
app.get("/api/transactions/sales-invoices/bulk-health-live", (_req, res) =>
  res.json({
    ok: true,
    module: "sales-invoice-bulk",
    build: "2026-09-20-manual-mapping-v7",
    mode: "LOAD XLS -> MANUAL PARTY/PRODUCT MAP -> VALIDATE -> POST",
    time: new Date().toISOString(),
  }),
);
app.use("/api/transactions/sales-invoices", salesInvoiceBulkRoutes);

// Resolve the signed company session once, then enforce the Plan Group's page/action ceiling across business APIs.
app.use("/api", optionalAuth, companyPermissionGuard);
app.use("/api/master", masterRoutes);
app.use("/api/reference", referenceRoutes);
app.use("/api/access", accessRoutes);
app.use("/api/company", companyRoutes);
app.use("/api/banks", bankRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/recruitment", recruitmentRoutes);
app.use("/api/operations", operationsRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/products", productRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/targets", targetRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/otp", otpRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/document-ai", documentAiRoutes);
app.use("/api/migration", migrationRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/purchase-ai", purchaseAiRoutes);
app.use("/api/sales-app", salesAppRoutes);
app.use("/api/modules", genericRoutes);


// Recalculate AI purchase triggers in the background. The scan is idempotent and
// preserves buyer-edited quantities while refreshing AI-owned recommendations.
startPurchaseAiAutomation();

app.use(errorHandler);
app.listen(env.port, () =>
  console.log(`Rupioo Global V2 API listening on http://localhost:${env.port}`),
);
