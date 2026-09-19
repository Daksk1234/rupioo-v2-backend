// Permission catalogue generated ONLY from the user's Roles_and_Permissions.xlsx.
// No extra V2 screens are included except:
//   1) Family & Individual Accounts
//   2) Company & Stakeholders
//
// V15 standardized action columns across every screen:
// View, Edit, Create, Delete, Download, Screenshot, Print.

export const PERMISSION_ACTIONS = [
  { key: "view", label: "View" },
  { key: "edit", label: "Edit" },
  { key: "create", label: "Create" },
  { key: "delete", label: "Delete" },
  { key: "download", label: "Download" },
  { key: "screenshot", label: "Screenshot" },
  { key: "print", label: "Print" }
];

export const permissionCatalogue = [
  {
    "app": "dms",
    "category": "Dashboard",
    "screens": [
      {
        "key": "dms.dashboard.dashboard",
        "label": "Dashboard",
        "allowedActions": [
          "view",
          "download",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Dashboard > Dashboard"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Users",
    "screens": [
      {
        "key": "dms.users.create_user",
        "label": "Create User",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Create User"
      },
      {
        "key": "dms.users.create_superadmin",
        "label": "Create SuperAdmin",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Create SuperAdmin"
      },
      {
        "key": "dms.users.expense_accounts",
        "label": "Expense Accounts",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Expense Accounts"
      },
      {
        "key": "dms.users.plan_request",
        "label": "Plan Request",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Plan Request"
      },
      {
        "key": "dms.users.emergency_invoice_request",
        "label": "Emergency Invoice Request",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Emergency Invoice Request"
      },
      {
        "key": "dms.users.subscription_plan",
        "label": "Subscription Plan",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Subscription Plan"
      },
      {
        "key": "dms.users.roles_and_persmissions",
        "label": "Roles and Persmissions",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Roles and Persmissions"
      },
      {
        "key": "dms.users.superadmin_list",
        "label": "SuperAdmin List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > SuperAdmin List"
      },
      {
        "key": "dms.users.superadmin_with_user",
        "label": "SuperAdmin With User",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > SuperAdmin With User"
      },
      {
        "key": "dms.users.superadmin_with_customer",
        "label": "SuperAdmin With Customer",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > SuperAdmin With Customer"
      },
      {
        "key": "dms.users.upload_sales_person",
        "label": "Upload Sales Person",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Upload Sales Person"
      },
      {
        "key": "dms.users.create_customer",
        "label": "Create Customer",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Create Customer"
      },
      {
        "key": "dms.users.create_grade",
        "label": "Create Grade",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Create Grade"
      },
      {
        "key": "dms.users.create_transporter",
        "label": "Create Transporter",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Create Transporter"
      },
      {
        "key": "dms.users.customize_uniqueid",
        "label": "Customize UniqueId",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Users > Customize UniqueId"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Sales",
    "screens": [
      {
        "key": "dms.sales.select_invoice",
        "label": "Select Invoice",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Select Invoice"
      },
      {
        "key": "dms.sales.sales_invoice",
        "label": "Sales Invoice",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Sales Invoice"
      },
      {
        "key": "dms.sales.sales_order",
        "label": "Sales Order",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Sales Order"
      },
      {
        "key": "dms.sales.place_order",
        "label": "Place Order",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Place Order"
      },
      {
        "key": "dms.sales.pending_order",
        "label": "Pending Order",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Pending Order"
      },
      {
        "key": "dms.sales.cancelled_order",
        "label": "Cancelled Order",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Cancelled Order"
      },
      {
        "key": "dms.sales.complete_order",
        "label": "Complete Order",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Complete Order"
      },
      {
        "key": "dms.sales.dispatch_details",
        "label": "Dispatch details",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Dispatch details"
      },
      {
        "key": "dms.sales.sales_return",
        "label": "Sales Return",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Sales Return"
      },
      {
        "key": "dms.sales.target_creation",
        "label": "Target Creation",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Target Creation"
      },
      {
        "key": "dms.sales.customer_target_creation",
        "label": "Customer Target Creation",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Customer Target Creation"
      },
      {
        "key": "dms.sales.salesperson_target",
        "label": "Salesperson Target",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Salesperson Target"
      },
      {
        "key": "dms.sales.target_achieved",
        "label": "Target Achieved",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Target Achieved"
      },
      {
        "key": "dms.sales.promotional_activity",
        "label": "Promotional Activity",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Promotional Activity"
      },
      {
        "key": "dms.sales.auto_billing_lock",
        "label": "Auto Billing Lock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Auto Billing Lock"
      },
      {
        "key": "dms.sales.achievement",
        "label": "Achievement",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Achievement"
      },
      {
        "key": "dms.sales.creditnote",
        "label": "CreditNote",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > CreditNote"
      },
      {
        "key": "dms.sales.sales_lead",
        "label": "Sales Lead",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales > Sales Lead"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Purchase",
    "screens": [
      {
        "key": "dms.purchase.purchase_order",
        "label": "Purchase Order",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Purchase Order"
      },
      {
        "key": "dms.purchase.purchase_pending",
        "label": "Purchase Pending",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Purchase Pending"
      },
      {
        "key": "dms.purchase.purchase_complete",
        "label": "Purchase Complete",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Purchase Complete"
      },
      {
        "key": "dms.purchase.purchase_invoice",
        "label": "Purchase Invoice",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Purchase Invoice"
      },
      {
        "key": "dms.purchase.purchase_damage",
        "label": "Purchase Damage",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Purchase Damage"
      },
      {
        "key": "dms.purchase.debit_notes",
        "label": "Debit Notes",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Debit Notes"
      },
      {
        "key": "dms.purchase.purchase_return",
        "label": "Purchase Return",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase > Purchase Return"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Transaction",
    "screens": [
      {
        "key": "dms.transaction.receipt",
        "label": "Receipt",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Transaction > Receipt"
      },
      {
        "key": "dms.transaction.payment",
        "label": "Payment",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Transaction > Payment"
      },
      {
        "key": "dms.transaction.cashbook",
        "label": "Cashbook",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Transaction > Cashbook"
      },
      {
        "key": "dms.transaction.cashaccount",
        "label": "CashAccount",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Transaction > CashAccount"
      },
      {
        "key": "dms.transaction.party_ledger",
        "label": "Party Ledger",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Transaction > Party Ledger"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Report",
    "screens": [
      {
        "key": "dms.report.stock_report",
        "label": "Stock Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Report > Stock Report"
      },
      {
        "key": "dms.report.team_and_target_report",
        "label": "Team and Target Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Report > Team and Target Report"
      },
      {
        "key": "dms.report.target_report",
        "label": "Target Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Report > Target Report"
      }
    ]
  },
  {
    "app": "dms",
    "category": "All GSTR",
    "screens": [
      {
        "key": "dms.all_gstr.gstr_1",
        "label": "GSTR 1",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "All GSTR > GSTR 1"
      },
      {
        "key": "dms.all_gstr.gstr_3b",
        "label": "GSTR 3B",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "All GSTR > GSTR 3B"
      },
      {
        "key": "dms.all_gstr.gstr_2b",
        "label": "GSTR 2B",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "All GSTR > GSTR 2B"
      },
      {
        "key": "dms.all_gstr.hsn_wise_report",
        "label": "HSN WISE REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "All GSTR > HSN WISE REPORT"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Purchase Reports",
    "screens": [
      {
        "key": "dms.purchase_reports.product_wise_purchase_report",
        "label": "PRODUCT WISE PURCHASE REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase Reports > PRODUCT WISE PURCHASE REPORT"
      },
      {
        "key": "dms.purchase_reports.purchase_order_report",
        "label": "PURCHASE ORDER REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase Reports > PURCHASE ORDER REPORT"
      },
      {
        "key": "dms.purchase_reports.party_wise_and_product_wise_purchase_report",
        "label": "PARTY WISE AND PRODUCT WISE PURCHASE REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase Reports > PARTY WISE AND PRODUCT WISE PURCHASE REPORT"
      },
      {
        "key": "dms.purchase_reports.purchase_return_report",
        "label": "Purchase Return Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Purchase Reports > Purchase Return Report"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Stock Reports",
    "screens": [
      {
        "key": "dms.stock_reports.stock_difference_report",
        "label": "STOCK DIFFERENCE REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > STOCK DIFFERENCE REPORT"
      },
      {
        "key": "dms.stock_reports.dead_stock_report",
        "label": "Dead Stock Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > Dead Stock Report"
      },
      {
        "key": "dms.stock_reports.low_stock_report",
        "label": "Low Stock Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > Low Stock Report"
      },
      {
        "key": "dms.stock_reports.closing_stock_report",
        "label": "Closing Stock Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > Closing Stock Report"
      },
      {
        "key": "dms.stock_reports.warehouse_stock_shortage",
        "label": "WareHouse Stock Shortage",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > WareHouse Stock Shortage"
      },
      {
        "key": "dms.stock_reports.damage_reports",
        "label": "Damage Reports",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > Damage Reports"
      },
      {
        "key": "dms.stock_reports.warehouse_reports",
        "label": "WareHouse Reports",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > WareHouse Reports"
      },
      {
        "key": "dms.stock_reports.warehouse_stock_report",
        "label": "WareHouse Stock Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock Reports > WareHouse Stock Report"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Sales Reports",
    "screens": [
      {
        "key": "dms.sales_reports.dead_parties_reports",
        "label": "Dead Parties Reports",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Dead Parties Reports"
      },
      {
        "key": "dms.sales_reports.party_wise_and_product_wise_sale_report",
        "label": "PARTY WISE AND PRODUCT WISE SALE REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > PARTY WISE AND PRODUCT WISE SALE REPORT"
      },
      {
        "key": "dms.sales_reports.product_wise_sale_report",
        "label": "PRODUCT WISE SALE REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > PRODUCT WISE SALE REPORT"
      },
      {
        "key": "dms.sales_reports.sales_order_report",
        "label": "Sales Order Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Sales Order Report"
      },
      {
        "key": "dms.sales_reports.sales_pending_report",
        "label": "Sales Pending Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Sales Pending Report"
      },
      {
        "key": "dms.sales_reports.salescomplete_order_report",
        "label": "SalesComplete Order Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > SalesComplete Order Report"
      },
      {
        "key": "dms.sales_reports.delivered_order_report",
        "label": "Delivered Order Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Delivered Order Report"
      },
      {
        "key": "dms.sales_reports.sales_report_and_amount",
        "label": "Sales Report and Amount",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Sales Report and Amount"
      },
      {
        "key": "dms.sales_reports.sales_return_report",
        "label": "Sales Return Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Sales Return Report"
      },
      {
        "key": "dms.sales_reports.salestarget_report",
        "label": "SalesTarget Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > SalesTarget Report"
      },
      {
        "key": "dms.sales_reports.target_achieved_report",
        "label": "Target Achieved Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Target Achieved Report"
      },
      {
        "key": "dms.sales_reports.target_pending_report",
        "label": "Target Pending Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > Target Pending Report"
      },
      {
        "key": "dms.sales_reports.salesdispatch_report",
        "label": "SalesDispatch Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Sales Reports > SalesDispatch Report"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Finance Reports",
    "screens": [
      {
        "key": "dms.finance_reports.lock_party_report",
        "label": "Lock Party Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Lock Party Report"
      },
      {
        "key": "dms.finance_reports.tax_report",
        "label": "TAX REPORT",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > TAX REPORT"
      },
      {
        "key": "dms.finance_reports.overdue_report",
        "label": "Overdue Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Overdue Report"
      },
      {
        "key": "dms.finance_reports.party_ledger_report",
        "label": "Party Ledger Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Party Ledger Report"
      },
      {
        "key": "dms.finance_reports.cashbook_report",
        "label": "cashbook Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > cashbook Report"
      },
      {
        "key": "dms.finance_reports.receipt_report",
        "label": "receipt Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > receipt Report"
      },
      {
        "key": "dms.finance_reports.payment_report",
        "label": "Payment Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Payment Report"
      },
      {
        "key": "dms.finance_reports.due_report",
        "label": "Due Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Due Report"
      },
      {
        "key": "dms.finance_reports.sales_report_and_amount",
        "label": "sales Report and Amount",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > sales Report and Amount"
      },
      {
        "key": "dms.finance_reports.sales_return_report",
        "label": "sales Return Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > sales Return Report"
      },
      {
        "key": "dms.finance_reports.bank_statement",
        "label": "Bank Statement",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Bank Statement"
      },
      {
        "key": "dms.finance_reports.partywiseledger_report",
        "label": "PartywiseLedger Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > PartywiseLedger Report"
      },
      {
        "key": "dms.finance_reports.profit_and_loss_report",
        "label": "Profit and Loss Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Profit and Loss Report"
      },
      {
        "key": "dms.finance_reports.balancesheet",
        "label": "BalanceSheet",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > BalanceSheet"
      },
      {
        "key": "dms.finance_reports.promotional_activity_report",
        "label": "Promotional Activity Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Finance Reports > Promotional Activity Report"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Stock",
    "screens": [
      {
        "key": "dms.stock.inward_stock",
        "label": "Inward Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Inward Stock"
      },
      {
        "key": "dms.stock.outward_stock",
        "label": "Outward Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Outward Stock"
      },
      {
        "key": "dms.stock.available_stock",
        "label": "Available Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Available Stock"
      },
      {
        "key": "dms.stock.closing_stock",
        "label": "Closing Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Closing Stock"
      },
      {
        "key": "dms.stock.opening_stock",
        "label": "Opening Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Opening Stock"
      },
      {
        "key": "dms.stock.low_stock",
        "label": "Low Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Low Stock"
      },
      {
        "key": "dms.stock.damaged_stock",
        "label": "Damaged Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Damaged Stock"
      },
      {
        "key": "dms.stock.overdue_stock",
        "label": "OverDue Stock",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > OverDue Stock"
      },
      {
        "key": "dms.stock.dead_party",
        "label": "Dead Party",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Stock > Dead Party"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Product",
    "screens": [
      {
        "key": "dms.product.category_list",
        "label": "Category List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Product > Category List"
      },
      {
        "key": "dms.product.subcategory_list",
        "label": "subCategory List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Product > subCategory List"
      },
      {
        "key": "dms.product.product_creation",
        "label": "Product Creation",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Product > Product Creation"
      },
      {
        "key": "dms.product.price_list",
        "label": "Price List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Product > Price List"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Warehouse",
    "screens": [
      {
        "key": "dms.warehouse.warehouselist",
        "label": "WarehouseList",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > WarehouseList"
      },
      {
        "key": "dms.warehouse.item_inward",
        "label": "Item Inward",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Item Inward"
      },
      {
        "key": "dms.warehouse.item_outward",
        "label": "Item Outward",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Item Outward"
      },
      {
        "key": "dms.warehouse.stock_transfer",
        "label": "Stock Transfer",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Stock Transfer"
      },
      {
        "key": "dms.warehouse.damage_report",
        "label": "Damage Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Damage Report"
      },
      {
        "key": "dms.warehouse.stock_storage",
        "label": "Stock Storage",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Stock Storage"
      },
      {
        "key": "dms.warehouse.wastage_detail",
        "label": "Wastage Detail",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Wastage Detail"
      },
      {
        "key": "dms.warehouse.dispatch_detail",
        "label": "Dispatch Detail",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Warehouse > Dispatch Detail"
      }
    ]
  },
  {
    "app": "production",
    "category": "Production",
    "screens": [
      {
        "key": "production.production.items",
        "label": "Items",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Items"
      },
      {
        "key": "production.production.production_process",
        "label": "Production Process",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Production Process"
      },
      {
        "key": "production.production.production_steps",
        "label": "Production Steps",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Production Steps"
      },
      {
        "key": "production.production.raw_products",
        "label": "Raw Products",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Raw Products"
      },
      {
        "key": "production.production.start_production",
        "label": "Start Production",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Start Production"
      },
      {
        "key": "production.production.daily_activity_report",
        "label": "Daily Activity Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Daily Activity Report"
      },
      {
        "key": "production.production.edit_production_daily_activity_report",
        "label": "Edit Production Daily Activity Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Edit Production Daily Activity Report"
      },
      {
        "key": "production.production.production_target",
        "label": "Production Target",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Production Target"
      },
      {
        "key": "production.production.production_target_list",
        "label": "Production Target List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Production Target List"
      },
      {
        "key": "production.production.production_target_list_detail",
        "label": "Production Target List Detail",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Production Target List Detail"
      },
      {
        "key": "production.production.wastage_material",
        "label": "Wastage Material",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Wastage Material"
      },
      {
        "key": "production.production.material_return",
        "label": "Material Return",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Material Return"
      },
      {
        "key": "production.production.price_calculater",
        "label": "Price Calculater",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Production > Price Calculater"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Others",
    "screens": [
      {
        "key": "dms.others.product",
        "label": "Product",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Product"
      },
      {
        "key": "dms.others.warehouse",
        "label": "Warehouse",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Warehouse"
      },
      {
        "key": "dms.others.production",
        "label": "Production",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Production"
      },
      {
        "key": "dms.others.setting",
        "label": "Setting",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Setting"
      },
      {
        "key": "dms.others.accounts",
        "label": "Accounts",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Accounts"
      },
      {
        "key": "dms.others.units",
        "label": "Units",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Units"
      },
      {
        "key": "dms.others.location_pincode",
        "label": "Location Pincode",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Location Pincode"
      },
      {
        "key": "dms.others.discount",
        "label": "Discount",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Discount"
      },
      {
        "key": "dms.others.invoice_template",
        "label": "Invoice Template",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Invoice Template"
      },
      {
        "key": "dms.others.assign_team",
        "label": "Assign Team",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Assign Team"
      },
      {
        "key": "dms.others.assign_salesperson_area",
        "label": "Assign SalesPerson Area",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Assign SalesPerson Area"
      },
      {
        "key": "dms.others.role_list",
        "label": "Role List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Role List"
      },
      {
        "key": "dms.others.create_department",
        "label": "Create Department",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Create Department"
      },
      {
        "key": "dms.others.department_role_assignment",
        "label": "Department Role Assignment",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Department Role Assignment"
      },
      {
        "key": "dms.others.view_hierarchy",
        "label": "View Hierarchy",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > View Hierarchy"
      },
      {
        "key": "dms.others.add_new_role",
        "label": "Add New Role",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Add New Role"
      },
      {
        "key": "dms.others.invoicelist",
        "label": "InvoiceList",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > InvoiceList"
      },
      {
        "key": "dms.others.hrm",
        "label": "HRM",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > HRM"
      },
      {
        "key": "dms.others.price_calculation",
        "label": "Price Calculation",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Price Calculation"
      },
      {
        "key": "dms.others.unitlist",
        "label": "UnitList",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > UnitList"
      },
      {
        "key": "dms.others.add_charges",
        "label": "Add Charges",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Add Charges"
      },
      {
        "key": "dms.others.setting_discount",
        "label": "Setting > Discount",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Setting > Discount"
      },
      {
        "key": "dms.others.setting_invoice_template",
        "label": "Setting > Invoice Template",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Others > Setting > Invoice Template"
      }
    ]
  },
  {
    "app": "hr",
    "category": "HRM",
    "screens": [
      {
        "key": "hr.hrm.recruitment_and_placement",
        "label": "Recruitment and Placement",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Recruitment and Placement"
      },
      {
        "key": "hr.hrm.time_sheet",
        "label": "Time Sheet",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Time Sheet"
      },
      {
        "key": "hr.hrm.performance",
        "label": "Performance",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Performance"
      },
      {
        "key": "hr.hrm.reports",
        "label": "Reports",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Reports"
      },
      {
        "key": "hr.hrm.set_rules",
        "label": "Set Rules",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Set Rules"
      },
      {
        "key": "hr.hrm.payroll",
        "label": "Payroll",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Payroll"
      },
      {
        "key": "hr.hrm.expenses",
        "label": "Expenses",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Expenses"
      },
      {
        "key": "hr.hrm.hrm_admin_setup",
        "label": "HRM Admin Setup",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > HRM Admin Setup"
      },
      {
        "key": "hr.hrm.shift_list",
        "label": "Shift List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM > Shift List"
      }
    ]
  },
  {
    "app": "hr",
    "category": "Recruitment and Placement",
    "screens": [
      {
        "key": "hr.recruitment_and_placement.job_create",
        "label": "Job Create",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Recruitment and Placement > Job Create"
      },
      {
        "key": "hr.recruitment_and_placement.job_applied_result",
        "label": "Job Applied/ Result",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Recruitment and Placement > Job Applied/ Result"
      },
      {
        "key": "hr.recruitment_and_placement.practice_and_skills_test",
        "label": "Practice & Skills Test",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Recruitment and Placement > Practice & Skills Test"
      },
      {
        "key": "hr.recruitment_and_placement.interview",
        "label": "Interview",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Recruitment and Placement > Interview"
      },
      {
        "key": "hr.recruitment_and_placement.offer_letter",
        "label": "Offer Letter",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Recruitment and Placement > Offer Letter"
      },
      {
        "key": "hr.recruitment_and_placement.training",
        "label": "Training",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Recruitment and Placement > Training"
      }
    ]
  },
  {
    "app": "hr",
    "category": "Time Sheet",
    "screens": [
      {
        "key": "hr.time_sheet.attendance",
        "label": "Attendance",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Time Sheet > Attendance"
      },
      {
        "key": "hr.time_sheet.employeelist",
        "label": "EmployeeList",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Time Sheet > EmployeeList"
      },
      {
        "key": "hr.time_sheet.add_leave",
        "label": "Add Leave",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Time Sheet > Add Leave"
      },
      {
        "key": "hr.time_sheet.manage_leave",
        "label": "Manage Leave",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Time Sheet > Manage Leave"
      },
      {
        "key": "hr.time_sheet.hours_and_holiday_master",
        "label": "Hours & Holiday Master",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Time Sheet > Hours & Holiday Master"
      },
      {
        "key": "hr.time_sheet.shift_list",
        "label": "Shift List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Time Sheet > Shift List"
      }
    ]
  },
  {
    "app": "hr",
    "category": "Performance",
    "screens": [
      {
        "key": "hr.performance.indicator",
        "label": "Indicator",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Performance > Indicator"
      },
      {
        "key": "hr.performance.incentive",
        "label": "Incentive",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Performance > Incentive"
      },
      {
        "key": "hr.performance.bonus",
        "label": "Bonus",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Performance > Bonus"
      },
      {
        "key": "hr.performance.appraisal",
        "label": "Appraisal",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Performance > Appraisal"
      },
      {
        "key": "hr.performance.goal_tracking",
        "label": "Goal Tracking",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Performance > Goal Tracking"
      }
    ]
  },
  {
    "app": "hr",
    "category": "HR Reports",
    "screens": [
      {
        "key": "hr.reports.attendance_report",
        "label": "Attendance Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Attendance Report"
      },
      {
        "key": "hr.reports.leave_report",
        "label": "Leave Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Leave Report"
      },
      {
        "key": "hr.reports.payroll_report",
        "label": "Payroll Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Payroll Report"
      },
      {
        "key": "hr.reports.timesheet_report",
        "label": "TimeSheet Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > TimeSheet Report"
      }
    ]
  },
  {
    "app": "hr",
    "category": "Set Rules",
    "screens": [
      {
        "key": "hr.set_rules.rules",
        "label": "Rules",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Set Rules > Rules"
      }
    ]
  },
  {
    "app": "hr",
    "category": "Payroll",
    "screens": [
      {
        "key": "hr.payroll.set_salary",
        "label": "Set Salary",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Payroll > Set Salary"
      },
      {
        "key": "hr.payroll.payslip",
        "label": "Payslip",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Payroll > Payslip"
      }
    ]
  },
  {
    "app": "hr",
    "category": "Expenses",
    "screens": [
      {
        "key": "hr.expenses.expenses_list",
        "label": "Expenses List",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Expenses > Expenses List"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Reports",
    "screens": [
      {
        "key": "dms.reports.admin_report",
        "label": "Admin Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Admin Report"
      },
      {
        "key": "dms.reports.customer_report",
        "label": "Customer Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Customer Report"
      },
      {
        "key": "dms.reports.staff_report",
        "label": "Staff Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Staff Report"
      },
      {
        "key": "dms.reports.transaction_report",
        "label": "Transaction Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Transaction Report"
      },
      {
        "key": "dms.reports.product_report",
        "label": "Product Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Product Report"
      },
      {
        "key": "dms.reports.earning_report",
        "label": "Earning Report",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Reports > Earning Report"
      }
    ]
  },
  {
    "app": "hr",
    "category": "HRM Admin Setup",
    "screens": [
      {
        "key": "hr.hrm_admin_setup.resignation",
        "label": "Resignation",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM Admin Setup > Resignation"
      },
      {
        "key": "hr.hrm_admin_setup.complaint",
        "label": "Complaint",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM Admin Setup > Complaint"
      },
      {
        "key": "hr.hrm_admin_setup.warning",
        "label": "Warning",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM Admin Setup > Warning"
      },
      {
        "key": "hr.hrm_admin_setup.announcement",
        "label": "Announcement",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM Admin Setup > Announcement"
      },
      {
        "key": "hr.hrm_admin_setup.event",
        "label": "Event",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM Admin Setup > Event"
      },
      {
        "key": "hr.hrm_admin_setup.termination",
        "label": "Termination",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "HRM Admin Setup > Termination"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Promotion Management",
    "screens": [
      {
        "key": "dms.promotion_management.promotion",
        "label": "Promotion",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Promotion Management > Promotion"
      },
      {
        "key": "dms.promotion_management.discount_and_coupon",
        "label": "Discount&Coupon",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Promotion Management > Discount&Coupon"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Media Status Management",
    "screens": [
      {
        "key": "dms.media_status_management.livestreamstatus",
        "label": "LivestreamStatus",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Media Status Management > LivestreamStatus"
      },
      {
        "key": "dms.media_status_management.chatstatus",
        "label": "ChatStatus",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete"
        ],
        "source": "Roles_and_Permissions.xlsx",
        "sourcePath": "Media Status Management > ChatStatus"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Family Accounts",
    "screens": [
      {
        "key": "dms.family_accounts.family_and_individual_accounts",
        "label": "Family & Individual Accounts",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "V2_REQUIRED_EXTRA",
        "sourcePath": "Family & Individual Accounts"
      }
    ]
  },
  {
    "app": "dms",
    "category": "Administration",
    "screens": [
      {
        "key": "dms.administration.company_and_stakeholders",
        "label": "Company & Stakeholders",
        "allowedActions": [
          "view",
          "create",
          "edit",
          "delete",
          "download",
          "create"
        ],
        "source": "V2_REQUIRED_EXTRA",
        "sourcePath": "Company & Stakeholders"
      }
    ]
  }
];

// Every permission screen uses one consistent seven-action model.
const STANDARD_PERMISSION_ACTIONS = PERMISSION_ACTIONS.map((action) => action.key);
for (const group of permissionCatalogue) {
  for (const screen of group.screens || []) {
    screen.allowedActions = [...STANDARD_PERMISSION_ACTIONS];
  }
}

export const KNOWN_PERMISSION_CODES = new Set(
  permissionCatalogue.flatMap((group) =>
    (group.screens || []).flatMap((screen) =>
      (screen.allowedActions || []).map((action) => `${screen.key}.${action}`)
    )
  )
);

export const allPermissionCodes = () => Array.from(KNOWN_PERMISSION_CODES);

export const sanitizePermissionCodes = (permissions = []) =>
  Array.from(
    new Set(
      (Array.isArray(permissions) ? permissions : [])
        .map((code) => String(code || "").trim())
        .filter((code) => KNOWN_PERMISSION_CODES.has(code))
    )
  );
