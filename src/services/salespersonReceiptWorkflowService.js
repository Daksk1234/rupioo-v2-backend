import { CustomerLink } from "../models/index.js";
import { financialModels, postBalancedEntries } from "./accountingService.js";
import { makeId } from "../utils/ids.js";

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

  const customer = await CustomerLink.findOne({ tenantKey, globalCustomerId: fresh.customerGlobalId }).lean();
  const partyAccountCode = debtorAccountCode(customer);
  const date = fresh.date || new Date();

  await postBalancedEntries({
    tenantKey,
    financialYear,
    transactionId: fresh.receiptNo,
    transactionType: "RECEIPT",
    date,
    partyGlobalId: fresh.customerGlobalId,
    narration: fresh.remarks || `Salesperson receipt ${fresh.receiptNo}`,
    entries: [
      receiptDebitLine(fresh),
      { accountCode: partyAccountCode, credit: amount },
    ],
  });

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
  fresh.receiptWorkflowStatus = "COMPLETED";
  fresh.cashierOtpStatus = "NOT_REQUIRED";
  fresh.ledgerPostedAt = fresh.ledgerPostedAt || new Date();
  // Accounting verification and physical cash custody are two separate facts.
  // A cash receipt reduces customer outstanding after OTP completion, but stays
  // with the salesperson until a cashier accepts the later handover batch.
  if (upper(fresh.mode) === "CASH" && !["DEPOSITED_TO_CASHIER", "CLOSED"].includes(upper(fresh.cashDepositStatus))) {
    fresh.cashDepositStatus = "PENDING_TO_DEPOSIT";
  } else if (upper(fresh.mode) !== "CASH") {
    fresh.cashDepositStatus = "NOT_APPLICABLE";
  }
  if (movement?._id) fresh.cashCustodyMovementId = String(movement._id);

  if (isCheque(fresh)) {
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
