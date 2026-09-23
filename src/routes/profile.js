import express from "express";
import bcrypt from "bcryptjs";
import { CompanyProfile, Group, Plan, PlatformPayment, User } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok } from "../utils/http.js";
import { subscriptionSnapshot } from "../utils/subscription.js";
import { gstChangeConfirmation, migrateCompanyTenantKey, normalizeCompanyGstin, validateGstinChangeTarget } from "../services/tenantMigrationService.js";

const router = express.Router();
router.use(requireAuth);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

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
  }
  await company.save();

  const data = await loadProfile(req);
  return ok(res, {
    ...data,
    gstChanged,
    tenantMigration,
    tenantKeyChanged: Boolean(tenantMigration?.changed),
    newTenantKey: tenantMigration?.newTenantKey || data?.company?.tenantKey || company.tenantKey,
  }, tenantMigration?.changed ? "GSTIN updated and company data moved to the new tenantKey" : "Superadmin profile updated");
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
