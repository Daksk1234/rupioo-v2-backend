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
    // DIRECT invoices stay independent from the order workflow. ORDER invoices are linked back to SalesOrder.
    billingMode: { type: String, enum: ["DIRECT", "ORDER"], default: "DIRECT", index: true },
    sourceOrderId: { type: String, index: true },
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
      deliveredAt: Date, deliveredTo: String, mobile: String, vehicleNo: String, biltyNo: String, remarks: String, deliveryMode: String,
      proofFiles: [{ kind:String, fileName:String, storedName:String, path:String, mimeType:String, size:Number }],
      proofFileIds: [String],
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
    // DIRECT keeps urgent/cash purchase invoices independent. PO links the smart procurement workflow.
    procurementMode: { type:String, enum:["DIRECT","PO"], default:"DIRECT", index:true },
    sourcePurchaseOrderId: { type:String, index:true }, sourcePurchaseOrderNo:String, sourceGrnId:{ type:String,index:true }, sourceGrnNo:String,
    accountingStatus: { type:String, default:"POSTED", index:true }, accountingPostedAt:Date, accountingPostedBy:String, warehouseOtpVerifiedAt:Date,
    vendorInvoiceFileIds: [String],
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
    // Order lifecycle quantities. qty remains the immutable ordered quantity.
    reservedQty: { type: Number, default: 0 },
    packedQty: { type: Number, default: 0 },
    invoicedQty: { type: Number, default: 0 },
    returnedQty: { type: Number, default: 0 },
    cancelledQty: { type: Number, default: 0 },
    shortageReason: String,
  }, { _id: false });

  const salesOrderSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, orderNo: { type: String, index: true }, date: { type: Date, index: true },
    customerGlobalId: { type: String, index: true }, customerNameSnapshot: String, salespersonId: { type: String, index: true },
    source: { type: String, enum: ["MANUAL", "REPEAT", "SUGGESTED"], default: "MANUAL", index: true },
    repeatFromOrderNo: String, repeatFromInvoiceNo: String, items: [salesOrderItemSchema],
    subtotal: Number, discountTotal: Number, taxTotal: Number, grandTotal: Number, remarks: String,
    // How the order entered the system. Direct cash/walk-in invoices do not create
    // SalesOrder rows and therefore remain completely independent of this workflow.
    orderChannel: { type: String, enum: ["DMS", "CUSTOMER", "SALESPERSON_ON_BEHALF"], default: "DMS", index: true },
    customerOtpRequired: { type: Boolean, default: false },
    customerOtpVerifiedAt: Date,
    customerOtpId: String,
    workflowStatus: { type: String, default: "ORDER_PLACED", index: true },
    reservation: {
      status: { type: String, enum: ["NONE", "RESERVED", "PARTIAL", "RELEASED"], default: "NONE" },
      reservedAt: Date, releasedAt: Date, releasedReason: String,
    },
    packing: {
      startedAt: Date, packedAt: Date, packedBy: String, packedByNameSnapshot: String,
      packageCount: { type: Number, default: 0 }, actualWeight: { type: Number, default: 0 }, remarks: String,
    },
    invoice: { invoiceId: String, invoiceNo: String, invoiceDate: Date },
    invoices: [{ invoiceId: String, invoiceNo: String, invoiceDate: Date, grandTotal: Number }],
    deliveryType: { type: String, enum: ["LOCAL", "TRANSPORTER"], default: "LOCAL", index: true },
    deliveryRunId: String,
    lastWorkflowAt: Date,
    nextAction: String,
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
  salesOrderSchema.index({ tenantKey: 1, financialYear: 1, workflowStatus: 1, updatedAt: -1 });

  const orderEventSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true },
    eventNo: { type: String, index: true }, orderId: { type: String, index: true }, orderNo: { type: String, index: true },
    invoiceId: String, invoiceNo: String, deliveryRunId: String,
    type: { type: String, index: true }, fromStatus: String, toStatus: String,
    note: String, meta: { type: Schema.Types.Mixed, default: {} },
    audience: { type: [String], default: ["DMS"] },
    actorId: String, actorNameSnapshot: String, actorRole: String,
    occurredAt: { type: Date, default: Date.now, index: true },
  }, { timestamps: true });
  orderEventSchema.index({ tenantKey: 1, financialYear: 1, orderId: 1, occurredAt: 1 });

  const orderNotificationSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true },
    notificationNo: { type: String, index: true }, orderId: String, orderNo: String, eventNo: String,
    recipientType: { type: String, enum: ["CUSTOMER", "SALESPERSON", "DELIVERY_BOY", "WAREHOUSE", "ORDER_DESK", "ADMIN"], index: true },
    recipientId: { type: String, index: true }, channel: { type: String, default: "IN_APP" },
    title: String, body: String, data: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["PENDING", "SENT", "READ", "FAILED"], default: "PENDING", index: true },
    sentAt: Date, readAt: Date,
  }, { timestamps: true });
  orderNotificationSchema.index({ tenantKey: 1, financialYear: 1, recipientType: 1, recipientId: 1, createdAt: -1 });

  const deliveryRunStopSchema = new Schema({
    stopId: { type: String, required: true }, sequence: Number,
    orderId: String, orderNo: String, invoiceId: String, invoiceNo: String,
    customerGlobalId: String, customerNameSnapshot: String, mobileSnapshot: String, salespersonId: String, warehouseId: String,
    destinationType: { type: String, enum: ["CUSTOMER", "TRANSPORTER"], default: "CUSTOMER" },
    destinationNameSnapshot: String, addressSnapshot: String, citySnapshot: String, pincodeSnapshot: String,
    location: { lat: Number, lng: Number },
    transporterId: String, transporterNameSnapshot: String, transporterStationId: String, transporterStationNameSnapshot: String,
    packageCount: Number, actualWeight: Number,
    status: { type: String, enum: ["PENDING", "STARTED", "ARRIVED", "DELIVERED", "HANDED_TO_TRANSPORTER", "FAILED", "RETURN_IN_TRANSIT", "RETURNED_TO_WAREHOUSE", "SKIPPED"], default: "PENDING", index: true },
    estimatedDistanceFromPreviousMeters: Number, estimatedTravelMinutes: Number, estimatedArrivalAt: Date,
    startedAt: Date, arrivedAt: Date, completedAt: Date,
    gps: { lat: Number, lng: Number, accuracy: Number },
    customerOtp: { otpId: String, verifiedAt: Date },
    transporterHandover: {
      cnNo: String, cnDate: Date, packages: Number, weight: Number, freightAmount: Number, freightMode: String,
      contactPerson: String, mobile: String, vehicleNo: String, proofFileId: String,
      destinationSnapshot: String, capturedAt: Date,
    },
    failure: { reason: String, remarks: String, salespersonOtpId: String, verifiedAt: Date, failedAt: Date },
    warehouseReturn: { otpId: String, verifiedAt: Date, receivedBy: String, receivedByNameSnapshot: String, receivedAt: Date, remarks: String },
  }, { _id: false });

  const deliveryRunSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true },
    runNo: { type: String, index: true }, date: { type: Date, default: Date.now, index: true },
    deliveryBoyId: { type: String, index: true }, deliveryBoyNameSnapshot: String, vehicleNo: String,
    status: { type: String, enum: ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"], default: "PLANNED", index: true },
    startLocation: { lat: Number, lng: Number }, currentLocation: { lat: Number, lng: Number, accuracy: Number },
    startedAt: Date, completedAt: Date, routeVersion: { type: Number, default: 1 },
    estimatedDistanceMeters: { type: Number, default: 0 }, estimatedTravelMinutes: { type: Number, default: 0 },
    stops: [deliveryRunStopSchema],
    createdBy: String, createdByNameSnapshot: String, updatedBy: String,
  }, { timestamps: true });
  deliveryRunSchema.index({ tenantKey: 1, financialYear: 1, runNo: 1 }, { unique: true });
  deliveryRunSchema.index({ tenantKey: 1, financialYear: 1, deliveryBoyId: 1, date: -1 });

  const creditNoteItemSchema = new Schema({
    productId: String, sku: String, nameSnapshot: String, qty: Number, unit: String,
    rate: Number, taxable: Number, tax: Number, lineTotal: Number, condition: String,
  }, { _id: false });
  const creditNoteSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true },
    creditNoteNo: { type: String, index: true }, date: { type: Date, default: Date.now, index: true },
    orderId: String, orderNo: String, invoiceId: String, invoiceNo: String,
    customerGlobalId: String, customerNameSnapshot: String, items: [creditNoteItemSchema],
    taxableTotal: Number, taxTotal: Number, grandTotal: Number, reason: String,
    status: { type: String, enum: ["DRAFT", "ISSUED", "CANCELLED"], default: "DRAFT", index: true },
    issuedAt: Date, createdBy: String, createdByNameSnapshot: String, issuedBy: String,
  }, { timestamps: true });
  creditNoteSchema.index({ tenantKey: 1, financialYear: 1, creditNoteNo: 1 }, { unique: true });
  creditNoteSchema.index({ tenantKey: 1, financialYear: 1, invoiceId: 1, status: 1 });

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
    OrderEvent: get("OrderEvent", orderEventSchema),
    OrderNotification: get("OrderNotification", orderNotificationSchema),
    DeliveryRun: get("DeliveryRun", deliveryRunSchema),
    CreditNote: get("CreditNote", creditNoteSchema),
    PromiseToPay: get("PromiseToPay", promiseToPaySchema),
    SalespersonCashMovement: get("SalespersonCashMovement", salespersonCashMovementSchema),
    SalespersonDayClosing: get("SalespersonDayClosing", salespersonDayClosingSchema),
    BankStatementImport: get("BankStatementImport", bankStatementImportSchema),
    BankStatementRow: get("BankStatementRow", bankStatementRowSchema)
  };
}
