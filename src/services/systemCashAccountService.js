import crypto from "crypto";
import bcrypt from "bcryptjs";
import {
  AccountTemplate,
  CustomerLink,
  GlobalCustomer,
  User,
} from "../models/index.js";
import { syncUserLedgers } from "./companyAccountingService.js";

export const SYSTEM_CASH_KEY = "CASH";

const clean = (value) => String(value ?? "").trim();
const upper = (value) => clean(value).toUpperCase();

const tenantDigest = (tenantKey) =>
  crypto.createHash("sha256").update(clean(tenantKey)).digest("hex").slice(0, 16);

const systemEmailForTenant = (tenantKey) =>
  `cash.${tenantDigest(tenantKey)}@system.rupio.invalid`;

const systemGlobalCustomerId = (tenantKey) =>
  `CASH-${tenantDigest(tenantKey).toUpperCase()}`;

async function ensureCashAccountTemplates() {
  await AccountTemplate.findOneAndUpdate(
    { systemCode: "SYS_CURRENT_ASSETS" },
    {
      $set: {
        systemCode: "SYS_CURRENT_ASSETS",
        name: "Current Assets",
        nature: "ASSET",
        parentCode: "",
        locked: true,
        allowCompanyLedger: true,
        reportMap: { trading: false, pnl: false, balanceSheet: true, cma: true, cashFlow: "OPERATING" },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await AccountTemplate.findOneAndUpdate(
    { systemCode: "SYS_CASH" },
    {
      $set: {
        systemCode: "SYS_CASH",
        name: "Cash-in-hand",
        nature: "ASSET",
        parentCode: "SYS_CURRENT_ASSETS",
        locked: true,
        allowCompanyLedger: true,
        reportMap: { trading: false, pnl: false, balanceSheet: true, cma: true, cashFlow: "OPERATING" },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/**
 * Ensures one system-managed CASH account for a company tenant.
 *
 * The CASH account is represented in both directories because V2 currently has
 * two party sources:
 *   - User/Ledger directory for accounting/user pickers.
 *   - Customer directory for sales/purchase/receipt/payment party pickers.
 *
 * Both records are non-login, unassigned and locked with systemKey=CASH.
 * Re-running this function repairs any accidental rename/status/accounting drift.
 */
export async function ensureSystemCashAccount({
  tenantKey,
  tenantId = "",
  planCode = "COMPLETE",
  actorId = "SYSTEM",
} = {}) {
  const key = clean(tenantKey);
  if (!key) return null;

  await ensureCashAccountTemplates();

  let cashUser = await User.findOne({ tenantKey: key, systemKey: SYSTEM_CASH_KEY });
  if (!cashUser) {
    cashUser = await User.findOne({
      tenantKey: key,
      name: /^CASH$/i,
      role: "LEDGER_ACCOUNT",
      loginEnabled: false,
    });
  }

  const accountingMappings = [{
    relationshipType: "CASH_ACCOUNT",
    systemAccountCode: "SYS_CASH",
    ledgerName: "CASH",
    openingBalance: 0,
    openingBalanceType: "DR",
    financialYear: "",
    status: "ACTIVE",
  }];

  if (!cashUser) {
    cashUser = await User.create({
      tenantKey: key,
      tenantId: clean(tenantId),
      name: "CASH",
      email: systemEmailForTenant(key),
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12),
      loginEnabled: false,
      role: "LEDGER_ACCOUNT",
      apps: [],
      permissions: [],
      planCode: clean(planCode) || "COMPLETE",
      status: "ACTIVE",
      accountType: "CURRENT ASSETS",
      tallyAccountTypeCode: "SYS_CURRENT_ASSETS",
      tallyAccountTypeName: "CURRENT ASSETS",
      tallyAccountNature: "ASSET",
      assignedToUserId: undefined,
      reportsTo: undefined,
      dataScope: "COMPANY",
      openingBalance: 0,
      openingBalanceType: "DR",
      accountingRequired: true,
      accountingMappings,
      systemManaged: true,
      systemKey: SYSTEM_CASH_KEY,
      systemNote: "SYSTEM-MANAGED CASH ACCOUNT. DO NOT DELETE OR ASSIGN.",
    });
  } else {
    cashUser.name = "CASH";
    cashUser.status = "ACTIVE";
    cashUser.loginEnabled = false;
    cashUser.role = "LEDGER_ACCOUNT";
    cashUser.apps = [];
    cashUser.permissions = [];
    cashUser.accountType = "CURRENT ASSETS";
    cashUser.tallyAccountTypeCode = "SYS_CURRENT_ASSETS";
    cashUser.tallyAccountTypeName = "CURRENT ASSETS";
    cashUser.tallyAccountNature = "ASSET";
    cashUser.assignedToUserId = undefined;
    cashUser.reportsTo = undefined;
    cashUser.departmentId = undefined;
    cashUser.department = "";
    cashUser.roleId = undefined;
    cashUser.branchId = undefined;
    cashUser.branch = "";
    cashUser.warehouseId = "";
    cashUser.dataScope = "COMPANY";
    cashUser.accountingRequired = true;
    cashUser.accountingMappings = accountingMappings;
    cashUser.systemManaged = true;
    cashUser.systemKey = SYSTEM_CASH_KEY;
    cashUser.systemNote = "SYSTEM-MANAGED CASH ACCOUNT. DO NOT DELETE OR ASSIGN.";
    if (tenantId) cashUser.tenantId = clean(tenantId);
    if (planCode) cashUser.planCode = clean(planCode);
    if (!cashUser.email) cashUser.email = systemEmailForTenant(key);
    if (!cashUser.passwordHash) {
      cashUser.passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    }
    await cashUser.save();
  }

  await syncUserLedgers(cashUser);

  const globalId = systemGlobalCustomerId(key);
  let global = await GlobalCustomer.findOne({ hiddenId: globalId });
  if (!global) {
    global = await GlobalCustomer.create({
      hiddenId: globalId,
      legalName: "CASH",
      tradeName: "CASH",
      customerType: "BUSINESS",
      gstins: [],
      mobiles: [],
      emails: [],
      registeredAddress: "",
      linkedTenants: [{ tenantKey: key, linkedAt: new Date() }],
    });
  } else {
    global.legalName = "CASH";
    global.tradeName = "CASH";
    if (!Array.isArray(global.linkedTenants)) global.linkedTenants = [];
    if (!global.linkedTenants.some((row) => clean(row?.tenantKey) === key)) {
      global.linkedTenants.push({ tenantKey: key, linkedAt: new Date() });
    }
    await global.save();
  }

  let cashParty = await CustomerLink.findOne({ tenantKey: key, systemKey: SYSTEM_CASH_KEY });
  if (!cashParty) {
    cashParty = await CustomerLink.findOne({ tenantKey: key, localName: /^CASH$/i });
  }

  const approval = {
    status: "APPROVED",
    submittedBy: clean(actorId) || "SYSTEM",
    submittedAt: new Date(),
    reviewedBy: clean(actorId) || "SYSTEM",
    reviewedAt: new Date(),
    decision: "SYSTEM_CASH_ACCOUNT",
    remarks: "SYSTEM-MANAGED CASH PARTY",
  };

  if (!cashParty) {
    cashParty = await CustomerLink.create({
      tenantKey: key,
      globalCustomerId: global.hiddenId,
      displayIdentifier: "CASH",
      localName: "CASH",
      customerType: "BUSINESS",
      paymentType: "CASH",
      creditDays: 0,
      creditLimit: 0,
      graceDays: 0,
      salespersonId: "",
      territoryId: "",
      partyType: "DEBITOR",
      registrationType: "UNREGISTERED",
      customerCode: "CASH",
      regionType: "LOCAL",
      priceList: "STANDARD",
      status: "ACTIVE",
      verification: { identity: true, mobile: true, email: true, gps: false, kyc: true, appLinked: false },
      requestedTerms: { paymentType: "CASH", creditDays: 0, creditLimit: 0, graceDays: 0, priceList: "STANDARD", requestedBy: clean(actorId) || "SYSTEM", requestedAt: new Date() },
      approvedTerms: { paymentType: "CASH", creditDays: 0, creditLimit: 0, graceDays: 0, priceList: "STANDARD", approvedBy: clean(actorId) || "SYSTEM", approvedAt: new Date() },
      approval,
      accountingProfile: {
        systemAccountCode: "SYS_CASH",
        ledgerName: "CASH",
        openingBalance: 0,
        openingBalanceType: "DR",
        financialYear: "",
      },
      systemManaged: true,
      systemKey: SYSTEM_CASH_KEY,
      systemNote: "SYSTEM-MANAGED CASH PARTY. DO NOT DELETE OR ASSIGN.",
    });
  } else {
    cashParty.globalCustomerId = global.hiddenId;
    cashParty.displayIdentifier = "CASH";
    cashParty.localName = "CASH";
    cashParty.customerType = "BUSINESS";
    cashParty.paymentType = "CASH";
    cashParty.creditDays = 0;
    cashParty.creditLimit = 0;
    cashParty.graceDays = 0;
    cashParty.salespersonId = "";
    cashParty.territoryId = "";
    cashParty.partyType = "DEBITOR";
    cashParty.registrationType = "UNREGISTERED";
    cashParty.customerCode = "CASH";
    cashParty.status = "ACTIVE";
    cashParty.accountingProfile = {
      systemAccountCode: "SYS_CASH",
      ledgerName: "CASH",
      openingBalance: 0,
      openingBalanceType: "DR",
      financialYear: cashParty.accountingProfile?.financialYear || "",
    };
    cashParty.approval = approval;
    cashParty.systemManaged = true;
    cashParty.systemKey = SYSTEM_CASH_KEY;
    cashParty.systemNote = "SYSTEM-MANAGED CASH PARTY. DO NOT DELETE OR ASSIGN.";
    await cashParty.save();
  }

  return {
    userId: String(cashUser._id),
    customerGlobalId: cashParty.globalCustomerId,
    name: "CASH",
    accountType: "CURRENT ASSETS",
    systemAccountCode: "SYS_CASH",
  };
}

export function isSystemCashRecord(record) {
  return Boolean(
    record &&
    (record.systemManaged === true || upper(record.systemKey) === SYSTEM_CASH_KEY) &&
    upper(record.systemKey || record.name || record.localName) === SYSTEM_CASH_KEY
  );
}
