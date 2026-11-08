// Maps the CURRENT V2 pages to the exact permission screens supplied by the
// user's Roles_and_Permissions.xlsx catalogue. No new permission screen is
// introduced here. A V2 page is visible only when at least one mapped screen
// has the requested action in the user's effective permission set.

const p = (...screenKeys) => screenKeys.filter(Boolean);

export const PAGE_PERMISSION_MAP = {
  // DMS
  "/dms/dashboard": p("dms.dashboard.dashboard"),
  "/dms/targets": p(
    "dms.sales.target_creation",
    "dms.sales.customer_target_creation",
    "dms.sales.salesperson_target",
    "dms.sales.target_achieved",
    "dms.sales.achievement"
  ),
  "/dms/leads": p("dms.sales.sales_lead"),
  "/dms/customers": p("dms.users.create_customer"),
  "/dms/unassigned-customers": p("dms.users.create_customer"),
  "/dms/customer-grades": p("dms.users.create_grade"),
  "/dms/transporters": p("dms.users.create_transporter"),
  "/dms/legacy-migration": p("dms.users.create_customer", "dms.users.create_user", "dms.product.product_creation", "dms.others.units"),
  "/dms/scan-forms": p(
    "dms.users.create_customer",
    "dms.users.create_user",
    "dms.users.create_transporter",
    "dms.product.product_creation",
    "dms.purchase.purchase_invoice",
    "dms.sales.sales_lead",
    "dms.users.expense_accounts",
    "dms.sales.sales_invoice"
  ),

  "/dms/sales-orders": p(
    "dms.sales.sales_order",
    "dms.sales.place_order",
    "dms.sales.pending_order",
    "dms.sales.cancelled_order",
    "dms.sales.complete_order"
  ),
  "/dms/dispatch": p("dms.sales.dispatch_details"),
  "/dms/sales-invoices": p("dms.sales.sales_invoice", "dms.sales.select_invoice"),
  "/dms/sales-returns": p("dms.sales.sales_return"),
  "/dms/credit-notes": p("dms.sales.creditnote"),
  "/dms/delivery-notes": p("dms.sales.sales_invoice", "dms.sales.dispatch_details"),

  "/dms/purchase-request": p("dms.purchase.purchase_order", "dms.purchase.purchase_pending"),
  "/dms/rfq": p("dms.purchase.purchase_order", "dms.purchase.purchase_pending"),
  "/dms/purchase-orders": p(
    "dms.purchase.purchase_order",
    "dms.purchase.purchase_pending",
    "dms.purchase.purchase_complete"
  ),
  "/dms/grn": p("dms.purchase.purchase_pending", "dms.purchase.purchase_complete", "dms.purchase.purchase_invoice"),
  "/dms/purchase-invoices": p("dms.purchase.purchase_invoice"),
  "/dms/purchase-returns": p("dms.purchase.purchase_return"),
  "/dms/debit-notes": p("dms.purchase.debit_notes"),

  "/dms/products": p("dms.product.product_creation", "dms.others.product"),
  "/dms/product-categories": p("dms.product.category_list", "dms.product.subcategory_list"),
  "/dms/units": p("dms.others.units", "dms.others.unitlist"),
  "/dms/price-list": p("dms.product.price_list"),
  "/dms/price-management": p("dms.others.price_calculation", "dms.others.setting_discount"),
  "/dms/stock": p("dms.stock.available_stock", "dms.report.stock_report"),
  "/dms/warehouses": p("dms.warehouse.warehouselist", "dms.others.warehouse"),
  "/dms/stock-transfer": p("dms.warehouse.stock_transfer"),
  "/dms/closing-stock": p("dms.stock.closing_stock", "dms.stock_reports.closing_stock_report"),
  "/dms/stock-ageing": p("dms.stock_reports.dead_stock_report", "dms.stock.dead_party"),

  // Customer-facing issue dashboards reuse existing customer-management
  // permissions. Both routes enforce administrator scope on the API itself.
  // Keep this mapping in sync with frontend/src/config/permissionPageMap.js.
  "/dms/customer-complaints": p("dms.users.create_customer"),
  "/dms/damage-claims": p("dms.users.create_customer"),
  // Full-page posted voucher corrections: independent MASTER/Plan/Role permission.
  "/dms/transactions/voucher-edit": p("dms.transaction.voucher_edit"),
  "/dms/receipts": p("dms.transaction.receipt"),
  "/dms/cashier": p("dms.transaction.receipt", "dms.transaction.cashbook", "dms.transaction.cashaccount"),
  "/dms/payments": p("dms.transaction.payment"),
  "/dms/cashbook": p("dms.transaction.cashbook", "dms.transaction.cashaccount", "dms.transaction.receipt", "dms.transaction.payment"),
  "/dms/cheque-control": p("dms.transaction.cheque_control"),
  "/dms/banking": p("dms.finance_reports.bank_statement", "dms.transaction.cashbook", "dms.transaction.cashaccount"),
  "/dms/bank-accounts": p("dms.finance_reports.bank_statement"),
  "/dms/expenses": p("dms.users.expense_accounts"),
  "/dms/ledger": p("dms.transaction.party_ledger", "dms.finance_reports.party_ledger_report", "dms.finance_reports.partywiseledger_report"),
  "/dms/trading": p("dms.finance_reports.profit_and_loss_report"),
  "/dms/cma": p("dms.finance_reports.profit_and_loss_report", "dms.finance_reports.balancesheet"),
  "/dms/proposed-balance-sheet": p("dms.finance_reports.balancesheet"),
  "/dms/pnl": p("dms.finance_reports.profit_and_loss_report"),
  "/dms/balance-sheet": p("dms.finance_reports.balancesheet"),

  "/dms/gst-reports": p("dms.all_gstr.gstr_1", "dms.all_gstr.gstr_2b", "dms.all_gstr.gstr_3b", "dms.all_gstr.hsn_wise_report", "dms.finance_reports.tax_report"),
  "/dms/gstr1": p("dms.all_gstr.gstr_1"),
  "/dms/gstr2b": p("dms.all_gstr.gstr_2b"),
  "/dms/gstr3b": p("dms.all_gstr.gstr_3b"),
  "/dms/hsn-wise-report": p("dms.all_gstr.hsn_wise_report"),
  "/dms/gst-input-output": p("dms.all_gstr.gstr_1", "dms.all_gstr.gstr_2b"),
  "/dms/tax-report": p("dms.finance_reports.tax_report"),

  "/dms/users": p(
    "dms.users.create_user",
    "dms.users.upload_sales_person",
    "dms.others.create_department",
    "dms.others.department_role_assignment",
    "dms.others.assign_salesperson_area",
    "dms.others.view_hierarchy"
  ),
  "/dms/sales-pincode-allotment": p("dms.others.assign_salesperson_area", "dms.users.upload_sales_person", "dms.users.create_user"),
  "/dms/branches": p("dms.users.create_user", "dms.others.setting"),
  "/dms/roles": p("dms.users.roles_and_persmissions", "dms.others.role_list", "dms.others.add_new_role"),
  "/dms/departments": p("dms.others.department_role_assignment", "dms.users.create_user"),
  "/dms/department-role-assignment": p("dms.others.department_role_assignment", "dms.others.view_hierarchy"),
  "/dms/customer-approvals": p("dms.users.create_customer"),
  "/dms/company-settings": p("dms.administration.company_and_stakeholders"),
  "/dms/family": p("dms.family_accounts.family_and_individual_accounts"),
  "/dms/settings": p("dms.others.setting"),

  // HR
  "/hr/dashboard": p("dms.others.hrm"),
  "/hr/employees": p("hr.time_sheet.employeelist"),
  "/hr/users": p("dms.users.create_user"),
  "/hr/departments": p("dms.others.create_department"),
  "/hr/designations": p("dms.others.department_role_assignment"),
  "/hr/teams": p("dms.others.assign_team"),
  "/hr/hierarchy": p("dms.others.view_hierarchy"),
  "/hr/roles": p("dms.users.roles_and_persmissions", "dms.others.role_list", "dms.others.add_new_role"),
  "/hr/attendance": p("hr.time_sheet.attendance"),
  "/hr/shifts": p("hr.time_sheet.shift_list", "hr.hrm.shift_list"),
  "/hr/leave": p("hr.time_sheet.add_leave", "hr.time_sheet.manage_leave"),
  "/hr/holidays": p("hr.time_sheet.hours_and_holiday_master"),
  "/hr/payroll": p("hr.hrm.payroll", "hr.payroll.set_salary", "hr.payroll.payslip"),
  "/hr/expenses": p("hr.hrm.expenses", "hr.expenses.expenses_list"),
  "/hr/recruitment": p(
    "hr.hrm.recruitment_and_placement",
    "hr.recruitment_and_placement.job_create",
    "hr.recruitment_and_placement.job_applied_result",
    "hr.recruitment_and_placement.practice_and_skills_test",
    "hr.recruitment_and_placement.interview",
    "hr.recruitment_and_placement.offer_letter",
    "hr.recruitment_and_placement.training"
  ),
  "/hr/performance": p(
    "hr.hrm.performance",
    "hr.performance.indicator",
    "hr.performance.incentive",
    "hr.performance.bonus",
    "hr.performance.appraisal",
    "hr.performance.goal_tracking"
  ),
  "/hr/reports": p(
    "hr.hrm.reports",
    "hr.reports.attendance_report",
    "hr.reports.leave_report",
    "hr.reports.payroll_report",
    "hr.reports.timesheet_report"
  ),

  // Production
  "/production/dashboard": p("dms.others.production"),
  "/production/planning": p("production.production.production_target", "production.production.production_target_list"),
  "/production/raw-material": p("production.production.raw_products"),
  "/production/execution": p(
    "production.production.start_production",
    "production.production.production_process",
    "production.production.production_steps"
  ),
  "/production/finished-goods": p("production.production.items"),
  "/production/scrap": p("production.production.wastage_material", "production.production.material_return"),
  "/production/reports": p(
    "production.production.daily_activity_report",
    "production.production.edit_production_daily_activity_report",
    "production.production.production_target_list_detail"
  )
};

// Current report catalogue -> exact Excel permission screen(s).
export const REPORT_PERMISSION_MAP = {
  // Old DMS report catalogue — exact permission keys from Roles_and_Permissions.xlsx.
  "Stock Report": p("dms.report.stock_report"),
  "Team and Target Report": p("dms.report.team_and_target_report"),
  "Target Report": p("dms.report.target_report"),

  "GSTR 1": p("dms.all_gstr.gstr_1"),
  "GSTR 3B": p("dms.all_gstr.gstr_3b"),
  "GSTR 2B": p("dms.all_gstr.gstr_2b"),
  "HSN WISE REPORT": p("dms.all_gstr.hsn_wise_report"),

  "PRODUCT WISE PURCHASE REPORT": p("dms.purchase_reports.product_wise_purchase_report"),
  "PURCHASE ORDER REPORT": p("dms.purchase_reports.purchase_order_report"),
  "PARTY WISE AND PRODUCT WISE PURCHASE REPORT": p("dms.purchase_reports.party_wise_and_product_wise_purchase_report"),
  "Purchase Return Report": p("dms.purchase_reports.purchase_return_report"),

  "STOCK DIFFERENCE REPORT": p("dms.stock_reports.stock_difference_report"),
  "Dead Stock Report": p("dms.stock_reports.dead_stock_report"),
  "Low Stock Report": p("dms.stock_reports.low_stock_report"),
  "Closing Stock Report": p("dms.stock_reports.closing_stock_report"),
  "WareHouse Stock Shortage": p("dms.stock_reports.warehouse_stock_shortage"),
  "Damage Reports": p("dms.stock_reports.damage_reports"),
  "WareHouse Reports": p("dms.stock_reports.warehouse_reports"),
  "WareHouse Stock Report": p("dms.stock_reports.warehouse_stock_report"),

  "Dead Parties Reports": p("dms.sales_reports.dead_parties_reports"),
  "PARTY WISE AND PRODUCT WISE SALE REPORT": p("dms.sales_reports.party_wise_and_product_wise_sale_report"),
  "PRODUCT WISE SALE REPORT": p("dms.sales_reports.product_wise_sale_report"),
  "Sales Order Report": p("dms.sales_reports.sales_order_report"),
  "Sales Pending Report": p("dms.sales_reports.sales_pending_report"),
  "SalesComplete Order Report": p("dms.sales_reports.salescomplete_order_report"),
  "Delivered Order Report": p("dms.sales_reports.delivered_order_report"),
  "Sales Report and Amount": p("dms.sales_reports.sales_report_and_amount", "dms.finance_reports.sales_report_and_amount"),
  "sales Report and Amount": p("dms.finance_reports.sales_report_and_amount", "dms.sales_reports.sales_report_and_amount"),
  "Sales Return Report": p("dms.sales_reports.sales_return_report", "dms.finance_reports.sales_return_report"),
  "sales Return Report": p("dms.finance_reports.sales_return_report", "dms.sales_reports.sales_return_report"),
  "SalesTarget Report": p("dms.sales_reports.salestarget_report"),
  "Target Achieved Report": p("dms.sales_reports.target_achieved_report"),
  "Target Pending Report": p("dms.sales_reports.target_pending_report"),
  "SalesDispatch Report": p("dms.sales_reports.salesdispatch_report"),

  "Lock Party Report": p("dms.finance_reports.lock_party_report"),
  "TAX REPORT": p("dms.finance_reports.tax_report"),
  "Overdue Report": p("dms.finance_reports.overdue_report"),
  "Party Ledger Report": p("dms.finance_reports.party_ledger_report"),
  "cashbook Report": p("dms.finance_reports.cashbook_report"),
  "receipt Report": p("dms.finance_reports.receipt_report"),
  "Payment Report": p("dms.finance_reports.payment_report"),
  "Due Report": p("dms.finance_reports.due_report"),
  "Bank Statement": p("dms.finance_reports.bank_statement"),
  "PartywiseLedger Report": p("dms.finance_reports.partywiseledger_report"),
  "Profit and Loss Report": p("dms.finance_reports.profit_and_loss_report"),
  "BalanceSheet": p("dms.finance_reports.balancesheet"),
  "Promotional Activity Report": p("dms.finance_reports.promotional_activity_report"),

  "Admin Report": p("dms.reports.admin_report"),
  "Customer Report": p("dms.reports.customer_report"),
  "Staff Report": p("dms.reports.staff_report"),
  "Transaction Report": p("dms.reports.transaction_report"),
  "Product Report": p("dms.reports.product_report"),
  "Earning Report": p("dms.reports.earning_report"),

  // V2-native aliases. These reuse existing permission screens; no new permission keys are invented.
  "Sales Summary": p("dms.sales_reports.sales_report_and_amount"),
  "Sales by Product": p("dms.sales_reports.product_wise_sale_report"),
  "Product Wise Sale Report": p("dms.sales_reports.product_wise_sale_report"),
  "Sales by Customer": p("dms.sales_reports.party_wise_and_product_wise_sale_report"),
  "Party Wise and Product Wise Sale Report": p("dms.sales_reports.party_wise_and_product_wise_sale_report"),
  "Sales by Salesperson": p("dms.sales_reports.sales_report_and_amount", "dms.report.team_and_target_report"),
  "Sales by Territory": p("dms.sales_reports.sales_report_and_amount"),
  "Margin Colour Mix": p("dms.sales_reports.product_wise_sale_report"),
  "Lead Funnel": p("dms.sales.sales_lead"),
  "Lead Funnel (Current)": p("dms.sales.sales_lead"),
  "Visit Achievement": p("dms.report.team_and_target_report", "dms.sales_reports.target_achieved_report"),
  "Target Achievement": p("dms.sales_reports.target_achieved_report", "dms.report.target_report"),
  "Collection Achievement": p("dms.finance_reports.receipt_report"),
  "Dead Parties Report (No Sales in FY)": p("dms.sales_reports.dead_parties_reports"),
  "Sales Complete Order Report": p("dms.sales_reports.salescomplete_order_report"),
  "Sales Dispatch Report": p("dms.sales_reports.salesdispatch_report"),

  "Purchase Summary": p("dms.purchase_reports.product_wise_purchase_report", "dms.purchase_reports.purchase_order_report"),
  "Purchase Report and Amount": p("dms.purchase_reports.product_wise_purchase_report"),
  "Product Wise Purchase Report": p("dms.purchase_reports.product_wise_purchase_report"),
  "Party Wise and Product Wise Purchase Report": p("dms.purchase_reports.party_wise_and_product_wise_purchase_report"),
  "Purchase Order Report": p("dms.purchase_reports.purchase_order_report"),
  "Supplier Performance": p("dms.purchase_reports.party_wise_and_product_wise_purchase_report"),
  "Landed Cost Analysis": p("dms.purchase_reports.product_wise_purchase_report"),

  "Stock Summary": p("dms.report.stock_report"),
  "Inward Stock Report": p("dms.stock.inward_stock", "dms.report.stock_report"),
  "Outward Stock Report": p("dms.stock.outward_stock", "dms.report.stock_report"),
  "Stock Movement Report": p("dms.report.stock_report"),
  "Closing Stock": p("dms.stock_reports.closing_stock_report"),
  "Closing Stock Report (Live)": p("dms.stock_reports.closing_stock_report"),
  "Available Stock Report (Live)": p("dms.stock.available_stock", "dms.report.stock_report"),
  "Low Stock Report (Live)": p("dms.stock_reports.low_stock_report"),
  "Dead Stock": p("dms.stock_reports.dead_stock_report"),
  "Dead Stock Report (No Outward This FY)": p("dms.stock_reports.dead_stock_report"),
  "Stock Ageing": p("dms.stock_reports.dead_stock_report"),
  "Warehouse Stock": p("dms.stock_reports.warehouse_stock_report", "dms.stock_reports.warehouse_reports"),
  "Warehouse Movement Report": p("dms.stock_reports.warehouse_reports", "dms.warehouse.stock_transfer"),

  "Trial Balance": p("dms.finance_reports.party_ledger_report", "dms.finance_reports.balancesheet"),
  "Trial Balance (Journal Movements)": p("dms.finance_reports.party_ledger_report", "dms.finance_reports.balancesheet"),
  "Trading Account": p("dms.finance_reports.profit_and_loss_report"),
  "Profit & Loss": p("dms.finance_reports.profit_and_loss_report"),
  "Balance Sheet": p("dms.finance_reports.balancesheet"),
  "Provisional Balance Sheet": p("dms.finance_reports.balancesheet"),
  "Cash Flow": p("dms.finance_reports.cashbook_report", "dms.finance_reports.receipt_report", "dms.finance_reports.payment_report"),
  "Receipts and Payments Summary": p("dms.finance_reports.receipt_report", "dms.finance_reports.payment_report"),
  "Fund Flow": p("dms.finance_reports.cashbook_report"),
  "Expense Analysis": p("dms.finance_reports.payment_report", "dms.users.expense_accounts"),
  "Expense Report": p("dms.finance_reports.payment_report", "dms.users.expense_accounts"),
  "Break-even": p("dms.finance_reports.profit_and_loss_report"),
  "CMA Operating Statement": p("dms.finance_reports.profit_and_loss_report"),
  "CMA Balance Sheet Analysis": p("dms.finance_reports.balancesheet"),
  "Working Capital": p("dms.finance_reports.balancesheet", "dms.finance_reports.due_report", "dms.finance_reports.overdue_report"),
  "Ratio Analysis": p("dms.finance_reports.balancesheet", "dms.finance_reports.profit_and_loss_report"),
  "Party-wise Ledger Movements": p("dms.finance_reports.partywiseledger_report", "dms.finance_reports.party_ledger_report"),
  "Due / Outstanding Movements": p("dms.finance_reports.due_report", "dms.finance_reports.overdue_report"),
  "Bank Statement Report": p("dms.finance_reports.bank_statement"),
  "Bank Statement (All Submitted Rows)": p("dms.finance_reports.bank_statement"),
  "Receipt Report": p("dms.finance_reports.receipt_report"),
  "Payment Report": p("dms.finance_reports.payment_report"),
  "Cashbook Report": p("dms.finance_reports.cashbook_report"),

  "GSTR-1 Reconciliation": p("dms.all_gstr.gstr_1"),
  "GSTR-2B Reconciliation": p("dms.all_gstr.gstr_2b"),
  "GSTR-3B Reconciliation": p("dms.all_gstr.gstr_3b"),
  "GSTR-9 Annual Reconciliation": p("dms.all_gstr.gstr_1", "dms.all_gstr.gstr_2b", "dms.all_gstr.gstr_3b"),
  "GST Compliance Health": p("dms.all_gstr.gstr_1", "dms.all_gstr.gstr_2b", "dms.all_gstr.gstr_3b", "dms.finance_reports.tax_report"),
  "GSTR-1": p("dms.all_gstr.gstr_1"),
  "GSTR-2B": p("dms.all_gstr.gstr_2b"),
  "GSTR-3B": p("dms.all_gstr.gstr_3b"),
  "HSN Wise Report": p("dms.all_gstr.hsn_wise_report"),
  "GST Input / Output": p("dms.all_gstr.gstr_1", "dms.all_gstr.gstr_2b", "dms.finance_reports.tax_report"),
  "Tax Report": p("dms.finance_reports.tax_report"),

  "Customer Health": p("dms.reports.customer_report", "dms.finance_reports.due_report", "dms.finance_reports.overdue_report"),
  "Customer Health (Current)": p("dms.reports.customer_report", "dms.finance_reports.due_report", "dms.finance_reports.overdue_report"),
  "Customer Credit Exposure": p("dms.finance_reports.overdue_report", "dms.finance_reports.due_report"),
  "Customer Credit Exposure (FY Movements)": p("dms.finance_reports.overdue_report", "dms.finance_reports.due_report"),
  "Customer Rating Trend": p("dms.reports.customer_report"),
  "Customer Master Report": p("dms.reports.customer_report"),
  "Receipt & Bounce": p("dms.finance_reports.receipt_report"),
  "Transporter Network": p("dms.users.create_transporter", "dms.warehouse.dispatch_detail"),
  "Transporter Network (Current)": p("dms.users.create_transporter", "dms.warehouse.dispatch_detail"),
  "Product Master and Price List (Current)": p("dms.reports.product_report", "dms.product.price_list"),
  "Barcode Registry": p("dms.reports.product_report", "dms.product.product_creation"),
  "Barcode Registry (Current)": p("dms.reports.product_report", "dms.product.product_creation"),

  "HR Attendance": p("hr.reports.attendance_report"),
  "HR Payroll": p("hr.reports.payroll_report"),
  "HR Leave": p("hr.reports.leave_report"),
  "Staff List (Current)": p("dms.reports.staff_report", "hr.reports.attendance_report"),

  "Production Plan vs Actual": p("production.production.daily_activity_report"),
  "Production Efficiency": p("production.production.daily_activity_report"),
  "Production Execution": p("production.production.daily_activity_report"),
  "WIP": p("production.production.production_target_list_detail"),
  "Production WIP": p("production.production.production_target_list_detail"),
  "QC & Rejection": p("production.production.daily_activity_report"),
  "Production Quality Control": p("production.production.daily_activity_report"),
  "Machine Downtime": p("production.production.daily_activity_report"),
  "Machine Maintenance": p("production.production.daily_activity_report"),

  "Family Net Worth": p("dms.family_accounts.family_and_individual_accounts"),
  "Family Cash Flow": p("dms.family_accounts.family_and_individual_accounts"),
  "Storage Usage": p("dms.administration.company_and_stakeholders", "dms.reports.admin_report"),
  "Audit Trail": p("dms.reports.admin_report"),
  "Executive Company Health": p("dms.reports.admin_report", "dms.finance_reports.profit_and_loss_report", "dms.finance_reports.balancesheet")
};

export const REPORT_SCREEN_KEYS = Array.from(
  new Set(Object.values(REPORT_PERMISSION_MAP).flat())
);

export const actionCode = (screenKey, action) => `${screenKey}.${action}`;

export function canScreenAction(permissions = [], screenKeys = [], action = "view") {
  const set = permissions instanceof Set ? permissions : new Set(permissions || []);
  if (set.has("*")) return true;
  return (screenKeys || []).some((key) => set.has(actionCode(key, action)));
}

export function canPageAction(permissions = [], path, action = "view") {
  if (path === "/dms/reports") {
    const reportAction = ["download", "screenshot", "print"].includes(action) ? action : "view";
    return canScreenAction(permissions, REPORT_SCREEN_KEYS, reportAction);
  }
  return canScreenAction(permissions, PAGE_PERMISSION_MAP[path] || [], action);
}

export function buildPageAccess(permissions = []) {
  const result = {};
  for (const path of Object.keys(PAGE_PERMISSION_MAP)) {
    result[path] = {
      view: canPageAction(permissions, path, "view"),
      edit: canPageAction(permissions, path, "edit"),
      create: canPageAction(permissions, path, "create"),
      delete: canPageAction(permissions, path, "delete"),
      download: canPageAction(permissions, path, "download"),
      screenshot: canPageAction(permissions, path, "screenshot"),
      print: canPageAction(permissions, path, "print")
    };
  }
  result["/dms/reports"] = {
    view: canPageAction(permissions, "/dms/reports", "view"),
    edit: false,
    create: false,
    delete: false,
    download: canPageAction(permissions, "/dms/reports", "download"),
    screenshot: canPageAction(permissions, "/dms/reports", "screenshot"),
    print: canPageAction(permissions, "/dms/reports", "print")
  };
  return result;
}

export function firstAllowedPath(pageAccess = {}) {
  const priority = [
    "/dms/dashboard",
    "/dms/customers",
    "/dms/products",
    "/dms/sales-invoices",
    "/dms/sales-orders",
    "/dms/stock",
    "/dms/reports",
    "/hr/dashboard",
    "/hr/employees",
    "/hr/recruitment",
    "/production/dashboard",
    "/production/execution"
  ];
  for (const path of priority) if (pageAccess[path]?.view) return path;
  return Object.keys(pageAccess).find((path) => pageAccess[path]?.view) || "/no-access";
}

export function reportAccessForPermissions(permissions = []) {
  const result = {};
  for (const [name, screenKeys] of Object.entries(REPORT_PERMISSION_MAP)) {
    result[name] = {
      view: canScreenAction(permissions, screenKeys, "view"),
      download: canScreenAction(permissions, screenKeys, "download")
    };
  }
  return result;
}

// Generic module resource mapping used by the backend API guard.
export const GENERIC_RESOURCE_PAGE_MAP = Object.fromEntries(
  Object.keys(PAGE_PERMISSION_MAP)
    .filter((path) => /^\/(dms|hr|production)\//.test(path))
    .map((path) => {
      const [, app, ...parts] = path.split("/");
      return [`${app}:${parts.join("-")}`, path];
    })
);
