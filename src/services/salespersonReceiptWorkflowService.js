import { CustomerLink, BankAccount } from "../models/index.js";
import { financialModels, postBalancedEntries } from "./accountingService.js";
import { makeId } from "../utils/ids.js";
import { isValidReceiptBankDate } from "./receiptAccountingRules.js";

const clean = (v) => String(v ?? "").trim();
const upper = (v) => clean(v).toUpperCase();
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;
const localDateKey = (value = new Date()) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function debtorAccountCode(customer) {
  return clean(customer?.accountingProfile?.systemAccountCode) || "SYS_SUNDRY_DEBTORS";
}

function isCheque(receipt) {
  const type = upper(receipt?.receiptType);
  const mode = upper(receipt?.mode);
  return type === "CHEQUE" || ["CHEQUE", "CHECK", "CHQ"].includes(mode);
}

function isUpi(receipt) {
  return upper(receipt?.receiptType) === "UPI" || upper(receipt?.mode) === "UPI";
}

function receiptDebitLine(receipt) {
  const amount = money(receipt.amount);
  if (upper(receipt.mode) === "CASH") return { accountCode: "SYS_CASH", debit: amount };

  // The salesperson form captures the customer's source bank/account, not the
  // company's receiving bank ledger. Keep verified BANK receipts in suspense
  // until normal bank/cheque reconciliation identifies the company bank account.
  if (isCheque(receipt)) {
    return {
      accountCode: "SYS_SUSPENSE",
      debit: amount,
      narration: `Cheque in hand ${receipt.chequeNumber || receipt.receiptNo}`,
    };
  }
  if (isUpi(receipt)) {
    return {
      accountCode: "SYS_SUSPENSE",
      debit: amount,
      narration: `UPI receipt awaiting bank allocation ${receipt.receiptNo}`,
    };
  }
  return { accountCode: "SYS_SUSPENSE", debit: amount, narration: `Bank receipt ${receipt.receiptNo}` };
}

export async function finalizeSalespersonReceipt({ tenantKey, financialYear, receipt, actorId = "", actorName = "" }) {
  if (!receipt?._id) throw new Error("Receipt is required");
  if (receipt.collectionSource !== "SALESPERSON_APP") throw new Error("Only salesperson receipts use the OTP workflow");
  if (receipt.customerOtpStatus !== "VERIFIED") {
    const error = new Error("Customer OTP must be verified before ledger posting");
    error.statusCode = 409;
    throw error;
  }

  const amount = money(receipt.amount);
  if (!(amount > 0)) throw new Error("Receipt amount must be greater than zero");

  const { Receipt, SalespersonCashMovement } = financialModels(tenantKey, financialYear);
  const fresh = await Receipt.findById(receipt._id);
  if (!fresh) throw new Error("Receipt not found");
  if (fresh.status === "POSTED" && fresh.ledgerPostedAt) return fresh;

  const customerFilter = { tenantKey, globalCustomerId: fresh.customerGlobalId };
  if (fresh.customerLinkId) customerFilter._id = fresh.customerLinkId;
  const customer = await CustomerLink.findOne(customerFilter).lean();
  if (!customer) {
    const error = new Error("Receipt customer record no longer matches the selected party. Ledger posting stopped.");
    error.statusCode = 409;
    throw error;
  }
  // Prevent an old/wrong receipt record from moving into the ledger under
  // another customer's account when the global identity is inconsistent.
  const compactName = (v) => clean(v).replace(/\s+/g, " ").toLocaleLowerCase("en");
  if (fresh.customerLinkId && compactName(fresh.partyNameSnapshot) !== compactName(customer.localName || customer.displayIdentifier || "Customer")) {
    const error = new Error("Receipt party has changed in Customer Master. Ledger posting stopped until reviewed.");
    error.statusCode = 409;
    throw error;
  }
  const partyAccountCode = debtorAccountCode(customer);
  const date = fresh.date || new Date();

  // Customer OTP only authenticates collection. Ledger posting is deliberately
  // deferred until cashier cash collection or company cheque approval.
  // Online collections await bank verification/accounting reconciliation.

  let movement = null;
  if (upper(fresh.mode) === "CASH") {
    movement = await SalespersonCashMovement.findOne({
      tenantKey,
      financialYear,
      $or: [{ receiptId: String(fresh._id) }, { receiptNo: fresh.receiptNo }],
      type: "COLLECTION",
    });
    if (!movement) {
      let movementNo = makeId("CASH");
      while (await SalespersonCashMovement.exists({ tenantKey, financialYear, movementNo })) movementNo = makeId("CASH");
      movement = await SalespersonCashMovement.create({
        tenantKey,
        financialYear,
        movementNo,
        salespersonId: fresh.collectedBySalespersonId || fresh.createdBy || "",
        salespersonNameSnapshot: fresh.collectedBySalespersonNameSnapshot || fresh.createdByNameSnapshot || "",
        date,
        dayKey: localDateKey(date),
        type: "COLLECTION",
        direction: "IN",
        amount,
        customerGlobalId: fresh.customerGlobalId,
        customerNameSnapshot: fresh.partyNameSnapshot || customer?.localName || "",
        receiptId: String(fresh._id),
        receiptNo: fresh.receiptNo,
        reference: fresh.reference || fresh.chequeNumber || "",
        remarks: fresh.remarks || "",
        status: "POSTED",
        verifiedBy: actorId,
        verifiedByNameSnapshot: actorName,
        verifiedAt: new Date(),
        accountingTransactionId: fresh.receiptNo,
        createdBy: fresh.createdBy || fresh.collectedBySalespersonId || "",
        createdByNameSnapshot: fresh.createdByNameSnapshot || fresh.collectedBySalespersonNameSnapshot || "",
      });
    } else if (movement.status !== "POSTED") {
      movement.status = "POSTED";
      movement.verifiedBy = actorId || movement.verifiedBy;
      movement.verifiedByNameSnapshot = actorName || movement.verifiedByNameSnapshot;
      movement.verifiedAt = movement.verifiedAt || new Date();
      movement.accountingTransactionId = fresh.receiptNo;
      await movement.save();
    }
  }

  fresh.status = "POSTED";
  // Customer OTP permits custody handover; it is NOT ledger posting.
  // Cashier handover OTP moves this to READY_FOR_CASHIER_COUNT, and only the
  // DMS cashier's final count/receive action may mark it COMPLETED.
  fresh.receiptWorkflowStatus = "CUSTOMER_OTP_VERIFIED";
  fresh.cashierOtpStatus = "NOT_REQUIRED";
  // Do NOT set ledgerPostedAt here. Custody and accounting are separate stages.
  // Accounting verification and physical cash custody are two separate facts.
  // Cash does not reduce customer outstanding until cashier acceptance and
  // the explicit Post to Ledger action.
  if (["CASH", "BANK"].includes(upper(fresh.mode)) && !["DEPOSITED_TO_CASHIER", "CLOSED", "HANDOVER_PENDING"].includes(upper(fresh.cashDepositStatus))) {
    fresh.cashDepositStatus = "PENDING_TO_DEPOSIT";
  }
  if (movement?._id) fresh.cashCustodyMovementId = String(movement._id);

  // Customer OTP confirms the collection, not an accounting receipt.
  // ONLINE is explicitly posted later from Cheque Control -> Online Payment.
  // Older online receipts which were already posted keep their historical
  // ledger entries unchanged; this prevents an automatic double posting.

  if (isCheque(fresh)) {
    if(!fresh.chequeApprovalStatus||fresh.chequeApprovalStatus==='NOT_REQUIRED')fresh.chequeApprovalStatus='PENDING';
    if (!["DEPOSITED", "CLEARED", "BOUNCED"].includes(upper(fresh.chequeStatus))) fresh.chequeStatus = "ISSUED";
    fresh.chequeIssueDate = fresh.chequeIssueDate || fresh.date || new Date();
    fresh.bounceStatus = fresh.bounceStatus || "PENDING";
  } else {
    fresh.bounceStatus = "CLEAR";
  }

  // Receipt-level cashier OTP is no longer used. Physical cashier handover has
  // its own batch OTP; clear any legacy receipt OTP secret after customer verification.
  fresh.customerOtpCode = undefined;
  fresh.cashierOtpCode = undefined;
  await fresh.save();
  return fresh;
}

/** Post exactly one original receipt journal after approved custody. Never repost on retries. */
export async function postCustodyApprovedReceipt({tenantKey,financialYear,receiptId,channel,bankReceivedDate,bankAccountId,cashierCloseId,
  cashierLedgerPost=false,ledgerDate,allowOtherCashier=false,session=null,actorId='',actorName=''}) {
  const {Receipt,LedgerEntry,SalespersonCashMovement}=financialModels(tenantKey,financialYear);
  if(channel==='CHEQUE'&&!session){
    await LedgerEntry.init();const chequeSession=await LedgerEntry.db.startSession();let result;
    try{await chequeSession.withTransaction(async()=>{result=await postCustodyApprovedReceipt({tenantKey,financialYear,receiptId,channel,
      bankReceivedDate,bankAccountId,session:chequeSession,actorId,actorName});});return result;}
    finally{await chequeSession.endSession();}
  }
  const receipt=await Receipt.findOne({_id:receiptId,tenantKey,financialYear,status:'POSTED',collectionSource:'SALESPERSON_APP',customerOtpStatus:'VERIFIED'}).session(session);
  if(!receipt)throw Object.assign(new Error('Customer-OTP-verified receipt not found'),{statusCode:404});
  const mode=upper(receipt.mode),type=upper(receipt.receiptType);
  let cashPostingDate;
  if(upper(receipt.disputeStatus)==='HOLD')throw Object.assign(new Error('Resolve this receipt dispute before posting'),{statusCode:409});
  if(channel==='CASH'){
    if(mode!=='CASH'||!['DEPOSITED_TO_CASHIER','CLOSED'].includes(upper(receipt.cashDepositStatus)))
      throw Object.assign(new Error('Cash must be collected and OTP verified by cashier first'),{statusCode:409});
    if(cashierLedgerPost){
      if(!session||!isValidReceiptBankDate(ledgerDate,financialYear))
        throw Object.assign(new Error('Enter a valid posting date within the selected financial year'),{statusCode:422});
      const batch=await SalespersonCashMovement.findOne({_id:receipt.cashDepositBatchId,tenantKey,financialYear,
        type:'HANDOVER',status:'APPROVED',...(allowOtherCashier?{}:{cashierReceivedBy:actorId}),
        'receiptBreakdown.receiptId':String(receipt._id)}).session(session).lean();
      const evidence=batch?.receiptBreakdown?.find(row=>String(row.receiptId)===String(receipt._id));
      if(!batch||!evidence||String(evidence.customerGlobalId)!==String(receipt.customerGlobalId)||
        Math.abs(money(evidence.amount)-money(receipt.amount))>0.005||upper(evidence.mode)!=='CASH')
        throw Object.assign(new Error('Cash receipt does not match the approved cashier handover'),{statusCode:409});
      if(batch.cashierCloseId&&!receipt.ledgerPostedAt){
        const close=await SalespersonCashMovement.findOne({_id:batch.cashierCloseId,tenantKey,financialYear,type:'CASHIER_CLOSE'}).session(session).lean();
        if(close?.status==='PENDING')throw Object.assign(new Error('Resume the pending Day Close for this handover'),{statusCode:409});
      }
      cashPostingDate=new Date(`${ledgerDate}T00:00:00.000Z`);
      if(receipt.cashDepositedAt&&new Date(receipt.cashDepositedAt).toISOString().slice(0,10)>ledgerDate)
        throw Object.assign(new Error('Posting date cannot precede receipt of physical cash'),{statusCode:422});
    }else{
    if(!/^[a-f\d]{24}$/i.test(String(cashierCloseId||'')))
      throw Object.assign(new Error('Use Cashier Post to Ledger or Day Close to post accepted cash'),{statusCode:409});
    const close=await SalespersonCashMovement.findOne({_id:cashierCloseId,tenantKey,financialYear,
      type:'CASHIER_CLOSE',status:'PENDING',recipientUserId:actorId}).session(session).lean();
    const batch=close&&await SalespersonCashMovement.findOne({_id:receipt.cashDepositBatchId,tenantKey,financialYear,
      type:'HANDOVER',status:'APPROVED',cashierCloseId,'receiptBreakdown.receiptId':String(receipt._id)}).session(session).lean();
    if(!batch)throw Object.assign(new Error('Cash receipt is not reserved by this cashier day close'),{statusCode:409});
    cashPostingDate=close.date;
    }
  }else if(channel==='CHEQUE'){
    if(!(['CHEQUE','CHECK','CHQ'].includes(type)||['CHEQUE','CHECK','CHQ'].includes(mode))||upper(receipt.chequeApprovalStatus)!=='APPROVED')
      throw Object.assign(new Error('Cheque must be approved by Company Received before ledger posting'),{statusCode:409});
    if (!isValidReceiptBankDate(bankReceivedDate, financialYear))
      throw Object.assign(new Error('Enter a real bank receipt date within the selected FY (YYYY-MM-DD)'), {statusCode:422});
  }else throw Object.assign(new Error('Unsupported receipt posting channel'),{statusCode:400});
  const customer=await CustomerLink.findOne({tenantKey,globalCustomerId:receipt.customerGlobalId,...(receipt.customerLinkId?{_id:receipt.customerLinkId}:{})}).lean();
  if(!customer)throw Object.assign(new Error('Original customer master record not found'),{statusCode:409});
  const existing=await LedgerEntry.find({tenantKey,financialYear,transactionId:receipt.receiptNo,transactionType:'RECEIPT',status:'POSTED'}).session(session).lean();
  if(channel==='CHEQUE'){
    const bank=await BankAccount.findOne({tenantKey,bankAccountId:clean(bankAccountId||receipt.bankAccountId),status:'ACTIVE'}).lean();
    if(!bank)throw Object.assign(new Error('Select an active company bank account for this cheque receipt'),{statusCode:422});
    const amount=money(receipt.amount),date=new Date(`${bankReceivedDate}T00:00:00.000Z`);
    const bankCode=['OD','CC'].includes(upper(bank.accountType))?'SYS_BANK_OD':'SYS_BANK_ACCOUNT';
    const bankLine={accountCode:bankCode,ledgerId:bank.ledgerId||'',bankAccountId:bank.bankAccountId,debit:amount};
    const matchesAmount=line=>Math.abs(Number(line.debit||0)-amount)<0.005&&!Number(line.credit||0);
    let bankTransactionId=receipt.receiptNo,alreadyPosted=false;
    if(existing.length){
      const balanced=existing.length===2&&Math.abs(existing.reduce((n,line)=>n+Number(line.debit||0)-Number(line.credit||0),0))<0.005;
      const customerCredit=existing.some(line=>String(line.partyGlobalId)===String(receipt.customerGlobalId)&&
        line.accountCode===debtorAccountCode(customer)&&Math.abs(Number(line.credit||0)-amount)<0.005&&!Number(line.debit||0));
      if(!balanced||!customerCredit)throw Object.assign(new Error('Existing cheque journal does not match the original customer and amount'),{statusCode:409});
      const directBank=existing.find(line=>line.accountCode===bankCode&&matchesAmount(line)&&
        (line.bankAccountId===bank.bankAccountId||!line.bankAccountId&&bank.ledgerId&&line.ledgerId===bank.ledgerId));
      if(directBank){
        if(new Date(directBank.date).getTime()!==date.getTime())throw Object.assign(new Error('This cheque is already posted on a different bank date; use its original posting date'),{statusCode:409});
        alreadyPosted=true;
      }else if(existing.some(line=>line.accountCode==='SYS_SUSPENSE'&&matchesAmount(line))){
        // Upgrade an earlier customer-only suspense posting without crediting
        // the customer again. The stable clearing reference makes retries safe.
        if(receipt.bankAccountId&&receipt.bankAccountId!==bank.bankAccountId&&receipt.bankLedgerTransactionId)
          throw Object.assign(new Error('Cheque was already allocated to another company bank'),{statusCode:409});
        bankTransactionId=receipt.bankLedgerTransactionId||`CHQ-BANK-${receipt.receiptNo}`;
        await postBalancedEntries({tenantKey,financialYear,transactionId:bankTransactionId,transactionType:'CHEQUE_CLEARING',date,session,
          partyGlobalId:receipt.customerGlobalId,narration:`Cheque bank receipt ${receipt.receiptNo}`,
          entries:[bankLine,{accountCode:'SYS_SUSPENSE',credit:amount}]});
        alreadyPosted=Boolean(receipt.bankLedgerTransactionId);
      }else throw Object.assign(new Error('Existing cheque journal belongs to another bank or account; reconcile before posting'),{statusCode:409});
    }else{
      await postBalancedEntries({tenantKey,financialYear,transactionId:receipt.receiptNo,transactionType:'RECEIPT',date,session,
        partyGlobalId:receipt.customerGlobalId,narration:receipt.remarks||`CHEQUE receipt ${receipt.receiptNo}`,
        entries:[bankLine,{accountCode:debtorAccountCode(customer),credit:amount}]});
    }
    const now=new Date();
    const updated=await Receipt.updateOne({_id:receipt._id,tenantKey,financialYear,status:'POSTED'},{$set:{
      ledgerPostedAt:receipt.ledgerPostedAt||now,ledgerPostedBy:actorId,ledgerPostedByNameSnapshot:actorName,receiptWorkflowStatus:'LEDGER_POSTED',
      mode:'BANK',bankAccountId:bank.bankAccountId,bankNameSnapshot:bank.bankName,bankLedgerTransactionId:bankTransactionId,chequeBankReceivedDate:date,
    }},{session});
    if(updated.matchedCount!==1&&updated.modifiedCount!==1)throw Object.assign(new Error('Cheque receipt changed while posting; reload and retry'),{statusCode:409});
    return {receiptNo:receipt.receiptNo,alreadyPosted,amount,customerGlobalId:receipt.customerGlobalId,
      bankAccountId:bank.bankAccountId,bankName:bank.bankName,bankTransactionId};
  }
  const completeCashJournal=channel!=='CASH'||(existing.length===2&&
    Math.abs(existing.reduce((sum,line)=>sum+Number(line.debit||0)-Number(line.credit||0),0))<0.005&&
    existing.some(line=>line.accountCode==='SYS_CASH'&&Math.abs(Number(line.debit||0)-money(receipt.amount))<0.005&&!Number(line.credit||0))&&
    existing.some(line=>line.accountCode!=='SYS_CASH'&&String(line.partyGlobalId)===String(receipt.customerGlobalId)&&
      Math.abs(Number(line.credit||0)-money(receipt.amount))<0.005&&!Number(line.debit||0)));
  if(receipt.ledgerPostedAt){
    if(existing.length!==2||!completeCashJournal)throw Object.assign(new Error('Receipt says posted but matching ledger journal is incomplete; accounting review required'),{statusCode:409});
    return {receiptNo:receipt.receiptNo,alreadyPosted:true,amount:money(receipt.amount)};
  }
  if(existing.length){
    // A legacy OTP-verified receipt may already have its journal. Recover state
    // without posting a duplicate or erasing historical audited transactions.
    if(existing.length!==2||!completeCashJournal||!existing.some(x=>x.partyGlobalId===receipt.customerGlobalId&&Math.abs(Number(x.credit||0)-money(receipt.amount))<0.01))
      throw Object.assign(new Error('Existing receipt ledger does not match customer/amount; manual review required'),{statusCode:409});
    receipt.ledgerPostedAt=new Date();receipt.receiptWorkflowStatus='LEDGER_POSTED';await receipt.save({session});
    return {receiptNo:receipt.receiptNo,alreadyPosted:true,amount:money(receipt.amount)};
  }
  const date=channel==='CHEQUE'?new Date(`${bankReceivedDate}T00:00:00.000Z`):cashPostingDate;
  await postBalancedEntries({tenantKey,financialYear,transactionId:receipt.receiptNo,transactionType:'RECEIPT',date,session,
    partyGlobalId:receipt.customerGlobalId,narration:receipt.remarks||`${channel} receipt ${receipt.receiptNo}`,
    entries:[receiptDebitLine(receipt),{accountCode:debtorAccountCode(customer),credit:money(receipt.amount)}]});
  const now=new Date();
  const update={$set:{ledgerPostedAt:now,ledgerPostedBy:actorId,ledgerPostedByNameSnapshot:actorName,
    receiptWorkflowStatus:'LEDGER_POSTED',...(channel==='CASH'?{cashierLedgerConfirmedAt:now,cashierLedgerConfirmedBy:actorId,cashierLedgerConfirmedByNameSnapshot:actorName}:
      {chequeBankReceivedDate:new Date(`${bankReceivedDate}T00:00:00.000Z`)})}};
  const updated=await Receipt.updateOne({_id:receipt._id,tenantKey,financialYear,status:'POSTED',ledgerPostedAt:null},update,{session});
  if(updated.modifiedCount!==1)throw Object.assign(new Error('Receipt changed while posting; reload and retry'),{statusCode:409});
  return {receiptNo:receipt.receiptNo,alreadyPosted:false,amount:money(receipt.amount),customerGlobalId:receipt.customerGlobalId};
}
