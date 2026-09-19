import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  User,
  Plan,
  Role,
  CompanyProfile,
  CompanyLedger,
  PlatformPayment,
  Pincode,
} from "../models/index.js";
import { ok, fail } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import {
  createCompanyBaseLedgers,
  defaultStakeholderRelationships,
  ensureLegalAccountTemplates,
  syncStakeholderLedgers,
} from "../services/companyAccountingService.js";
import {
  defaultRoleTemplates,
  MASTER_TEMPLATE_TENANT,
} from "../config/defaultRoleTemplates.js";
import { sanitizePermissionCodes } from "../config/permissionCatalogue.js";
import { searchTaxpayer } from "../services/masterGstService.js";
import { addBillingPeriod } from "../utils/subscription.js";

const router = express.Router();

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const FY_RE = /^20\d{2}-\d{2}$/;
const VALID_COMPANY_TYPES = [
  "PROPRIETORSHIP",
  "PARTNERSHIP",
  "LLP",
  "PRIVATE_LIMITED",
  "PUBLIC_LIMITED",
  "OPC",
  "TRUST",
  "SOCIETY",
  "OTHER",
];

const normalizeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
const normalizeGstin = (value) => String(value || "").trim().toUpperCase();
const normalizePan = (value) => String(value || "").trim().toUpperCase();
const digits = (value) => String(value || "").replace(/\D/g, "");
const panFromGstin = (gstin) => (GSTIN_RE.test(gstin) ? gstin.slice(2, 12) : "");
const maskAadhaar = (value) => {
  const d = digits(value);
  return d.length === 12 ? `XXXXXXXX${d.slice(-4)}` : "";
};
const hashAadhaar = (value) => {
  const d = digits(value);
  return d.length === 12
    ? crypto.createHash("sha256").update(d).digest("hex")
    : "";
};
const paymentRef = () =>
  `SELF_${Date.now()}_${crypto.randomBytes(5).toString("hex").toUpperCase()}`;

async function ensureRoleTemplates() {
  for (const template of defaultRoleTemplates) {
    await Role.findOneAndUpdate(
      { tenantKey: MASTER_TEMPLATE_TENANT, code: template.code },
      {
        $set: {
          ...template,
          tenantKey: MASTER_TEMPLATE_TENANT,
          sourceTemplateCode: template.code,
          status: "ACTIVE",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
}

router.get("/plans", async (_req, res) => {
  const rows = await Plan.find({ status: "ACTIVE" })
    .select(
      "name code description groupCode monthlyAmount yearlyAmount addons limits roleTemplateCodes status"
    )
    .sort({ yearlyAmount: 1, monthlyAmount: 1, name: 1 })
    .lean();

  return ok(
    res,
    rows.map((plan) => ({
      ...plan,
      roleCount: Array.isArray(plan.roleTemplateCodes)
        ? plan.roleTemplateCodes.length
        : 0,
    }))
  );
});

router.get("/gst/search", async (req, res, next) => {
  try {
    const taxpayer = await searchTaxpayer(req.query.gstin);
    return ok(res, taxpayer, "GST taxpayer found");
  } catch (error) {
    return next(error);
  }
});

router.get("/pincode", async (req, res) => {
  const pincode = digits(req.query.pincode).slice(0, 6);
  if (pincode.length !== 6) return fail(res, "Enter a valid 6-digit pincode", 400);
  const rows = await Pincode.find({ pincode }).limit(25).lean();
  return ok(res, rows);
});

router.post("/superadmin", async (req, res) => {
  const gstin = normalizeGstin(req.body.gstin);
  const embeddedPan = panFromGstin(gstin);
  const pan = normalizePan(req.body.pan || embeddedPan);
  const tenantKey = gstin;
  const companyName = String(req.body.companyName || "").trim();
  const tradeName = String(req.body.tradeName || "").trim();
  const companyType = normalizeCode(req.body.companyType);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const mobile = digits(req.body.mobile).slice(-10);
  const aadhaar = digits(req.body.aadhaar);
  const address = String(req.body.address || req.body.registeredAddress || "").trim();
  const pincode = digits(req.body.pincode).slice(0, 6);
  const city = String(req.body.city || "").trim();
  const state = String(req.body.state || "").trim();
  const planCode = normalizeCode(req.body.planCode);
  const hasMultipleBranches = Boolean(req.body.hasMultipleBranches);
  const branchCount = hasMultipleBranches
    ? Math.max(2, Number(req.body.branchCount || 2))
    : 1;
  const billingCycle =
    String(req.body.billingCycle || "YEARLY").toUpperCase() === "MONTHLY"
      ? "MONTHLY"
      : "YEARLY";
  const skipPayment = Boolean(req.body.skipPayment);

  const requestedYears = Array.isArray(req.body.financialYears)
    ? req.body.financialYears
    : [req.body.financialYear];
  const financialYears = Array.from(
    new Set(
      requestedYears
        .map((value) => String(value || "").trim())
        .filter((value) => FY_RE.test(value))
    )
  );
  const financialYear = String(
    req.body.financialYear || financialYears[0] || ""
  ).trim();
  if (financialYear && !financialYears.includes(financialYear)) {
    financialYears.unshift(financialYear);
  }

  if (!GSTIN_RE.test(gstin)) return fail(res, "A valid GST Number is required", 400);
  if (!PAN_RE.test(pan)) return fail(res, "A valid PAN Number is required", 400);
  if (pan !== embeddedPan) {
    return fail(res, `PAN must match the PAN embedded in GSTIN (${embeddedPan})`, 400);
  }
  if (!companyName) return fail(res, "Company Name is required", 400);
  if (!VALID_COMPANY_TYPES.includes(companyType)) {
    return fail(res, "Select a valid Company Type", 400);
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) return fail(res, "A valid email ID is required", 400);
  if (password.length < 8) return fail(res, "Password must contain at least 8 characters", 400);
  if (!financialYears.length || !FY_RE.test(financialYear)) {
    return fail(res, "Add at least one valid Financial Year", 400);
  }
  if (!planCode) return fail(res, "Select a Plan", 400);
  if (!skipPayment) {
    return fail(
      res,
      "For self-registration, confirm 'Skip payment / payment already done' to continue",
      400
    );
  }
  if (aadhaar && aadhaar.length !== 12) return fail(res, "Aadhaar Number must contain 12 digits", 400);
  if (pincode && pincode.length !== 6) return fail(res, "Pincode must contain 6 digits", 400);

  if (await User.exists({ email })) return fail(res, "This email is already registered", 409);
  if (await CompanyProfile.exists({ $or: [{ tenantKey }, { gstin }] })) {
    return fail(res, "This GSTIN is already registered", 409);
  }

  const plan = await Plan.findOne({ code: planCode, status: "ACTIVE" }).lean();
  if (!plan) return fail(res, "Selected plan is not active", 409);

  const branchLimit = plan?.limits?.companies;
  if (
    branchLimit !== null &&
    branchLimit !== undefined &&
    Number(branchLimit) >= 0 &&
    branchCount > Number(branchLimit)
  ) {
    return fail(
      res,
      `This plan allows maximum ${branchLimit} branch(es). Selected: ${branchCount}.`,
      409
    );
  }

  const stakeholderInput = Array.isArray(req.body.stakeholders)
    ? req.body.stakeholders
    : [];
  const namedStakeholders = stakeholderInput.filter((row) =>
    String(row?.name || "").trim()
  );
  if (companyType === "PROPRIETORSHIP" && namedStakeholders.length !== 1) {
    return fail(res, "Proprietorship must have exactly one proprietor", 400);
  }
  if (companyType !== "PROPRIETORSHIP" && !namedStakeholders.length) {
    return fail(res, "Add at least one stakeholder", 400);
  }

  await ensureLegalAccountTemplates();
  await ensureRoleTemplates();

  const availableTemplates = await Role.find({
    tenantKey: MASTER_TEMPLATE_TENANT,
    status: "ACTIVE",
  }).lean();
  const dmsTemplates = availableTemplates.filter((template) =>
    (template.apps || []).includes("dms")
  );
  const planCodes = (plan.roleTemplateCodes || []).map(String);
  const selectedTemplates = planCodes.length
    ? dmsTemplates.filter((template) => planCodes.includes(template.code))
    : dmsTemplates;

  if (!selectedTemplates.length) {
    return fail(res, "The selected plan has no active DMS role templates", 409);
  }

  const stakeholders = namedStakeholders.map((row) => {
    const stakeholderAadhaar = digits(row.aadhaar);
    const stakeholder = {
      stakeholderId: row.stakeholderId || makeId("STK"),
      name: String(row.name).trim(),
      roleType: normalizeCode(row.roleType || "OWNER"),
      pan: normalizePan(row.pan),
      aadhaarHash:
        stakeholderAadhaar.length === 12 ? hashAadhaar(stakeholderAadhaar) : "",
      aadhaarMasked:
        stakeholderAadhaar.length === 12 ? maskAadhaar(stakeholderAadhaar) : "",
      dinDpin: String(row.dinDpin || "").trim().toUpperCase(),
      mobile: digits(row.mobile).slice(-10),
      email: String(row.email || "").trim().toLowerCase(),
      designation: String(row.designation || "").trim(),
      ownershipPct: Number(row.ownershipPct || 0),
      profitSharePct: Number(row.profitSharePct || 0),
      contribution: Number(row.contribution || 0),
      openingCapital: Number(row.openingCapital || 0),
      joiningDate: row.joiningDate || undefined,
      active: true,
      shareholder: Boolean(row.shareholder),
      systemLoginRequired: Boolean(row.systemLoginRequired),
      accountingRelationships: Array.isArray(row.accountingRelationships)
        ? row.accountingRelationships
        : [],
    };

    if (!stakeholder.accountingRelationships.length) {
      stakeholder.accountingRelationships = defaultStakeholderRelationships(
        { ...stakeholder, financialYear },
        companyType
      );
    }
    return stakeholder;
  });

  const amountRupees =
    billingCycle === "MONTHLY"
      ? Number(plan.monthlyAmount || 0)
      : Number(plan.yearlyAmount || 0);

  let createdUser = null;
  let createdProfile = null;
  let payment = null;

  try {
    createdUser = await User.create({
      tenantKey,
      name: companyName,
      email,
      mobile,
      passwordHash: await bcrypt.hash(password, 12),
      role: "SUPERADMIN",
      apps: ["dms"],
      permissions: ["*"],
      planCode: plan.code,
      dataScope: "COMPANY",
      status: "ACTIVE",
    });

    payment = await PlatformPayment.create({
      paymentRef: paymentRef(),
      companyName,
      gstin,
      planCode: plan.code,
      billingCycle,
      amountRupees,
      amountPaise: Math.round(amountRupees * 100),
      currency: "INR",
      provider: "SELF_REGISTRATION",
      status: "MANUAL_PAID",
      manualNote: "Self-registration: payment marked as done using skip-payment confirmation",
      createdBy: "SELF_REGISTRATION",
      verifiedAt: new Date(),
    });

    const subscriptionStartAt = payment.verifiedAt || new Date();
    const subscriptionEndAt = addBillingPeriod(subscriptionStartAt, billingCycle, 1);

    createdProfile = await CompanyProfile.create({
      tenantKey,
      companyName,
      tradeName,
      companyType,
      gstin,
      pan,
      aadhaarHash: aadhaar.length === 12 ? hashAadhaar(aadhaar) : "",
      aadhaarMasked: aadhaar.length === 12 ? maskAadhaar(aadhaar) : "",
      mobile,
      email,
      registeredAddress: address,
      pincode,
      city,
      state,
      financialYear,
      financialYears,
      hasMultipleBranches,
      branchCount,
      planCode: plan.code,
      planGroupCode: plan.groupCode || "",
      billingCycle,
      paymentStatus: "MANUAL_PAID",
      paymentRef: payment.paymentRef,
      subscriptionStartAt,
      subscriptionEndAt,
      renewalDate: subscriptionEndAt,
      lastRenewedAt: subscriptionStartAt,
      subscriptionStatus: "ACTIVE",
      planHistory: [{
        planCode: plan.code,
        billingCycle,
        startAt: subscriptionStartAt,
        endAt: subscriptionEndAt,
        paymentRef: payment.paymentRef,
        amountRupees,
        action: "INITIAL_SELF_REGISTRATION",
        changedBy: "SELF_REGISTRATION",
        at: subscriptionStartAt,
      }],
      gstVerification: {
        verified: Boolean(req.body.gstVerified),
        source: String(req.body.gstSource || ""),
        status: String(req.body.gstStatus || ""),
        taxpayerType: String(req.body.gstTaxpayerType || ""),
        constitution: String(req.body.gstConstitution || ""),
        verifiedAt: req.body.gstVerified ? new Date() : undefined,
      },
      stakeholders,
      status: "ACTIVE",
      createdBy: "SELF_REGISTRATION",
    });

    createdUser.tenantId = String(createdProfile._id);
    await createdUser.save();

    await Role.bulkWrite(
      selectedTemplates.map((template) => ({
        updateOne: {
          filter: { tenantKey, code: template.code },
          update: {
            $set: {
              tenantKey,
              name: template.name,
              code: template.code,
              description: template.description || "",
              apps: template.apps || [],
              permissions: sanitizePermissionCodes(template.permissions || []),
              dataScope: "SELF",
              approvalLimits: {
                discountPct: 0,
                creditAmount: 0,
                orderAmount: 0,
              },
              sourceTemplateCode: template.code,
              templateVersion: template.templateVersion || 3,
              locked: false,
              status: "ACTIVE",
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    await createCompanyBaseLedgers(createdProfile);
    for (const stakeholder of createdProfile.stakeholders.filter((row) => row.active)) {
      await syncStakeholderLedgers({
        tenantKey,
        companyType,
        stakeholder,
        financialYear,
      });
    }

    payment.tenantKey = tenantKey;
    payment.linkedUserId = String(createdUser._id);
    payment.linkedCompanyProfileId = String(createdProfile._id);
    payment.subscriptionStartAt = subscriptionStartAt;
    payment.subscriptionEndAt = subscriptionEndAt;
    await payment.save();

    return ok(
      res,
      {
        registered: true,
        email,
        tenantId: String(createdProfile._id),
        tenantKey,
        companyName,
        planCode: plan.code,
        paymentStatus: payment.status,
      },
      "Registration completed. You can now sign in.",
      201
    );
  } catch (error) {
    if (createdUser?._id) await User.deleteOne({ _id: createdUser._id }).catch(() => {});
    if (createdProfile?._id) {
      await CompanyProfile.deleteOne({ _id: createdProfile._id }).catch(() => {});
    }
    await CompanyLedger.deleteMany({ tenantKey, createdFrom: "COMPANY_SETUP" }).catch(() => {});
    if (payment?._id) await PlatformPayment.deleteOne({ _id: payment._id }).catch(() => {});
    if (error?.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || "value";
      return fail(res, `Duplicate ${field}. Please use a different value.`, 409);
    }
    throw error;
  }
});

export default router;
