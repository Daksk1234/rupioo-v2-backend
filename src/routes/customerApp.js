import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import fs from "fs";
import path from "path";
import {
  CompanyProfile,
  CustomerDamageClaim,
  CustomerGrade,
  CustomerLink,
  CustomerPortalAccount,
  CustomerPromotion,
  CustomerSupportTicket,
  FileMeta,
  GlobalCustomer,
  Pincode,
  Product,
  User,
} from "../models/index.js";
import { env } from "../config/env.js";
import {collectorForCustomerFilter} from '../services/collectorTerritoryService.js';
import { fail, ok, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { searchTaxpayer } from "../services/gstService.js";
import { resolveCustomerSalesperson } from "../services/assignmentHierarchyService.js";
import { financialModels } from "../services/accountingService.js";
import { buildCustomerReceivableLedger } from "../services/customerReceivableLedgerService.js";
import { isReceiptLedgerPosted } from "../services/receiptAccountingRules.js";
import { dmsAvailableStockMap } from "../services/dmsAvailableStockService.js";
import { createOtp, verifyOtp, getActiveCustomerOrderOtp } from "../services/otpService.js";
import {
  getMaxActiveGradeDiscount,
  gradeBasicFromMrp,
  historicalAverageRates,
  mrpBasicExcludingGst,
  priceFromOldDmsLogic,
  purchaseRateOf,
  round2,
} from "../services/oldDmsPricingService.js";
import { readFile } from "../services/storageService.js";
import { sendBusinessEmail } from "../services/mailService.js";

const router = express.Router();
const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const lower = (v) => clean(v).toLowerCase();
const digits = (v) => clean(v).replace(/\D/g, "");
const num = (v) => Number(v || 0) || 0;
const money = (v) => Number(num(v).toFixed(2));
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function currentFinancialYear(date = new Date()) {
  const d = new Date(date);
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
function companyFinancialYear(_company, _requested = "") {
  // CUSTOMER APP RULE: the customer can never browse or post into an old FY.
  // Always resolve from today's date (Apr-Mar) and ignore company/requested FY.
  return currentFinancialYear();
}
function customerToken(account, globalCustomer) {
  return jwt.sign(
    {
      sub: String(account._id),
      role: "CUSTOMER_PORTAL",
      globalCustomerId: globalCustomer.hiddenId,
      name: globalCustomer.tradeName || globalCustomer.legalName,
      email: account.email || "",
      mobile: account.mobile || "",
      gstin: globalCustomer.gstins?.[0]?.value || "",
      tokenVersion: 1,
    },
    env.jwtSecret,
    { expiresIn: "30d" },
  );
}

function emailVerificationToken({ supplierId, email, otpId }) {
  return jwt.sign(
    { role: "CUSTOMER_EMAIL_VERIFIED", supplierId: String(supplierId), email: lower(email), otpId: String(otpId) },
    env.jwtSecret,
    { expiresIn: "20m" },
  );
}
function verifyEmailVerificationToken(token, { supplierId, email }) {
  try {
    const claims = jwt.verify(clean(token), env.jwtSecret);
    return claims.role === "CUSTOMER_EMAIL_VERIFIED"
      && String(claims.supplierId) === String(supplierId)
      && lower(claims.email) === lower(email);
  } catch {
    return false;
  }
}
function passwordSetupToken(account, globalCustomer) {
  return jwt.sign(
    {
      role: "CUSTOMER_PASSWORD_SETUP",
      sub: String(account._id),
      globalCustomerId: globalCustomer.hiddenId,
      version: Number(account.passwordResetVersion || 0),
    },
    env.jwtSecret,
    { expiresIn: "60m" },
  );
}
async function requireCustomerAuth(req, res, next) {
  const header = clean(req.headers.authorization);
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return fail(res, "Customer authentication required", 401);
  try {
    const claims = jwt.verify(token, env.jwtSecret);
    if (claims.role !== "CUSTOMER_PORTAL" || !claims.globalCustomerId) return fail(res, "Invalid customer session", 401);
    const account = await CustomerPortalAccount.findOne({ _id: claims.sub, globalCustomerId: claims.globalCustomerId, status: "ACTIVE" }).lean();
    if (!account) return fail(res, "Customer session is no longer active", 401);
    req.customerAuth = { ...claims, account };
    return next();
  } catch {
    return fail(res, "Invalid or expired customer session", 401);
  }
}
async function supplierContext(req, res, { activeOnly = false } = {}) {
  const supplierId = clean(req.headers["x-customer-supplier-id"] || req.query.supplierId || req.body?.supplierId);
  if (!supplierId) {
    fail(res, "Select a supplier / Superadmin company first", 400);
    return null;
  }
  const company = await CompanyProfile.findOne({ _id: supplierId, status: "ACTIVE" }).lean();
  if (!company) {
    fail(res, "Selected supplier is not available", 404);
    return null;
  }
  const link = await CustomerLink.findOne({ tenantKey: company.tenantKey, globalCustomerId: req.customerAuth.globalCustomerId }).lean();
  if (!link) {
    fail(res, "You are not registered with this supplier", 403);
    return null;
  }
  if (activeOnly && link.status !== "ACTIVE") {
    fail(res, "This supplier registration is still awaiting activation. Ordering and full account features become available after approval; the product catalogue and current prices remain viewable.", 403, { registrationStatus: link.status });
    return null;
  }
  return { supplierId, company, link, tenantKey: company.tenantKey };
}
async function collectorsFor(link, tenantKey) {
  if (!link?.globalCustomerId || !tenantKey || link.status !== "ACTIVE") return [];
  const rows = await User.find({
    tenantKey, role: { $in: ["COLLECTION_EXECUTIVE", "COLLECTOR"] }, status: "ACTIVE", loginEnabled: true,
    ...collectorForCustomerFilter(link),
  }).select("_id name mobile").sort({ name: 1 }).lean();
  return rows.map((u) => ({ id: String(u._id), name: u.name || "Collection Executive", mobile: u.mobile || "" }));
}
async function salespersonFor(link, tenantKey) {
  const id = clean(link?.salespersonId);
  if (!id) return null;
  const user = await User.findOne({ _id: id, tenantKey, status: "ACTIVE" }).select("_id name mobile email").lean();
  return user ? { id: String(user._id), name: user.name, mobile: user.mobile || "", email: user.email || "" } : null;
}
function safeCompany(company = {}) {
  return {
    supplierId: String(company._id || ""),
    companyName: company.companyName || "",
    tradeName: company.tradeName || "",
    gstin: company.gstin || "",
    registeredAddress: company.registeredAddress || "",
    pincode: company.pincode || "",
    area: company.area || "",
    city: company.city || "",
    district: company.district || "",
    state: company.state || "",
    mobile: company.mobile || "",
    email: company.email || "",
  };
}
async function membershipsFor(globalCustomerId, { includeInactiveRequests = false } = {}) {
  const statusFilter = includeInactiveRequests
    ? { $nin: ["DEACTIVATED"] }
    : { $nin: ["REJECTED", "DEACTIVATED"] };
  const links = await CustomerLink.find({ globalCustomerId, status: statusFilter })
    .sort({ status: 1, createdAt: 1 })
    .lean();
  const tenantKeys = [...new Set(links.map((x) => x.tenantKey).filter(Boolean))];
  const companies = await CompanyProfile.find({ tenantKey: { $in: tenantKeys }, status: "ACTIVE" }).lean();
  const cm = new Map(companies.map((c) => [c.tenantKey, c]));
  const userIds = links.map((x) => x.salespersonId).filter(Boolean);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds }, status: "ACTIVE" }).select("_id name mobile email tenantKey").lean()
    : [];
  const um = new Map(users.map((u) => [`${u.tenantKey}:${u._id}`, u]));

  // Customer Grades is the live source of truth. Do not trust an old cached
  // CustomerLink.gradeDiscountPct when a Superadmin later changes the grade.
  const gradeCodes = [...new Set(links.map((x) => upper(x.gradeCode)).filter(Boolean))];
  const grades = tenantKeys.length && gradeCodes.length
    ? await CustomerGrade.find({ tenantKey: { $in: tenantKeys }, code: { $in: gradeCodes }, status: "ACTIVE" })
      .select("tenantKey code name discountPct")
      .lean()
    : [];
  const gm = new Map(grades.map((g) => [`${g.tenantKey}:${upper(g.code)}`, g]));

  return links.map((link) => {
    const company = cm.get(link.tenantKey);
    if (!company) return null;
    const sales = um.get(`${link.tenantKey}:${link.salespersonId}`);
    const liveGrade = link.gradeCode ? gm.get(`${link.tenantKey}:${upper(link.gradeCode)}`) : null;
    return {
      ...safeCompany(company),
      membershipStatus: link.status,
      active: link.status === "ACTIVE",
      registrationSource: link.registrationSource || "DMS",
      registeredAt: link.registrationRequestedAt || link.createdAt,
      customerName: link.localName || "",
      displayIdentifier: link.displayIdentifier || "",
      paymentType: link.status === "ACTIVE" ? link.paymentType : undefined,
      creditDays: link.status === "ACTIVE" ? num(link.creditDays) : undefined,
      creditLimit: link.status === "ACTIVE" ? money(link.creditLimit) : undefined,
      gradeCode: link.status === "ACTIVE" ? link.gradeCode || "" : undefined,
      gradeName: link.status === "ACTIVE" ? liveGrade?.name || "" : undefined,
      gradeDiscountPct: link.status === "ACTIVE" ? num(liveGrade?.discountPct) : undefined,
      salesperson: sales ? { id: String(sales._id), name: sales.name, mobile: sales.mobile || "", email: sales.email || "" } : null,
    };
  }).filter(Boolean);
}

async function globalByGstin(gstin) {
  return GlobalCustomer.findOne({ "gstins.value": upper(gstin) });
}
async function ensureCustomerLinkFromSignup({ global, company, taxpayer, pincode, mobile, email, supplierId, appVersion, deviceLabel }) {
  let link = await CustomerLink.findOne({ tenantKey: company.tenantKey, globalCustomerId: global.hiddenId });
  if (link) {
    if (!link.registrationRequestedAt) link.registrationRequestedAt = new Date();
    if (!link.registrationSource || link.registrationSource === "DMS") {
      // Preserve DMS as source for a relationship created by the Superadmin.
    } else link.registrationSource = "SELF_APP";
    link.customerAppLastSeenAt = new Date();
    link.verification = { ...(link.verification?.toObject?.() || link.verification || {}), email: true, appLinked: true };
    link.registrationMeta = {
      ...(link.registrationMeta?.toObject?.() || link.registrationMeta || {}),
      supplierId, pincode: digits(pincode).slice(0, 6), mobile, email, emailVerified: true,
      termsAcceptedAt: link.registrationMeta?.termsAcceptedAt || new Date(),
      gstAutoFetched: Boolean(taxpayer), appVersion: clean(appVersion), deviceLabel: clean(deviceLabel),
    };
    await link.save();
    return { link, existed: true };
  }
  const pin = digits(pincode).slice(0, 6);
  const pinRows = pin ? await Pincode.find({ pincode: pin, status: "ACTIVE" }).limit(1).lean() : [];
  const pinRow = pinRows[0] || {};
  let salespersonId = "";
  if (pin) {
    try {
      const assignment = await resolveCustomerSalesperson({ tenantKey: company.tenantKey, pincode: pin, requireAssignment: false });
      salespersonId = clean(assignment?.salespersonId);
    } catch {}
  }
  const legalName = taxpayer?.legalName || global.legalName || taxpayer?.tradeName || "Customer";
  const address = taxpayer?.principalAddress || global.registeredAddress || "";
  link = await CustomerLink.create({
    tenantKey: company.tenantKey,
    globalCustomerId: global.hiddenId,
    displayIdentifier: taxpayer?.gstin || global.gstins?.[0]?.value || global.hiddenId,
    localName: taxpayer?.tradeName || legalName,
    customerType: "BUSINESS",
    registrationType: taxpayer?.taxpayerType || "GST REGISTERED",
    businessType: taxpayer?.businessType || "",
    firmType: taxpayer?.constitution || "",
    gstStatus: taxpayer?.status || "",
    gstRange: taxpayer?.jurisdictionCentre || "",
    eInvoiceStatus: taxpayer?.eInvoiceStatus || "",
    filingFrequency: taxpayer?.filingFrequency || "",
    salespersonId,
    contacts: [{ name: legalName, designation: "PRIMARY", mobile, email, primary: true, active: true }],
    addresses: [{
      type: "BILLING", address, pincode: pin, area: pinRow.area || "", city: pinRow.city || "",
      district: pinRow.district || "", state: pinRow.state || taxpayer?.principalAddressRaw?.stcd || "", verified: Boolean(taxpayer),
    }],
    companyContactNumber: mobile,
    paymentType: "CASH", creditDays: 0, creditLimit: 0, graceDays: 0,
    status: "PENDING_APPROVAL",
    verification: { identity: Boolean(taxpayer), mobile: false, email: true, gps: false, kyc: false, appLinked: true },
    approval: { status: "PENDING", submittedBy: global.hiddenId, submittedAt: new Date(), remarks: "Customer self-registration from Customer App" },
    approvalHistory: [{ action: "SELF_APP_REGISTERED", by: global.hiddenId, at: new Date(), remarks: "Customer requested supplier registration from Customer App" }],
    registrationSource: "SELF_APP",
    registrationRequestedAt: new Date(),
    registrationMeta: { supplierId, pincode: pin, mobile, email, emailVerified: true, termsAcceptedAt: new Date(), gstAutoFetched: Boolean(taxpayer), appVersion: clean(appVersion), deviceLabel: clean(deviceLabel) },
    customerAppLastSeenAt: new Date(),
  });
  if (!global.linkedTenants.some((x) => x.tenantKey === company.tenantKey)) {
    global.linkedTenants.push({ tenantKey: company.tenantKey, linkedAt: new Date() });
    await global.save();
  }
  return { link, existed: false };
}

// ---------------- PUBLIC ONBOARDING ----------------
router.get("/health", (_req, res) => ok(res, { module: "customer-app", build: "2026-10-09-v3-registration-products-current-fy" }));

router.get("/suppliers", async (req, res) => {
  try {
    const q = clean(req.query.q);
    const pincode = digits(req.query.pincode).slice(0, 6);
    const city = clean(req.query.city);
    const district = clean(req.query.district);
    const filter = { status: "ACTIVE" };
    const clauses = [];
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      clauses.push({ $or: [{ companyName: rx }, { tradeName: rx }, { city: rx }, { district: rx }, { state: rx }, { gstin: rx }] });
    }
    if (pincode) clauses.push({ pincode });
    if (city) clauses.push({ city: new RegExp(`^${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (district) clauses.push({ district: new RegExp(`^${district.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (clauses.length) filter.$and = clauses;
    let rows = await CompanyProfile.find(filter).sort({ companyName: 1 }).limit(80).lean();
    // If an exact pincode returns nothing, broaden to its city/district automatically.
    if (!rows.length && pincode) {
      const pin = await Pincode.findOne({ pincode, status: "ACTIVE" }).lean();
      if (pin) rows = await CompanyProfile.find({ status: "ACTIVE", $or: [{ district: new RegExp(`^${pin.district}$`, "i") }, { city: new RegExp(`^${pin.city}$`, "i") }] }).sort({ district: 1, companyName: 1 }).limit(80).lean();
    }
    return ok(res, { items: rows.map(safeCompany) });
  } catch (error) { return fail(res, error.message, 500); }
});

router.get("/pincode/:pincode", async (req, res) => {
  const pin = digits(req.params.pincode).slice(0, 6);
  if (pin.length !== 6) return fail(res, "Enter a valid 6-digit pincode", 400);
  const rows = await Pincode.find({ pincode: pin, status: "ACTIVE" }).sort({ area: 1 }).limit(30).lean();
  return ok(res, { items: rows });
});

router.post("/gst-search", async (req, res) => {
  try {
    const gstin = upper(req.body.gstin);
    if (!GSTIN_RE.test(gstin)) return fail(res, "Enter a valid 15-character GSTIN", 400);
    const taxpayer = await searchTaxpayer(gstin);
    return ok(res, taxpayer);
  } catch (error) { return fail(res, error.message, error.status || error.statusCode || 500, error.details); }
});

router.post("/registration/email-otp/request", async (req, res) => {
  try {
    const supplierId = clean(req.body.supplierId);
    const email = lower(req.body.email);
    if (!supplierId) return fail(res, "Choose your supplier first", 400);
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail(res, "Enter a valid email address", 400);
    const company = await CompanyProfile.findOne({ _id: supplierId, status: "ACTIVE" }).lean();
    if (!company) return fail(res, "Selected supplier is not active", 404);
    const result = await createOtp({
      tenantKey: company.tenantKey,
      transactionId: makeId("EMAILVERIFY"),
      actionType: "CUSTOMER_EMAIL_VERIFY",
      recipientId: email,
      context: { supplierId, email },
    });
    await sendBusinessEmail({
      to: email,
      subject: `Verify your email for ${company.tradeName || company.companyName || "Rupio Customer"}`,
      text: `Your Rupio Customer email verification OTP is ${result.code}. It expires shortly. Do not share this OTP.`,
      html: `<div style="font-family:Inter,Arial,sans-serif;background:#f6f7fb;padding:28px;color:#17232a"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e9ec;border-radius:16px;padding:28px"><div style="font-size:12px;font-weight:800;letter-spacing:.08em;color:#18766f">RUPIO CUSTOMER</div><h2 style="margin:14px 0 6px">Verify your email</h2><p style="color:#62717b;line-height:1.6">You are registering with <strong>${company.tradeName || company.companyName || "your supplier"}</strong>.</p><div style="font-size:32px;font-weight:900;letter-spacing:8px;margin:22px 0;color:#132f2d">${result.code}</div><p style="color:#62717b;font-size:13px">Enter this OTP in the Customer App. Do not share it with anyone.</p></div></div>`,
    });
    return ok(res, { otpId: result.otpId, expiresAt: result.expiresAt, devCode: process.env.NODE_ENV === "production" ? undefined : result.code }, "Verification OTP sent to your email");
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.post("/registration/email-otp/verify", async (req, res) => {
  try {
    const supplierId = clean(req.body.supplierId);
    const email = lower(req.body.email);
    const result = await verifyOtp({ otpId: req.body.otpId, code: req.body.code });
    if (!result.ok) return fail(res, result.reason, 400);
    const challenge = result.challenge;
    if (upper(challenge.actionType) !== "CUSTOMER_EMAIL_VERIFY") return fail(res, "This OTP is not for email verification", 409);
    if (lower(challenge.recipientId) !== email) return fail(res, "OTP does not belong to this email address", 403);
    if (String(challenge.context?.supplierId || "") !== supplierId) return fail(res, "OTP does not belong to the selected supplier", 403);
    return ok(res, { verified: true, emailVerificationToken: emailVerificationToken({ supplierId, email, otpId: challenge.otpId }) }, "Email verified successfully");
  } catch (error) { return fail(res, error.message, 500); }
});

router.post("/signup", async (req, res) => {
  try {
    const gstin = upper(req.body.gstin);
    const supplierId = clean(req.body.supplierId);
    const mobile = digits(req.body.mobile).slice(-10);
    const email = lower(req.body.email);
    const emailToken = clean(req.body.emailVerificationToken);
    const termsAccepted = req.body.termsAccepted === true;
    if (!supplierId) return fail(res, "Choose your supplier first", 400);
    if (!GSTIN_RE.test(gstin)) return fail(res, "Enter a valid GSTIN", 400);
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail(res, "Enter a valid email address", 400);
    if (!verifyEmailVerificationToken(emailToken, { supplierId, email })) return fail(res, "Verify your email address before registration", 400);
    if (mobile.length !== 10) return fail(res, "Enter a valid 10-digit mobile number", 400);
    if (!termsAccepted) return fail(res, "Accept the Terms & Conditions to continue", 400);
    const company = await CompanyProfile.findOne({ _id: supplierId, status: "ACTIVE" });
    if (!company) return fail(res, "Selected supplier is not active", 404);

    let taxpayer = null;
    try { taxpayer = await searchTaxpayer(gstin); } catch (error) {
      if ([400, 404].includes(Number(error.status))) return fail(res, error.message, error.status);
      return fail(res, "GST details could not be verified right now. Please try again.", 503);
    }
    const pincode = digits(taxpayer?.principalAddressRaw?.pncd || taxpayer?.principalAddressRaw?.pincode || "").slice(0, 6);
    let global = await globalByGstin(gstin);
    if (!global) {
      global = await GlobalCustomer.create({
        hiddenId: makeId("GC"), legalName: taxpayer?.legalName || taxpayer?.tradeName || gstin,
        tradeName: taxpayer?.tradeName || "", registeredAddress: taxpayer?.principalAddress || "",
        customerType: "BUSINESS", pan: taxpayer?.pan || (gstin.length === 15 ? gstin.slice(2, 12) : ""),
        gstins: [{ value: gstin, state: taxpayer?.principalAddressRaw?.stcd || "", status: taxpayer?.status || "VERIFIED", verifiedAt: new Date() }],
        mobiles: [{ value: mobile, verified: false, primary: true }],
        emails: [{ value: email, verified: true, primary: true }],
        gstProfile: { taxpayerType: taxpayer?.taxpayerType || "", constitution: taxpayer?.constitution || "", registrationDate: taxpayer?.registrationDate || undefined, lastVerifiedAt: new Date(), filingStatus: taxpayer?.filingFrequency || "" },
        linkedTenants: [{ tenantKey: company.tenantKey, linkedAt: new Date() }],
      });
    } else {
      if (!global.mobiles.some((x) => digits(x.value).slice(-10) === mobile)) global.mobiles.push({ value: mobile, verified: false, primary: !global.mobiles.length });
      const existingEmail = global.emails.find((x) => lower(x.value) === email);
      if (existingEmail) { existingEmail.verified = true; existingEmail.active = true; }
      else global.emails.push({ value: email, verified: true, primary: !global.emails.length });
      if (taxpayer?.legalName) global.legalName = taxpayer.legalName;
      if (taxpayer?.tradeName) global.tradeName = taxpayer.tradeName;
      if (taxpayer?.principalAddress) global.registeredAddress = taxpayer.principalAddress;
      if (!global.linkedTenants.some((x) => x.tenantKey === company.tenantKey)) global.linkedTenants.push({ tenantKey: company.tenantKey, linkedAt: new Date() });
      await global.save();
    }

    let account = await CustomerPortalAccount.findOne({ globalCustomerId: global.hiddenId }).select("+passwordHash");
    if (account) {
      // Existing GST customer already has a portal identity. Registration of an
      // additional supplier must happen after login through + Add Superadmin.
      return fail(res, "This GST customer already has a Customer App account. Sign in and use + Add Superadmin.", 409);
    }
    const clash = await CustomerPortalAccount.findOne({ $or: [{ email }, { mobile }] }).lean();
    if (clash) return fail(res, "This email or mobile number is already linked to another Customer App account", 409);

    await ensureCustomerLinkFromSignup({ global, company, taxpayer, pincode, mobile, email, supplierId, appVersion: req.body.appVersion, deviceLabel: req.body.deviceLabel });
    account = await CustomerPortalAccount.create({
      globalCustomerId: global.hiddenId,
      email,
      mobile,
      // No user-chosen password is accepted on signup. A random unusable secret
      // is stored until the one-time email setup link is completed.
      passwordHash: await bcrypt.hash(`${makeId("PENDING")}::${Date.now()}::${Math.random()}`, 12),
      emailVerified: true,
      passwordResetVersion: 1,
      createdFrom: "SELF_REGISTRATION",
    });
    const setupToken = passwordSetupToken(account, global);
    const resetUrl = `rupio-customer://reset-password?token=${encodeURIComponent(setupToken)}`;
    try {
      await sendBusinessEmail({
        to: email,
        subject: "Set your Rupio Customer password",
        text: `Your registration with ${company.tradeName || company.companyName || "your supplier"} was submitted. Set your Customer App password using this link: ${resetUrl}\n\nThis link expires in 60 minutes and can be used once.`,
        html: `<div style="font-family:Inter,Arial,sans-serif;background:#f6f7fb;padding:28px;color:#17232a"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e9ec;border-radius:16px;padding:28px"><div style="font-size:12px;font-weight:800;letter-spacing:.08em;color:#18766f">RUPIO CUSTOMER</div><h2 style="margin:14px 0 6px">Create your password</h2><p style="color:#62717b;line-height:1.6">Your registration with <strong>${company.tradeName || company.companyName || "your supplier"}</strong> has been submitted.</p><a href="${resetUrl}" style="display:inline-block;margin:18px 0;background:#177b73;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:800">Set Password</a><p style="color:#62717b;font-size:13px;line-height:1.6">The link expires in 60 minutes and can be used once. After setting your password, sign in with your GSTIN and password.</p></div></div>`,
      });
    } catch (mailError) {
      await CustomerPortalAccount.deleteOne({ _id: account._id }).catch(() => {});
      throw mailError;
    }
    return ok(res, {
      registered: true,
      email,
      gstin,
      supplierId,
      passwordResetSent: true,
      devResetUrl: process.env.NODE_ENV === "production" ? undefined : resetUrl,
    }, "Registration submitted. A password setup link has been sent to your verified email.", 201);
  } catch (error) {
    if (error?.code === 11000) return fail(res, "Customer App account already exists for this GST/email/mobile", 409);
    return fail(res, error.message, error.status || error.statusCode || 500);
  }
});

router.post("/password/reset", async (req, res) => {
  try {
    const token = clean(req.body.token);
    const password = String(req.body.password || "");
    if (!token) return fail(res, "Password setup token is required", 400);
    if (password.length < 8) return fail(res, "Password must be at least 8 characters", 400);
    let claims;
    try { claims = jwt.verify(token, env.jwtSecret); } catch { return fail(res, "This password setup link is invalid or has expired", 400); }
    if (claims.role !== "CUSTOMER_PASSWORD_SETUP" || !claims.sub || !claims.globalCustomerId) return fail(res, "Invalid password setup link", 400);
    const account = await CustomerPortalAccount.findOne({ _id: claims.sub, globalCustomerId: claims.globalCustomerId, status: "ACTIVE" }).select("+passwordHash");
    if (!account) return fail(res, "Customer account is no longer available", 404);
    if (Number(account.passwordResetVersion || 0) !== Number(claims.version || 0)) return fail(res, "This password setup link has already been used", 400);
    account.passwordHash = await bcrypt.hash(password, 12);
    account.passwordConfiguredAt = new Date();
    account.passwordResetVersion = Number(account.passwordResetVersion || 0) + 1;
    await account.save();
    return ok(res, { reset: true }, "Password created successfully. You can now sign in.");
  } catch (error) { return fail(res, error.message, 500); }
});

router.post("/login", async (req, res) => {
  try {
    const gstin = upper(req.body.gstin);
    const password = String(req.body.password || "");
    if (!GSTIN_RE.test(gstin)) return fail(res, "Enter the customer GSTIN", 400);
    if (!password) return fail(res, "Password is required", 400);

    // GSTIN is the master identity. Every tenant-local CustomerLink underneath
    // this GlobalCustomer becomes accessible through one customer session.
    const global = await globalByGstin(gstin);
    if (!global) return fail(res, "No customer was found with this GSTIN", 401);

    const links = await CustomerLink.find({
      globalCustomerId: global.hiddenId,
      status: { $nin: ["DEACTIVATED"] },
    }).select("+portalPasswordHash");
    if (!links.length) return fail(res, "This GSTIN is not linked to any Superadmin customer account", 401);

    let account = await CustomerPortalAccount.findOne({ globalCustomerId: global.hiddenId }).select("+passwordHash");
    if (account && account.status !== "ACTIVE") return fail(res, "This Customer App account is not active", 403);
    const passwordHashes = [];
    if (account?.passwordHash) passwordHashes.push(account.passwordHash);
    for (const link of links) {
      if (link.portalLoginEnabled !== false && link.portalPasswordHash) passwordHashes.push(link.portalPasswordHash);
    }
    let matchedHash = "";
    for (const hash of passwordHashes) {
      try {
        if (await bcrypt.compare(password, hash)) { matchedHash = hash; break; }
      } catch {}
    }
    if (!matchedHash) return fail(res, "Invalid customer login details", 401);

    // DMS-created customers may have tenant-local passwords before they ever
    // create a Customer App account. Create the neutral session account on the
    // first successful GST-scoped login without duplicating the customer.
    if (!account) {
      account = await CustomerPortalAccount.create({
        globalCustomerId: global.hiddenId,
        passwordHash: matchedHash,
        createdFrom: "DMS_CUSTOMER_LINK",
      });
      account = await CustomerPortalAccount.findById(account._id).select("+passwordHash");
    }

    account.lastLoginAt = new Date();
    account.lastLoginIp = clean(req.ip).slice(0, 120);
    account.lastLoginUserAgent = clean(req.get("user-agent")).slice(0, 500);
    account.loginCount = num(account.loginCount) + 1;
    await account.save();
    const memberships = await membershipsFor(global.hiddenId);
    return ok(res, {
      token: customerToken(account, global),
      customer: {
        globalCustomerId: global.hiddenId,
        legalName: global.legalName,
        tradeName: global.tradeName,
        gstin,
        email: account.email || global.emails?.find((x) => x?.active !== false)?.value || "",
        mobile: account.mobile || global.mobiles?.find((x) => x?.active !== false)?.value || "",
      },
      memberships,
      // Intentionally blank: login always opens the all-Superadmins home first.
      selectedSupplierId: "",
    });
  } catch (error) { return fail(res, error.message, 500); }
});

// ---------------- AUTHENTICATED CUSTOMER APP ----------------
router.use(requireCustomerAuth);


// Customer-visible OTPs for salesperson-created receipts. The OTP is deliberately
// exposed only to the authenticated customer for the selected supplier/company.
router.get("/receipt-verification-otps", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true });
    if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const { Receipt } = financialModels(ctx.tenantKey, financialYear);
    const now = new Date();
    const items = await Receipt.find({
      tenantKey: ctx.tenantKey,
      financialYear,
      customerGlobalId: ctx.link.globalCustomerId,
      collectionSource: "SALESPERSON_APP",
      status: { $ne: "DELETED" },
      customerOtpStatus: "PENDING",
      receiptWorkflowStatus: "PENDING_CUSTOMER_OTP",
    }).select("+customerOtpCode").sort({ createdAt: -1 }).limit(20).lean();
    return ok(res, {
      financialYear,
      items: items.map((r) => ({
        id: String(r._id),
        receiptNo: r.receiptNo,
        date: r.date,
        amount: money(r.amount),
        mode: upper(r.mode),
        receiptType: upper(r.receiptType),
        allocationType: upper(r.allocationType),
        againstInvoices: r.againstInvoices || [],
        chequeNumber: r.chequeNumber || "",
        upiPaymentText: r.upiPaymentText || "",
        remarks: r.remarks || "",
        madeBy: r.collectedBySalespersonNameSnapshot || r.createdByNameSnapshot || "Sales Person",
        otp: r.customerOtpCode || "",
        expiresAt: r.customerOtpExpiresAt || null,
        expired: Boolean(r.customerOtpExpiresAt && new Date(r.customerOtpExpiresAt) < now),
      })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

// In-app acknowledgement messages created immediately after the customer
// confirms a salesperson receipt with OTP. These are deliberately separate
// from the OTP list: the OTP disappears after verification, while the message
// remains available to the customer as a confirmation record.
router.get("/receipt-messages", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true });
    if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const { OrderNotification } = financialModels(ctx.tenantKey, financialYear);
    const items = await OrderNotification.find({
      tenantKey: ctx.tenantKey,
      financialYear,
      recipientType: "CUSTOMER",
      recipientId: ctx.link.globalCustomerId,
      "data.notificationType": { $in: ["RECEIPT_CUSTOMER_CONFIRMATION", "CASH_COLLECTION_ISSUE"] },
      status: { $ne: "FAILED" },
    }).sort({ createdAt: -1 }).limit(20).lean();

    const pendingIds = items.filter((x) => x.status === "PENDING").map((x) => x._id);
    if (pendingIds.length) {
      await OrderNotification.updateMany({ _id: { $in: pendingIds } }, { $set: { status: "SENT", sentAt: new Date() } });
    }

    return ok(res, {
      financialYear,
      items: items.map((x) => ({
        id: String(x._id),
        title: x.title || "Receipt confirmation",
        body: x.body || "",
        notificationType: x.data?.notificationType || "RECEIPT_CUSTOMER_CONFIRMATION",
        receiptNo: x.data?.receiptNo || "",
        amount: money(x.data?.amount),
        mode: upper(x.data?.mode),
        receiptType: upper(x.data?.receiptType),
        salespersonName: x.data?.salespersonName || "",
        issueStatus: x.data?.status || "",
        reason: x.data?.reason || "",
        verifiedAt: x.data?.customerOtpVerifiedAt || x.createdAt,
        createdAt: x.createdAt,
      })),
    });
  } catch (error) { return fail(res, error.message, error.statusCode || 500); }
});

router.get("/me", async (req, res) => {
  const global = await GlobalCustomer.findOne({ hiddenId: req.customerAuth.globalCustomerId }).select("hiddenId legalName tradeName registeredAddress gstins pan mobiles emails").lean();
  return ok(res, { customer: global, memberships: await membershipsFor(req.customerAuth.globalCustomerId) });
});

router.get("/supplier-home-list", async (req, res) => {
  try {
    // Show every supplier linked to this GST customer except rejected/deactivated
    // relationships. Pending suppliers can be opened in catalogue-only mode.
    const memberships = await membershipsFor(req.customerAuth.globalCustomerId);
    const items = await Promise.all(memberships.map(async (membership) => {
      const company = await CompanyProfile.findById(membership.supplierId).lean();
      if (!company) return null;
      const link = await CustomerLink.findOne({ tenantKey: company.tenantKey, globalCustomerId: req.customerAuth.globalCustomerId }).lean();
      if (!link || ["REJECTED", "DEACTIVATED"].includes(upper(link.status))) return null;
      const financialYear = companyFinancialYear(company);
      if (link.status !== "ACTIVE") {
        return { ...membership, financialYear, ledgerBalance: null, ledgerBalanceSigned: null, ledgerBalanceType: "", catalogueOnly: true };
      }
      const ledger = await buildCustomerReceivableLedger({ tenantKey: company.tenantKey, financialYear, customer: link });
      const signedBalance = money(ledger.closingSigned);
      return {
        ...membership, financialYear, catalogueOnly: false,
        ledgerBalance: Math.abs(signedBalance), ledgerBalanceSigned: signedBalance,
        ledgerBalanceType: signedBalance < 0 ? "CR" : "DR",
      };
    }));
    return ok(res, { items: items.filter(Boolean), financialYear: currentFinancialYear() });
  } catch (error) { return fail(res, error.message, 500); }
});

router.get("/approval-list", async (req, res) => {
  try {
    const memberships = await membershipsFor(req.customerAuth.globalCustomerId, { includeInactiveRequests: true });
    const items = memberships
      .filter((x) => !x.active && (x.registrationSource === "SELF_APP" || x.registeredAt))
      .sort((a, b) => new Date(b.registeredAt || 0) - new Date(a.registeredAt || 0));
    return ok(res, { items });
  } catch (error) { return fail(res, error.message, 500); }
});

router.post("/memberships/request", async (req, res) => {
  try {
    const supplierId = clean(req.body.supplierId);
    const company = await CompanyProfile.findOne({ _id: supplierId, status: "ACTIVE" });
    if (!company) return fail(res, "Selected supplier is not active", 404);
    let link = await CustomerLink.findOne({ tenantKey: company.tenantKey, globalCustomerId: req.customerAuth.globalCustomerId });
    if (link) {
      if (["REJECTED", "DEACTIVATED", "INACTIVE"].includes(upper(link.status))) {
        link.status = "PENDING_APPROVAL";
        link.registrationSource = "SELF_APP";
        link.registrationRequestedAt = new Date();
        link.customerAppLastSeenAt = new Date();
        link.approval = { ...(link.approval?.toObject?.() || link.approval || {}), status: "PENDING", submittedBy: req.customerAuth.globalCustomerId, submittedAt: new Date(), remarks: "Customer re-requested supplier registration from Customer App" };
        link.approvalHistory = [...(link.approvalHistory || []), { action: "SELF_APP_REREQUESTED", by: req.customerAuth.globalCustomerId, at: new Date(), remarks: "Customer re-requested supplier registration from Customer App" }];
        await link.save();
        return ok(res, { membershipStatus: link.status, memberships: await membershipsFor(req.customerAuth.globalCustomerId) }, "Supplier registration request submitted again", 201);
      }
      return ok(res, { membershipStatus: link.status, memberships: await membershipsFor(req.customerAuth.globalCustomerId) }, "Supplier is already linked to your customer identity");
    }
    const global = await GlobalCustomer.findOne({ hiddenId: req.customerAuth.globalCustomerId });
    const account = req.customerAuth.account;
    const gstin = global?.gstins?.[0]?.value || "";
    let taxpayer = null; try { if (gstin) taxpayer = await searchTaxpayer(gstin); } catch {}
    const pincode = digits(req.body.pincode || "").slice(0, 6);
    const created = await ensureCustomerLinkFromSignup({ global, company, taxpayer, pincode, mobile: account.mobile || global?.mobiles?.[0]?.value || "", email: account.email || global?.emails?.[0]?.value || "", supplierId, appVersion: req.body.appVersion, deviceLabel: req.body.deviceLabel });
    link = created.link;
    return ok(res, { membershipStatus: link.status, memberships: await membershipsFor(req.customerAuth.globalCustomerId) }, "Supplier registration request submitted", 201);
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.get("/home", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: false }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const [sales, collectors] = await Promise.all([
      salespersonFor(ctx.link, ctx.tenantKey), collectorsFor(ctx.link, ctx.tenantKey),
    ]);
    const base = { supplier: safeCompany(ctx.company), membership: { status: ctx.link.status, active: ctx.link.status === "ACTIVE", registrationSource: ctx.link.registrationSource, registeredAt: ctx.link.registrationRequestedAt || ctx.link.createdAt }, salesperson: sales, collectors, financialYear };
    if (ctx.link.status !== "ACTIVE") {
      const productCount = await Product.countDocuments({ tenantKey: ctx.tenantKey, status: "ACTIVE" });
      return ok(res, { ...base, locked: true, productCount, message: "Registration is awaiting Superadmin activation. Product catalogue and current prices are visible; ordering and financial features unlock after approval." });
    }
    const { SalesOrder, SalesInvoice, Receipt } = financialModels(ctx.tenantKey, financialYear);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
    const baseFilter = { tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId };
    const orderFilter = { ...baseFilter, date: { $gte: monthStart, $lt: monthEnd }, status: { $nin: ["CANCELLED", "REJECTED", "DELETED", "COMPLETED"] }, workflowStatus: { $nin: ["CANCELLED", "REJECTED", "DELIVERED", "COMPLETED"] } };
    const invoiceFilter = { ...baseFilter, date: { $gte: monthStart, $lt: monthEnd }, status: "POSTED", invoiceType: { $ne: "PERFORMA" } };
    const [ordersAgg, invoicesAgg, recentOrders, recentInvoices, receiptAgg, ledger, promoCount] = await Promise.all([
      SalesOrder.aggregate([{ $match: orderFilter }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$grandTotal" } } }]),
      SalesInvoice.aggregate([{ $match: invoiceFilter }, { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$grandTotal" } } }]),
      SalesOrder.find(orderFilter).sort({ date: -1 }).limit(3).lean(),
      SalesInvoice.find(invoiceFilter).sort({ date: -1 }).limit(3).select("invoiceNo date grandTotal workflowStatus delivery status").lean(),
      Receipt.aggregate([{ $match: { ...baseFilter, status: "POSTED", $or: [
        { collectionSource: { $ne: "SALESPERSON_APP" } }, { ledgerPostedAt: { $exists: true } },
      ] } }, { $group: { _id: null, amount: { $sum: "$amount" } } }]),
      buildCustomerReceivableLedger({ tenantKey: ctx.tenantKey, financialYear, customer: ctx.link }),
      activePromotionFilter(ctx).then((filter) => CustomerPromotion.countDocuments(filter)),
    ]);
    const outstanding = money(ledger.closingSigned);
    const creditLimit = money(ctx.link.creditLimit || ctx.link.approvedTerms?.creditLimit);
    return ok(res, { ...base, locked: false, summary: {
      orderCount: ordersAgg[0]?.count || 0, orderTotal: money(ordersAgg[0]?.amount),
      invoiceCount: invoicesAgg[0]?.count || 0, invoiceTotal: money(invoicesAgg[0]?.amount),
      period: "CURRENT_MONTH", receipts: money(receiptAgg[0]?.amount), outstanding,
      creditLimit, availableCredit: money(creditLimit - outstanding),
      promotionCount: promoCount,
    }, recentOrders, recentInvoices });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

async function activePromotionFilter(ctx) {
  const now = new Date();
  const audience = [{ audience: "ALL" }, { audience: "CUSTOMERS", customerGlobalIds: ctx.link.globalCustomerId }];
  if (ctx.link.gradeCode) audience.push({ audience: "GRADE", gradeCodes: upper(ctx.link.gradeCode) });
  return { tenantKey: ctx.tenantKey, status: "ACTIVE", $and: [{ $or: [{ startAt: { $exists: false } }, { startAt: null }, { startAt: { $lte: now } }] }, { $or: [{ endAt: { $exists: false } }, { endAt: null }, { endAt: { $gte: now } }] }, { $or: audience }] };
}
async function liveGradeFor(ctx) {
  const code = upper(ctx.link.gradeCode);
  if (!code) return { code: "", name: "", discountPct: 0 };
  const grade = await CustomerGrade.findOne({ tenantKey: ctx.tenantKey, code, status: "ACTIVE" })
    .select("code name discountPct")
    .lean();
  return grade ? { code: grade.code, name: grade.name || "", discountPct: num(grade.discountPct) } : { code, name: "", discountPct: 0 };
}

async function priceRowsFor(ctx, products, financialYear = "") {
  const grade = await liveGradeFor(ctx);
  const fy = financialYear || companyFinancialYear(ctx.company);
  const productIds = products.map((p) => String(p._id));

  // IMPORTANT: Customer App pricing deliberately mirrors the CURRENT DMS
  // /catalog/old-dms-price-list/products + Create Sales Invoice logic.
  // Do not trust a stale Product.mrp because the Price List is now calculated
  // dynamically from the selected FY's market sale/purchase history.
  const [maxDiscount, history, stockByProduct] = await Promise.all([
    getMaxActiveGradeDiscount(ctx.tenantKey),
    historicalAverageRates({ tenantKey: ctx.tenantKey, financialYear: fy, productIds })
      .catch(() => ({ sales: new Map(), purchases: new Map() })),
    dmsAvailableStockMap({ tenantKey: ctx.tenantKey, financialYear: fy }),
  ]);

  return products.map((p) => {
    const id = String(p._id);
    const saleHistory = history.sales.get(id);
    const purchaseHistory = history.purchases.get(id);
    const marketSalePrice = Number(saleHistory?.averageRate || 0);
    const averagePurchaseRate = Number(purchaseHistory?.averageRate || 0);
    const fallbackPurchase = purchaseRateOf(p);
    const purchaseRate = averagePurchaseRate > 0 ? averagePurchaseRate : fallbackPurchase;
    const landedPrice = Number(p.landedCost || 0) > 0 ? Number(p.landedCost) : Number(purchaseRate || 0);
    const rawMarketProfitPct = landedPrice > 0 && marketSalePrice > 0
      ? ((marketSalePrice - landedPrice) / landedPrice) * 100
      : 3;
    const exactProfitPercentage = Math.max(3, rawMarketProfitPct);
    const minimumSalePrice = landedPrice > 0
      ? round2(landedPrice * (1 + exactProfitPercentage / 100))
      : 0;
    const priced = priceFromOldDmsLogic(
      { ...p, salePrice: minimumSalePrice, profitPercentage: exactProfitPercentage },
      maxDiscount,
      {
        costOverride: landedPrice,
        saleRateOverride: minimumSalePrice,
        profitOverride: exactProfitPercentage,
      },
    );

    const gstRate = num(priced.gstRate);
    const mrp = money(priced.mrp);
    const mrpBasic = mrp > 0 ? mrpBasicExcludingGst(mrp, gstRate) : money(minimumSalePrice || p.salePrice);
    const effectiveRate = mrp > 0
      ? gradeBasicFromMrp(mrp, gstRate, grade.discountPct)
      : money(mrpBasic * (1 - Math.min(100, Math.max(0, grade.discountPct)) / 100));

    return {
      productId: id, sku: p.sku, name: p.name,
      category: p.category || "", subCategory: p.subCategory || "",
      hsnCode: p.hsnCode || "", gstRate,
      unit: p.basicUnit || "PCS", packingUnit: p.packingUnit || "",
      qtyInBag: num(p.qtyInBag || 1),
      availableStock: stockByProduct.get(id) ?? 0,
      mrp, basicRate: money(mrpBasic), discountPct: money(grade.discountPct),
      landedPrice: money(landedPrice), marketSalePrice: money(marketSalePrice), minimumSalePrice: money(minimumSalePrice),
      maxGradeDiscountPct: money(maxDiscount),
      gradeCode: grade.code, gradeName: grade.name,
      // Customer rate = grade-adjusted BASIC (ex GST), exactly as Create Invoice.
      rate: effectiveRate,
      saleIncludingGst: money(effectiveRate * (1 + gstRate / 100)),
      pricingFinancialYear: fy,
      imageFileIds: p.imageFileIds || [],
    };
  });
}

async function keepOnlyImageFiles(tenantKey, products) {
  const ids = [...new Set(products.flatMap((p) => p.imageFileIds || []).map(clean).filter(Boolean))];
  if (!ids.length) return products.map((p) => ({ ...p, imageFileIds: [] }));
  const files = await FileMeta.find({ tenantKey, fileId: { $in: ids }, mimeType: { $in: ["image/jpeg", "image/png", "image/webp", "image/avif"] } })
    .select("fileId originalName mimeType")
    .lean();
  const allowed = new Map(files.map((f) => [String(f.fileId), f]));
  return products.map((p) => ({
    ...p,
    imageFileIds: (p.imageFileIds || []).map(clean).filter((id) => allowed.has(id)),
    images: (p.imageFileIds || []).map(clean).filter((id) => allowed.has(id)).map((id) => ({
      fileId: id,
      originalName: allowed.get(id)?.originalName || "Product image",
      mimeType: allowed.get(id)?.mimeType || "image/jpeg",
      url: `/product-images/${encodeURIComponent(id)}`,
    })),
  }));
}

router.get("/products", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: false }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const page = Math.max(1, Number(req.query.page || 1)); const limit = Math.min(100, Math.max(10, Number(req.query.limit || 30))); const q = clean(req.query.q); const category = clean(req.query.category);
    const filter = { tenantKey: ctx.tenantKey, status: "ACTIVE" };
    if (q) { const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); filter.$or = [{ name: rx }, { sku: rx }, { category: rx }, { subCategory: rx }, { hsnCode: rx }]; }
    if (category) filter.category = category;
    const [rows, total, categories] = await Promise.all([
      Product.find(filter).select("sku name category subCategory hsnCode gstRate basicUnit packingUnit qtyInBag currentStock reservedStock mrp salePrice landedCost averagePurchasePrice lastPurchasePrice openingRate minimumProfitPct profitPercentage imageFileIds").sort({ category: 1, name: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Product.countDocuments(filter), Product.distinct("category", { tenantKey: ctx.tenantKey, status: "ACTIVE" }),
    ]);
    const pricedRaw = await priceRowsFor(ctx, rows, financialYear);
    const priced = await keepOnlyImageFiles(ctx.tenantKey, pricedRaw);
    return ok(res, { items: priced, categories: categories.filter(Boolean).sort(), priceVisible: true, canOrder: ctx.link.status === "ACTIVE", registrationStatus: ctx.link.status, financialYear, meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.get("/product-images/:fileId", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: false }); if (!ctx) return;
    const fileId = clean(req.params.fileId);
    if (!fileId) return fail(res, "Product image not found", 404);
    const product = await Product.findOne({ tenantKey: ctx.tenantKey, status: "ACTIVE", imageFileIds: fileId }).select("_id imageFileIds").lean();
    if (!product) return fail(res, "Product image not available for this supplier", 404);
    const fileMeta = await FileMeta.findOne({ tenantKey: ctx.tenantKey, fileId, mimeType: { $in: ["image/jpeg", "image/png", "image/webp", "image/avif"] } }).lean();
    if (!fileMeta) return fail(res, "Product image not found", 404);
    const result = await readFile(fileId);
    if (!result?.buffer) return fail(res, "Product image not found", 404);
    res.setHeader("Content-Type", result.meta?.mimeType || fileMeta.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.send(result.buffer);
  } catch (error) { return fail(res, error.message || "Unable to load product image", 500); }
});

router.post("/cart/reprice", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const productIds = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : []).map(clean).filter(Boolean))].slice(0, 250);
    if (!productIds.length) return ok(res, { items: [], financialYear });
    const docs = await Product.find({ tenantKey: ctx.tenantKey, _id: { $in: productIds }, status: "ACTIVE" }).lean();
    const items = await priceRowsFor(ctx, docs, financialYear);
    return ok(res, { items, financialYear });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

async function reserveCustomerOrderItems(tenantKey, items = []) {
  const reserved = [];
  try {
    for (const item of items) {
      const qty = Math.max(0, num(item.qty));
      if (!(qty > 0)) continue;
      const product = await Product.findOneAndUpdate(
        {
          _id: item.productId,
          tenantKey,
          status: "ACTIVE",
          $expr: {
            $gte: [
              { $subtract: [{ $ifNull: ["$currentStock", 0] }, { $ifNull: ["$reservedStock", 0] }] },
              qty,
            ],
          },
        },
        { $inc: { reservedStock: qty } },
        { new: true },
      );
      if (!product) {
        const snapshot = await Product.findOne({ _id: item.productId, tenantKey }).select("name currentStock reservedStock").lean();
        const available = Math.max(0, num(snapshot?.currentStock) - num(snapshot?.reservedStock));
        const error = new Error(`${snapshot?.name || item.nameSnapshot || item.sku || "Product"}: requested ${qty}, but only ${available} is available now. Refresh the cart and try again.`);
        error.status = 409;
        throw error;
      }
      item.reservedQty = qty;
      reserved.push({ productId: item.productId, qty });
    }
    return reserved;
  } catch (error) {
    for (const row of reserved) {
      await Product.updateOne({ _id: row.productId, tenantKey }, { $inc: { reservedStock: -row.qty } }).catch(() => {});
      await Product.updateOne({ _id: row.productId, tenantKey, reservedStock: { $lt: 0 } }, { $set: { reservedStock: 0 } }).catch(() => {});
    }
    throw error;
  }
}

async function releaseCustomerReservationRows(tenantKey, rows = []) {
  for (const row of rows) {
    await Product.updateOne({ _id: row.productId, tenantKey }, { $inc: { reservedStock: -Math.max(0, num(row.qty)) } }).catch(() => {});
    await Product.updateOne({ _id: row.productId, tenantKey, reservedStock: { $lt: 0 } }, { $set: { reservedStock: 0 } }).catch(() => {});
  }
}

router.post("/orders", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!rawItems.length) return fail(res, "Add at least one product", 400);
    const productIds = [...new Set(rawItems.map((x) => clean(x.productId)).filter(Boolean))];
    const docs = await Product.find({ tenantKey: ctx.tenantKey, _id: { $in: productIds }, status: "ACTIVE" }).lean();
    const priced = await priceRowsFor(ctx, docs, financialYear); const pm = new Map(priced.map((x) => [x.productId, x]));
    const items = []; let subtotal = 0, discountTotal = 0, taxTotal = 0, grandTotal = 0;
    for (const row of rawItems) {
      const p = pm.get(clean(row.productId)); const qty = num(row.qty); if (!p || qty <= 0) continue;
      const gross = qty * p.basicRate; const discount = gross * p.discountPct / 100; const taxable = money(gross - discount); const tax = money(taxable * p.gstRate / 100); const lineTotal = money(taxable + tax);
      subtotal += gross; discountTotal += discount; taxTotal += tax; grandTotal += lineTotal;
      items.push({ productId: p.productId, sku: p.sku, nameSnapshot: p.name, hsnSnapshot: p.hsnCode, qty, unit: p.unit, packingUnit: p.packingUnit, qtyInBag: p.qtyInBag, listRate: p.basicRate, rate: p.rate, discountPct: p.discountPct, taxable, gstRateSnapshot: p.gstRate, tax, lineTotal });
    }
    if (!items.length) return fail(res, "Enter quantity for at least one valid product", 400);
    const { SalesOrder, LedgerEntry, OrderEvent, OrderNotification } = financialModels(ctx.tenantKey, financialYear);
    const [ledgerAgg, pendingAgg] = await Promise.all([
      LedgerEntry.aggregate([{ $match: { tenantKey: ctx.tenantKey, financialYear, partyGlobalId: ctx.link.globalCustomerId, status: "POSTED" } }, { $group: { _id: null, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } }]),
      SalesOrder.aggregate([{ $match: { tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, status: { $in: ["SUBMITTED", "CREDIT_HOLD", "APPROVED", "PROCESSING"] } } }, { $group: { _id: null, total: { $sum: "$grandTotal" } } }]),
    ]);
    const ledger = ledgerAgg[0] || {}; const opening = ctx.link.accountingProfile?.financialYear === financialYear ? (upper(ctx.link.accountingProfile?.openingBalanceType) === "CR" ? -num(ctx.link.accountingProfile?.openingBalance) : num(ctx.link.accountingProfile?.openingBalance)) : 0;
    const receivableBeforeOrder = money(opening + num(ledger.debit) - num(ledger.credit)); const pendingOrderExposure = money(pendingAgg[0]?.total); const creditLimit = money(ctx.link.creditLimit || ctx.link.approvedTerms?.creditLimit); const projectedExposure = money(Math.max(0, receivableBeforeOrder) + pendingOrderExposure + grandTotal); const exceededBy = creditLimit > 0 ? money(Math.max(0, projectedExposure - creditLimit)) : 0; const creditHold = creditLimit > 0 && exceededBy > 0;
    let orderNo = makeId("SO"); while (await SalesOrder.exists({ tenantKey: ctx.tenantKey, financialYear, orderNo })) orderNo = makeId("SO");

    // Reserve Available-to-Promise stock atomically BEFORE saving the order.
    // Two customers pressing Create Order at the same moment cannot both consume
    // the same last units: MongoDB only allows the reservation whose condition
    // currentStock - reservedStock >= requested quantity is still true.
    const reservedRows = await reserveCustomerOrderItems(ctx.tenantKey, items);
    let order;
    try {
      order = await SalesOrder.create({ tenantKey: ctx.tenantKey, financialYear, orderNo, date: new Date(), customerGlobalId: ctx.link.globalCustomerId, customerNameSnapshot: ctx.link.localName, salespersonId: clean(ctx.link.salespersonId), source: "MANUAL", orderChannel: "CUSTOMER", customerOtpRequired: false, workflowStatus: creditHold ? "CREDIT_HOLD" : "ORDER_PLACED", nextAction: creditHold ? "Credit approval required" : "Send to warehouse", lastWorkflowAt: new Date(), items, subtotal: money(subtotal), discountTotal: money(discountTotal), taxTotal: money(taxTotal), grandTotal: money(grandTotal), remarks: clean(req.body.remarks), status: creditHold ? "CREDIT_HOLD" : "SUBMITTED", reservation: { status: "RESERVED", reservedAt: new Date(), releasedAt: null, releasedReason: "" }, creditControl: { creditLimit, receivableBeforeOrder, pendingOrderExposure, availableBeforeOrder: creditLimit > 0 ? money(Math.max(0, creditLimit - Math.max(0, receivableBeforeOrder) - pendingOrderExposure)) : 0, orderAmount: money(grandTotal), projectedExposure, exceededBy, holdReason: creditHold ? `Credit limit exceeded by ₹${exceededBy.toLocaleString("en-IN")}` : "", checkedAt: new Date() }, createdBy: req.customerAuth.globalCustomerId, createdByNameSnapshot: ctx.link.localName });
    } catch (error) {
      await releaseCustomerReservationRows(ctx.tenantKey, reservedRows);
      throw error;
    }
    const eventNo = makeId("EVT");
    await OrderEvent.create({ tenantKey: ctx.tenantKey, financialYear, eventNo, orderId: String(order._id), orderNo, type: "ORDER_CREATED", fromStatus: "", toStatus: order.workflowStatus, note: "Order placed directly by customer from Customer App", meta: { orderChannel: "CUSTOMER", grandTotal: money(grandTotal), creditHold }, audience: ["DMS", "CUSTOMER", "SALESPERSON"], actorId: req.customerAuth.globalCustomerId, actorNameSnapshot: ctx.link.localName, actorRole: "CUSTOMER", occurredAt: new Date() });
    await OrderNotification.create({ tenantKey: ctx.tenantKey, financialYear, notificationNo: makeId("NTF"), orderId: String(order._id), orderNo, eventNo, recipientType: "CUSTOMER", recipientId: ctx.link.globalCustomerId, channel: "IN_APP", title: `Order ${orderNo} received`, body: creditHold ? "Order received and waiting for credit approval" : "Order received and waiting for verification", data: { workflowStatus: order.workflowStatus }, status: "PENDING" });
    return ok(res, order, creditHold ? "Order placed and sent for credit approval" : "Order placed successfully", 201);
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.get("/orders", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company); const page = Math.max(1, Number(req.query.page || 1)); const limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const { SalesOrder } = financialModels(ctx.tenantKey, financialYear); const filter = { tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId }; if (req.query.status) filter.status = upper(req.query.status);
    const [items, total] = await Promise.all([SalesOrder.find(filter).sort({ date: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), SalesOrder.countDocuments(filter)]);
    return ok(res, { items, financialYear, meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const financialYear = companyFinancialYear(ctx.company); const { SalesOrder, OrderEvent } = financialModels(ctx.tenantKey, financialYear);
    const order = await SalesOrder.findOne({ _id: req.params.id, tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId }).lean(); if (!order) return fail(res, "Order not found", 404);
    const events = await OrderEvent.find({ tenantKey: ctx.tenantKey, financialYear, orderId: String(order._id), audience: "CUSTOMER" }).sort({ occurredAt: 1 }).lean(); return ok(res, { order, events });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.post("/orders/:id/cancel", async (req,res)=>{
  try{
    const ctx=await supplierContext(req,res,{activeOnly:true});if(!ctx)return;
    const financialYear=companyFinancialYear(ctx.company);
    const {SalesOrder,OrderEvent}=financialModels(ctx.tenantKey,financialYear);
    const order=await SalesOrder.findOne({_id:req.params.id,tenantKey:ctx.tenantKey,financialYear,customerGlobalId:ctx.link.globalCustomerId});
    if(!order)return fail(res,"Order not found",404);
    if(["DELIVERED","HANDED_TO_TRANSPORTER","CLOSED","CANCELLED","REJECTED"].includes(upper(order.workflowStatus)))return fail(res,"This order cannot be cancelled",409);
    if(upper(order.workflowStatus)==="CANCELLATION_IN_PROCESS")return ok(res,order,"Cancellation already requested. Salesperson must contact you and record the reason.");
    const reason=clean(req.body.reason);
    if(!reason)return fail(res,"Please provide the cancellation reason",400);
    const previous=order.workflowStatus;
    order.cancellation={source:"CUSTOMER",status:"AWAITING_SALESPERSON",reason,requestedBy:ctx.link.globalCustomerId,requestedAt:new Date()};
    order.workflowStatus="CANCELLATION_IN_PROCESS";order.nextAction="Salesperson must contact customer and add remarks";order.lastWorkflowAt=new Date();
    await order.save();
    await OrderEvent.create({tenantKey:ctx.tenantKey,financialYear,eventNo:makeId("EVT"),orderId:String(order._id),orderNo:order.orderNo,type:"CANCELLATION_REQUESTED",fromStatus:previous,toStatus:"CANCELLATION_IN_PROCESS",note:reason,audience:["DMS","CUSTOMER","SALESPERSON"],actorId:ctx.link.globalCustomerId,actorRole:"CUSTOMER",occurredAt:new Date()});
    return ok(res,order,"Cancellation requested. Assigned salesperson must contact customer and record remarks.");
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});

router.get("/orders/:id/phase2-otp",async(req,res)=>{
  try{
    const ctx=await supplierContext(req,res,{activeOnly:true});if(!ctx)return;
    const financialYear=companyFinancialYear(ctx.company);
    const order=await financialModels(ctx.tenantKey,financialYear).SalesOrder.findOne({_id:req.params.id,tenantKey:ctx.tenantKey,financialYear,customerGlobalId:ctx.link.globalCustomerId}).lean();
    if(!order)return fail(res,"Order not found",404);
    const purpose=upper(req.query.purpose)==="CANCEL"?"CANCEL":"DELIVERY";
    const otpId=purpose==="CANCEL"?order.cancellation?.customerOtpId:order.handover?.customerOtpId;
    const actionType=purpose==="CANCEL"?"ORDER_CANCEL_CONFIRM":"DELIVERY_CUSTOMER_CONFIRM";
    return ok(res,await getActiveCustomerOrderOtp({tenantKey:ctx.tenantKey,transactionId:String(order._id),recipientId:ctx.link.globalCustomerId,otpId,actionType})||{otp:null});
  }catch(e){return fail(res,e.message,e.statusCode||500)}
});

// Only the authenticated customer can VIEW their own order OTP. Staff must
// ask the customer for the code and enter it in their own DMS/Salesperson app.
router.get("/orders/:id/customer-otp", async (req,res) => {
  try {
    const ctx = await supplierContext(req,res,{activeOnly:true}); if(!ctx)return;
    const financialYear=companyFinancialYear(ctx.company);
    const order=await financialModels(ctx.tenantKey,financialYear).SalesOrder.findOne({
      _id:req.params.id,tenantKey:ctx.tenantKey,financialYear,customerGlobalId:ctx.link.globalCustomerId
    }).select("_id customerOtpId customerOtpVerifiedAt").lean();
    if(!order)return fail(res,"Order not found",404);
    if(order.customerOtpVerifiedAt)return ok(res,{verified:true});
    return ok(res,await getActiveCustomerOrderOtp({tenantKey:ctx.tenantKey,transactionId:String(order._id),
      recipientId:ctx.link.globalCustomerId,otpId:order.customerOtpId}) || {otp:null},"Customer OTP status");
  }catch(error){return fail(res,error.message,error.status||error.statusCode||500)}
});

router.post("/orders/:id/customer-otp/request", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const { SalesOrder, OrderEvent } = financialModels(ctx.tenantKey, financialYear);
    const order = await SalesOrder.findOne({ _id: req.params.id, tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId });
    if (!order) return fail(res, "Order not found", 404);
    if (order.customerOtpVerifiedAt) return ok(res, { verified: true, order }, "Order OTP is already verified");
    if (!order.customerOtpRequired && upper(order.workflowStatus) !== "OTP_PENDING") return fail(res, "This order does not require customer OTP verification", 409);
    const account = req.customerAuth.account;
    const result = await createOtp({ tenantKey: ctx.tenantKey, transactionId: String(order._id), actionType: "ORDER_CUSTOMER_CONFIRM", recipientId: ctx.link.globalCustomerId, context: { orderNo: order.orderNo, supplierId: ctx.supplierId, mobile: account.mobile || "", email: account.email || "" } });
    const fromStatus = upper(order.workflowStatus || "OTP_PENDING");
    order.customerOtpRequired = true; order.customerOtpId = result.otpId; order.workflowStatus = "OTP_PENDING"; order.nextAction = "Customer OTP verification required"; order.lastWorkflowAt = new Date(); await order.save();
    await OrderEvent.create({ tenantKey: ctx.tenantKey, financialYear, eventNo: makeId("EVT"), orderId: String(order._id), orderNo: order.orderNo, type: "OTP_REQUESTED", fromStatus, toStatus: "OTP_PENDING", note: "Customer requested order verification OTP from Customer App", meta: {}, audience: ["DMS", "CUSTOMER", "SALESPERSON"], actorId: ctx.link.globalCustomerId, actorNameSnapshot: ctx.link.localName, actorRole: "CUSTOMER", occurredAt: new Date() });
    return ok(res, { otpId: result.otpId, expiresAt: result.expiresAt, otp:result.code }, "Show this OTP to your salesperson or Superadmin; do not enter it in this app");
  } catch (error) { return fail(res, error.message, error.status || error.statusCode || 500); }
});

// Customer-entered order OTP verification is forbidden. Verification must be
// carried out by the salesperson or Superadmin using the staff-authenticated API.
router.post("/orders/:id/customer-otp/verify", (_req,res) =>
  fail(res,"Give the OTP to your salesperson or Superadmin. Customers do not verify their own order OTP.",403));

router.get("/invoices", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const financialYear = companyFinancialYear(ctx.company); const page = Math.max(1, Number(req.query.page || 1)); const limit = Math.min(100, Math.max(10, Number(req.query.limit || 30))); const { SalesInvoice } = financialModels(ctx.tenantKey, financialYear);
    const filter = { tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, status: "POSTED" }; const [items, total] = await Promise.all([SalesInvoice.find(filter).sort({ date: -1 }).skip((page - 1) * limit).limit(limit).lean(), SalesInvoice.countDocuments(filter)]); return ok(res, { items, financialYear, meta: pageMeta(page, limit, total) });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

// Customer financial statement: same customer receivables source as the DMS ledger.
// Rows are always limited to the selected supplier's CURRENT financial year.
router.get("/financials", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const { SalesInvoice, Receipt } = financialModels(ctx.tenantKey, financialYear);
    const [invoices, receipts, ledger] = await Promise.all([
      SalesInvoice.find({ tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, status: "POSTED", invoiceType: { $ne: "PERFORMA" } }).sort({ date: 1 }).select("_id invoiceNo date grandTotal netInvoiceAmount creditNoteAmount workflowStatus").lean(),
      Receipt.find({ tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, status: { $nin: ["DELETED", "CANCELLED"] } }).sort({ date: -1, createdAt: -1 }).select("-customerOtpCode -cashierOtpCode").lean(),
      buildCustomerReceivableLedger({ tenantKey: ctx.tenantKey, financialYear, customer: ctx.link }),
    ]);
    const paidReceipts = receipts.filter(isReceiptLedgerPosted);
    let remainingReceipts = paidReceipts.reduce((sum, r) => sum + num(r.amount), 0);
    const invoiceStatus = invoices.map((inv) => {
      const net = num(inv.netInvoiceAmount || (num(inv.grandTotal) - num(inv.creditNoteAmount)));
      const paid = Math.min(net, Math.max(0, remainingReceipts)); remainingReceipts -= paid;
      const outstanding = money(Math.max(0, net - paid));
      return { ...inv, netAmount: money(net), paidAmount: money(paid), outstanding, paymentStatus: outstanding <= 0 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID" };
    }).reverse();
    const fyStartYear = Number(financialYear.slice(0, 4));
    const fyStartDate = `${fyStartYear}-04-01`, fyEndDate = `${fyStartYear + 1}-03-31`;
    const safeDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(clean(v)) ? clean(v) : "";
    const requestedFrom = safeDay(req.query.startDate), requestedTo = safeDay(req.query.endDate);
    const month = Number(req.query.month);
    let from = requestedFrom || fyStartDate, to = requestedTo || fyEndDate;
    if (!requestedFrom && !requestedTo && Number.isInteger(month) && month >= 1 && month <= 12) {
      const year = month >= 4 ? fyStartYear : fyStartYear + 1;
      from = `${year}-${String(month).padStart(2, "0")}-01`;
      to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    }
    if (from < fyStartDate || to > fyEndDate || from > to) return fail(res, "Selected dates must lie within the current financial year", 400);
    const dateKey = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";
    const before = ledger.rows.filter((r) => dateKey(r.date) < from);
    let running = money(ledger.openingSigned + before.reduce((sum, r) => sum + num(r.debit) - num(r.credit), 0));
    const opening = running;
    const rows = ledger.rows.filter((r) => dateKey(r.date) >= from && dateKey(r.date) <= to).map((r) => {
      running = money(running + num(r.debit) - num(r.credit));
      return { id: String(r._id), date: r.date, particular: r.narration || ctx.link.localName || "Party", voucherType: upper(r.transactionType).replaceAll("_", " "), voucherNo: r.transactionId || "", debit: money(r.debit), credit: money(r.credit), runningBalance: Math.abs(running), runningBalanceType: running < 0 ? "CR" : "DR" };
    });
    // An unverified collection must not be labelled PAID simply because its accounting entry exists.
    const paymentRows = receipts.map((r) => {
      const isSalesperson = upper(r.collectionSource) === "SALESPERSON_APP";
      const paymentStatus = isReceiptLedgerPosted(r) ? "PAID" : "UNPAID";
      return { ...r, paymentStatus, customerOtpStatus: r.customerOtpStatus || (isSalesperson ? "PENDING" : "NOT_REQUIRED"), cashierOtpStatus: r.cashierOtpStatus || (isSalesperson ? "PENDING" : "NOT_REQUIRED") };
    });
    return ok(res, { financialYear, filters: { startDate: from, endDate: to }, summary: {
      opening: money(opening), balance: money(running), closing: money(ledger.closingSigned),
      totalDebit: money(rows.reduce((sum, r) => sum + r.debit, 0)), totalCredit: money(rows.reduce((sum, r) => sum + r.credit, 0)),
    }, invoices: invoiceStatus, receipts: paymentRows, ledger: rows });
  } catch (error) { return fail(res, error.message, error.status || 500); }
});

router.get("/promotions", async (req, res) => {
  try { const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const filter = await activePromotionFilter(ctx); const items = await CustomerPromotion.find(filter).sort({ startAt: -1, createdAt: -1 }).lean(); return ok(res, { items }); } catch (error) { return fail(res, error.message, 500); }
});

router.get("/complaint-references", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const financialYear = companyFinancialYear(ctx.company);
    const { Receipt, SalesInvoice, SalesOrder } = financialModels(ctx.tenantKey, financialYear);
    const base = { tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId };
    const [payments, bills, orders] = await Promise.all([
      Receipt.find({ ...base, status: { $ne: "DELETED" } }).sort({ date: -1 }).limit(250).select("receiptNo date amount").lean(),
      SalesInvoice.find({ ...base, status: "POSTED", invoiceType: { $ne: "PERFORMA" } }).sort({ date: -1 }).limit(250).select("invoiceNo date grandTotal").lean(),
      SalesOrder.find({ ...base, status: { $ne: "DELETED" } }).sort({ date: -1 }).limit(250).select("orderNo date grandTotal").lean(),
    ]);
    return ok(res, { payments: payments.map(r => ({ id: String(r._id), no: r.receiptNo, date: r.date, amount: r.amount })), bills: bills.map(r => ({ id: String(r._id), no: r.invoiceNo, date: r.date, amount: r.grandTotal })), orders: orders.map(r => ({ id: String(r._id), no: r.orderNo, date: r.date, amount: r.grandTotal })) });
  } catch (error) { return fail(res, error.message, 500); }
});

router.get("/complaints", async (req, res) => {
  try { const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const items = await CustomerSupportTicket.find({ tenantKey: ctx.tenantKey, globalCustomerId: ctx.link.globalCustomerId }).sort({ createdAt: -1 }).limit(200).lean(); return ok(res, { items }); } catch (error) { return fail(res, error.message, 500); }
});
router.post("/complaints", async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return;
    const type = upper(req.body.type || "GENERAL"), subject = clean(req.body.subject);
    if (!subject) return fail(res, "Complaint subject is required", 400);
    const referenceId = clean(req.body.referenceId);
    let referenceNo = "", referenceType = "";
    if (referenceId) {
      const names = { PAYMENT: ["Receipt", "receiptNo"], BILL: ["SalesInvoice", "invoiceNo"], ORDER: ["SalesOrder", "orderNo"] };
      if (!names[type]) return fail(res, "References are only available for payments, bills and orders", 400);
      const financialYear = companyFinancialYear(ctx.company);
      const models = financialModels(ctx.tenantKey, financialYear);
      const [modelName, field] = names[type];
      const record = /^[a-fA-F0-9]{24}$/.test(referenceId) ? await models[modelName].findOne({ _id: referenceId, tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId }).select(field).lean() : null;
      if (!record) return fail(res, "Selected reference does not belong to this customer", 403);
      referenceType = type; referenceNo = clean(record[field]);
    }
    const ticket = await CustomerSupportTicket.create({ ticketNo: makeId("CST"), tenantKey: ctx.tenantKey, globalCustomerId: ctx.link.globalCustomerId, type: ["PAYMENT", "BILL", "SCHEME", "ORDER", "GENERAL"].includes(type) ? type : "GENERAL", referenceType, referenceId, referenceNo, subject, description: clean(req.body.description), priority: "NORMAL" });
    return ok(res, ticket, "Complaint raised successfully", 201);
  } catch (error) { return fail(res, error.message, 500); }
});

const uploadDir = path.resolve(process.cwd(), "storage", "customer-app");
fs.mkdirSync(uploadDir, { recursive: true });
const claimUpload = multer({ storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadDir), filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 9)}${path.extname(file.originalname || "").slice(0, 10)}`) }), limits: { fileSize: 6 * 1024 * 1024, files: 5 }, fileFilter: (_req, file, cb) => cb(null, /^image\//i.test(file.mimetype || "")) });
router.get("/damage-claims", async (req, res) => { try { const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const items = await CustomerDamageClaim.find({ tenantKey: ctx.tenantKey, globalCustomerId: ctx.link.globalCustomerId }).sort({ createdAt: -1 }).limit(200).lean(); return ok(res, { items }); } catch (error) { return fail(res, error.message, 500); } });
router.post("/damage-claims", claimUpload.array("images", 5), async (req, res) => {
  try {
    const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const financialYear = companyFinancialYear(ctx.company); const { SalesInvoice } = financialModels(ctx.tenantKey, financialYear); const invoiceNo = clean(req.body.invoiceNo); if (!invoiceNo) return fail(res, "Invoice number is required", 400);
    const invoice = await SalesInvoice.findOne({ tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, invoiceNo, status: "POSTED" }).lean(); if (!invoice) return fail(res, "Invoice not found for this customer", 404);
    let requestedItems = []; try { requestedItems = JSON.parse(req.body.items || "[]"); } catch {} const invoiceLines = invoice.items || []; const items = requestedItems.map((x) => { const lineIndex = Number(x.lineIndex); const billed = Number.isInteger(lineIndex) && lineIndex >= 0 && lineIndex < invoiceLines.length ? invoiceLines[lineIndex] : invoiceLines.find(r => String(r.productId) === clean(x.productId)); if (!billed || String(billed.productId) !== clean(x.productId)) return null; const damagedQty = Math.max(0, num(x.damagedQty)); if (damagedQty <= 0 || damagedQty > num(billed.qty)) return null; return { productId: clean(x.productId), productName: billed.nameSnapshot, billedQty: num(billed.qty), damagedQty, reason: clean(x.reason) }; }).filter(Boolean); if (!items.length) return fail(res, "Add at least one valid damaged product quantity", 400);
    const images = (req.files || []).map((f) => ({ fileName: f.originalname, storedName: f.filename, mimeType: f.mimetype, size: f.size })); const claim = await CustomerDamageClaim.create({ claimNo: makeId("DMG"), tenantKey: ctx.tenantKey, globalCustomerId: ctx.link.globalCustomerId, invoiceId: String(invoice._id), invoiceNo: invoice.invoiceNo, invoiceDate: invoice.date, items, notes: clean(req.body.notes), images }); return ok(res, claim, "Damage claim submitted", 201);
  } catch (error) { return fail(res, error.message, 500); }
});

router.post("/otp/request", async (req, res) => {
  try { const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const actionType = upper(req.body.actionType || "CUSTOMER_ACTION"); const transactionId = clean(req.body.transactionId || makeId("TXN")); const account = req.customerAuth.account; const result = await createOtp({ tenantKey: ctx.tenantKey, transactionId, actionType, recipientId: req.customerAuth.globalCustomerId, context: { supplierId: ctx.supplierId, mobile: account.mobile || "", email: account.email || "" } }); return ok(res, { otpId: result.otpId, expiresAt: result.expiresAt, devCode: process.env.NODE_ENV === "production" ? undefined : result.code }, "OTP generated"); } catch (error) { return fail(res, error.message, 500); }
});
router.post("/otp/verify", async (req, res) => { const result = await verifyOtp({ otpId: req.body.otpId, code: req.body.code }); if (!result.ok) return fail(res, result.reason, 400); if (String(result.challenge.recipientId) !== req.customerAuth.globalCustomerId) return fail(res, "OTP does not belong to this customer", 403); return ok(res, { verified: true, actionType: result.challenge.actionType, transactionId: result.challenge.transactionId }, "OTP verified"); });

async function relationshipInsights(ctx, financialYear) {
  const { SalesInvoice, SalesOrder, Receipt } = financialModels(ctx.tenantKey, financialYear);
  const [invoices, orders, receipts] = await Promise.all([
    SalesInvoice.find({ tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, status: "POSTED" }).sort({ date: 1 }).lean(),
    SalesOrder.find({ tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId }).sort({ date: 1 }).lean(),
    Receipt.find({ tenantKey: ctx.tenantKey, financialYear, customerGlobalId: ctx.link.globalCustomerId, status: "POSTED" }).lean(),
  ]);
  const now = new Date(); const recentCut = new Date(now); recentCut.setDate(recentCut.getDate() - 90); const priorCut = new Date(recentCut); priorCut.setDate(priorCut.getDate() - 90);
  const rates = new Map(); for (const inv of invoices) for (const item of inv.items || []) { const id = clean(item.productId); if (!id) continue; const r = rates.get(id) || { name: item.nameSnapshot, recent: [], prior: [] }; const rate = num(item.effectiveRate || item.rate); const d = new Date(inv.date); if (d >= recentCut) r.recent.push(rate); else if (d >= priorCut) r.prior.push(rate); rates.set(id, r); }
  const priceTrends = [...rates.entries()].map(([productId, r]) => { const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; const recent = avg(r.recent), prior = avg(r.prior); return { productId, name: r.name, recentAverageRate: money(recent), previousAverageRate: money(prior), changePct: prior > 0 ? money(((recent - prior) / prior) * 100) : 0, direction: prior <= 0 ? "NEW" : recent > prior * 1.01 ? "UP" : recent < prior * .99 ? "DOWN" : "STABLE" }; }).filter((x) => x.recentAverageRate > 0).sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 12);
  let orderedQty = 0, invoicedQty = 0, cycleDays = []; for (const order of orders) { for (const i of order.items || []) { orderedQty += num(i.qty); invoicedQty += num(i.invoicedQty); } if (order.invoice?.invoiceDate && order.date) cycleDays.push(Math.max(0, (new Date(order.invoice.invoiceDate) - new Date(order.date)) / 86400000)); }
  const totalSales = invoices.reduce((s, x) => s + num(x.netInvoiceAmount || x.grandTotal), 0); const totalReceipts = receipts.filter(isReceiptLedgerPosted).reduce((s, x) => s + num(x.amount), 0); const lastInvoice = invoices[invoices.length - 1];
  return { financialYear, sales: { invoiceCount: invoices.length, total: money(totalSales), averageInvoice: invoices.length ? money(totalSales / invoices.length) : 0, lastInvoiceAt: lastInvoice?.date || null }, payments: { receiptCount: receipts.filter(isReceiptLedgerPosted).length, total: money(totalReceipts), collectionVsSalesPct: totalSales > 0 ? money(totalReceipts / totalSales * 100) : 0 }, supply: { orderCount: orders.length, orderedQty: money(orderedQty), invoicedQty: money(invoicedQty), fillRatePct: orderedQty > 0 ? money(invoicedQty / orderedQty * 100) : null, averageOrderToInvoiceDays: cycleDays.length ? money(cycleDays.reduce((s, x) => s + x, 0) / cycleDays.length) : null }, priceTrends };
}

router.get("/insights", async (req, res) => { try { const ctx = await supplierContext(req, res, { activeOnly: true }); if (!ctx) return; const financialYear = companyFinancialYear(ctx.company); return ok(res, { supplier: safeCompany(ctx.company), insights: await relationshipInsights(ctx, financialYear) }); } catch (error) { return fail(res, error.message, 500); } });
router.get("/insights/compare-suppliers", async (req, res) => {
  try {
    const memberships = (await membershipsFor(req.customerAuth.globalCustomerId)).filter((m) => m.active); const items = [];
    for (const membership of memberships.slice(0, 12)) { const company = await CompanyProfile.findById(membership.supplierId).lean(); const link = await CustomerLink.findOne({ tenantKey: company.tenantKey, globalCustomerId: req.customerAuth.globalCustomerId }).lean(); const financialYear = companyFinancialYear(company); const insights = await relationshipInsights({ company, link, tenantKey: company.tenantKey }, financialYear); items.push({ supplier: safeCompany(company), salesperson: membership.salesperson, insights }); }
    return ok(res, { items, note: "Comparison uses only this customer's own transaction, price and supply history with each supplier; it does not expose other customers or confidential company-wide data." });
  } catch (error) { return fail(res, error.message, 500); }
});

export default router;
