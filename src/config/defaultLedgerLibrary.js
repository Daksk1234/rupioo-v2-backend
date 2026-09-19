// Generated from the Super Admin ledger catalogue supplied on 2026-09-15.
// The visible Main Account Head is preserved exactly; systemAccountCode maps it
// to V2's underlying accounting engine.

export const DEFAULT_LEDGER_LIBRARY = [
  {
    "mainAccountHead": "Capital Account",
    "defaultSystemAccountCode": "SYS_CAPITAL",
    "ledgers": [
      {
        "templateKey": "CAPITAL_ACCOUNT__PROPRIETOR_CAPITAL",
        "name": "Proprietor Capital",
        "systemAccountCode": "SYS_PROPRIETOR_CAPITAL"
      },
      {
        "templateKey": "CAPITAL_ACCOUNT__PARTNER_CAPITAL",
        "name": "Partner Capital",
        "systemAccountCode": "SYS_PARTNER_CAPITAL"
      },
      {
        "templateKey": "CAPITAL_ACCOUNT__PARTNER_CURRENT_ACCOUNT",
        "name": "Partner Current Account",
        "systemAccountCode": "SYS_PARTNER_CURRENT"
      },
      {
        "templateKey": "CAPITAL_ACCOUNT__SHARE_CAPITAL",
        "name": "Share Capital",
        "systemAccountCode": "SYS_SHARE_CAPITAL"
      },
      {
        "templateKey": "CAPITAL_ACCOUNT__DRAWINGS",
        "name": "Drawings",
        "systemAccountCode": "SYS_DRAWINGS"
      },
      {
        "templateKey": "CAPITAL_ACCOUNT__ADDITIONAL_CAPITAL_INTRODUCED",
        "name": "Additional Capital Introduced",
        "systemAccountCode": "SYS_CAPITAL"
      }
    ]
  },
  {
    "mainAccountHead": "Reserves & Surplus",
    "defaultSystemAccountCode": "SYS_RESERVES_SURPLUS",
    "ledgers": [
      {
        "templateKey": "RESERVES_SURPLUS__GENERAL_RESERVE",
        "name": "General Reserve",
        "systemAccountCode": "SYS_RESERVES_SURPLUS"
      },
      {
        "templateKey": "RESERVES_SURPLUS__CAPITAL_RESERVE",
        "name": "Capital Reserve",
        "systemAccountCode": "SYS_RESERVES_SURPLUS"
      },
      {
        "templateKey": "RESERVES_SURPLUS__RETAINED_EARNINGS",
        "name": "Retained Earnings",
        "systemAccountCode": "SYS_RESERVES_SURPLUS"
      },
      {
        "templateKey": "RESERVES_SURPLUS__PROFIT_LOSS_BALANCE",
        "name": "Profit & Loss Balance",
        "systemAccountCode": "SYS_RESERVES_SURPLUS"
      }
    ]
  },
  {
    "mainAccountHead": "Secured Loans",
    "defaultSystemAccountCode": "SYS_SECURED_LOAN",
    "ledgers": [
      {
        "templateKey": "SECURED_LOANS__TERM_LOAN",
        "name": "Term Loan",
        "systemAccountCode": "SYS_SECURED_LOAN"
      },
      {
        "templateKey": "SECURED_LOANS__MACHINERY_LOAN",
        "name": "Machinery Loan",
        "systemAccountCode": "SYS_SECURED_LOAN"
      },
      {
        "templateKey": "SECURED_LOANS__VEHICLE_LOAN",
        "name": "Vehicle Loan",
        "systemAccountCode": "SYS_SECURED_LOAN"
      },
      {
        "templateKey": "SECURED_LOANS__WORKING_CAPITAL_LOAN",
        "name": "Working Capital Loan",
        "systemAccountCode": "SYS_SECURED_LOAN"
      },
      {
        "templateKey": "SECURED_LOANS__CASH_CREDIT",
        "name": "Cash Credit",
        "systemAccountCode": "SYS_BANK_OD"
      },
      {
        "templateKey": "SECURED_LOANS__BANK_OD",
        "name": "Bank OD",
        "systemAccountCode": "SYS_BANK_OD"
      }
    ]
  },
  {
    "mainAccountHead": "Unsecured Loans",
    "defaultSystemAccountCode": "SYS_UNSECURED_LOAN",
    "ledgers": [
      {
        "templateKey": "UNSECURED_LOANS__DIRECTOR_LOAN",
        "name": "Director Loan",
        "systemAccountCode": "SYS_DIRECTOR_LOAN"
      },
      {
        "templateKey": "UNSECURED_LOANS__PARTNER_LOAN",
        "name": "Partner Loan",
        "systemAccountCode": "SYS_PARTNER_LOAN"
      },
      {
        "templateKey": "UNSECURED_LOANS__LOAN_FROM_RELATIVES",
        "name": "Loan from Relatives",
        "systemAccountCode": "SYS_UNSECURED_LOAN"
      },
      {
        "templateKey": "UNSECURED_LOANS__LOAN_FROM_OTHERS",
        "name": "Loan from Others",
        "systemAccountCode": "SYS_UNSECURED_LOAN"
      },
      {
        "templateKey": "UNSECURED_LOANS__INTER_COMPANY_LOAN",
        "name": "Inter-Company Loan",
        "systemAccountCode": "SYS_UNSECURED_LOAN"
      }
    ]
  },
  {
    "mainAccountHead": "Sundry Creditors",
    "defaultSystemAccountCode": "SYS_SUNDRY_CREDITORS",
    "ledgers": [
      {
        "templateKey": "SUNDRY_CREDITORS__RAW_MATERIAL_SUPPLIERS",
        "name": "Raw Material Suppliers",
        "systemAccountCode": "SYS_SUNDRY_CREDITORS"
      },
      {
        "templateKey": "SUNDRY_CREDITORS__PACKING_MATERIAL_SUPPLIERS",
        "name": "Packing Material Suppliers",
        "systemAccountCode": "SYS_SUNDRY_CREDITORS"
      },
      {
        "templateKey": "SUNDRY_CREDITORS__SERVICE_CREDITORS",
        "name": "Service Creditors",
        "systemAccountCode": "SYS_SUNDRY_CREDITORS"
      },
      {
        "templateKey": "SUNDRY_CREDITORS__TRANSPORT_CREDITORS",
        "name": "Transport Creditors",
        "systemAccountCode": "SYS_SUNDRY_CREDITORS"
      },
      {
        "templateKey": "SUNDRY_CREDITORS__EXPENSE_CREDITORS",
        "name": "Expense Creditors",
        "systemAccountCode": "SYS_SUNDRY_CREDITORS"
      }
    ]
  },
  {
    "mainAccountHead": "Sundry Debtors",
    "defaultSystemAccountCode": "SYS_SUNDRY_DEBTORS",
    "ledgers": [
      {
        "templateKey": "SUNDRY_DEBTORS__CUSTOMERS",
        "name": "Customers",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "SUNDRY_DEBTORS__DEALERS",
        "name": "Dealers",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "SUNDRY_DEBTORS__DISTRIBUTORS",
        "name": "Distributors",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "SUNDRY_DEBTORS__INSTITUTIONAL_CUSTOMERS",
        "name": "Institutional Customers",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "SUNDRY_DEBTORS__ECOMMERCE_RECEIVABLE",
        "name": "Ecommerce Receivable",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      }
    ]
  },
  {
    "mainAccountHead": "Bank Accounts",
    "defaultSystemAccountCode": "SYS_BANK_ACCOUNT",
    "ledgers": [
      {
        "templateKey": "BANK_ACCOUNTS__SBI_CURRENT_ACCOUNT",
        "name": "SBI Current Account",
        "systemAccountCode": "SYS_BANK_ACCOUNT"
      },
      {
        "templateKey": "BANK_ACCOUNTS__HDFC_CURRENT_ACCOUNT",
        "name": "HDFC Current Account",
        "systemAccountCode": "SYS_BANK_ACCOUNT"
      },
      {
        "templateKey": "BANK_ACCOUNTS__ICICI_CURRENT_ACCOUNT",
        "name": "ICICI Current Account",
        "systemAccountCode": "SYS_BANK_ACCOUNT"
      },
      {
        "templateKey": "BANK_ACCOUNTS__AXIS_BANK",
        "name": "Axis Bank",
        "systemAccountCode": "SYS_BANK_ACCOUNT"
      },
      {
        "templateKey": "BANK_ACCOUNTS__BANK_OD_ACCOUNT",
        "name": "Bank OD Account",
        "systemAccountCode": "SYS_BANK_OD"
      }
    ]
  },
  {
    "mainAccountHead": "Cash-in-Hand",
    "defaultSystemAccountCode": "SYS_CASH",
    "ledgers": [
      {
        "templateKey": "CASH_IN_HAND__CASH_ACCOUNT",
        "name": "Cash Account",
        "systemAccountCode": "SYS_CASH"
      },
      {
        "templateKey": "CASH_IN_HAND__PETTY_CASH",
        "name": "Petty Cash",
        "systemAccountCode": "SYS_CASH"
      },
      {
        "templateKey": "CASH_IN_HAND__BRANCH_CASH",
        "name": "Branch Cash",
        "systemAccountCode": "SYS_CASH"
      },
      {
        "templateKey": "CASH_IN_HAND__FACTORY_CASH",
        "name": "Factory Cash",
        "systemAccountCode": "SYS_CASH"
      }
    ]
  },
  {
    "mainAccountHead": "Fixed Assets",
    "defaultSystemAccountCode": "SYS_FIXED_ASSETS",
    "ledgers": [
      {
        "templateKey": "FIXED_ASSETS__LAND",
        "name": "Land",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__FACTORY_BUILDING",
        "name": "Factory Building",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__OFFICE_BUILDING",
        "name": "Office Building",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__PLANT_MACHINERY",
        "name": "Plant & Machinery",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__ELECTRICAL_INSTALLATION",
        "name": "Electrical Installation",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__FURNITURE_FIXTURES",
        "name": "Furniture & Fixtures",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__COMPUTERS",
        "name": "Computers",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__LAPTOPS",
        "name": "Laptops",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__PRINTERS",
        "name": "Printers",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__AIR_CONDITIONER",
        "name": "Air Conditioner",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__VEHICLES",
        "name": "Vehicles",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__DELIVERY_VEHICLES",
        "name": "Delivery Vehicles",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__MOBILE_PHONES",
        "name": "Mobile Phones",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__CCTV",
        "name": "CCTV",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__GENERATOR",
        "name": "Generator",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__UPS_INVERTER",
        "name": "UPS/Inverter",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__SOLAR_PLANT",
        "name": "Solar Plant",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__TOOLS_EQUIPMENT",
        "name": "Tools & Equipment",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "FIXED_ASSETS__OFFICE_EQUIPMENT",
        "name": "Office Equipment",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      }
    ]
  },
  {
    "mainAccountHead": "Accumulated Depreciation",
    "defaultSystemAccountCode": "SYS_FIXED_ASSETS",
    "ledgers": [
      {
        "templateKey": "ACCUMULATED_DEPRECIATION__DEPRECIATION_BUILDING",
        "name": "Depreciation – Building",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "ACCUMULATED_DEPRECIATION__PLANT_MACHINERY",
        "name": "Plant & Machinery",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "ACCUMULATED_DEPRECIATION__VEHICLE",
        "name": "Vehicle",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "ACCUMULATED_DEPRECIATION__FURNITURE",
        "name": "Furniture",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "ACCUMULATED_DEPRECIATION__COMPUTER",
        "name": "Computer",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      },
      {
        "templateKey": "ACCUMULATED_DEPRECIATION__ELECTRICAL_EQUIPMENT",
        "name": "Electrical Equipment",
        "systemAccountCode": "SYS_FIXED_ASSETS"
      }
    ]
  },
  {
    "mainAccountHead": "Investments",
    "defaultSystemAccountCode": "SYS_INVESTMENT",
    "ledgers": [
      {
        "templateKey": "INVESTMENTS__FIXED_DEPOSIT",
        "name": "Fixed Deposit",
        "systemAccountCode": "SYS_INVESTMENT"
      },
      {
        "templateKey": "INVESTMENTS__MUTUAL_FUND",
        "name": "Mutual Fund",
        "systemAccountCode": "SYS_INVESTMENT"
      },
      {
        "templateKey": "INVESTMENTS__SHARES",
        "name": "Shares",
        "systemAccountCode": "SYS_INVESTMENT"
      },
      {
        "templateKey": "INVESTMENTS__BONDS",
        "name": "Bonds",
        "systemAccountCode": "SYS_INVESTMENT"
      },
      {
        "templateKey": "INVESTMENTS__SECURITY_DEPOSIT_INVESTMENT",
        "name": "Security Deposit Investment",
        "systemAccountCode": "SYS_INVESTMENT"
      }
    ]
  },
  {
    "mainAccountHead": "Loans & Advances – Asset",
    "defaultSystemAccountCode": "SYS_LOANS_ADVANCES",
    "ledgers": [
      {
        "templateKey": "LOANS_ADVANCES_ASSET__STAFF_ADVANCE",
        "name": "Staff Advance",
        "systemAccountCode": "SYS_STAFF_ADVANCE"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__SUPPLIER_ADVANCE",
        "name": "Supplier Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__SALARY_ADVANCE",
        "name": "Salary Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__TRAVEL_ADVANCE",
        "name": "Travel Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__DIRECTOR_ADVANCE",
        "name": "Director Advance",
        "systemAccountCode": "SYS_DIRECTOR_ADVANCE"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__PARTNER_ADVANCE",
        "name": "Partner Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__SECURITY_DEPOSIT",
        "name": "Security Deposit",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "LOANS_ADVANCES_ASSET__RENT_DEPOSIT",
        "name": "Rent Deposit",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      }
    ]
  },
  {
    "mainAccountHead": "Deposits",
    "defaultSystemAccountCode": "SYS_DEPOSIT_ASSET",
    "ledgers": [
      {
        "templateKey": "DEPOSITS__ELECTRICITY_SECURITY_DEPOSIT",
        "name": "Electricity Security Deposit",
        "systemAccountCode": "SYS_DEPOSIT_ASSET"
      },
      {
        "templateKey": "DEPOSITS__TELEPHONE_DEPOSIT",
        "name": "Telephone Deposit",
        "systemAccountCode": "SYS_DEPOSIT_ASSET"
      },
      {
        "templateKey": "DEPOSITS__RENT_SECURITY_DEPOSIT",
        "name": "Rent Security Deposit",
        "systemAccountCode": "SYS_DEPOSIT_ASSET"
      },
      {
        "templateKey": "DEPOSITS__LPG_DEPOSIT",
        "name": "LPG Deposit",
        "systemAccountCode": "SYS_DEPOSIT_ASSET"
      },
      {
        "templateKey": "DEPOSITS__BANK_MARGIN_DEPOSIT",
        "name": "Bank Margin Deposit",
        "systemAccountCode": "SYS_DEPOSIT_ASSET"
      }
    ]
  },
  {
    "mainAccountHead": "Stock-in-Hand",
    "defaultSystemAccountCode": "SYS_STOCK",
    "ledgers": [
      {
        "templateKey": "STOCK_IN_HAND__RAW_MATERIAL_STOCK",
        "name": "Raw Material Stock",
        "systemAccountCode": "SYS_STOCK"
      },
      {
        "templateKey": "STOCK_IN_HAND__PACKING_MATERIAL_STOCK",
        "name": "Packing Material Stock",
        "systemAccountCode": "SYS_STOCK"
      },
      {
        "templateKey": "STOCK_IN_HAND__WORK_IN_PROGRESS",
        "name": "Work-in-Progress",
        "systemAccountCode": "SYS_STOCK"
      },
      {
        "templateKey": "STOCK_IN_HAND__FINISHED_GOODS",
        "name": "Finished Goods",
        "systemAccountCode": "SYS_STOCK"
      },
      {
        "templateKey": "STOCK_IN_HAND__SCRAP_STOCK",
        "name": "Scrap Stock",
        "systemAccountCode": "SYS_STOCK"
      },
      {
        "templateKey": "STOCK_IN_HAND__CONSUMABLES_STOCK",
        "name": "Consumables Stock",
        "systemAccountCode": "SYS_STOCK"
      }
    ]
  },
  {
    "mainAccountHead": "Purchase Accounts",
    "defaultSystemAccountCode": "SYS_PURCHASE",
    "ledgers": [
      {
        "templateKey": "PURCHASE_ACCOUNTS__RAW_MATERIAL_PURCHASE",
        "name": "Raw Material Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_ACCOUNTS__TRADING_GOODS_PURCHASE",
        "name": "Trading Goods Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_ACCOUNTS__PACKING_MATERIAL_PURCHASE",
        "name": "Packing Material Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_ACCOUNTS__CONSUMABLE_PURCHASE",
        "name": "Consumable Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_ACCOUNTS__IMPORT_PURCHASE",
        "name": "Import Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_ACCOUNTS__LOCAL_PURCHASE",
        "name": "Local Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_ACCOUNTS__INTERSTATE_PURCHASE",
        "name": "Interstate Purchase",
        "systemAccountCode": "SYS_PURCHASE"
      }
    ]
  },
  {
    "mainAccountHead": "Purchase Return",
    "defaultSystemAccountCode": "SYS_PURCHASE",
    "ledgers": [
      {
        "templateKey": "PURCHASE_RETURN__PURCHASE_RETURN",
        "name": "Purchase Return",
        "systemAccountCode": "SYS_PURCHASE"
      },
      {
        "templateKey": "PURCHASE_RETURN__DEBIT_NOTE_TO_SUPPLIER",
        "name": "Debit Note to Supplier",
        "systemAccountCode": "SYS_PURCHASE"
      }
    ]
  },
  {
    "mainAccountHead": "Direct Expenses",
    "defaultSystemAccountCode": "SYS_DIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "DIRECT_EXPENSES__FREIGHT_INWARD",
        "name": "Freight Inward",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__LOADING_UNLOADING_INWARD",
        "name": "Loading & Unloading Inward",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__CARRIAGE_INWARD",
        "name": "Carriage Inward",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__LABOUR_CHARGES_PRODUCTION",
        "name": "Labour Charges – Production",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__JOB_WORK_CHARGES",
        "name": "Job Work Charges",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__MANUFACTURING_LABOUR",
        "name": "Manufacturing Labour",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__FACTORY_POWER",
        "name": "Factory Power",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__PRODUCTION_ELECTRICITY",
        "name": "Production Electricity",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__FACTORY_CONSUMABLES",
        "name": "Factory Consumables",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__MACHINE_RUNNING_EXPENSE",
        "name": "Machine Running Expense",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__PRODUCTION_GAS_FUEL",
        "name": "Production Gas/Fuel",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__PACKING_CHARGES_PRODUCTION",
        "name": "Packing Charges – Production",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__IMPORT_DUTY",
        "name": "Import Duty",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "DIRECT_EXPENSES__CLEARING_FORWARDING_PURCHASE",
        "name": "Clearing & Forwarding – Purchase",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Manufacturing Expenses",
    "defaultSystemAccountCode": "SYS_DIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "MANUFACTURING_EXPENSES__MACHINE_REPAIR_MAINTENANCE",
        "name": "Machine Repair & Maintenance",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__FACTORY_REPAIR",
        "name": "Factory Repair",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__FACTORY_RENT",
        "name": "Factory Rent",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__FACTORY_ELECTRICITY",
        "name": "Factory Electricity",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__BOILER_FUEL",
        "name": "Boiler Fuel",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__GENERATOR_FUEL",
        "name": "Generator Fuel",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__PRODUCTION_CONSUMABLES",
        "name": "Production Consumables",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__QUALITY_TESTING_CHARGES",
        "name": "Quality Testing Charges",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__FACTORY_LABOUR_WELFARE",
        "name": "Factory Labour Welfare",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "MANUFACTURING_EXPENSES__FACTORY_HOUSEKEEPING",
        "name": "Factory Housekeeping",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Sales Accounts",
    "defaultSystemAccountCode": "SYS_SALES",
    "ledgers": [
      {
        "templateKey": "SALES_ACCOUNTS__LOCAL_SALES",
        "name": "Local Sales",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_ACCOUNTS__INTERSTATE_SALES",
        "name": "Interstate Sales",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_ACCOUNTS__EXPORT_SALES",
        "name": "Export Sales",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_ACCOUNTS__ECOMMERCE_SALES",
        "name": "Ecommerce Sales",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_ACCOUNTS__CASH_SALES",
        "name": "Cash Sales",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_ACCOUNTS__CREDIT_SALES",
        "name": "Credit Sales",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_ACCOUNTS__SCRAP_SALES",
        "name": "Scrap Sales",
        "systemAccountCode": "SYS_SALES"
      }
    ]
  },
  {
    "mainAccountHead": "Sales Return",
    "defaultSystemAccountCode": "SYS_SALES",
    "ledgers": [
      {
        "templateKey": "SALES_RETURN__SALES_RETURN",
        "name": "Sales Return",
        "systemAccountCode": "SYS_SALES"
      },
      {
        "templateKey": "SALES_RETURN__CREDIT_NOTE_TO_CUSTOMER",
        "name": "Credit Note to Customer",
        "systemAccountCode": "SYS_SALES"
      }
    ]
  },
  {
    "mainAccountHead": "Indirect Income",
    "defaultSystemAccountCode": "SYS_INDIRECT_INCOME",
    "ledgers": [
      {
        "templateKey": "INDIRECT_INCOME__INTEREST_RECEIVED",
        "name": "Interest Received",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__DISCOUNT_RECEIVED",
        "name": "Discount Received",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__COMMISSION_RECEIVED",
        "name": "Commission Received",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__RENT_RECEIVED",
        "name": "Rent Received",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__INSURANCE_CLAIM_RECEIVED",
        "name": "Insurance Claim Received",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__SCRAP_INCOME",
        "name": "Scrap Income",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__MISCELLANEOUS_INCOME",
        "name": "Miscellaneous Income",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "INDIRECT_INCOME__FOREIGN_EXCHANGE_GAIN",
        "name": "Foreign Exchange Gain",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      }
    ]
  },
  {
    "mainAccountHead": "Salary & Employee Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__SALARY",
        "name": "Salary",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__WAGES_OFFICE",
        "name": "Wages – Office",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__BONUS",
        "name": "Bonus",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__INCENTIVE",
        "name": "Incentive",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__OVERTIME",
        "name": "Overtime",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__STAFF_WELFARE",
        "name": "Staff Welfare",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__EMPLOYEE_REIMBURSEMENT",
        "name": "Employee Reimbursement",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__RECRUITMENT_EXPENSE",
        "name": "Recruitment Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__TRAINING_EXPENSE",
        "name": "Training Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SALARY_EMPLOYEE_EXPENSES__UNIFORM_EXPENSE",
        "name": "Uniform Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Travelling Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "TRAVELLING_EXPENSES__LOCAL_TRAVELLING",
        "name": "Local Travelling",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__OUTSTATION_TRAVELLING",
        "name": "Outstation Travelling",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__AIR_FARE",
        "name": "Air Fare",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__TRAIN_FARE",
        "name": "Train Fare",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__BUS_FARE",
        "name": "Bus Fare",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__TAXI_CAB",
        "name": "Taxi/Cab",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__HOTEL_EXPENSE",
        "name": "Hotel Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__BOARDING_LODGING",
        "name": "Boarding & Lodging",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__DAILY_ALLOWANCE",
        "name": "Daily Allowance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TRAVELLING_EXPENSES__TRAVEL_FOOD_EXPENSE",
        "name": "Travel Food Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Vehicle Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "VEHICLE_EXPENSES__FUEL_EXPENSE",
        "name": "Fuel Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__PETROL_EXPENSE",
        "name": "Petrol Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__DIESEL_EXPENSE",
        "name": "Diesel Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__CNG_EXPENSE",
        "name": "CNG Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__EV_CHARGING_EXPENSE",
        "name": "EV Charging Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__VEHICLE_REPAIR",
        "name": "Vehicle Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__VEHICLE_SERVICING",
        "name": "Vehicle Servicing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__VEHICLE_INSURANCE",
        "name": "Vehicle Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__VEHICLE_ROAD_TAX",
        "name": "Vehicle Road Tax",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__TOLL_CHARGES",
        "name": "Toll Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__PARKING_CHARGES",
        "name": "Parking Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "VEHICLE_EXPENSES__DRIVER_EXPENSE",
        "name": "Driver Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Office Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "OFFICE_EXPENSES__OFFICE_STATIONERY",
        "name": "Office Stationery",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__PRINTING_STATIONERY",
        "name": "Printing & Stationery",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__PHOTOCOPY_EXPENSE",
        "name": "Photocopy Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__COURIER_EXPENSE",
        "name": "Courier Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__POSTAGE",
        "name": "Postage",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__OFFICE_CONSUMABLES",
        "name": "Office Consumables",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__OFFICE_CLEANING",
        "name": "Office Cleaning",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__HOUSEKEEPING",
        "name": "Housekeeping",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__PANTRY_EXPENSE",
        "name": "Pantry Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__TEA_REFRESHMENT",
        "name": "Tea & Refreshment",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "OFFICE_EXPENSES__DRINKING_WATER",
        "name": "Drinking Water",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Rent Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "RENT_EXPENSES__OFFICE_RENT",
        "name": "Office Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RENT_EXPENSES__FACTORY_RENT",
        "name": "Factory Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RENT_EXPENSES__WAREHOUSE_RENT",
        "name": "Warehouse Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RENT_EXPENSES__GODOWN_RENT",
        "name": "Godown Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RENT_EXPENSES__STAFF_QUARTER_RENT",
        "name": "Staff Quarter Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RENT_EXPENSES__SHOP_RENT",
        "name": "Shop Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Electricity & Utilities",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "ELECTRICITY_UTILITIES__ELECTRICITY_EXPENSE",
        "name": "Electricity Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ELECTRICITY_UTILITIES__WATER_CHARGES",
        "name": "Water Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ELECTRICITY_UTILITIES__GENERATOR_EXPENSE",
        "name": "Generator Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ELECTRICITY_UTILITIES__GAS_CHARGES",
        "name": "Gas Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ELECTRICITY_UTILITIES__UTILITY_CHARGES",
        "name": "Utility Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Telephone & Communication",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "TELEPHONE_COMMUNICATION__MOBILE_EXPENSE",
        "name": "Mobile Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TELEPHONE_COMMUNICATION__TELEPHONE_EXPENSE",
        "name": "Telephone Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TELEPHONE_COMMUNICATION__INTERNET_EXPENSE",
        "name": "Internet Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TELEPHONE_COMMUNICATION__BROADBAND_EXPENSE",
        "name": "Broadband Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TELEPHONE_COMMUNICATION__SIM_RECHARGE",
        "name": "SIM Recharge",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TELEPHONE_COMMUNICATION__DATA_CARD_EXPENSE",
        "name": "Data Card Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "IT & Software Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__SOFTWARE_SUBSCRIPTION",
        "name": "Software Subscription",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__SAAS_CHARGES",
        "name": "SaaS Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__CLOUD_HOSTING",
        "name": "Cloud Hosting",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__SERVER_EXPENSE",
        "name": "Server Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__DOMAIN_RENEWAL",
        "name": "Domain Renewal",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__WEBSITE_HOSTING",
        "name": "Website Hosting",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__EMAIL_HOSTING",
        "name": "Email Hosting",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__ERP_DMS_EXPENSE",
        "name": "ERP/DMS Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__ANTIVIRUS",
        "name": "Antivirus",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "IT_SOFTWARE_EXPENSES__SOFTWARE_AMC",
        "name": "Software AMC",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Repair & Maintenance",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "REPAIR_MAINTENANCE__BUILDING_REPAIR",
        "name": "Building Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__MACHINERY_REPAIR",
        "name": "Machinery Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__ELECTRICAL_REPAIR",
        "name": "Electrical Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__COMPUTER_REPAIR",
        "name": "Computer Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__FURNITURE_REPAIR",
        "name": "Furniture Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__AC_REPAIR",
        "name": "AC Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__VEHICLE_REPAIR",
        "name": "Vehicle Repair",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "REPAIR_MAINTENANCE__GENERAL_MAINTENANCE",
        "name": "General Maintenance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Professional Charges",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "PROFESSIONAL_CHARGES__CA_FEES",
        "name": "CA Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__AUDITOR_FEES",
        "name": "Auditor Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__ADVOCATE_FEES",
        "name": "Advocate Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__CONSULTANT_FEES",
        "name": "Consultant Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__LEGAL_CHARGES",
        "name": "Legal Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__ARCHITECT_FEES",
        "name": "Architect Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__ENGINEER_FEES",
        "name": "Engineer Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PROFESSIONAL_CHARGES__COMPANY_SECRETARY_FEES",
        "name": "Company Secretary Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Bank Charges",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "BANK_CHARGES__BANK_CHARGES",
        "name": "Bank Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BANK_CHARGES__CHEQUE_RETURN_CHARGES",
        "name": "Cheque Return Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BANK_CHARGES__RTGS_NEFT_CHARGES",
        "name": "RTGS/NEFT Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BANK_CHARGES__UPI_CHARGES",
        "name": "UPI Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BANK_CHARGES__POS_CHARGES",
        "name": "POS Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BANK_CHARGES__CREDIT_CARD_CHARGES",
        "name": "Credit Card Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BANK_CHARGES__LOAN_PROCESSING_FEES",
        "name": "Loan Processing Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Interest & Finance Cost",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "INTEREST_FINANCE_COST__BANK_INTEREST",
        "name": "Bank Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INTEREST_FINANCE_COST__LOAN_INTEREST",
        "name": "Loan Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INTEREST_FINANCE_COST__OD_INTEREST",
        "name": "OD Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INTEREST_FINANCE_COST__CC_INTEREST",
        "name": "CC Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INTEREST_FINANCE_COST__VEHICLE_LOAN_INTEREST",
        "name": "Vehicle Loan Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INTEREST_FINANCE_COST__MACHINERY_LOAN_INTEREST",
        "name": "Machinery Loan Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INTEREST_FINANCE_COST__LATE_PAYMENT_INTEREST",
        "name": "Late Payment Interest",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Selling & Distribution",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "SELLING_DISTRIBUTION__FREIGHT_OUTWARD",
        "name": "Freight Outward",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SELLING_DISTRIBUTION__DELIVERY_CHARGES",
        "name": "Delivery Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SELLING_DISTRIBUTION__COURIER_TO_CUSTOMER",
        "name": "Courier to Customer",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SELLING_DISTRIBUTION__LOADING_OUTWARD",
        "name": "Loading Outward",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SELLING_DISTRIBUTION__SALES_COMMISSION",
        "name": "Sales Commission",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SELLING_DISTRIBUTION__DEALER_COMMISSION",
        "name": "Dealer Commission",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SELLING_DISTRIBUTION__MARKETPLACE_COMMISSION",
        "name": "Marketplace Commission",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Advertisement & Marketing",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "ADVERTISEMENT_MARKETING__ADVERTISEMENT",
        "name": "Advertisement",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__DIGITAL_MARKETING",
        "name": "Digital Marketing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__FACEBOOK_ADS",
        "name": "Facebook Ads",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__GOOGLE_ADS",
        "name": "Google Ads",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__SOCIAL_MEDIA_MARKETING",
        "name": "Social Media Marketing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__PRINTING_ADVERTISEMENT",
        "name": "Printing Advertisement",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__EXHIBITION_EXPENSE",
        "name": "Exhibition Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__PROMOTIONAL_EXPENSE",
        "name": "Promotional Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__SAMPLES",
        "name": "Samples",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ADVERTISEMENT_MARKETING__GIFTS",
        "name": "Gifts",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Packaging Expenses",
    "defaultSystemAccountCode": "SYS_DIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "PACKAGING_EXPENSES__PACKING_MATERIAL_EXPENSE",
        "name": "Packing Material Expense",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PACKAGING_EXPENSES__CARTON_EXPENSE",
        "name": "Carton Expense",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PACKAGING_EXPENSES__TAPE_EXPENSE",
        "name": "Tape Expense",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PACKAGING_EXPENSES__STRETCH_FILM",
        "name": "Stretch Film",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PACKAGING_EXPENSES__LABELS_STICKERS",
        "name": "Labels & Stickers",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PACKAGING_EXPENSES__STRAPPING_MATERIAL",
        "name": "Strapping Material",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PACKAGING_EXPENSES__PALLET_EXPENSE",
        "name": "Pallet Expense",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Insurance Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "INSURANCE_EXPENSES__FACTORY_INSURANCE",
        "name": "Factory Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INSURANCE_EXPENSES__FIRE_INSURANCE",
        "name": "Fire Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INSURANCE_EXPENSES__STOCK_INSURANCE",
        "name": "Stock Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INSURANCE_EXPENSES__VEHICLE_INSURANCE",
        "name": "Vehicle Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INSURANCE_EXPENSES__MARINE_INSURANCE",
        "name": "Marine Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INSURANCE_EXPENSES__EMPLOYEE_INSURANCE",
        "name": "Employee Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "INSURANCE_EXPENSES__MACHINERY_INSURANCE",
        "name": "Machinery Insurance",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Security Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "SECURITY_EXPENSES__SECURITY_GUARD_CHARGES",
        "name": "Security Guard Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SECURITY_EXPENSES__CCTV_AMC",
        "name": "CCTV AMC",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SECURITY_EXPENSES__SECURITY_AGENCY_CHARGES",
        "name": "Security Agency Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Housekeeping Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "HOUSEKEEPING_EXPENSES__CLEANING_MATERIAL",
        "name": "Cleaning Material",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "HOUSEKEEPING_EXPENSES__HOUSEKEEPING_LABOUR",
        "name": "Housekeeping Labour",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "HOUSEKEEPING_EXPENSES__PEST_CONTROL",
        "name": "Pest Control",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "HOUSEKEEPING_EXPENSES__GARBAGE_DISPOSAL",
        "name": "Garbage Disposal",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Freight & Transport",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "FREIGHT_TRANSPORT__LOCAL_TRANSPORT",
        "name": "Local Transport",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "FREIGHT_TRANSPORT__OUTSTATION_TRANSPORT",
        "name": "Outstation Transport",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "FREIGHT_TRANSPORT__FREIGHT_OUTWARD",
        "name": "Freight Outward",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "FREIGHT_TRANSPORT__FREIGHT_INWARD",
        "name": "Freight Inward",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "FREIGHT_TRANSPORT__COURIER",
        "name": "Courier",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "FREIGHT_TRANSPORT__PARCEL_CHARGES",
        "name": "Parcel Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "FREIGHT_TRANSPORT__VEHICLE_HIRE_CHARGES",
        "name": "Vehicle Hire Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Business Promotion",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "BUSINESS_PROMOTION__CUSTOMER_GIFTS",
        "name": "Customer Gifts",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BUSINESS_PROMOTION__DIWALI_GIFTS",
        "name": "Diwali Gifts",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BUSINESS_PROMOTION__NEW_YEAR_GIFTS",
        "name": "New Year Gifts",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BUSINESS_PROMOTION__SAMPLES",
        "name": "Samples",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BUSINESS_PROMOTION__ENTERTAINMENT_EXPENSE",
        "name": "Entertainment Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BUSINESS_PROMOTION__CUSTOMER_MEETING_EXPENSE",
        "name": "Customer Meeting Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Subscription & Membership",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "SUBSCRIPTION_MEMBERSHIP__TRADE_ASSOCIATION_FEE",
        "name": "Trade Association Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SUBSCRIPTION_MEMBERSHIP__CHAMBER_MEMBERSHIP",
        "name": "Chamber Membership",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SUBSCRIPTION_MEMBERSHIP__PROFESSIONAL_MEMBERSHIP",
        "name": "Professional Membership",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SUBSCRIPTION_MEMBERSHIP__NEWSPAPER_MAGAZINE",
        "name": "Newspaper & Magazine",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "SUBSCRIPTION_MEMBERSHIP__ONLINE_SUBSCRIPTION",
        "name": "Online Subscription",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Rates & Taxes",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "RATES_TAXES__MUNICIPAL_TAX",
        "name": "Municipal Tax",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RATES_TAXES__PROPERTY_TAX",
        "name": "Property Tax",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RATES_TAXES__PROFESSIONAL_TAX",
        "name": "Professional Tax",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RATES_TAXES__TRADE_LICENCE_FEE",
        "name": "Trade Licence Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RATES_TAXES__POLLUTION_FEE",
        "name": "Pollution Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RATES_TAXES__FACTORY_LICENCE_FEE",
        "name": "Factory Licence Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "GST / Duties & Taxes",
    "defaultSystemAccountCode": "SYS_DUTIES_TAXES",
    "ledgers": [
      {
        "templateKey": "GST_DUTIES_TAXES__CGST_INPUT",
        "name": "CGST Input",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__SGST_INPUT",
        "name": "SGST Input",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__IGST_INPUT",
        "name": "IGST Input",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__CGST_OUTPUT",
        "name": "CGST Output",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__SGST_OUTPUT",
        "name": "SGST Output",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__IGST_OUTPUT",
        "name": "IGST Output",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__GST_PAYABLE",
        "name": "GST Payable",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__GST_RECEIVABLE",
        "name": "GST Receivable",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__RCM_GST",
        "name": "RCM GST",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__GST_INTEREST",
        "name": "GST Interest",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "GST_DUTIES_TAXES__GST_LATE_FEE",
        "name": "GST Late Fee",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      }
    ]
  },
  {
    "mainAccountHead": "TDS Accounts",
    "defaultSystemAccountCode": "SYS_DUTIES_TAXES",
    "ledgers": [
      {
        "templateKey": "TDS_ACCOUNTS__TDS_PAYABLE_SALARY",
        "name": "TDS Payable – Salary",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "TDS_ACCOUNTS__CONTRACTOR",
        "name": "Contractor",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "TDS_ACCOUNTS__PROFESSIONAL",
        "name": "Professional",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "TDS_ACCOUNTS__RENT",
        "name": "Rent",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "TDS_ACCOUNTS__COMMISSION",
        "name": "Commission",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "TDS_ACCOUNTS__TDS_RECEIVABLE",
        "name": "TDS Receivable",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      }
    ]
  },
  {
    "mainAccountHead": "TCS Accounts",
    "defaultSystemAccountCode": "SYS_DUTIES_TAXES",
    "ledgers": [
      {
        "templateKey": "TCS_ACCOUNTS__TCS_PAYABLE",
        "name": "TCS Payable",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      },
      {
        "templateKey": "TCS_ACCOUNTS__TCS_RECEIVABLE",
        "name": "TCS Receivable",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      }
    ]
  },
  {
    "mainAccountHead": "PF/ESI/Payroll Liabilities",
    "defaultSystemAccountCode": "SYS_CURRENT_LIABILITIES",
    "ledgers": [
      {
        "templateKey": "PF_ESI_PAYROLL_LIABILITIES__PF_PAYABLE",
        "name": "PF Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "PF_ESI_PAYROLL_LIABILITIES__ESI_PAYABLE",
        "name": "ESI Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "PF_ESI_PAYROLL_LIABILITIES__SALARY_PAYABLE",
        "name": "Salary Payable",
        "systemAccountCode": "SYS_SALARY_PAYABLE"
      },
      {
        "templateKey": "PF_ESI_PAYROLL_LIABILITIES__BONUS_PAYABLE",
        "name": "Bonus Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "PF_ESI_PAYROLL_LIABILITIES__PROFESSIONAL_TAX_PAYABLE",
        "name": "Professional Tax Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      }
    ]
  },
  {
    "mainAccountHead": "Other Current Liabilities",
    "defaultSystemAccountCode": "SYS_CURRENT_LIABILITIES",
    "ledgers": [
      {
        "templateKey": "OTHER_CURRENT_LIABILITIES__EXPENSE_PAYABLE",
        "name": "Expense Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "OTHER_CURRENT_LIABILITIES__AUDIT_FEE_PAYABLE",
        "name": "Audit Fee Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "OTHER_CURRENT_LIABILITIES__ELECTRICITY_PAYABLE",
        "name": "Electricity Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "OTHER_CURRENT_LIABILITIES__RENT_PAYABLE",
        "name": "Rent Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "OTHER_CURRENT_LIABILITIES__FREIGHT_PAYABLE",
        "name": "Freight Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "OTHER_CURRENT_LIABILITIES__INTEREST_PAYABLE",
        "name": "Interest Payable",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      }
    ]
  },
  {
    "mainAccountHead": "Current Assets",
    "defaultSystemAccountCode": "SYS_CURRENT_ASSETS",
    "ledgers": [
      {
        "templateKey": "CURRENT_ASSETS__PREPAID_INSURANCE",
        "name": "Prepaid Insurance",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "CURRENT_ASSETS__PREPAID_RENT",
        "name": "Prepaid Rent",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "CURRENT_ASSETS__PREPAID_EXPENSES",
        "name": "Prepaid Expenses",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "CURRENT_ASSETS__ACCRUED_INCOME",
        "name": "Accrued Income",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "CURRENT_ASSETS__GST_RECEIVABLE",
        "name": "GST Receivable",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "CURRENT_ASSETS__TDS_RECEIVABLE",
        "name": "TDS Receivable",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      }
    ]
  },
  {
    "mainAccountHead": "Provision Accounts",
    "defaultSystemAccountCode": "SYS_PROVISIONS",
    "ledgers": [
      {
        "templateKey": "PROVISION_ACCOUNTS__PROVISION_FOR_AUDIT_FEES",
        "name": "Provision for Audit Fees",
        "systemAccountCode": "SYS_PROVISIONS"
      },
      {
        "templateKey": "PROVISION_ACCOUNTS__PROVISION_FOR_TAX",
        "name": "Provision for Tax",
        "systemAccountCode": "SYS_PROVISIONS"
      },
      {
        "templateKey": "PROVISION_ACCOUNTS__PROVISION_FOR_EXPENSES",
        "name": "Provision for Expenses",
        "systemAccountCode": "SYS_PROVISIONS"
      },
      {
        "templateKey": "PROVISION_ACCOUNTS__PROVISION_FOR_BONUS",
        "name": "Provision for Bonus",
        "systemAccountCode": "SYS_PROVISIONS"
      },
      {
        "templateKey": "PROVISION_ACCOUNTS__PROVISION_FOR_LEAVE_ENCASHMENT",
        "name": "Provision for Leave Encashment",
        "systemAccountCode": "SYS_PROVISIONS"
      }
    ]
  },
  {
    "mainAccountHead": "Bad Debts & Provisions",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "BAD_DEBTS_PROVISIONS__BAD_DEBTS",
        "name": "Bad Debts",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BAD_DEBTS_PROVISIONS__PROVISION_FOR_DOUBTFUL_DEBTS",
        "name": "Provision for Doubtful Debts",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "BAD_DEBTS_PROVISIONS__CUSTOMER_BALANCE_WRITTEN_OFF",
        "name": "Customer Balance Written Off",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Discount Accounts",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "DISCOUNT_ACCOUNTS__DISCOUNT_ALLOWED",
        "name": "Discount Allowed",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DISCOUNT_ACCOUNTS__CASH_DISCOUNT_ALLOWED",
        "name": "Cash Discount Allowed",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DISCOUNT_ACCOUNTS__DISCOUNT_RECEIVED",
        "name": "Discount Received",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      }
    ]
  },
  {
    "mainAccountHead": "Miscellaneous Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "MISCELLANEOUS_EXPENSES__GENERAL_EXPENSE",
        "name": "General Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "MISCELLANEOUS_EXPENSES__MISCELLANEOUS_EXPENSE",
        "name": "Miscellaneous Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "MISCELLANEOUS_EXPENSES__SUNDRY_EXPENSE",
        "name": "Sundry Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "MISCELLANEOUS_EXPENSES__SMALL_EXPENSE",
        "name": "Small Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "MISCELLANEOUS_EXPENSES__ROUND_OFF",
        "name": "Round Off",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Round Off",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "ROUND_OFF__ROUND_OFF_GAIN",
        "name": "Round Off Gain",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "ROUND_OFF__ROUND_OFF_LOSS",
        "name": "Round Off Loss",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Suspense Account",
    "defaultSystemAccountCode": "SYS_SUSPENSE",
    "ledgers": [
      {
        "templateKey": "SUSPENSE_ACCOUNT__SUSPENSE_ACCOUNT",
        "name": "Suspense Account",
        "systemAccountCode": "SYS_SUSPENSE"
      },
      {
        "templateKey": "SUSPENSE_ACCOUNT__UNIDENTIFIED_BANK_RECEIPT",
        "name": "Unidentified Bank Receipt",
        "systemAccountCode": "SYS_SUSPENSE"
      },
      {
        "templateKey": "SUSPENSE_ACCOUNT__UNIDENTIFIED_BANK_PAYMENT",
        "name": "Unidentified Bank Payment",
        "systemAccountCode": "SYS_SUSPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Bank Reconciliation / Clearing",
    "defaultSystemAccountCode": "SYS_CURRENT_ASSETS",
    "ledgers": [
      {
        "templateKey": "BANK_RECONCILIATION_CLEARING__BANK_CLEARING_ACCOUNT",
        "name": "Bank Clearing Account",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "BANK_RECONCILIATION_CLEARING__PAYMENT_GATEWAY_CLEARING",
        "name": "Payment Gateway Clearing",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      },
      {
        "templateKey": "BANK_RECONCILIATION_CLEARING__ECOMMERCE_SETTLEMENT_CLEARING",
        "name": "Ecommerce Settlement Clearing",
        "systemAccountCode": "SYS_CURRENT_ASSETS"
      }
    ]
  },
  {
    "mainAccountHead": "Ecommerce Accounts",
    "defaultSystemAccountCode": "SYS_SUNDRY_DEBTORS",
    "ledgers": [
      {
        "templateKey": "ECOMMERCE_ACCOUNTS__AMAZON_RECEIVABLE",
        "name": "Amazon Receivable",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "ECOMMERCE_ACCOUNTS__FLIPKART_RECEIVABLE",
        "name": "Flipkart Receivable",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "ECOMMERCE_ACCOUNTS__BLINKIT_RECEIVABLE",
        "name": "Blinkit Receivable",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "ECOMMERCE_ACCOUNTS__INSTAMART_RECEIVABLE",
        "name": "Instamart Receivable",
        "systemAccountCode": "SYS_SUNDRY_DEBTORS"
      },
      {
        "templateKey": "ECOMMERCE_ACCOUNTS__MARKETPLACE_COMMISSION",
        "name": "Marketplace Commission",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ECOMMERCE_ACCOUNTS__MARKETPLACE_TDS_TCS",
        "name": "Marketplace TDS/TCS",
        "systemAccountCode": "SYS_DUTIES_TAXES"
      }
    ]
  },
  {
    "mainAccountHead": "Advance from Customers",
    "defaultSystemAccountCode": "SYS_CURRENT_LIABILITIES",
    "ledgers": [
      {
        "templateKey": "ADVANCE_FROM_CUSTOMERS__CUSTOMER_ADVANCE",
        "name": "Customer Advance",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "ADVANCE_FROM_CUSTOMERS__BOOKING_ADVANCE",
        "name": "Booking Advance",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "ADVANCE_FROM_CUSTOMERS__SECURITY_ADVANCE",
        "name": "Security Advance",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      }
    ]
  },
  {
    "mainAccountHead": "Advance to Suppliers",
    "defaultSystemAccountCode": "SYS_LOANS_ADVANCES",
    "ledgers": [
      {
        "templateKey": "ADVANCE_TO_SUPPLIERS__SUPPLIER_ADVANCE",
        "name": "Supplier Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "ADVANCE_TO_SUPPLIERS__MACHINERY_ADVANCE",
        "name": "Machinery Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      },
      {
        "templateKey": "ADVANCE_TO_SUPPLIERS__RAW_MATERIAL_ADVANCE",
        "name": "Raw Material Advance",
        "systemAccountCode": "SYS_LOANS_ADVANCES"
      }
    ]
  },
  {
    "mainAccountHead": "Deposits Received",
    "defaultSystemAccountCode": "SYS_CURRENT_LIABILITIES",
    "ledgers": [
      {
        "templateKey": "DEPOSITS_RECEIVED__CUSTOMER_SECURITY_DEPOSIT",
        "name": "Customer Security Deposit",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      },
      {
        "templateKey": "DEPOSITS_RECEIVED__DEALER_SECURITY_DEPOSIT",
        "name": "Dealer Security Deposit",
        "systemAccountCode": "SYS_CURRENT_LIABILITIES"
      }
    ]
  },
  {
    "mainAccountHead": "Taxes & Statutory Expense",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "TAXES_STATUTORY_EXPENSE__ROC_FILING_FEE",
        "name": "ROC Filing Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TAXES_STATUTORY_EXPENSE__GST_LATE_FEE",
        "name": "GST Late Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TAXES_STATUTORY_EXPENSE__TDS_LATE_FEE",
        "name": "TDS Late Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "TAXES_STATUTORY_EXPENSE__STATUTORY_FILING_CHARGES",
        "name": "Statutory Filing Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Donation / CSR",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "DONATION_CSR__DONATION",
        "name": "Donation",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DONATION_CSR__CSR_EXPENSE",
        "name": "CSR Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DONATION_CSR__CHARITY_EXPENSE",
        "name": "Charity Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Entertainment Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "ENTERTAINMENT_EXPENSES__STAFF_ENTERTAINMENT",
        "name": "Staff Entertainment",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ENTERTAINMENT_EXPENSES__CUSTOMER_ENTERTAINMENT",
        "name": "Customer Entertainment",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "ENTERTAINMENT_EXPENSES__MEETING_REFRESHMENT",
        "name": "Meeting Refreshment",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Printing Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "PRINTING_EXPENSES__VISITING_CARD_PRINTING",
        "name": "Visiting Card Printing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PRINTING_EXPENSES__CATALOGUE_PRINTING",
        "name": "Catalogue Printing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PRINTING_EXPENSES__INVOICE_PRINTING",
        "name": "Invoice Printing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PRINTING_EXPENSES__LABEL_PRINTING",
        "name": "Label Printing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PRINTING_EXPENSES__BROCHURE_PRINTING",
        "name": "Brochure Printing",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Legal & Compliance",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "LEGAL_COMPLIANCE__LEGAL_FEES",
        "name": "Legal Fees",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "LEGAL_COMPLIANCE__TRADEMARK_EXPENSE",
        "name": "Trademark Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "LEGAL_COMPLIANCE__PATENT_EXPENSE",
        "name": "Patent Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "LEGAL_COMPLIANCE__ISO_CERTIFICATION",
        "name": "ISO Certification",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "LEGAL_COMPLIANCE__FSSAI_FEE",
        "name": "FSSAI Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "LEGAL_COMPLIANCE__POLLUTION_CONTROL_FEE",
        "name": "Pollution Control Fee",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Research & Development",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "RESEARCH_DEVELOPMENT__PRODUCT_DEVELOPMENT",
        "name": "Product Development",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RESEARCH_DEVELOPMENT__SAMPLE_DEVELOPMENT",
        "name": "Sample Development",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RESEARCH_DEVELOPMENT__TESTING_CHARGES",
        "name": "Testing Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "RESEARCH_DEVELOPMENT__LABORATORY_CHARGES",
        "name": "Laboratory Charges",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Warehouse Expenses",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "WAREHOUSE_EXPENSES__WAREHOUSE_RENT",
        "name": "Warehouse Rent",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "WAREHOUSE_EXPENSES__WAREHOUSE_LABOUR",
        "name": "Warehouse Labour",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "WAREHOUSE_EXPENSES__WAREHOUSE_ELECTRICITY",
        "name": "Warehouse Electricity",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "WAREHOUSE_EXPENSES__MATERIAL_HANDLING",
        "name": "Material Handling",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "WAREHOUSE_EXPENSES__FORKLIFT_EXPENSE",
        "name": "Forklift Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Production Consumables",
    "defaultSystemAccountCode": "SYS_DIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "PRODUCTION_CONSUMABLES__LUBRICANT",
        "name": "Lubricant",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PRODUCTION_CONSUMABLES__GREASE",
        "name": "Grease",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PRODUCTION_CONSUMABLES__CUTTING_TOOLS",
        "name": "Cutting Tools",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PRODUCTION_CONSUMABLES__MACHINE_OIL",
        "name": "Machine Oil",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PRODUCTION_CONSUMABLES__CLEANING_CHEMICAL",
        "name": "Cleaning Chemical",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "PRODUCTION_CONSUMABLES__SPARE_CONSUMABLES",
        "name": "Spare Consumables",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Scrap / Wastage",
    "defaultSystemAccountCode": "SYS_DIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "SCRAP_WASTAGE__PRODUCTION_WASTAGE",
        "name": "Production Wastage",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "SCRAP_WASTAGE__SCRAP_EXPENSE",
        "name": "Scrap Expense",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "SCRAP_WASTAGE__DAMAGED_STOCK",
        "name": "Damaged Stock",
        "systemAccountCode": "SYS_DIRECT_EXPENSE"
      },
      {
        "templateKey": "SCRAP_WASTAGE__STOCK_WRITTEN_OFF",
        "name": "Stock Written Off",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Depreciation",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "DEPRECIATION__DEPRECIATION_MACHINERY",
        "name": "Depreciation – Machinery",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DEPRECIATION__BUILDING",
        "name": "Building",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DEPRECIATION__VEHICLE",
        "name": "Vehicle",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DEPRECIATION__FURNITURE",
        "name": "Furniture",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DEPRECIATION__COMPUTER",
        "name": "Computer",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "DEPRECIATION__ELECTRICAL_EQUIPMENT",
        "name": "Electrical Equipment",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      }
    ]
  },
  {
    "mainAccountHead": "Prior Period / Exceptional",
    "defaultSystemAccountCode": "SYS_INDIRECT_EXPENSE",
    "ledgers": [
      {
        "templateKey": "PRIOR_PERIOD_EXCEPTIONAL__PRIOR_PERIOD_EXPENSE",
        "name": "Prior Period Expense",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PRIOR_PERIOD_EXCEPTIONAL__PRIOR_PERIOD_INCOME",
        "name": "Prior Period Income",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      },
      {
        "templateKey": "PRIOR_PERIOD_EXCEPTIONAL__EXCEPTIONAL_LOSS",
        "name": "Exceptional Loss",
        "systemAccountCode": "SYS_INDIRECT_EXPENSE"
      },
      {
        "templateKey": "PRIOR_PERIOD_EXCEPTIONAL__EXCEPTIONAL_INCOME",
        "name": "Exceptional Income",
        "systemAccountCode": "SYS_INDIRECT_INCOME"
      }
    ]
  }
];

export const flattenLedgerLibrary = () =>
  DEFAULT_LEDGER_LIBRARY.flatMap(group =>
    group.ledgers.map(item => ({...item, mainAccountHead: group.mainAccountHead}))
  );

export const normalizeLedgerLibraryName = value =>
  String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
