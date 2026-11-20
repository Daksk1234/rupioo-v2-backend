import mongoose from "mongoose";
const { Schema } = mongoose;

export function fyModels(db) {
  const get = (name, schema) => db.models[name] || db.model(name, schema);

  const ledgerEntrySchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, transactionId: { type: String, index: true },
    transactionType: { type: String, index: true }, date: { type: Date, index: true }, accountCode: { type: String, index: true },
    partyGlobalId: { type: String, index: true }, ledgerId: { type: String, index: true }, bankAccountId: { type: String, index: true },
    debit: Number, credit: Number, narration: String, status: { type: String, default: "POSTED" },
    // Immutable, deterministic identifier for ONE journal line. Old rows do not
    // have this key; the partial unique index therefore does not break migrations.
    postingKey: { type: String },
    // When a posted journal is reversed for an edit/cancellation, preserve its
    // former deterministic key here and release postingKey so the corrected
    // transaction can safely reuse the active posting key.
    archivedPostingKey: { type: String, default: "" },
  }, { timestamps: true });
  ledgerEntrySchema.index(
    { tenantKey: 1, financialYear: 1, postingKey: 1 },
    { unique: true, partialFilterExpression: { postingKey: { $type: "string" } } },
  );
  // Cashbook/BANK lookups filter by ledger account and sort by voucher date.
  // The party-specific index below cannot satisfy that sort without a party filter.
  ledgerEntrySchema.index({ tenantKey: 1, financialYear: 1, accountCode: 1, status: 1, date: 1, createdAt: 1 });
  // Fast customer-ledger reports (Lock Party / receivable ageing).
  ledgerEntrySchema.index({ tenantKey: 1, financialYear: 1, accountCode: 1, status: 1, partyGlobalId: 1, date: 1 });

  const invoiceItemSchema = new Schema({
    productId: String, sku: String, nameSnapshot: String, hsnSnapshot: String, qty: Number, unit: String,
    packingUnit: String, qtyInBag: Number, grossQty: Number, mrpSnapshot: Number, gradeDiscountPct: Number,
    landedCostSnapshot: Number, averagePurchasePriceSnapshot: Number, rate: Number, discountPct: Number, effectiveRate: Number, taxable: Number,
    // Purchase invoices keep the entered/basic taxable separately from the net value
    // after bill-level Discount + Charges.  This prevents edit/list/stock costing
    // from confusing the raw Basic Total with the actual taxable purchase value.
    netRate: Number, netTaxable: Number, billDiscountShare: Number, billChargeShare: Number,
    gstRateSnapshot: Number, cgst: Number, sgst: Number, igst: Number, tax: Number, lineTotal: Number, profitPct: Number, marginColor: String
  }, { _id: false });

  const salesInvoiceSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, invoiceNo: { type: String, index: true },
    // INVOICE = statutory/posted Sales Invoice. PERFORMA = non-posting
    // performa document that can later be converted into a real Sales Invoice.
    // Existing rows without this field are treated as INVOICE by the API.
    invoiceType: { type: String, enum: ["INVOICE", "PERFORMA"], default: "INVOICE", index: true },
    performaSerial: Number,
    // Linkage is retained on both sides when a Performa is converted.
    sourcePerformaId: String, sourcePerformaNo: String,
    convertedInvoiceId: String, convertedInvoiceNo: String, convertedAt: Date,
    convertedBy: String, convertedByNameSnapshot: String,
    voidedInvoiceNo: { type: String, default: "" }, voidedAt: Date, // preserve the original number of safely recycled test invoices
    date: { type: Date, index: true },
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
      mode: { type:String, default:"LOCAL" }, matchType:String, firmCitySnapshot:String, customerCitySnapshot:String, transporterId:String, globalTransporterId:String, transporterNameSnapshot:String,
      bookingStationId:String, bookingStationNameSnapshot:String, bookingStationAddressSnapshot:String, bookingStationCitySnapshot:String, bookingStationPincodeSnapshot:String,
      deliveryStationId:String, deliveryStationNameSnapshot:String, deliveryStationAddressSnapshot:String, deliveryStationCitySnapshot:String, deliveryStationPincodeSnapshot:String, serviceAreaSnapshot:String
    },
    branchId: { type:String, index:true }, warehouseId: { type:String, index:true }, warehouseNameSnapshot: String, assignedTo: { type:String, index:true },
    workflowStatus: { type:String, default:"POSTED", index:true }, releasedToWarehouseAt: Date, warehouseProcessedBy: String,
    // Credit Note state is stored on the invoice for fast invoice-wise outstanding/UI.
    // The CreditNote collection remains the accounting source of truth.
    creditNoteAmount: { type:Number, default:0 }, netInvoiceAmount: Number,
    creditNoteStatus: { type:String, enum:["NONE","PARTIAL","FULL"], default:"NONE", index:true },
    lastCreditNoteNo: String, lastCreditNoteAt: Date,
    // Transporter / consignment-note details captured against the sales invoice.
    // Keep this separate from accounting Credit Notes above.
    consignmentNote: {
      cnDate: Date, cnQty: Number, cnNumber: String,
      imageFileId: String, imageName: String, imageMimeType: String,
      savedAt: Date, savedBy: String, savedByNameSnapshot: String
    },
    delivery: {
      deliveredAt: Date,
      // Dispatch information captured at delivery time. Keep old receiver/proof
      // fields for backward compatibility with historical invoices, but new
      // deliveries use transporter/package/CN/LR details instead.
      transporterName: String, noOfPackages: Number, cnNumber: String,
      deliveredTo: String, mobile: String, vehicleNo: String, biltyNo: String, remarks: String, deliveryMode: String,
      proofFiles: [{ kind:String, fileName:String, storedName:String, path:String, mimeType:String, size:Number }],
      proofFileIds: [String],
      emailedAt: Date, emailTo: String, emailStatus: String, emailError: String
    },
    status: { type: String, default: "POSTED", index: true }, createdBy: String, createdByNameSnapshot: String
  }, { timestamps: true });
  salesInvoiceSchema.index({ tenantKey: 1, invoiceNo: 1 }, { unique: true });
  salesInvoiceSchema.index({ tenantKey: 1, financialYear: 1, status: 1, date: 1 });
  salesInvoiceSchema.index({ tenantKey: 1, financialYear: 1, invoiceType: 1, status: 1, date: -1 });
  salesInvoiceSchema.index({ tenantKey: 1, financialYear: 1, status: 1, "items.productId": 1, date: -1 });
  // Fast customer activity reports (Dead Party / last purchase / 3-month activity).
  salesInvoiceSchema.index({ tenantKey: 1, financialYear: 1, status: 1, customerGlobalId: 1, date: -1 });

  const purchaseAdjustmentSchema = new Schema({
    id: String, masterId: String, type: String, title: String, method: String, value: Number, applied: Number
  }, { _id: false });

  const purchaseInvoiceSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, invoiceNo: { type:String, index:true }, date: { type: Date, index: true },
    supplierGlobalId: String, supplierNameSnapshot: String, supplierGstinSnapshot: String, purchaseType: String,
    items: [invoiceItemSchema], adjustments: [purchaseAdjustmentSchema], subtotal: Number, billDiscount: Number, otherCharges: Number, taxableTotal: Number, taxTotal: Number, roundOff: Number, grandTotal: Number,
    landedCharges: Number, transportationCost: Number, labourCost: Number, localFreight: Number, miscellaneousCost: Number, landedTax: Number, landedExpensePercentage: Number, maxGstPercentage: Number,
    // DIRECT keeps urgent/cash purchase invoices independent. PO links the smart procurement workflow.
    procurementMode: { type:String, enum:["DIRECT","PO"], default:"DIRECT", index:true },
    sourcePurchaseOrderId: { type:String, index:true }, sourcePurchaseOrderNo:String, sourceGrnId:{ type:String,index:true }, sourceGrnNo:String,
    accountingStatus: { type:String, default:"POSTED", index:true }, accountingPostedAt:Date, accountingPostedBy:String, warehouseOtpVerifiedAt:Date,
    vendorInvoiceFileIds: [String],
    remarks:String, createdBy:String, createdByNameSnapshot:String, status: { type: String, default: "POSTED" }
  }, { timestamps: true });
  purchaseInvoiceSchema.index({ tenantKey:1, financialYear:1, invoiceNo:1 }, { unique:true });
  purchaseInvoiceSchema.index({ tenantKey:1, financialYear:1, status:1, date:1 });
  purchaseInvoiceSchema.index({ tenantKey:1, financialYear:1, status:1, "items.productId":1, date:-1 });

  const receiptSchema = new Schema({
    tenantKey: String,
    financialYear: String,
    receiptNo: { type: String, index: true },
    sourceKey: String,
    creationSource: {type:String,index:true},
    date: { type: Date, index: true },
    customerGlobalId: { type: String, index: true },
    // Identity of the precise tenant-local CustomerLink chosen by the collector.
    customerLinkId: String,
    partyType:String,
    partyNameSnapshot:String,
    amount: Number,
    // Top-level collection channel used by the salesperson receipt flow.
    // Legacy rows may still store CHEQUE directly in mode; new rows use CASH/BANK.
    mode: String,
    receiptType: { type: String, index: true }, // CASH / CHEQUE / UPI
    allocationType: { type: String, default: "INVOICE", index: true }, // INVOICE / ADVANCE
    againstInvoices: [{
      invoiceId: String,
      invoiceNo: String,
      invoiceDate: Date,
      financialYear:String,
      amount: Number,
    }],
    againstDocuments:[{kind:String,documentId:String,documentNo:String,financialYear:String,canonicalKey:String,amount:Number}],
    collectionBatchId:String,customerConfirmationMethod:String,onlineTransactionDate:Date,onlineTransactionTime:String,
    payerAccountNumber: String,
    payerIfsc: String, payerBankName: String, collectedByRole: String,
    clientMutationId: { type: String, index: true },
    bankMatchStatus: {type:String,default:"PENDING_BANK_VERIFICATION"},
    bankMatchStatementRowId: String, bankMatchedAt: Date,
    paymentProofFileId: { type: String, index: true },
    paymentProofKind: String,
    upiPaymentText: String,
    reference: String,
    remarks:String,
    bankAccountId:{type:String,index:true},
    bankNameSnapshot:String,
    statementImportId:String,
    statementRowNo:Number,
    runningBalance:Number,
    bounceStatus: String,
    // Cheque lifecycle. Older receipts may not have these fields; reports use
    // receipt date / bank-statement linkage as safe fallbacks where possible.
    chequeNumber: { type:String, index:true },
    chequeIssueDate: Date,
    chequeDepositDate: Date,
    chequeClearanceDate: Date,
    chequeBounceDate: Date,
    chequeBouncePostedAt:Date,chequeBounceChargeSnapshot:Number,
    chequeStatus: { type:String, index:true },
    // Sales Person app ownership. Legacy receipts remain valid because these
    // fields are optional and attribution falls back to createdBy where needed.
    collectedBySalespersonId: { type: String, index: true },
    collectedBySalespersonNameSnapshot: String,
    collectionSource: { type: String, default: "DMS", index: true },
    cashCustodyMovementId: { type: String, index: true },

    // Salesperson receipt verification workflow. No salesperson-created receipt
    // is allowed into the ledger until BOTH the customer OTP and cashier OTP are
    // verified. OTP codes are hidden from normal queries and are exposed only by
    // the dedicated customer/DMS OTP endpoints.
    receiptWorkflowStatus: { type: String, default: "DMS_DIRECT", index: true },
    customerOtpId: String,
    customerOtpCode: { type: String, select: false },
    customerOtpExpiresAt: Date,
    customerOtpStatus: { type: String, default: "NOT_REQUIRED", index: true },
    customerOtpVerifiedAt: Date,
    cashierOtpId: String,
    cashierOtpCode: { type: String, select: false },
    cashierOtpExpiresAt: Date,
    cashierOtpStatus: { type: String, default: "NOT_REQUIRED", index: true },
    cashierOtpVerifiedAt: Date,
    cashierOtpVerifiedBy: String,
    cashierOtpVerifiedByNameSnapshot: String,
    ledgerPostedAt: Date,ledgerPostedBy:String,ledgerPostedByNameSnapshot:String,
    chequeBankReceivedDate:Date,bankLedgerTransactionId:String,
    chequeApprovalStatus:{type:String,default:'NOT_REQUIRED',index:true},
    chequeApprovalBatchId:String,
    disputeStatus:{type:String,default:'NONE',index:true},
    disputeRemark:String,disputeRaisedAt:Date,disputeResolvedAt:Date,
    disputeHistory:[{status:String,remark:String,at:Date,by:String,byName:String}],
    cashierLedgerConfirmedAt: Date,
    cashierLedgerConfirmedBy: String,
    cashierLedgerConfirmedByNameSnapshot: String,

    // Physical-cash details captured from the Sales Person app. These fields are
    // Cash custody is independent of ledger posting. For new collector receipts,
    // customer OTP verification is NOT a ledger post; cashier must approve custody
    // and explicitly post to ledger after receiving physical cash.
    cashDenominations: [{ denomination: Number, count: Number, amount: Number }],
    cashDepositStatus: { type: String, default: "NOT_APPLICABLE", index: true },
    cashDepositBatchId: { type: String, index: true },
    cashDepositedAt: Date,
    cashDepositedBy: String,
    cashDepositedByNameSnapshot: String,

    createdBy:String,
    createdByNameSnapshot:String,
    status: { type: String, default: "POSTED", index: true }
  }, { timestamps: true });
  receiptSchema.index({tenantKey:1,financialYear:1,clientMutationId:1},{unique:true,partialFilterExpression:{clientMutationId:{$type:"string"}}});
  receiptSchema.index({tenantKey:1,financialYear:1,bankMatchStatementRowId:1},{unique:true,partialFilterExpression:{bankMatchStatementRowId:{$type:"string"}}});
  receiptSchema.index({ tenantKey: 1, financialYear: 1, collectedBySalespersonId: 1, date: -1 });
  receiptSchema.index({tenantKey:1,financialYear:1,creationSource:1,mode:1,status:1,date:1});
  receiptSchema.index({ tenantKey: 1, financialYear: 1, status: 1, bounceStatus: 1, date: -1 });
  receiptSchema.index({ tenantKey: 1, financialYear: 1, collectionSource: 1, receiptWorkflowStatus: 1, date: -1 });
  receiptSchema.index({ tenantKey: 1, financialYear: 1, customerOtpStatus: 1, cashierOtpStatus: 1, date: -1 });
  receiptSchema.index({ tenantKey: 1, financialYear: 1, chequeStatus: 1, chequeIssueDate: -1 });
  receiptSchema.index({tenantKey:1,financialYear:1,sourceKey:1},{unique:true,partialFilterExpression:{sourceKey:{$type:"string"}}});

  // An internal cash↔bank transfer is NOT a customer receipt/payment.
  // Keep its own document so receipt totals, collection incentives and supplier
  // payments do not grow when the company simply moves its own money.
  const contraVoucherSchema = new Schema({
    tenantKey:{type:String,index:true},financialYear:{type:String,index:true},
    contraNo:{type:String,required:true,index:true},date:{type:Date,index:true},
    direction:{type:String,enum:["DEPOSIT","WITHDRAWAL"],required:true},
    bankAccountId:{type:String,index:true},bankNameSnapshot:String,
    amount:{type:Number,required:true},reference:String,remarks:String,
    runningBalance:Number,status:{type:String,default:"POSTED",index:true},
    createdBy:String,createdByNameSnapshot:String,
  },{timestamps:true});
  contraVoucherSchema.index({tenantKey:1,financialYear:1,contraNo:1},{unique:true});

  // Single source record for a transfer between two banks belonging to this company.
  // Never insert a customer Receipt or Payment for an internal transfer.
  const bankTransferSchema = new Schema({
    tenantKey:{type:String,index:true},financialYear:{type:String,index:true},
    transferNo:{type:String,required:true},date:{type:Date,index:true},
    fromBankAccountId:{type:String,required:true,index:true},
    toBankAccountId:{type:String,required:true,index:true},
    fromBankNameSnapshot:String,toBankNameSnapshot:String,
    amount:{type:Number,required:true},reference:String,remarks:String,
    fromRunningBalance:Number,toRunningBalance:Number,
    status:{type:String,enum:["PENDING_POST","POSTED"],default:"PENDING_POST",index:true},
    createdBy:String,createdByNameSnapshot:String,
  },{timestamps:true});
  bankTransferSchema.index({tenantKey:1,financialYear:1,transferNo:1},{unique:true});
  bankTransferSchema.index({tenantKey:1,financialYear:1,fromBankAccountId:1,toBankAccountId:1,date:1});

  // Immutable audit trail for edits to posted, DMS-direct vouchers.
  // Journal updates and this audit record commit within the same DB transaction.
  const voucherEditAuditSchema = new Schema({
    tenantKey:{type:String,index:true},financialYear:{type:String,index:true},
    voucherKind:String,voucherId:String,voucherNo:String,
    previous:Schema.Types.Mixed,next:Schema.Types.Mixed,
    previousJournal:[Schema.Types.Mixed],nextJournal:[Schema.Types.Mixed],
    reason:String,editedBy:String,editedByNameSnapshot:String,editedAt:Date,
  },{timestamps:true});
  voucherEditAuditSchema.index({tenantKey:1,financialYear:1,voucherKind:1,voucherId:1,createdAt:-1});

  // Superadmin book adjustments retain the source and full correction trail.
  // They do not silently mutate statutory invoices or OTP evidence.
  const bookCorrectionSchema = new Schema({
    tenantKey:{type:String,required:true,index:true},financialYear:{type:String,required:true,index:true},
    book:{type:String,enum:['CASH','BANK'],required:true},sourceKey:{type:String,required:true},bankAccountId:String,
    date:Date,debit:Number,credit:Number,remarks:String,partyName:String,partyGlobalId:String,partyType:String,deleted:Boolean,
    originalSnapshot:Schema.Types.Mixed,originalJournalNet:Number,
    activeJournalTransactionIds:[String],editedBy:String,editedByNameSnapshot:String,reason:String,
  },{timestamps:true});
  bookCorrectionSchema.index({tenantKey:1,financialYear:1,book:1,sourceKey:1},{unique:true});
  bookCorrectionSchema.index({tenantKey:1,financialYear:1,book:1,bankAccountId:1,date:1});
  const bookCorrectionAuditSchema = new Schema({
    tenantKey:String,financialYear:String,book:String,sourceKey:String,action:String,
    previous:Schema.Types.Mixed,next:Schema.Types.Mixed,reason:String,
    correctionJournalId:String,editedBy:String,editedByNameSnapshot:String,
  },{timestamps:true});
  bookCorrectionAuditSchema.index({tenantKey:1,financialYear:1,book:1,sourceKey:1,createdAt:-1});

  const paymentSchema = new Schema({ tenantKey: String, financialYear: String, paymentNo: String, sourceKey:String, date: { type: Date, index: true }, partyGlobalId: { type: String, index: true }, partyType:String, partyNameSnapshot:String, amount: Number, mode: String, reference: String, remarks:String, bankAccountId:{type:String,index:true}, bankNameSnapshot:String, statementImportId:String, statementRowNo:Number, runningBalance:Number, createdBy:String, createdByNameSnapshot:String, status: { type: String, default: "POSTED" } }, { timestamps: true });

  paymentSchema.index({tenantKey:1,financialYear:1,sourceKey:1},{unique:true,partialFilterExpression:{sourceKey:{$type:"string"}}});
  paymentSchema.index({ tenantKey: 1, financialYear: 1, status: 1, date: -1 });

  const bankStatementImportSchema = new Schema({
    tenantKey:String, financialYear:{type:String,index:true}, importId:{type:String,index:true}, bankAccountId:{type:String,index:true}, bankNameSnapshot:String, accountNumberSnapshot:String,
    fileName:String, openingBalance:Number, closingBalance:Number, totalDebit:Number, totalCredit:Number, totalRows:Number, postedRows:Number, unmatchedRows:Number, duplicateRows:Number, errorRows:Number,
    status:{type:String,default:"DRAFT_REVIEW",index:true}, importedBy:String, importedByNameSnapshot:String, submittedBy:String, submittedByNameSnapshot:String, submittedAt:Date
  },{timestamps:true});
  bankStatementImportSchema.index({tenantKey:1,financialYear:1,bankAccountId:1,createdAt:-1});

  const bankStatementRowSchema = new Schema({
    tenantKey:String, financialYear:{type:String,index:true}, importId:{type:String,index:true}, bankAccountId:{type:String,index:true}, rowNo:Number, date:{type:Date,index:true}, partyName:String, remarks:String, mode:String,
    debit:Number, credit:Number, runningBalance:Number, fingerprint:{type:String,index:true}, sourceFingerprint:{type:String,index:true}, matchedPartyGlobalId:String, matchedPartyName:String, partyAccountCode:String,
    transactionType:String, transactionId:String, postingFingerprint:String, detectionSource:String, matchConfidence:Number, candidateCount:Number, submittedAt:Date,
    classification:{type:String,default:"DRAFT",index:true}, createdBy:String, createdByNameSnapshot:String, submittedBy:String, submittedByNameSnapshot:String, error:String
  },{timestamps:true});
  bankStatementRowSchema.index({tenantKey:1,financialYear:1,bankAccountId:1,fingerprint:1},{unique:true});
  bankStatementRowSchema.index(
    { tenantKey:1, financialYear:1, bankAccountId:1, postingFingerprint:1 },
    { unique:true, partialFilterExpression:{ postingFingerprint:{ $type:"string" } } },
  );

  const stockMovementSchema = new Schema({ tenantKey: String, financialYear: String, date: { type: Date, index: true }, productId: { type: String, index: true }, warehouseId: String, type: { type: String, index: true }, qtyIn: Number, qtyOut: Number, landedCost: Number, referenceId: String }, { timestamps: true });
  const expenseSchema = new Schema({ tenantKey: String, financialYear: String, expenseNo: { type: String, index: true }, date: { type: Date, index: true }, accountCode: { type: String, index: true }, amount: Number, nature: String, allocationMethod: String, branchId: String, productId: String, customerGlobalId: String, status: { type: String, default: "POSTED" } }, { timestamps: true });

  // Sales Person app orders are intentionally separate from posted Sales Invoices.
  const salesOrderItemSchema = new Schema({
    productId: { type: String, index: true }, sku: String, nameSnapshot: String, hsnSnapshot: String,
    qty: Number, unit: String, packingUnit: String, qtyInBag: Number, listRate: Number,
    rate: Number, gradeDiscountPct: Number, discountPct: Number, taxable: Number, gstRateSnapshot: Number, tax: Number, lineTotal: Number,
    // `gradeDiscountPct` has no default: old orders stored grade in discountPct.
    // Order lifecycle quantities. qty remains the immutable ordered quantity.
    reservedQty: { type: Number, default: 0 },
    packedQty: { type: Number, default: 0 },
    invoicedQty: { type: Number, default: 0 },
    returnedQty: { type: Number, default: 0 },
    cancelledQty: { type: Number, default: 0 },
    shortageReason: String,
    // Product-level warehouse routing. One order may be split across several warehouses.
    warehouseId: { type: String, index: true },
    warehouseNameSnapshot: String,
    warehouseStatus: { type: String, default: "" },
    warehousePackedAt: Date,
    warehousePackedBy: String,
    warehousePackedByNameSnapshot: String,
    packageCount: { type: Number, default: 0 }, actualWeight: { type: Number, default: 0 },
    damagedQty: { type: Number, default: 0 }, currentWarehouseId: String,
    transferReceivedAt: Date, transferMode: String,
  }, { _id: false });

  const salesOrderSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true }, orderNo: { type: String, index: true }, date: { type: Date, index: true },
    customerGlobalId: { type: String, index: true }, customerNameSnapshot: String, salespersonId: { type: String, index: true },
    // Legacy/single-warehouse snapshot plus product-level routing in items[].
    warehouseId: { type: String, index: true }, warehouseNameSnapshot: String,
    mainWarehouseId: { type: String, index: true },
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
    cancellation: {
      status: { type: String, default: "NONE" }, source: String, reason: String, remarks: String,
      requestedBy: String, requestedAt: Date, approvedBy: String, approvedAt: Date,
      customerOtpId: String, salespersonOtpId: String, salespersonContactedAt: Date,
      stockImageFileId: String,
      items: [{ productId: String, qty: Number, packageCount: Number, weight: Number }],
      completedAt: Date, creditNoteId: String, creditNoteNo: String,
    },
    dispatchCustody: { recordedAt: Date, settledAt: Date, settlement: String },
    handover: {
      customerOtpId: String, status: String, otpId: String,
      requestedAt: Date, requestedBy: String, offeredAt: Date,
      confirmedAt: Date, confirmedBy: String,
      items: [{ productId: String, qty: Number, packageCount: Number, weight: Number }],
    },
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
  salesOrderSchema.index({ tenantKey: 1, financialYear: 1, status: 1, workflowStatus: 1, date: 1 });

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
      transporterId: String, totalAmount: Number,
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

  // Statutory adjustment / movement documents share the existing CreditNote
  // collection. This is intentional: some Atlas Free/Flex deployments are at the
  // 500-collection ceiling, so Debit Note and Delivery Note must not create new
  // collections. Existing order-return credit notes remain fully compatible.
  const creditNoteItemSchema = new Schema({
    productId: String, sku: String, nameSnapshot: String, description: String,
    hsnSnapshot: String, qty: Number, unit: String, packingUnit: String,
    rate: Number, discountPct: Number, effectiveRate: Number,
    taxable: Number, gstRateSnapshot: Number, cgst: Number, sgst: Number, igst: Number,
    tax: Number, lineTotal: Number, condition: String,
  }, { _id: false });
  const creditNoteSchema = new Schema({
    tenantKey: { type: String, index: true }, financialYear: { type: String, index: true },
    documentType: { type: String, enum: ["CREDIT_NOTE", "DEBIT_NOTE", "DELIVERY_NOTE"], default: "CREDIT_NOTE", index: true },
    // creditNoteNo is retained as the physical unique document-number field so
    // the existing unique index and old order-return code continue to work.
    creditNoteNo: { type: String, index: true }, documentNo: { type: String, index: true },
    date: { type: Date, default: Date.now, index: true },
    orderId: String, orderNo: String, invoiceId: String, invoiceNo: String,
    referenceDocumentId: String, referenceDocumentNo: String, referenceDocumentDate: Date,
    customerGlobalId: String, customerNameSnapshot: String,
    partyGlobalId: { type: String, index: true }, partyNameSnapshot: String,
    partyGstinSnapshot: String, addressSnapshot: String,
    reasonType: String, reason: String, gstType: String,
    items: [creditNoteItemSchema],
    subtotal: Number, billDiscount: Number, otherCharges: Number,
    taxableTotal: Number, taxTotal: Number, roundOff: Number, grandTotal: Number,
    warehouseId: { type: String, index: true }, warehouseNameSnapshot: String,
    stockEffectApplied: { type: Boolean, default: false },
    origin: { type: String, default: "MANUAL" },
    // Delivery Note / job-work movement fields. These do not post accounting.
    jobWorkPurpose: String, expectedReturnDate: Date, transporterName: String,
    placeOfSupply: String, vehicleNo: String, distanceKm: Number, eWayBillRequired: { type: Boolean, default: false },
    eWayBillReason: String, eWayBillNo: String, eWayBillDate: Date, returnedAt: Date,
    remarks: String,
    status: { type: String, enum: ["DRAFT", "ISSUED", "RETURNED", "CANCELLED"], default: "DRAFT", index: true },
    issuedAt: Date, createdBy: String, createdByNameSnapshot: String, issuedBy: String,
  }, { timestamps: true });
  creditNoteSchema.index({ tenantKey: 1, financialYear: 1, creditNoteNo: 1 }, { unique: true });
  creditNoteSchema.index({ tenantKey: 1, financialYear: 1, documentType: 1, date: -1 });
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
  // Physical order-scoped warehouse transfers. Each receipt creates paired stock
  // movements ONLY when the destination warehouse accepts it.
  const warehouseTransferSchema = new Schema({
    tenantKey: {type:String,index:true}, financialYear:{type:String,index:true},
    transferNo:{type:String,required:true},orderId:{type:String,index:true},orderNo:String,
    fromWarehouseId:{type:String,index:true},toWarehouseId:{type:String,index:true},
    mode:{type:String,enum:["PACKED","UNPACKED","RETURN"],required:true},
    status:{type:String,enum:["REQUESTED","RECEIVED"],default:"REQUESTED",index:true},
    items:[{productId:String,productName:String,qty:Number,packageCount:Number,weight:Number}],
    requestedAt:Date,requestedBy:String,receivedAt:Date,receivedBy:String,
  },{timestamps:true});
  warehouseTransferSchema.index({tenantKey:1,financialYear:1,transferNo:1},{unique:true});
  warehouseTransferSchema.index({tenantKey:1,financialYear:1,orderId:1,fromWarehouseId:1,toWarehouseId:1,mode:1});
  const warehouseClosingSchema = new Schema({
    tenantKey:{type:String,index:true},financialYear:{type:String,index:true},warehouseId:{type:String,index:true},
    monthKey:{type:String,index:true},status:{type:String,default:"OPEN",enum:["OPEN","SUBMITTED","REVIEWED"]},
    rows:[{productId:String,productName:String,expected:Number,actual:Number,variance:Number,reason:String}],
    submittedAt:Date,submittedBy:String,reviewedAt:Date,reviewedBy:String,reviewRemarks:String,
  },{timestamps:true});
  warehouseClosingSchema.index({tenantKey:1,financialYear:1,warehouseId:1,monthKey:1},{unique:true});

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
      enum: ["COLLECTION", "HANDOVER", "BANK_DEPOSIT", "SHORTAGE", "EXCESS", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "CASHIER_CLOSE"],
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

    // Cash and bank receipts can share a handover. Only cashAmount is physical
    // currency, so bankAmount must NEVER enter cash denomination reconciliation.
    cashAmount: Number,
    bankAmount: Number,
    // Cash handover batch. One HANDOVER may contain many party-wise receipts.
    // We store the batch in the existing cash-movement collection so deployments
    // close to the Mongo collection limit do not need another FY collection.
    denominations: [{ denomination: Number, count: Number, amount: Number }],
    receiptBreakdown: [{
      receiptId: String, receiptNo: String, customerGlobalId: String,
      customerNameSnapshot: String, amount: Number, mode: String, receiptType: String,
      receiptDenominations: [{ denomination: Number, count: Number, amount: Number }],
      collectedAt: Date,
    }],
    handoverWorkflowStatus: { type: String, default: "LEGACY", index: true },
    handoverOtpId: String,
    handoverOtpCode: { type: String, select: false },
    handoverOtpExpiresAt: Date,
    handoverOtpStatus: { type: String, default: "NOT_REQUIRED", index: true },
    handoverOtpVerifiedAt: Date,
    cashierReceivedAt: Date,
    cashierReceivedBy: String,
    cashierReceivedByNameSnapshot: String,
    cashierCloseId: { type: String, index: true },
    partyIssues: [{
      issueId: String, receiptId: String, receiptNo: String, customerGlobalId: String,
      partyNameSnapshot: String, amount: Number, reason: String,
      status: { type: String, default: "PENDING_SALESPERSON_ACK" },
      acknowledgementOtpId: String, acknowledgementOtpCode: String, acknowledgementOtpExpiresAt: Date,
      acknowledgedAt: Date, acknowledgedBy: String, resolvedAt: Date, resolvedBy: String, resolutionRemark: String,
      raisedAt: Date, raisedBy: String, raisedByNameSnapshot: String,
    }],
    closeExpectedAmount: Number,
    closeDeclaredAmount: Number,
    closeVariance: Number,
    closeDate: Date,

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
    VoucherEditAudit: get("VoucherEditAudit", voucherEditAuditSchema),
    BookCorrection: get("BookCorrection", bookCorrectionSchema),
    BookCorrectionAudit: get("BookCorrectionAudit", bookCorrectionAuditSchema),
    ContraVoucher: get("ContraVoucher", contraVoucherSchema),
    BankTransfer: get("BankTransfer", bankTransferSchema),
    StockMovement: get("StockMovement", stockMovementSchema),
    WarehouseTransfer: get("WarehouseTransfer", warehouseTransferSchema),
    WarehouseClosing: get("WarehouseClosing", warehouseClosingSchema),
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
