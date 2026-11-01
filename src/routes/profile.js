import express from "express";
import bcrypt from "bcryptjs";
import { CompanyProfile, CompanyLedger, Group, Plan, PlatformPayment, User } from "../models/index.js";
import { MailConnection } from "../models/mailConnection.model.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import { subscriptionSnapshot } from "../utils/subscription.js";
import { gstChangeConfirmation, migrateCompanyTenantKey, normalizeCompanyGstin, validateGstinChangeTarget } from "../services/tenantMigrationService.js";
import { encryptSecret } from "../services/mail/crypto.js";
import { verifySmtpConnection } from "../services/mail/smtpMail.service.js";
import { detectMailProvider, isValidEmail } from "../services/mail/providerDetection.service.js";

const router = express.Router();
router.use(requireAuth);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

async function smtpPresetForEmail(email, body = {}) {
  const requestedHost = clean(body.smtpHost);
  const requestedPort = Number(body.smtpPort || 0);
  if (requestedHost) {
    const port = requestedPort > 0 ? requestedPort : 587;
    return {
      host: requestedHost,
      port,
      secure: body.smtpSecure === true || String(body.smtpSecure || "").toLowerCase() === "true" || port === 465,
      detectedProvider: "custom",
    };
  }

  const domain = String(email.split("@")[1] || "").toLowerCase();
  if (["yahoo.com", "ymail.com"].includes(domain)) {
    return { host: "smtp.mail.yahoo.com", port: 465, secure: true, detectedProvider: "yahoo" };
  }
  if (["icloud.com", "me.com", "mac.com"].includes(domain)) {
    return { host: "smtp.mail.me.com", port: 587, secure: false, detectedProvider: "icloud" };
  }

  const detected = await detectMailProvider(email);
  if (detected.provider === "google") {
    return { host: "smtp.gmail.com", port: 465, secure: true, detectedProvider: "google" };
  }
  if (detected.provider === "microsoft") {
    return { host: "smtp.office365.com", port: 587, secure: false, detectedProvider: "microsoft" };
  }
  if (/hostinger/i.test(String(detected.reason || ""))) {
    return { host: "smtp.hostinger.com", port: 465, secure: true, detectedProvider: "hostinger" };
  }

  const error = new Error("Could not determine the SMTP server for this email. Enter SMTP Host in Advanced App Password settings.");
  error.statusCode = 400;
  throw error;
}

function assertSuperadmin(req, res) {
  if (req.auth?.role !== "SUPERADMIN") {
    fail(res, "Superadmin profile is available only to the company Superadmin", 403);
    return false;
  }
  return true;
}

async function loadProfile(req) {
  const [user, company] = await Promise.all([
    User.findById(req.auth.sub).select("-passwordHash").lean(),
    CompanyProfile.findOne({ tenantKey: req.auth.tenantKey })
      .select("-aadhaarHash -stakeholders.aadhaarHash")
      .lean(),
  ]);

  if (!user || !company) return null;

  const plan = company.planCode
    ? await Plan.findOne({ code: company.planCode }).lean()
    : null;

  const currentGroupCode = String(plan?.groupCode || company.planGroupCode || "")
    .trim()
    .toUpperCase();

  const [group, payments] = await Promise.all([
    currentGroupCode
      ? Group.findOne({ tenantKey: "demo", code: currentGroupCode, status: "ACTIVE" }).lean()
          .then((row) => row || Group.findOne({ code: currentGroupCode, status: "ACTIVE" }).sort({ createdAt: 1 }).lean())
      : null,
    PlatformPayment.find({ tenantKey: company.tenantKey })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
  ]);

  const subscription = subscriptionSnapshot(company);
  const mailConnection = await MailConnection.findOne({ database: company.tenantKey })
    .select("email provider authMode status smtpHost smtpPort smtpSecure smtpUser encryptedSmtpPassword lastHealthAt lastSuccessfulSendAt lastError")
    .lean();

  return {
    user: {
      ...user,
      id: user._id,
      tenantId: String(user.tenantId || company._id || ""),
      tenantKey: user.tenantKey,
    },
    company,
    plan,
    group: group
      ? {
          code: group.code,
          name: group.name,
          description: group.description,
        }
      : null,
    subscription,
    payments,
    mail: mailConnection
      ? {
          connected: mailConnection.status === "connected",
          email: mailConnection.email || "",
          provider: mailConnection.provider || "",
          authMode: mailConnection.authMode || "",
          status: mailConnection.status || "disconnected",
          smtpHost: mailConnection.smtpHost || "",
          smtpPort: Number(mailConnection.smtpPort || 0),
          smtpSecure: Boolean(mailConnection.smtpSecure),
          hasAppPassword: Boolean(mailConnection.encryptedSmtpPassword),
          lastHealthAt: mailConnection.lastHealthAt || null,
          lastSuccessfulSendAt: mailConnection.lastSuccessfulSendAt || null,
          lastError: mailConnection.lastError || "",
        }
      : { connected: false, status: "disconnected", hasAppPassword: false },
  };
}

router.get("/", async (req, res) => {
  if (!assertSuperadmin(req, res)) return;
  const data = await loadProfile(req);
  if (!data) return fail(res, "Superadmin/company profile not found", 404);
  return ok(res, data);
});

router.put("/", async (req, res) => {
  if (!assertSuperadmin(req, res)) return;

  const user = await User.findById(req.auth.sub);
  const company = await CompanyProfile.findOne({ tenantKey: req.auth.tenantKey });
  if (!user || !company) return fail(res, "Superadmin/company profile not found", 404);
  const previousCashYear=String(company.firstCashFinancialYear||"");
  const previousCashAmount=Number(company.firstCashOpeningBalance||0);

  const requestedGstin = normalizeCompanyGstin(req.body.gstin ?? company.gstin ?? company.tenantKey);
  let tenantMigration = null;
  const gstChanged = requestedGstin !== normalizeCompanyGstin(company.gstin);
  const tenantMoveRequested = req.body.migrateTenantData === true && requestedGstin !== String(company.tenantKey || "").trim();
  if (gstChanged || tenantMoveRequested) {
    try { await validateGstinChangeTarget({ profile: company, nextGstin: requestedGstin }); }
    catch (error) { return fail(res, error.message, error.status || 409, { code: error.code || "GST_CHANGE_FAILED" }); }
    const gstPan = requestedGstin.slice(2, 12);
    const requestedPan = clean(req.body.pan || gstPan || company.pan).toUpperCase();
    if (gstPan && requestedPan !== gstPan) return fail(res, `PAN must match the PAN embedded in GSTIN (${gstPan})`, 400);
    if (gstChanged && typeof req.body.migrateTenantData !== "boolean") {
      return fail(
        res,
        "GST Number changed. Confirm whether all company data should move to the new GST tenantKey.",
        409,
        gstChangeConfirmation(company, requestedGstin),
      );
    }
    company.gstin = requestedGstin;
    company.pan = requestedPan;
  } else if (req.body.pan !== undefined) {
    company.pan = clean(req.body.pan).toUpperCase();
  }

  const nextEmail = lower(req.body.email ?? user.email);
  if (!nextEmail || !/^\S+@\S+\.\S+$/.test(nextEmail)) {
    return fail(res, "Enter a valid email address", 400);
  }

  const duplicate = await User.exists({ email: nextEmail, _id: { $ne: user._id } });
  if (duplicate) return fail(res, "This email is already used by another login", 409);

  user.name = clean(req.body.name ?? user.name);
  user.email = nextEmail;
  user.mobile = clean(req.body.mobile ?? user.mobile);
  await user.save();

  for (const key of ["companyName", "tradeName", "mobile", "email", "registeredAddress", "pincode", "area", "city", "district", "state", "logoFileId", "signatureFileId", "invoiceTerms", "gpayNumber"]) {
    if (req.body[key] !== undefined) company[key] = clean(req.body[key]);
  }

  for (const [key, label] of [["stockOverdueDays", "Overdue days"], ["deadStockDays", "Dead stock days"]]) {
    if (req.body[key] === undefined) continue;
    const value = Math.trunc(Number(req.body[key]));
    if (!Number.isFinite(value) || value < 1 || value > 3650) {
      return fail(res, `${label} must be between 1 and 3650`, 400);
    }
    company[key] = value;
  }

  if (req.body.bankDetails && typeof req.body.bankDetails === "object") {
    company.bankDetails = { ...(company.bankDetails?.toObject?.() || company.bankDetails || {}), ...req.body.bankDetails };
  }
  if (req.body.gstVerified !== undefined) {
    company.gstVerification = {
      ...(company.gstVerification?.toObject?.() || company.gstVerification || {}),
      verified: Boolean(req.body.gstVerified),
      source: clean(req.body.gstSource || company.gstVerification?.source || ""),
      status: clean(req.body.gstStatus || company.gstVerification?.status || ""),
      taxpayerType: clean(req.body.gstTaxpayerType || company.gstVerification?.taxpayerType || ""),
      constitution: clean(req.body.gstConstitution || company.gstVerification?.constitution || ""),
      verifiedAt: req.body.gstVerified ? new Date() : company.gstVerification?.verifiedAt,
    };
  }

  if (req.body.financialYear !== undefined) {
    const fy = clean(req.body.financialYear);
    if (fy && Array.isArray(company.financialYears) && company.financialYears.length && !company.financialYears.includes(fy)) {
      return fail(res, "Default financial year must be one of the company's enabled financial years", 400);
    }
    company.financialYear = fy;
  }

  if (Array.isArray(req.body.financialYears)) {
    const years = Array.from(new Set(req.body.financialYears.map(clean).filter(Boolean)));
    company.financialYears = years;
    if (years.length && !years.includes(company.financialYear)) company.financialYear = years[0];
  }

  // First-year cash opening: company-wide, not per cashier or per user.
  // Validate BEFORE saving anything. Cashbook and finance reports both read SYS_CASH.
  const cashOpeningChanged = req.body.firstCashFinancialYear !== undefined || req.body.firstCashOpeningBalance !== undefined;
  if(cashOpeningChanged){
    const firstYear=clean(req.body.firstCashFinancialYear ?? company.firstCashFinancialYear);
    const amount=Number(req.body.firstCashOpeningBalance ?? company.firstCashOpeningBalance ?? 0);
    const match=/^(\d{4})-(\d{2})$/.exec(firstYear);
    if(!match || Number(match[2])!==((Number(match[1])+1)%100))return fail(res,"First Cash Financial Year must use YYYY-YY, e.g. 2025-26",400);
    if(!Number.isFinite(amount) || amount<0 || amount>1e14)return fail(res,"Cash opening must be a valid non-negative amount",400);
    const configured=[...(company.financialYears||[])].filter(Boolean);
    if(configured.length && !configured.includes(firstYear))return fail(res,"Cash opening FY must be one of the enabled financial years",400);
    if(configured.length && firstYear!==configured.sort()[0])return fail(res,"Cash opening must be set against the company's first financial year",400);
    company.firstCashFinancialYear=firstYear;
    company.firstCashOpeningBalance=Math.round(amount*100)/100;
  }

  const previousStartingNumber = Number(company.salesInvoiceStartingNumber || 1);
  for (const key of ["salesInvoicePrefix", "salesInvoiceSuffix"]) {
    if (req.body[key] !== undefined) company[key] = clean(req.body[key]);
  }
  if (req.body.salesInvoiceStartingNumber !== undefined) {
    const startingNumber = Math.trunc(Number(req.body.salesInvoiceStartingNumber));
    if (!Number.isFinite(startingNumber) || startingNumber < 1) {
      return fail(res, "Sales invoice starting number must be 1 or more", 400);
    }
    company.salesInvoiceStartingNumber = startingNumber;
    if (!company.salesInvoiceNextNumber || startingNumber !== previousStartingNumber) {
      company.salesInvoiceNextNumber = startingNumber;
    }
  }

  // Tenant migration is the final structural operation after all editable
  // fields above have passed validation.
  if (tenantMoveRequested) {
    try {
      tenantMigration = await migrateCompanyTenantKey({
        companyProfileId: String(company._id), oldTenantKey: company.tenantKey, newGstin: requestedGstin,
        actorId: req.auth.sub, actorRole: req.auth.role,
      });
    } catch (error) {
      return fail(res, error.message, error.status || 500, { code: error.code || "TENANT_MIGRATION_FAILED" });
    }
    company.tenantKey = requestedGstin;
    user.tenantKey = requestedGstin;
    req.auth.tenantKey = requestedGstin;
    // The user was saved earlier for normal profile fields. Save again after a
    // tenant move so the login identity stored in MongoDB also carries the new
    // tenantKey.
    await user.save();
  }
  if (gstChanged || tenantMoveRequested) {
    company.gstin = requestedGstin;
    company.markModified("gstin");
  }
  await company.save();

  const persistedCompany = await CompanyProfile.findById(company._id).lean();
  if (!persistedCompany) return fail(res, "Company profile disappeared while saving", 500, { code: "COMPANY_PROFILE_SAVE_FAILED" });
  if ((gstChanged || tenantMoveRequested) && normalizeCompanyGstin(persistedCompany.gstin) !== requestedGstin) {
    return fail(res, "GSTIN could not be persisted. The company still has the previous GST number.", 500, {
      code: "GSTIN_PERSISTENCE_FAILED", requestedGstin, persistedGstin: normalizeCompanyGstin(persistedCompany.gstin),
    });
  }

  if(cashOpeningChanged){
    // Synchronize the existing company cash ledger for Cashbook + P&L/Balance Sheet.
    // Do not create duplicate ledger rows. Skip if a ledger isn't provisioned yet:
    // Cashbook still uses the profile value directly in that case.
    const cashLedger=await CompanyLedger.findOne({tenantKey:company.tenantKey,systemAccountCode:"SYS_CASH",ownerType:"COMPANY",status:{$ne:"INACTIVE"}})
      || await CompanyLedger.findOne({tenantKey:company.tenantKey,systemAccountCode:"SYS_CASH",status:{$ne:"INACTIVE"}});
    if(cashLedger){
      const previous=(cashLedger.openingBalances||[]).filter(x=>{
        const y=String(x.financialYear||"");
        if(y===String(company.firstCashFinancialYear))return false;
        // Do not leave the old profile-created opening behind when the first FY changes.
        if(y===previousCashYear && previousCashYear!==company.firstCashFinancialYear && Number(x.amount||0)===previousCashAmount && String(x.type||"DR")==="DR")return false;
        return true;
      });
      cashLedger.openingBalances=[...previous,{financialYear:company.firstCashFinancialYear,amount:company.firstCashOpeningBalance,type:"DR"}];
      await cashLedger.save();
    }
  }
  const data = await loadProfile(req);
  return ok(res, {
    ...data,
    gstChanged,
    tenantMigration,
    tenantKeyChanged: Boolean(tenantMigration?.changed),
    newTenantKey: tenantMigration?.newTenantKey || data?.company?.tenantKey || company.tenantKey,
  }, tenantMigration?.changed ? "GSTIN updated and company data moved to the new tenantKey" : "Superadmin profile updated");
});

router.post("/mail-app-password", async (req, res) => {
  if (!assertSuperadmin(req, res)) return;
  try {
    const user = await User.findById(req.auth.sub).select("name email tenantKey").lean();
    const company = await CompanyProfile.findOne({ tenantKey: req.auth.tenantKey })
      .select("companyName tradeName tenantKey")
      .lean();
    if (!user || !company) return fail(res, "Superadmin/company profile not found", 404);

    const email = lower(user.email);
    if (!isValidEmail(email)) return fail(res, "Superadmin email is not valid", 400);
    let appPassword = String(req.body.appPassword || "").trim();
    if (!appPassword) return fail(res, "App Password is required", 400);

    const preset = await smtpPresetForEmail(email, req.body || {});
    if (preset.detectedProvider === "google") appPassword = appPassword.replace(/\s+/g, "");
    if (appPassword.length < 6) return fail(res, "App Password is too short", 400);

    const encryptedSmtpPassword = encryptSecret(appPassword);
    const candidate = {
      email,
      smtpHost: preset.host,
      smtpPort: preset.port,
      smtpSecure: preset.secure,
      smtpUser: email,
      encryptedSmtpPassword,
    };
    // Verify BEFORE replacing an existing OAuth/SMTP connection so a mistyped
    // App Password cannot break a working company mailbox.
    await verifySmtpConnection(candidate);

    await MailConnection.findOneAndUpdate(
      { database: company.tenantKey },
      {
        $set: {
          database: company.tenantKey,
          superadminId: String(user._id),
          email,
          fromName: clean(company.tradeName || company.companyName || user.name || email),
          provider: "smtp",
          authMode: "smtp",
          status: "connected",
          smtpHost: preset.host,
          smtpPort: preset.port,
          smtpSecure: preset.secure,
          smtpUser: email,
          encryptedSmtpPassword,
          encryptedRefreshToken: "",
          encryptedAccessToken: "",
          accessTokenExpiresAt: null,
          needsUpgrade: false,
          consentAccepted: true,
          consentAcceptedAt: new Date(),
          lastHealthAt: new Date(),
          lastError: "",
        },
      },
      { upsert: true, new: true },
    );

    const data = await loadProfile(req);
    return ok(res, data, `App Password connected. Invoice email will be sent from ${email}.`);
  } catch (error) {
    return fail(res, error.message || "Unable to connect App Password", error.statusCode || 400);
  }
});

router.delete("/mail-app-password", async (req, res) => {
  if (!assertSuperadmin(req, res)) return;
  await MailConnection.findOneAndUpdate(
    { database: req.auth.tenantKey, authMode: { $in: ["smtp", "smtp_legacy"] } },
    {
      $set: { status: "disconnected", lastError: "App Password removed by Superadmin", lastErrorAt: new Date() },
      $unset: { encryptedSmtpPassword: "" },
    },
  );
  const data = await loadProfile(req);
  return ok(res, data, "App Password removed");
});

router.post("/change-password", async (req, res) => {
  if (!assertSuperadmin(req, res)) return;

  const currentPassword = String(req.body.currentPassword || "");
  const newPassword = String(req.body.newPassword || "");

  if (!currentPassword) return fail(res, "Current password is required", 400);
  if (newPassword.length < 8) return fail(res, "New password must be at least 8 characters", 400);

  const user = await User.findById(req.auth.sub);
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return fail(res, "Current password is incorrect", 400);
  }

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  await user.save();
  return ok(res, { changed: true }, "Password changed successfully");
});

export default router;
