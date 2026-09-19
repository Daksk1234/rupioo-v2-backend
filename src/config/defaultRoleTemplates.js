import { permissionCatalogue, sanitizePermissionCodes } from "./permissionCatalogue.js";

export const MASTER_TEMPLATE_TENANT = "__MASTER_ROLE_TEMPLATES__";

const ALL_ACTIONS = ["view","edit","create","delete","download","screenshot","print"];
const SAFE_ACTIONS = ["view","edit","create","download","screenshot","print"];
const VIEW_ACTIONS = ["view","download","screenshot","print"];

const unique = (values) => Array.from(new Set((values || []).filter(Boolean)));

const permissionCodes = ({
  apps = [],
  categories = [],
  categoryContains = [],
  screenContains = [],
  actions = ALL_ACTIONS,
} = {}) => {
  const appSet = new Set(apps);
  const categorySet = new Set(categories);
  const actionSet = new Set(actions);
  const categoryNeedles = categoryContains.map(x => String(x).toLowerCase());
  const screenNeedles = screenContains.map(x => String(x).toLowerCase());
  const out = [];

  for (const group of permissionCatalogue) {
    if (appSet.size && !appSet.has(group.app)) continue;

    const categoryLower = String(group.category || "").toLowerCase();
    const categoryMatch =
      !categorySet.size && !categoryNeedles.length
        ? true
        : categorySet.has(group.category) ||
          categoryNeedles.some(n => categoryLower.includes(n));

    if (!categoryMatch && !screenNeedles.length) continue;

    for (const screen of group.screens || []) {
      const screenLower = String(screen.label || "").toLowerCase();
      const screenMatch =
        !screenNeedles.length || screenNeedles.some(n => screenLower.includes(n));

      if (!categoryMatch && !screenMatch) continue;
      if (screenNeedles.length && !screenMatch && !categoryMatch) continue;

      for (const action of screen.allowedActions || []) {
        if (actionSet.has(action)) out.push(`${screen.key}.${action}`);
      }
    }
  }

  return unique(out);
};

const withLegacy = (matrix, _legacy = []) => sanitizePermissionCodes(matrix);

const role = ({
  name,
  code,
  description,
  apps,
  dataScope,
  permissions,
  legacy = [],
  approvalLimits = {},
}) => ({
  name,
  code,
  description,
  apps,
  dataScope,
  permissions: sanitizePermissionCodes(withLegacy(permissions, legacy)),
  approvalLimits: {
    discountPct: Number(approvalLimits.discountPct || 0),
    creditAmount: Number(approvalLimits.creditAmount || 0),
    orderAmount: Number(approvalLimits.orderAmount || 0),
  },
  locked: false,
  status: "ACTIVE",
  templateVersion: 2,
});

const dmsAll = () => permissionCodes({ apps:["dms"] });
const hrAll = () => permissionCodes({ apps:["hr"] });
const productionAll = () => permissionCodes({ apps:["production"] });
const allOperational = () => permissionCodes({ apps:["dms","hr","production"] });

export const defaultRoleTemplates = [
  role({
    name:"Company Administrator",
    code:"COMPANY_ADMIN",
    description:"Full company-level access across all applications enabled by the plan.",
    apps:["dms","hr","production"],
    dataScope:"COMPANY",
    permissions:allOperational(),
    legacy:["dms.users.manage","hr.users.manage","company.manage","customers.approve","customers.edit","customers.create","accounts.view","accounts.post","accounts.approve","reports.view","reports.company","sales.create","sales.approve","sales.price_override","purchase.create","purchase.approve","stock.view","stock.adjust","hr.employees.manage","hr.attendance.manage","hr.leave.approve","hr.payroll.manage","production.plan","production.execute","production.qc","production.maintenance"],
    approvalLimits:{discountPct:100,creditAmount:999999999,orderAmount:999999999},
  }),

  role({
    name:"DMS Administrator",
    code:"DMS_ADMIN",
    description:"Full DMS operational and administration access.",
    apps:["dms"],
    dataScope:"COMPANY",
    permissions:dmsAll(),
    legacy:["dms.users.manage","company.manage","customers.approve","customers.edit","customers.create","accounts.view","accounts.post","accounts.approve","reports.view","reports.company","sales.create","sales.approve","sales.price_override","purchase.create","purchase.approve","stock.view","stock.adjust"],
    approvalLimits:{discountPct:100,creditAmount:999999999,orderAmount:999999999},
  }),

  role({
    name:"Accounts Head",
    code:"ACCOUNTS_HEAD",
    description:"Finance, accounting, banking, GST, credit control and financial reporting.",
    apps:["dms"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["dms"],categoryContains:["finance","transaction","gstr","gst","report","administration"],screenContains:["customer approval","sales invoice","purchase invoice","credit note","debit note"],actions:ALL_ACTIONS}),
    legacy:["accounts.view","accounts.post","accounts.approve","customers.approve","customers.edit","reports.view","reports.company"],
    approvalLimits:{discountPct:20,creditAmount:10000000,orderAmount:10000000},
  }),

  role({
    name:"Accountant",
    code:"ACCOUNTANT",
    description:"Day-to-day receipts, payments, invoices, ledgers, banking, GST and reports.",
    apps:["dms"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["dms"],categoryContains:["finance","transaction","gstr","gst","report"],screenContains:["sales invoice","purchase invoice","credit note","debit note"],actions:SAFE_ACTIONS}),
    legacy:["accounts.view","accounts.post","customers.approve","reports.view"],
    approvalLimits:{discountPct:0,creditAmount:500000,orderAmount:500000},
  }),

  role({
    name:"Sales Head",
    code:"SALES_HEAD",
    description:"Company sales, CRM, targets, customer approvals, pricing visibility and sales reports.",
    apps:["dms"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["dms"],categoryContains:["sales","crm","overview","report"],screenContains:["customer","lead","visit","target","quotation","dispatch"],actions:ALL_ACTIONS}),
    legacy:["customers.view","customers.create","customers.edit","customers.approve","leads.view","leads.manage","visits.create","sales.create","sales.approve","sales.price_override","reports.view","reports.company"],
    approvalLimits:{discountPct:25,creditAmount:5000000,orderAmount:10000000},
  }),

  role({
    name:"Sales Manager",
    code:"SALES_MANAGER",
    description:"Team sales, leads, customer management, targets, visits and sales reports.",
    apps:["dms"],
    dataScope:"TEAM",
    permissions:permissionCodes({apps:["dms"],categoryContains:["sales","crm","overview","report"],screenContains:["customer","lead","visit","target","quotation","dispatch"],actions:SAFE_ACTIONS}),
    legacy:["customers.view","customers.create","customers.edit","customers.approve","leads.view","leads.manage","visits.create","sales.create","sales.approve","reports.view"],
    approvalLimits:{discountPct:10,creditAmount:1000000,orderAmount:2500000},
  }),

  role({
    name:"Sales Person",
    code:"SALES_PERSON",
    description:"Own customers, leads, visits, quotations, orders, invoices where allowed, targets and collections.",
    apps:["dms"],
    dataScope:"SELF",
    permissions:permissionCodes({apps:["dms"],categoryContains:["sales","crm","overview"],screenContains:["customer","lead","visit","target","quotation","order","receipt"],actions:["view","create","edit","update","download"]}),
    legacy:["customers.view","customers.create","leads.view","leads.manage","visits.create","sales.create","reports.view"],
    approvalLimits:{discountPct:3,creditAmount:0,orderAmount:500000},
  }),

  role({
    name:"CRM / Lead Manager",
    code:"CRM_MANAGER",
    description:"Lead pool, customer conversion, visits, territories and CRM reporting.",
    apps:["dms"],
    dataScope:"TEAM",
    permissions:permissionCodes({apps:["dms"],categoryContains:["crm","sales"],screenContains:["lead","customer","visit","territor","target"],actions:ALL_ACTIONS}),
    legacy:["customers.view","customers.create","customers.edit","leads.view","leads.manage","visits.create","reports.view"],
  }),

  role({
    name:"Collection Executive",
    code:"COLLECTION_EXECUTIVE",
    description:"Customer receipts, collection visits, outstanding and collection reports.",
    apps:["dms"],
    dataScope:"SELF",
    permissions:permissionCodes({apps:["dms"],categoryContains:["transaction","finance","crm"],screenContains:["receipt","overdue","due report","ledger","visit","customer"],actions:["view","create","edit","update","download"]}),
    legacy:["customers.view","visits.create","reports.view","accounts.view"],
  }),

  role({
    name:"Purchase Head",
    code:"PURCHASE_HEAD",
    description:"Purchase planning, orders, invoices, returns, suppliers, stock visibility and purchase reports.",
    apps:["dms"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["dms"],categoryContains:["purchase","product","stock","warehouse","report"],screenContains:["supplier","purchase"],actions:ALL_ACTIONS}),
    legacy:["purchase.create","purchase.approve","stock.view","reports.view","reports.company"],
    approvalLimits:{orderAmount:10000000},
  }),

  role({
    name:"Purchase Executive",
    code:"PURCHASE_EXECUTIVE",
    description:"Purchase requests, RFQ, orders, GRN and purchase invoices within assigned scope.",
    apps:["dms"],
    dataScope:"SELF",
    permissions:permissionCodes({apps:["dms"],categoryContains:["purchase","product","stock"],actions:SAFE_ACTIONS}),
    legacy:["purchase.create","stock.view","reports.view"],
    approvalLimits:{orderAmount:1000000},
  }),

  role({
    name:"Warehouse Manager",
    code:"WAREHOUSE_MANAGER",
    description:"Warehouses, inward/outward, transfers, stock, damage, dispatch and stock reports.",
    apps:["dms"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["dms"],categoryContains:["warehouse","stock"],screenContains:["dispatch"],actions:ALL_ACTIONS}),
    legacy:["stock.view","stock.adjust","reports.view","reports.company"],
  }),

  role({
    name:"Warehouse User",
    code:"WAREHOUSE_USER",
    description:"Operational warehouse inward, outward, stock transfer, picking/dispatch and stock view.",
    apps:["dms"],
    dataScope:"SELF",
    permissions:permissionCodes({apps:["dms"],categoryContains:["warehouse","stock"],screenContains:["dispatch"],actions:["view","create","edit","update","download"]}),
    legacy:["stock.view","reports.view"],
  }),

  role({
    name:"Data Entry Operator",
    code:"DATA_ENTRY_OPERATOR",
    description:"High-volume data entry and bulk upload for permitted masters without approval authority.",
    apps:["dms"],
    dataScope:"SELF",
    permissions:permissionCodes({apps:["dms"],categoryContains:["product","crm","others","users"],actions:["view","create","edit","update","download","create"]}),
    legacy:["customers.view","customers.create","reports.view"],
  }),

  role({
    name:"HR Administrator",
    code:"HR_ADMIN",
    description:"Full HR application access including users, recruitment, attendance, payroll and HR administration.",
    apps:["hr"],
    dataScope:"COMPANY",
    permissions:hrAll(),
    legacy:["hr.employees.manage","hr.users.manage","hr.attendance.manage","hr.leave.approve","hr.payroll.manage","reports.view","reports.company"],
  }),

  role({
    name:"HR Manager",
    code:"HR_MANAGER",
    description:"Department HR, employees, recruitment, attendance, leave, performance and reports.",
    apps:["hr"],
    dataScope:"DEPARTMENT",
    permissions:permissionCodes({apps:["hr"],actions:ALL_ACTIONS}),
    legacy:["hr.employees.manage","hr.users.manage","hr.attendance.manage","hr.leave.approve","hr.payroll.manage","reports.view"],
  }),

  role({
    name:"Recruiter",
    code:"RECRUITER",
    description:"Job creation, applicants, screening, interviews, offers, training and candidate documents.",
    apps:["hr"],
    dataScope:"DEPARTMENT",
    permissions:permissionCodes({apps:["hr"],categoryContains:["recruit"],screenContains:["candidate","employee","document"],actions:ALL_ACTIONS}),
    legacy:["hr.employees.manage","reports.view"],
  }),

  role({
    name:"Attendance & Leave Manager",
    code:"ATTENDANCE_MANAGER",
    description:"Attendance, shifts, holidays, leave requests and time-sheet reporting.",
    apps:["hr"],
    dataScope:"DEPARTMENT",
    permissions:permissionCodes({apps:["hr"],categoryContains:["time","attendance"],screenContains:["leave","shift","holiday"],actions:ALL_ACTIONS}),
    legacy:["hr.attendance.manage","hr.leave.approve","reports.view"],
  }),

  role({
    name:"Payroll Manager",
    code:"PAYROLL_MANAGER",
    description:"Salary, payroll, loans, advances, employee expenses, employee ledger and payroll reports.",
    apps:["hr"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["hr"],categoryContains:["payroll","money","expenses","report"],screenContains:["salary","payslip","loan","ledger"],actions:ALL_ACTIONS}),
    legacy:["hr.payroll.manage","reports.view","reports.company"],
  }),

  role({
    name:"Production Head",
    code:"PRODUCTION_HEAD",
    description:"Full production planning, execution, quality, machines, maintenance and production reporting.",
    apps:["production"],
    dataScope:"COMPANY",
    permissions:productionAll(),
    legacy:["production.plan","production.execute","production.qc","production.maintenance","reports.view","reports.company"],
  }),

  role({
    name:"Production Manager",
    code:"PRODUCTION_MANAGER",
    description:"Department production planning, work orders, execution, stock movements and reports.",
    apps:["production"],
    dataScope:"DEPARTMENT",
    permissions:permissionCodes({apps:["production"],actions:ALL_ACTIONS}),
    legacy:["production.plan","production.execute","production.qc","production.maintenance","reports.view"],
  }),

  role({
    name:"Production Operator",
    code:"PRODUCTION_OPERATOR",
    description:"Assigned work orders, production execution, raw material, WIP and production activity.",
    apps:["production"],
    dataScope:"SELF",
    permissions:permissionCodes({apps:["production"],categoryContains:["execution","production"],screenContains:["work order","raw material","wip","start production","daily activity"],actions:["view","create","edit","update"]}),
    legacy:["production.execute"],
  }),

  role({
    name:"Quality Control Manager",
    code:"QC_MANAGER",
    description:"Incoming, in-process and finished-goods quality control with production reports.",
    apps:["production"],
    dataScope:"DEPARTMENT",
    permissions:permissionCodes({apps:["production"],categoryContains:["quality","report"],screenContains:["quality","qc","finished"],actions:ALL_ACTIONS}),
    legacy:["production.qc","reports.view"],
  }),

  role({
    name:"Maintenance Manager",
    code:"MAINTENANCE_MANAGER",
    description:"Machine master, downtime, breakdowns, maintenance schedules and maintenance reporting.",
    apps:["production"],
    dataScope:"DEPARTMENT",
    permissions:permissionCodes({apps:["production"],categoryContains:["machine","maintenance","report"],screenContains:["machine","maintenance"],actions:ALL_ACTIONS}),
    legacy:["production.maintenance","reports.view"],
  }),

  role({
    name:"Auditor / Read Only",
    code:"AUDITOR",
    description:"Read-only access with download rights to all applications enabled by the plan.",
    apps:["dms","hr","production"],
    dataScope:"COMPANY",
    permissions:permissionCodes({apps:["dms","hr","production"],actions:VIEW_ACTIONS}),
    legacy:["reports.view","accounts.view","stock.view","customers.view"],
  }),
];

export const defaultRoleTemplateCodes = defaultRoleTemplates.map(r => r.code);
