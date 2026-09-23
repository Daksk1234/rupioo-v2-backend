const f = (key, label, type = "text", required = false, aliases = []) => ({ key, label, type, required, aliases });

export const DOCUMENT_FORM_TEMPLATES = {
  CUSTOMER: {
    type: "CUSTOMER", version: 1, title: "Customer Registration Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Business", fields: [f("gstin","GSTIN","text",false,["gst no","gst number"]),f("legalName","Party / Legal Name","text",true,["firm name","company name","party name"]),f("partyType","Party Type","choice",false,["debtor","creditor","ecommerce"]),f("pan","PAN"),f("companyContactNumber","Mobile No.","phone",true,["mobile","contact"]),f("email","Email","email")] },
      { title: "Delivery Address", fields: [f("address","Address","textarea",true),f("pincode","Pincode","pincode",true),f("area","Area"),f("city","City"),f("district","District"),f("state","State")] },
      { title: "Owner", fields: [f("ownerName","Owner Name"),f("ownerMobile","Owner Mobile","phone"),f("ownerPan","Owner PAN"),f("ownerAddress","Owner Address","textarea")] },
      { title: "Commercial", fields: [f("paymentType","Payment Type","choice",false,["cash","credit"]),f("creditDays","Credit Days","number"),f("creditLimit","Credit Limit","number"),f("remarks","Remarks","textarea")] },
      { title: "Bank", fields: [f("ifsc","IFSC","ifsc"),f("accountNumber","Account No."),f("accountName","Account Name"),f("bankName","Bank Name"),f("bankAddress","Bank Address","textarea")] }
    ]
  },
  USER: {
    type: "USER", version: 1, title: "User / Employee Registration Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Personal", fields: [f("name","Full Name","text",true),f("dateOfBirth","Date of Birth","date"),f("mobile","Mobile","phone",true),f("email","Email","email"),f("fatherName","Father Name"),f("fatherMobile","Father Mobile","phone"),f("motherMobile","Mother Mobile","phone"),f("aadhaar","Aadhaar"),f("pan","PAN"),f("drivingLicenseNumber","Driving Licence")] },
      { title: "Address", fields: [f("pincode","Pincode","pincode"),f("area","Area"),f("city","City"),f("district","District"),f("state","State"),f("address","Address","textarea")] },
      { title: "Bank", fields: [f("ifsc","IFSC","ifsc"),f("bankAccountNumber","Account No."),f("bankAccountName","Account Name"),f("bankName","Bank Name"),f("bankAddress","Bank Address","textarea")] },
      { title: "Employment", fields: [f("designation","Designation"),f("appointmentDate","Appointment Date","date"),f("salary","Salary","number"),f("lastWorkingFirmName","Last Firm"),f("lastWorkingProfileName","Last Profile"),f("lastWorkingContactNumber","Last Firm Contact","phone")] }
    ]
  },
  TRANSPORTER: {
    type: "TRANSPORTER", version: 1, title: "Transporter Registration Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Transporter", fields: [f("name","Transporter / Firm Name","text",true),f("gstin","GSTIN"),f("pan","PAN"),f("paymentTerms","Payment Terms"),f("freightNotes","Freight Notes","textarea")] },
      { title: "Primary Station", fields: [f("stationName","Station Name","text",true),f("stationType","Station Type","choice",false,["booking","delivery","both"]),f("pincode","Pincode","pincode"),f("address","Station Address","textarea"),f("serviceCities","Service Cities"),f("servicePincodes","Service Pincodes"),f("contactName","Contact Person"),f("phone","Phone","phone"),f("email","Email","email")] }
    ]
  },
  PRODUCT: {
    type: "PRODUCT", version: 1, title: "Product Master Creation Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Identity", fields: [f("name","Product Name","text",true),f("category","Category"),f("subCategory","Sub Category"),f("sku","SKU"),f("barcode","Barcode / GTIN")] },
      { title: "Tax & Unit", fields: [f("hsnCode","HSN Code","hsn"),f("hsnDescription","HSN Description","textarea"),f("gstRate","GST %","number"),f("basicUnit","Basic Unit"),f("packingUnit","Packing Unit"),f("qtyInBag","Qty in Packing","number")] },
      { title: "Stock & Price", fields: [f("warehouseName","Warehouse"),f("openingStock","Opening Stock","number"),f("openingRate","Opening Rate","number"),f("mrp","MRP","number"),f("salePrice","Sale Price","number"),f("minStockAlert","Minimum Stock Alert","number")] }
    ]
  },
  SALES_INVOICE: {
    type: "SALES_INVOICE", version: 1, title: "Sales Invoice Capture Sheet", subtitle: "Bulk scan sales invoices into DMS V2",
    sections: [
      { title: "Invoice", fields: [f("customerName","Buyer / Party Name","text",true),f("customerGstin","Buyer GSTIN"),f("invoiceNo","Invoice No.","text",true),f("date","Invoice Date","date",true),f("warehouseName","Warehouse"),f("orderNo","Order No."),f("arn","ARN / Reference"),f("noOfPackages","No. of Packages","number"),f("taxableValue","Scanned Taxable Value","number"),f("cgstAmount","CGST","number"),f("sgstAmount","SGST","number"),f("igstAmount","IGST","number"),f("roundOff","Round Off","number"),f("invoiceValue","Scanned Invoice Value","number"),f("billDiscount","Bill Discount","number"),f("otherCharges","Other Charges","number"),f("remarks","Remarks","textarea")] }
    ],
    table: { key: "items", title: "Products", columns: [f("name","Product","text",true),f("sku","SKU"),f("hsnCode","HSN"),f("qty","Qty","number",true),f("unit","Unit"),f("rate","Basic Rate","number",true),f("gstRate","GST %","number"),f("discountPct","Discount %","number")] }
  },
  PURCHASE_INVOICE: {
    type: "PURCHASE_INVOICE", version: 1, title: "Purchase Invoice Capture Sheet", subtitle: "Use for manual supplier invoice entry when required",
    sections: [
      { title: "Invoice", fields: [f("supplierName","Supplier / Party Name","text",true),f("supplierGstin","Supplier GSTIN"),f("invoiceNo","Invoice No.","text",true),f("date","Invoice Date","date",true),f("taxableValue","Scanned Taxable Value","number"),f("cgstAmount","CGST","number"),f("sgstAmount","SGST","number"),f("igstAmount","IGST","number"),f("roundOff","Round Off","number"),f("invoiceValue","Scanned Invoice Value","number"),f("remarks","Remarks","textarea")] },
      { title: "Landed Expenses", fields: [f("transportationCost","Transportation","number"),f("labourCost","Labour","number"),f("localFreight","Local Freight","number"),f("miscellaneousCost","Miscellaneous","number")] }
    ],
    table: { key: "items", title: "Products", columns: [f("name","Product","text",true),f("hsnCode","HSN"),f("qty","Qty","number",true),f("unit","Unit"),f("rate","Basic Rate","number",true),f("gstRate","GST %","number"),f("discountPct","Discount %","number")] }
  },
  LEAD: {
    type: "LEAD", version: 1, title: "Sales Lead / Visit Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Lead", fields: [f("companyName","Party Name","text",true),f("address","Address","textarea",true),f("mobile","Mobile No.","phone",true),f("pincode","Pincode","pincode",true),f("city","City"),f("state","State"),f("contactPerson","Contact Person"),f("whatsapp","WhatsApp","phone"),f("email","Email","email"),f("productInterest","Product Interest"),f("priority","Priority","choice",false,["hot","warm","normal","cold"])] },
      { title: "Follow-up", fields: [f("visitDate","Visit Date","date"),f("visitTime","Visit Time","time"),f("remarks","Remarks","textarea"),f("outcome","Outcome"),f("nextFollowUpAt","Next Visit / Follow-up","datetime")] }
    ]
  },
  EXPENSE: {
    type: "EXPENSE", version: 1, title: "Expense / Bill Capture Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Expense", fields: [f("date","Date","date",true),f("vendorName","Vendor / Payee"),f("invoiceNo","Bill / Ref No."),f("amount","Amount","number",true),f("paymentMode","Payment Mode"),f("expenseAccount","Expense Head"),f("gstin","Vendor GSTIN"),f("narration","Narration / Purpose","textarea")] }
    ]
  },
  DELIVERY_PROOF: {
    type: "DELIVERY_PROOF", version: 1, title: "Delivery Proof / Bilty Form", subtitle: "DMS V2 • Scan & Fill",
    sections: [
      { title: "Delivery", fields: [f("invoiceNo","Invoice No.","text",true),f("deliveredAt","Delivery Date / Time","datetime",true),f("deliveredTo","Received By","text",true),f("mobile","Receiver Mobile","phone"),f("vehicleNo","Vehicle No."),f("biltyNo","Bilty / LR No."),f("transporterName","Transporter"),f("deliveryStation","Delivery Station"),f("remarks","Remarks","textarea")] }
    ]
  },
  VENDOR_QUOTATION: {
    type: "VENDOR_QUOTATION", version: 1, title: "Vendor Quotation", subtitle: "Purchase AI • Vendor Document Scan",
    sections: [
      { title: "Quotation", fields: [f("quoteNo","Quotation No."),f("quoteDate","Quotation Date","date"),f("validityDate","Valid Till","date"),f("vendorName","Vendor Name"),f("vendorGstin","Vendor GSTIN"),f("creditDays","Credit Days","number"),f("deliveryDays","Delivery Days","number"),f("freight","Freight","number"),f("freightTerms","Freight Terms"),f("grandTotal","Grand Total","number"),f("remarks","Remarks","textarea")] }
    ],
    table: { key: "items", title: "Quoted Products", columns: [f("name","Product","text",true),f("sku","SKU"),f("hsnCode","HSN"),f("qty","Qty","number",true),f("unit","Unit"),f("rate","Basic Rate","number",true),f("discountPct","Discount %","number"),f("gstRate","GST %","number"),f("landedRate","Landed Rate","number")] }
  },
  LR_COPY: {
    type: "LR_COPY", version: 1, title: "LR / Bilty / Consignment Note", subtitle: "Purchase AI • Dispatch Scan",
    sections: [
      { title: "Transport", fields: [f("transporterName","Transporter","text",true),f("lrNo","LR / CN / Bilty No.","text",true),f("lrDate","LR Date","date"),f("fromLocation","From"),f("destination","Destination"),f("packages","No. of Packages","number"),f("weight","Weight","number"),f("freight","Freight","number"),f("freightMode","Paid / To Pay"),f("vehicleNo","Vehicle No."),f("expectedArrival","Expected Arrival","date"),f("remarks","Remarks","textarea")] }
    ]
  },
  SUPPLIER_INVOICE: {
    type: "SUPPLIER_INVOICE", version: 1, title: "Supplier Invoice", subtitle: "Purchase AI • Vendor Invoice Scan",
    sections: [
      { title: "Invoice", fields: [f("supplierName","Supplier Name","text",true),f("supplierGstin","Supplier GSTIN"),f("invoiceNo","Invoice No.","text",true),f("date","Invoice Date","date",true),f("poNo","PO No."),f("packages","Packages","number"),f("taxableValue","Taxable Value","number"),f("cgstAmount","CGST","number"),f("sgstAmount","SGST","number"),f("igstAmount","IGST","number"),f("freight","Freight","number"),f("invoiceValue","Invoice Value","number"),f("remarks","Remarks","textarea")] }
    ],
    table: { key: "items", title: "Invoice Products", columns: [f("name","Product","text",true),f("sku","SKU"),f("hsnCode","HSN"),f("qty","Qty","number",true),f("unit","Unit"),f("rate","Basic Rate","number",true),f("discountPct","Discount %","number"),f("gstRate","GST %","number")] }
  },
  SUPPLIER_CREDIT_NOTE: {
    type: "SUPPLIER_CREDIT_NOTE", version: 1, title: "Supplier Credit Note", subtitle: "Purchase AI • Claim Resolution Scan",
    sections: [
      { title: "Credit Note", fields: [f("creditNoteNo","Credit Note No.","text",true),f("date","Credit Note Date","date",true),f("invoiceNo","Against Invoice No."),f("poNo","PO No."),f("taxableValue","Taxable Value","number"),f("tax","GST","number"),f("total","Credit Note Total","number"),f("reason","Reason","textarea")] }
    ]
  }
};

export const listDocumentTemplates = () => Object.values(DOCUMENT_FORM_TEMPLATES);
export const getDocumentTemplate = (type) => DOCUMENT_FORM_TEMPLATES[String(type || "").trim().toUpperCase()] || null;
export const flattenedFields = (template) => (template?.sections || []).flatMap((s) => s.fields || []);
