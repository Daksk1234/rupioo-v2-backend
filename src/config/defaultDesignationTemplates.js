import { permissionCatalogue } from "./permissionCatalogue.js";

export const MASTER_DESIGNATION_TENANT = "__MASTER_DESIGNATION_TEMPLATES__";
export const DATA_SCOPES = ["SELF","ASSIGNED","TEAM","TERRITORY","WAREHOUSE","BRANCH","DEPARTMENT","COMPANY","ALL"];

const uniq = (values=[]) => Array.from(new Set(values.filter(Boolean)));
const lower = (v) => String(v || "").toLowerCase();

const codes = ({
  apps = [],
  categoryContains = [],
  screenContains = [],
  screenKeys = [],
  actions = [],
  excludeScreenContains = [],
} = {}) => {
  const appSet = new Set(apps);
  const keySet = new Set(screenKeys);
  const actionSet = new Set(actions);
  const cats = categoryContains.map(lower);
  const screens = screenContains.map(lower);
  const excludes = excludeScreenContains.map(lower);
  const out = [];

  for (const group of permissionCatalogue) {
    if (appSet.size && !appSet.has(group.app)) continue;
    const cat = lower(group.category);
    const catMatch = !cats.length || cats.some((x) => cat.includes(x));
    for (const screen of group.screens || []) {
      const text = lower(`${screen.label} ${screen.key} ${screen.path || ""}`);
      if (excludes.some((x) => text.includes(x))) continue;
      const screenMatch = !screens.length || screens.some((x) => text.includes(x));
      const keyMatch = !keySet.size || keySet.has(screen.key);
      if (!catMatch || !screenMatch || !keyMatch) continue;
      for (const action of screen.allowedActions || []) {
        if (actionSet.size && !actionSet.has(action)) continue;
        out.push(`${screen.key}.${action}`);
      }
    }
  }
  return uniq(out);
};

const role = ({
  name, code, department, apps=["dms"], dataScope="SELF", allowedScopes,
  permissions=[], fieldAccess={}, workflowTransitions={}, approvalLimits={}, description=""
}) => ({
  name, code, department, apps, dataScope,
  allowedScopes: allowedScopes?.length ? allowedScopes : [dataScope, "SELF"],
  permissions: uniq(permissions), fieldAccess, workflowTransitions,
  approvalLimits: {
    discountPct: Number(approvalLimits.discountPct || 0),
    creditAmount: Number(approvalLimits.creditAmount || 0),
    orderAmount: Number(approvalLimits.orderAmount || 0),
  },
  description, status:"ACTIVE", templateVersion:1,
});

const viewDownload = ["view","download","print","export"];
const operate = ["view","create","edit","update","process","download","print","export","view_price"];
const manage = ["view","create","edit","update","delete","download","create","approve","cancel","process","assign","reassign","print","export","view_price","view_cost","view_profit","view_ledger","view_sensitive"];

const companyOperational = codes({apps:["dms","hr","production"],actions:manage});
const dmsOperational = codes({apps:["dms"],actions:manage});

export const defaultDesignationTemplates = [
  role({
    name:"Management / Company Administrator", code:"COMPANY_MANAGEMENT", department:"Management",
    apps:["dms","hr","production"], dataScope:"COMPANY", allowedScopes:["COMPANY","DEPARTMENT","BRANCH","TEAM","SELF"],
    permissions:companyOperational,
    approvalLimits:{discountPct:100,creditAmount:999999999,orderAmount:999999999},
    description:"Company-wide operational ceiling. MASTER-only platform powers are never included."
  }),
  role({
    name:"Accounts Head", code:"ACCOUNTS_HEAD", department:"Accounts", apps:["dms"], dataScope:"COMPANY",
    allowedScopes:["COMPANY","BRANCH","DEPARTMENT","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["account","finance","transaction","bank","gst","report"],actions:manage}),
      ...codes({apps:["dms"],screenContains:["customer approval","customer","supplier"],actions:["view","approve","edit","update","view_ledger","view_sensitive","download","print","export"]}),
    ]),
    approvalLimits:{discountPct:20,creditAmount:10000000,orderAmount:0},
    description:"Accounting, banking, GST, customer-credit approval and statutory reporting."
  }),
  role({
    name:"Accountant", code:"ACCOUNTANT", department:"Accounts", apps:["dms"], dataScope:"COMPANY",
    allowedScopes:["COMPANY","BRANCH","DEPARTMENT","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["account","finance","transaction","bank","gst"],actions:["view","create","edit","update","process","download","print","export","view_ledger","view_sensitive"]}),
      ...codes({apps:["dms"],screenContains:["customer","supplier"],actions:["view","view_ledger","download","print","export"]}),
    ]),
    description:"Day-to-day accounting without MASTER or destructive posted-entry powers."
  }),
  role({
    name:"Sales Head", code:"SALES_HEAD", department:"Sales", apps:["dms"], dataScope:"COMPANY",
    allowedScopes:["COMPANY","BRANCH","TEAM","TERRITORY","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["sales","crm"],actions:manage}),
      ...codes({apps:["dms"],screenContains:["target","customer","lead","visit","collection","receipt"],actions:manage}),
      ...codes({apps:["dms"],categoryContains:["sales report"],actions:viewDownload}),
    ]),
    approvalLimits:{discountPct:25,creditAmount:5000000,orderAmount:10000000},
    description:"Company sales leadership, targets, approvals, customers and team performance."
  }),
  role({
    name:"Sales Manager", code:"SALES_MANAGER", department:"Sales", apps:["dms"], dataScope:"TEAM",
    allowedScopes:["TEAM","TERRITORY","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["sales","crm"],actions:["view","create","edit","update","process","assign","reassign","download","print","export","view_price","approve"]}),
      ...codes({apps:["dms"],screenContains:["target","customer","lead","visit","collection"],actions:["view","create","edit","update","assign","reassign","approve","download","print","export"]}),
    ]),
    approvalLimits:{discountPct:10,creditAmount:1000000,orderAmount:2500000},
    description:"Own team/territory only. No company-wide financial or purchase-cost visibility."
  }),
  role({
    name:"Sales Person", code:"SALES_PERSON", department:"Sales", apps:["dms"], dataScope:"SELF",
    allowedScopes:["SELF","ASSIGNED","TERRITORY"],
    permissions:uniq([
      ...codes({apps:["dms"],screenContains:["customer","lead","visit","quotation","sales order","sales invoice","receipt","collection","target"],actions:["view","create","edit","update","process","download","print","view_price"]}),
    ]),
    fieldAccess:{
      product:{deny:["landedCost","averagePurchasePrice","lastPurchasePrice"]},
      salesInvoice:{deny:["grossProfit","grossMarginPct","landedCost","averagePurchasePrice"]},
      customer:{deny:["approvedTerms.creditLimit","companyHealth.internalNotes"]}
    },
    approvalLimits:{discountPct:3,creditAmount:0,orderAmount:500000},
    description:"Own/assigned customers, leads, visits, orders and collections only."
  }),
  role({
    name:"Collection Executive", code:"COLLECTION_EXECUTIVE", department:"Sales", apps:["dms"], dataScope:"ASSIGNED",
    allowedScopes:["ASSIGNED","SELF","TERRITORY"],
    permissions:codes({apps:["dms"],screenContains:["receipt","collection","customer","outstanding","overdue","visit"],actions:["view","create","edit","update","process","download","print","view_ledger"]}),
    description:"Assigned collection/customer work only; no full accounting or company reports."
  }),
  role({
    name:"Purchase Head", code:"PURCHASE_HEAD", department:"Purchase", apps:["dms"], dataScope:"COMPANY",
    allowedScopes:["COMPANY","BRANCH","DEPARTMENT","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["purchase"],actions:manage}),
      ...codes({apps:["dms"],screenContains:["supplier","product","stock","landed"],actions:["view","download","print","export","view_cost","view_price"]}),
    ]),
    approvalLimits:{orderAmount:10000000},
    description:"Purchase planning, approval, invoices and supplier/landed-cost visibility."
  }),
  role({
    name:"Purchase Executive", code:"PURCHASE_EXECUTIVE", department:"Purchase", apps:["dms"], dataScope:"ASSIGNED",
    allowedScopes:["ASSIGNED","SELF","DEPARTMENT"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["purchase"],actions:operate}),
      ...codes({apps:["dms"],screenContains:["supplier","product","stock"],actions:["view","download","print","view_cost","view_price"]}),
    ]),
    approvalLimits:{orderAmount:1000000},
    description:"Assigned purchase operations; approval remains with authorised senior roles."
  }),
  role({
    name:"Warehouse Incharge", code:"WAREHOUSE_INCHARGE", department:"Warehouse", apps:["dms"], dataScope:"WAREHOUSE",
    allowedScopes:["WAREHOUSE","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["warehouse","stock & warehouse","stock"],actions:["view","create","edit","update","process","download","print","export"]}),
      ...codes({apps:["dms"],screenKeys:["dms.sales.sales_invoice","dms.sales.sales_invoices"],actions:["view","process","download","print"]}),
      ...codes({apps:["dms"],screenKeys:["dms.sales.dispatch","dms.sales.dispatch_details"],actions:["view","process","update","download","print"]}),
    ]),
    fieldAccess:{
      salesInvoice:{
        allow:["invoiceNo","date","customerNameSnapshot","addressSnapshot","items.productId","items.qty","items.basicUnit","items.packingUnit","items.qtyInBag","items.grossPack","items.mrp","noOfPackages","deliveryBoy","remarks","workflowStatus"],
        deny:["grossProfit","grossMarginPct","landedCost","averagePurchasePrice","creditLimit","ledger"]
      },
      product:{allow:["sku","name","basicUnit","packingUnit","qtyInBag","currentStock","mrp"],deny:["lastPurchasePrice","averagePurchasePrice","landedCost","minimumProfitPct"]}
    },
    workflowTransitions:{
      salesInvoice:["RELEASED_TO_WAREHOUSE>PICKING","PICKING>PACKED","PACKED>READY_FOR_DISPATCH"]
    },
    description:"Only bills released to the user's warehouse plus warehouse stock/work queue. No all-orders, pending/delivered sales reports, cost, profit or ledger visibility."
  }),
  role({
    name:"Warehouse Executive", code:"WAREHOUSE_EXECUTIVE", department:"Warehouse", apps:["dms"], dataScope:"WAREHOUSE",
    allowedScopes:["WAREHOUSE","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],categoryContains:["warehouse"],actions:["view","create","update","process","download","print"]}),
      ...codes({apps:["dms"],screenContains:["current stock","available stock","stock transfer"],actions:["view","update","process","download","print"]}),
      ...codes({apps:["dms"],screenKeys:["dms.sales.sales_invoice","dms.sales.sales_invoices"],actions:["view","process","print"]}),
    ]),
    fieldAccess:{salesInvoice:{deny:["grossProfit","grossMarginPct","landedCost","averagePurchasePrice"]},product:{deny:["lastPurchasePrice","averagePurchasePrice","landedCost","minimumProfitPct"]}},
    workflowTransitions:{salesInvoice:["RELEASED_TO_WAREHOUSE>PICKING","PICKING>PACKED"]},
    description:"Warehouse execution for assigned warehouse only."
  }),
  role({
    name:"Dispatch Manager", code:"DISPATCH_MANAGER", department:"Dispatch", apps:["dms"], dataScope:"BRANCH",
    allowedScopes:["BRANCH","WAREHOUSE","ASSIGNED","SELF"],
    permissions:uniq([
      ...codes({apps:["dms"],screenContains:["dispatch","sales invoice"],actions:["view","process","update","assign","reassign","download","print"]}),
      ...codes({apps:["dms"],screenContains:["stock","warehouse"],actions:["view","download","print"]}),
    ]),
    workflowTransitions:{salesInvoice:["READY_FOR_DISPATCH>DISPATCHED"]},
    description:"Dispatch-only control for the assigned branch/warehouse."
  }),
  role({
    name:"Data Entry Operator", code:"DATA_ENTRY_OPERATOR", department:"Administration", apps:["dms"], dataScope:"ASSIGNED",
    allowedScopes:["ASSIGNED","SELF"],
    permissions:codes({apps:["dms"],categoryContains:["product","crm","others","users"],actions:["view","create","edit","update","download","create"]}),
    description:"Bulk/master data entry without approvals or sensitive financial visibility."
  }),
  role({
    name:"HR Executive", code:"HR_EXECUTIVE", department:"HR", apps:["hr"], dataScope:"DEPARTMENT",
    allowedScopes:["DEPARTMENT","SELF"],
    permissions:codes({apps:["hr"],screenContains:["employee","attendance","leave","candidate","recruit","document"],actions:["view","create","edit","update","process","download","print","export","view_sensitive"]}),
    description:"HR operations excluding payroll administration unless separately permitted by role."
  }),
  role({
    name:"HR Manager", code:"HR_MANAGER", department:"HR", apps:["hr"], dataScope:"DEPARTMENT",
    allowedScopes:["DEPARTMENT","COMPANY","SELF"],
    permissions:codes({apps:["hr"],actions:manage}),
    description:"HR department administration and approvals."
  }),
  role({
    name:"Recruiter", code:"RECRUITER", department:"HR", apps:["hr"], dataScope:"DEPARTMENT",
    allowedScopes:["DEPARTMENT","SELF"],
    permissions:codes({apps:["hr"],screenContains:["recruit","candidate","job","interview","offer"],actions:manage}),
    description:"Recruitment pipeline only."
  }),
  role({
    name:"Payroll Manager", code:"PAYROLL_MANAGER", department:"HR", apps:["hr"], dataScope:"COMPANY",
    allowedScopes:["COMPANY","DEPARTMENT","SELF"],
    permissions:codes({apps:["hr"],screenContains:["payroll","salary","payslip","loan","advance","ledger","expense"],actions:manage}),
    description:"Payroll, statutory salary and employee-money records."
  }),
  role({
    name:"Production Manager", code:"PRODUCTION_MANAGER", department:"Production", apps:["production"], dataScope:"DEPARTMENT",
    allowedScopes:["DEPARTMENT","BRANCH","SELF"],
    permissions:codes({apps:["production"],actions:manage}),
    description:"Production planning/execution within the assigned department/site."
  }),
  role({
    name:"Production Operator", code:"PRODUCTION_OPERATOR", department:"Production", apps:["production"], dataScope:"ASSIGNED",
    allowedScopes:["ASSIGNED","SELF"],
    permissions:codes({apps:["production"],screenContains:["work order","production","raw material","wip","daily activity"],actions:["view","create","edit","update","process"]}),
    description:"Assigned work orders and production execution only."
  }),
  role({
    name:"QC Incharge", code:"QC_INCHARGE", department:"Quality", apps:["production"], dataScope:"DEPARTMENT",
    allowedScopes:["DEPARTMENT","ASSIGNED","SELF"],
    permissions:codes({apps:["production"],screenContains:["quality","qc","finished"],actions:["view","create","edit","update","process","approve","download","print","export"]}),
    description:"Quality-control work and approval within the assigned production department."
  }),
  role({
    name:"Maintenance Incharge", code:"MAINTENANCE_INCHARGE", department:"Maintenance", apps:["production"], dataScope:"DEPARTMENT",
    allowedScopes:["DEPARTMENT","ASSIGNED","SELF"],
    permissions:codes({apps:["production"],screenContains:["machine","maintenance","breakdown","downtime"],actions:["view","create","edit","update","process","assign","download","print","export"]}),
    description:"Machine maintenance, breakdowns and assigned maintenance work."
  }),
  role({
    name:"Auditor / Read Only", code:"AUDITOR", department:"Audit", apps:["dms","hr","production"], dataScope:"COMPANY",
    allowedScopes:["COMPANY","BRANCH","DEPARTMENT","SELF"],
    permissions:codes({apps:["dms","hr","production"],actions:viewDownload}),
    description:"Read/download/print/export only; no create/update/process/approve powers."
  }),
];

export const findDefaultDesignation = (code) => defaultDesignationTemplates.find((x) => x.code === String(code || "").toUpperCase());
