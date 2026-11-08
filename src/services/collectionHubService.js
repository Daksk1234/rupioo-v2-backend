// Collection-hub bridge: one original Receipt is the accounting source of truth.
// No second receipt/payment, ledger or bank transaction is created here.
import { GenericRecord } from '../models/index.js';
import { getIfscMaster, ifscSnapshot, normalizeIfsc } from './ifscMasterService.js';
import { receiptCustodyStatus } from './receivedChequeRules.js';

import { collectionChannel, receiptIsVerified, chequeCollectionReference } from './collectionHubRules.js';
export { collectionChannel, receiptIsVerified, chequeCollectionReference, onlineCollectionStatus } from './collectionHubRules.js';
const clean = value => String(value ?? '').trim();
export const RECEIVED_RESOURCE = 'cheque-control-received';

let uniqueIndexPromise;
function ensureUniqueLinkedCheque() {
  if (!uniqueIndexPromise) uniqueIndexPromise = GenericRecord.collection.createIndex(
    { tenantKey: 1, app: 1, resource: 1, reference: 1 },
    { name: 'unique_collection_hub_cheque_receipt', unique: true,
      partialFilterExpression: { resource: RECEIVED_RESOURCE, 'data.collectionLinked': true } }
  ).catch(error => { uniqueIndexPromise = undefined; throw error; });
  return uniqueIndexPromise;
}

export async function syncChequeForReceipt(receipt, actor = {}) {
  if (!receiptIsVerified(receipt) || collectionChannel(receipt) !== 'CHEQUE') return null;
  if (!clean(receipt.receiptNo) || !clean(receipt.customerGlobalId)) throw Error('Receipt lacks original reference or customer');
  const ifsc = normalizeIfsc(receipt.payerIfsc);
  if (!ifsc) {
    const error = new Error(`Cheque ${receipt.receiptNo} needs IFSC before registering for deposit`);
    error.statusCode = 422;
    throw error;
  }
  const bank = ifscSnapshot(await getIfscMaster(ifsc));
  const tenantKey = clean(receipt.tenantKey);
  const originalReference = chequeCollectionReference(receipt);
  const scope = { tenantKey, app: 'dms', resource: RECEIVED_RESOURCE };
  const receivedDate = new Date(receipt.date).toISOString().slice(0, 10);
  const chequeDate = new Date(receipt.chequeIssueDate || receipt.date).toISOString().slice(0, 10);
  const amount = Math.round(Number(receipt.amount || 0) * 100) / 100;
  const ownerRole = clean(receipt.collectedByRole || actor.role || 'SALES_PERSON').toUpperCase();
  const identity = { chequeNo: clean(receipt.chequeNumber), ifsc, amount };
  if (!identity.chequeNo || !(identity.amount > 0)) throw Error('Cheque number and positive amount required');

  // Reuse a cheque already linked through the direct cheque-register workflow.
  const existing = await GenericRecord.findOne({ ...scope,
    $or: [ { reference: originalReference },
      { 'data.linkedReceiptNo': receipt.receiptNo, 'data.linkedReceiptFy': receipt.financialYear } ] });
  if (existing) {
    if (clean(existing.data?.customerGlobalId) !== clean(receipt.customerGlobalId)
        || Number(existing.data?.amount) !== amount
        || clean(existing.data?.chequeNo) !== identity.chequeNo) {
      throw Object.assign(new Error(`Cheque link conflict for ${receipt.receiptNo}; review manually`), { statusCode: 409 });
    }
    return { id: String(existing._id), status: existing.data.status, alreadyLinked: true };
  }
  const candidates = await GenericRecord.find({ ...scope,
    'data.chequeNo': identity.chequeNo, 'data.ifsc': ifsc, 'data.amount': amount,
    'data.status': { $nin: ['CANCELLED', 'LOST'] } }).limit(3);
  if (candidates.length) {
    const same = candidates.find(x => clean(x.data.customerGlobalId) === clean(receipt.customerGlobalId)
      && !clean(x.data.linkedReceiptNo));
    if (candidates.length !== 1 || !same) throw Object.assign(new Error('Matching cheque already exists; link it manually to avoid duplicates'), {statusCode:409});
    // Attach ONLY to an unlinked existing cheque; preserve its custody and status.
    const linked = await GenericRecord.findOneAndUpdate({ _id: same._id, ...scope, 'data.linkedReceiptNo': { $in: ['', null] } }, {
      $set: { 'data.linkedReceiptNo': receipt.receiptNo, 'data.linkedReceiptFy': receipt.financialYear }
    }, {new:true});
    if (!linked) throw Object.assign(new Error('Cheque was linked concurrently; refresh'), {statusCode:409});
    return { id: String(linked._id), status: linked.data.status, alreadyLinked: true };
  }
  const status = receiptCustodyStatus(ownerRole);
  const item = {
    ...identity, issuedByPartyName: clean(receipt.partyNameSnapshot), customerGlobalId: clean(receipt.customerGlobalId),
    issuerBankName: bank.bankName, issuerBranchName: bank.branchName,
    issuerBankAddress: bank.bankAddress, issuerCity: bank.city, issuerState: bank.state,
    receivedDate, chequeDate, status, custodyStatus: status,
    receivedByUserId: clean(receipt.collectedBySalespersonId || receipt.createdBy),
    receivedByName: clean(receipt.collectedBySalespersonNameSnapshot || receipt.createdByNameSnapshot),
    receivedByRole: ownerRole, cashierUserId: '', cashierReceivedAt: '',
    linkedReceiptNo: clean(receipt.receiptNo), linkedReceiptFy: clean(receipt.financialYear),
    depositBankAccountId: '', depositBankName: '', depositDate: '', clearedDate: '', statusDate: receivedDate,
    ledgerStatus: receipt.ledgerPostedAt ? 'ORIGINAL_RECEIPT_POSTED' : 'NOT_POSTED',
    ledgerTransactionId: clean(receipt.receiptNo), bankTransactionReference: '',
    remarks: clean(receipt.remarks), collectionLinked: true,
    history: [{ status, at: new Date().toISOString(), by: clean(actor.sub || receipt.createdBy),
      reason: `Created from customer-OTP-verified receipt ${receipt.receiptNo}; no new ledger posting` }],
  };
  await ensureUniqueLinkedCheque();
  try {
    const doc = await GenericRecord.findOneAndUpdate({ ...scope, reference: originalReference },
      { $setOnInsert: { ...scope, reference: originalReference, title: `${item.chequeNo} • ${item.issuedByPartyName}`,
          date: new Date(`${receivedDate}T00:00:00.000Z`), amount, status: 'ACTIVE',
          createdBy: clean(actor.sub || receipt.createdBy), data: item } },
      { upsert: true, new: true, setDefaultsOnInsert: true });
    return { id: String(doc._id), status: doc.data.status, alreadyLinked: false };
  } catch (error) {
    if (error?.code === 11000) {
      const found = await GenericRecord.findOne({ ...scope, reference: originalReference });
      if (found) return { id: String(found._id), status: found.data.status, alreadyLinked: true };
    }
    throw error;
  }
}
