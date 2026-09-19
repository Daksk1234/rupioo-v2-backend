import mongoose from "mongoose";
const { Schema } = mongoose;

export function fyModels(db) {
  const get = (name, schema) => db.models[name] || db.model(name, schema);

  const ledgerEntrySchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, transactionId: { type: String, index: true },
    transactionType: { type: String, index: true }, date: { type: Date, index: true }, accountCode: { type: String, index: true },
    partyGlobalId: { type: String, index: true }, ledgerId: { type: String, index: true }, bankAccountId: { type: String, index: true },
    debit: Number, credit: Number, narration: String, status: { type: String, default: "POSTED" }
  }, { timestamps: true });

  const invoiceItemSchema = new Schema({
    productId: String, sku: String, nameSnapshot: String, hsnSnapshot: String, qty: Number, unit: String,
    packingUnit: String, qtyInBag: Number, grossQty: Number, mrpSnapshot: Number, gradeDiscountPct: Number,
    landedCostSnapshot: Number, averagePurchasePriceSnapshot: Number, rate: Number, discountPct: Number, effectiveRate: Number, taxable: Number,
    gstRateSnapshot: Number, cgst: Number, sgst: Number, igst: Number, tax: Number, lineTotal: Number, profitPct: Number, marginColor: String
  }, { _id: false });

  const salesInvoiceSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, invoiceNo: { type: String, index: true }, date: { type: Date, index: true },
    customerGlobalId: { type: String, index: true }, customerNameSnapshot: String, gstinSnapshot: String, addressSnapshot: String,
    items: [invoiceItemSchema], subtotal: Number, billDiscount: Number, otherCharges: Number, taxableTotal: Number, taxTotal: Number, roundOff: Number, grandTotal: Number, grossProfit: Number, grossMarginPct: Number,
    orderNo: String, arn: String, noOfPackages: Number, deliveryBoy: String, gstType: String, remarks: String,
    eInvoice: {
      status: { type: String, enum: ["NOT_GENERATED", "PENDING", "GENERATED", "CANCELLED"], default: "NOT_GENERATED" },
      irn: { type: String, default: "" }, ackNo: { type: String, default: "" }, ackDate: Date, signedQrPayload: { type: String, default: "" }
    },
    transportAssignment: {
      mode: { type:String, default:"LOCAL" }, firmCitySnapshot:String, customerCitySnapshot:String, transporterId:String, globalTransporterId:String, transporterNameSnapshot:String,
      bookingStationId:String, bookingStationNameSnapshot:String, bookingStationAddressSnapshot:String, bookingStationCitySnapshot:String, bookingStationPincodeSnapshot:String,
      deliveryStationId:String, deliveryStationNameSnapshot:String, deliveryStationAddressSnapshot:String, deliveryStationCitySnapshot:String, deliveryStationPincodeSnapshot:String, serviceAreaSnapshot:String
    },
    branchId: { type:String, index:true }, warehouseId: { type:String, index:true }, warehouseNameSnapshot: String, assignedTo: { type:String, index:true },
    workflowStatus: { type:String, default:"POSTED", index:true }, releasedToWarehouseAt: Date, warehouseProcessedBy: String,
    delivery: {
      deliveredAt: Date, deliveredTo: String, mobile: String, vehicleNo: String, biltyNo: String, remarks: String,
      proofFiles: [{ kind:String, fileName:String, storedName:String, path:String, mimeType:String, size:Number }],
      emailedAt: Date, emailTo: String, emailStatus: String, emailError: String
    },
    status: { type: String, default: "POSTED", index: true }, createdBy: String, createdByNameSnapshot: String
  }, { timestamps: true });
  salesInvoiceSchema.index({ tenantKey: 1, invoiceNo: 1 }, { unique: true });

  const purchaseInvoiceSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, invoiceNo: { type:String, index:true }, date: { type: Date, index: true },
    supplierGlobalId: String, supplierNameSnapshot: String, supplierGstinSnapshot: String, purchaseType: String,
    items: [invoiceItemSchema], subtotal: Number, billDiscount: Number, otherCharges: Number, taxableTotal: Number, taxTotal: Number, roundOff: Number, grandTotal: Number,
    landedCharges: Number, transportationCost: Number, labourCost: Number, localFreight: Number, miscellaneousCost: Number, landedTax: Number, landedExpensePercentage: Number, maxGstPercentage: Number,
    remarks:String, createdBy:String, createdByNameSnapshot:String, status: { type: String, default: "POSTED" }
  }, { timestamps: true });
  purchaseInvoiceSchema.index({ tenantKey:1, financialYear:1, invoiceNo:1 }, { unique:true });

  const receiptSchema = new Schema({
    tenantKey: String,
    financialYear: String,
    receiptNo: { type: String, index: true },
    date: { type: Date, index: true },
    customerGlobalId: { type: String, index: true },
    partyNameSnapshot:String,
    amount: Number,
    mode: String,
    reference: String,
    remarks:String,
    bankAccountId:{type:String,index:true},
    bankNameSnapshot:String,
    statementImportId:String,
    statementRowNo:Number,
    runningBalance:Number,
    bounceStatus: String,
    // Sales Person app ownership. Legacy receipts remain valid because these
    // fields are optional and attribution falls back to createdBy where needed.
    collectedBySalespersonId: { type: String, index: true },
    collectionSource: { type: String, default: "DMS", index: true },
    cashCustodyMovementId: { type: String, index: true },
    createdBy:String,
    createdByNameSnapshot:String,
    status: { type: String, default: "POSTED" }
  }, { timestamps: true });
  receiptSchema.index({ tenantKey: 1, financialYear: 1, collectedBySalespersonId: 1, date: -1 });

  const paymentSchema = new Schema({ tenantKey: String, financialYear: String, paymentNo: String, date: { type: Date, index: true }, partyGlobalId: { type: String, index: true }, partyNameSnapshot:String, amount: Number, mode: String, reference: String, remarks:String, bankAccountId:{type:String,index:true}, bankNameSnapshot:String, statementImportId:String, statementRowNo:Number, runningBalance:Number, createdBy:String, createdByNameSnapshot:String, status: { type: String, default: "POSTED" } }, { timestamps: true });

  const bankStatementImportSchema = new Schema({
    tenantKey:String, financialYear:{type:String,index:true}, importId:{type:String,index:true}, bankAccountId:{type:String,index:true}, bankNameSnapshot:String, accountNumberSnapshot:String,
    fileName:String, openingBalance:Number, closingBalance:Number, totalDebit:Number, totalCredit:Number, totalRows:Number, postedRows:Number, unmatchedRows:Number, duplicateRows:Number, errorRows:Number,
    status:{type:String,default:"DRAFT_REVIEW",index:true}, importedBy:String, importedByNameSnapshot:String, submittedBy:String, submittedByNameSnapshot:String, submittedAt:Date
  },{timestamps:true});
  bankStatementImportSchema.index({tenantKey:1,financialYear:1,bankAccountId:1,createdAt:-1});

  const bankStatementRowSchema = new Schema({
    tenantKey:String, financialYear:{type:String,index:true}, importId:{type:String,index:true}, bankAccountId:{type:String,index:true}, rowNo:Number, date:{type:Date,index:true}, partyName:String, remarks:String, mode:String,
    debit:Number, credit:Number, runningBalance:Number, fingerprint:{type:String,index:true}, sourceFingerprint:{type:String,index:true}, matchedPartyGlobalId:String, matchedPartyName:String, partyAccountCode:String,
    transactionType:String, transactionId:String, detectionSource:String, matchConfidence:Number, candidateCount:Number, submittedAt:Date,
    classification:{type:String,default:"DRAFT",index:true}, createdBy:String, createdByNameSnapshot:String, submittedBy:String, submittedByNameSnapshot:String, error:String
  },{timestamps:true});
  bankStatementRowSchema.index({tenantKey:1,financialYear:1,bankAccountId:1,fingerprint:1},{unique:true});

  const stockMovementSchema = new Schema({ tenantKey: String, financialYear: String, date: { type: Date, index: true }, productId: { type: String, index: true }, warehouseId: String, type: { type: String, index: true }, qtyIn: Number, qtyOut: Number, landedCost: Number, referenceId: String }, { timestamps: true });
  const expenseSchema = new Schema({ tenantKey: String, financialYear: String, expenseNo: { type: String, index: true }, date: { type: Date, index: true }, accountCode: { type: String, index: true }, amount: Number, nature: String, allocationMethod: String, branchId: String, productId: String, customerGlobalId: String, status: { type: String, default: "POSTED" } }, { timestamps: true });

  // Sales Person app orders are intentionally separate from posted Sales Invoices.
  const salesOrderItemSchema = new Schema({
    productId: { type: String, index: true }, sku: String, nameSnapshot: String, hsnSnapshot: String,
    qty: Number, unit: String, packingUnit: String, qtyInBag: Number, listRate: Number,
    rate: Number, discountPct: Number, taxable: Number, gstRateSnapshot: Number, tax: Number, lineTotal: Number,
  }, { _id: false });

  const salesOrderSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, orderNo: { type: String, index: true }, date: { type: Date, index: true },
    customerGlobalId: { type: String, index: true }, customerNameSnapshot: String, salespersonId: { type: String, index: true },
    source: { type: String, enum: ["MANUAL", "REPEAT", "SUGGESTED"], default: "MANUAL", index: true },
    repeatFromOrderNo: String, repeatFromInvoiceNo: String, items: [salesOrderItemSchema],
    subtotal: Number, discountTotal: Number, taxTotal: Number, grandTotal: Number, remarks: String,
    // Credit control is a hold, not a lost order. Admin/DMS can later approve it.
    status: { type: String, enum: ["DRAFT", "SUBMITTED", "CREDIT_HOLD", "APPROVED", "PROCESSING", "CONVERTED", "CANCELLED", "REJECTED"], default: "SUBMITTED", index: true },
    creditControl: {
      creditLimit: Number,
      receivableBeforeOrder: Number,
      pendingOrderExposure: Number,
      availableBeforeOrder: Number,
      orderAmount: Number,
      projectedExposure: Number,
      exceededBy: Number,
      holdReason: String,
      checkedAt: Date,
      decision: { type: String, enum: ["APPROVE", "REJECT", ""], default: "" },
      decisionBy: String,
      decisionByNameSnapshot: String,
      decisionAt: Date,
      decisionRemark: String,
    },
    createdBy: String, createdByNameSnapshot: String,
  }, { timestamps: true });
  salesOrderSchema.index({ tenantKey: 1, financialYear: 1, orderNo: 1 }, { unique: true });
  salesOrderSchema.index({ tenantKey: 1, financialYear: 1, customerGlobalId: 1, date: -1 });
  salesOrderSchema.index({ tenantKey: 1, financialYear: 1, salespersonId: 1, date: -1 });

  const promiseToPaySchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, promiseNo: { type: String, index: true },
    customerGlobalId: { type: String, index: true }, customerNameSnapshot: String, salespersonId: { type: String, index: true },
    amount: { type: Number, default: 0 }, promiseDate: { type: Date, index: true }, invoiceNos: [String], remarks: String,
    status: { type: String, enum: ["OPEN", "PARTIAL", "FULFILLED", "BROKEN", "CANCELLED"], default: "OPEN", index: true },
    fulfilledAmount: { type: Number, default: 0 }, fulfilledByReceiptIds: [String], lastActionAt: Date,
    createdBy: String, createdByNameSnapshot: String,
  }, { timestamps: true });
  promiseToPaySchema.index({ tenantKey: 1, financialYear: 1, promiseNo: 1 }, { unique: true });
  promiseToPaySchema.index({ tenantKey: 1, financialYear: 1, customerGlobalId: 1, status: 1, promiseDate: 1 });

  // Physical cash custody for Sales Person collections. Customer accounting is
  // posted through Receipt/LedgerEntry; this model tracks who physically holds cash.
  const salespersonCashMovementSchema = new Schema({
    tenantKey: { type: String, index: true },
    financialYear: { type: String, index: true },
    movementNo: { type: String, index: true },
    salespersonId: { type: String, index: true },
    salespersonNameSnapshot: String,
    date: { type: Date, default: Date.now, index: true },
    dayKey: { type: String, index: true },
    type: {
      type: String,
      enum: ["COLLECTION", "HANDOVER", "BANK_DEPOSIT", "SHORTAGE", "EXCESS", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"],
      required: true,
      index: true,
    },
    direction: { type: String, enum: ["IN", "OUT"], required: true, index: true },
    amount: { type: Number, required: true },
    customerGlobalId: { type: String, index: true },
    customerNameSnapshot: String,
    receiptId: String,
    receiptNo: String,
    recipientUserId: { type: String, index: true },
    recipientName: String,
    bankAccountId: { type: String, index: true },
    bankNameSnapshot: String,
    reference: String,
    proofReference: String,
    remarks: String,
    sourceDayClosingId: String,
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED", "POSTED", "CANCELLED"], default: "PENDING", index: true },
    verifiedBy: String,
    verifiedByNameSnapshot: String,
    verifiedAt: Date,
    rejectionReason: String,
    accountingTransactionId: String,
    createdBy: String,
    createdByNameSnapshot: String,
  }, { timestamps: true });
  salespersonCashMovementSchema.index({ tenantKey: 1, financialYear: 1, movementNo: 1 }, { unique: true });
  salespersonCashMovementSchema.index({ tenantKey: 1, financialYear: 1, salespersonId: 1, date: -1 });
  salespersonCashMovementSchema.index({ tenantKey: 1, financialYear: 1, salespersonId: 1, status: 1, type: 1 });

  const salespersonDayClosingSchema = new Schema({
    tenantKey: { type: String, index: true },
    financialYear: { type: String, index: true },
    closingNo: { type: String, index: true },
    salespersonId: { type: String, index: true },
    salespersonNameSnapshot: String,
    dayKey: { type: String, index: true },
    closingDate: { type: Date, index: true },
    openingCash: Number,
    cashCollected: Number,
    approvedHandover: Number,
    approvedBankDeposit: Number,
    approvedAdjustmentsIn: Number,
    approvedAdjustmentsOut: Number,
    expectedClosing: Number,
    declaredClosing: Number,
    variance: Number,
    varianceType: { type: String, enum: ["NONE", "SHORTAGE", "EXCESS"], default: "NONE" },
    remarks: String,
    status: { type: String, enum: ["CLOSED", "REVIEW_REQUIRED", "APPROVED", "REJECTED"], default: "CLOSED", index: true },
    varianceMovementId: String,
    reviewedBy: String,
    reviewedByNameSnapshot: String,
    reviewedAt: Date,
    reviewRemark: String,
    createdBy: String,
    createdByNameSnapshot: String,
  }, { timestamps: true });
  salespersonDayClosingSchema.index({ tenantKey: 1, financialYear: 1, closingNo: 1 }, { unique: true });
  salespersonDayClosingSchema.index({ tenantKey: 1, financialYear: 1, salespersonId: 1, dayKey: 1 }, { unique: true });

  return {
    LedgerEntry: get("LedgerEntry", ledgerEntrySchema),
    SalesInvoice: get("SalesInvoice", salesInvoiceSchema),
    PurchaseInvoice: get("PurchaseInvoice", purchaseInvoiceSchema),
    Receipt: get("Receipt", receiptSchema),
    Payment: get("Payment", paymentSchema),
    StockMovement: get("StockMovement", stockMovementSchema),
    Expense: get("Expense", expenseSchema),
    SalesOrder: get("SalesOrder", salesOrderSchema),
    PromiseToPay: get("PromiseToPay", promiseToPaySchema),
    SalespersonCashMovement: get("SalespersonCashMovement", salespersonCashMovementSchema),
    SalespersonDayClosing: get("SalespersonDayClosing", salespersonDayClosingSchema),
    BankStatementImport: get("BankStatementImport", bankStatementImportSchema),
    BankStatementRow: get("BankStatementRow", bankStatementRowSchema)
  };
}
