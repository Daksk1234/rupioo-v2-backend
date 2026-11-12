import { CustomerLink } from '../models/index.js';
import { financialCollectionExists, financialModels } from './accountingService.js';
import { cashPaise } from './cashbookBalanceMath.js';

export const CASH_SALES_SOURCE_MODE='CASH_SALES_ONLY';
const excludedStatuses=new Set(['DRAFT','DELETED','CANCELLED','VOID','VOIDED']);

// This view starts from zero for the selected FY. Only the original invoice
// documents qualify; cash journals, receipts and book overrides are not inputs.
export function buildCashSalesCashbook({salesInvoices=[],cashPartyIds=[]}={}) {
  const parties=new Set(cashPartyIds.map(String));
  const seen=new Set();
  const invoices=salesInvoices.filter(invoice=>{
    const key=String(invoice._id||invoice.invoiceNo||'');
    const total=Number(invoice.grandTotal);
    if(!key||seen.has(key)||!parties.has(String(invoice.customerGlobalId))||
      String(invoice.invoiceType||'INVOICE').toUpperCase()==='PERFORMA'||
      excludedStatuses.has(String(invoice.status||'').toUpperCase())||
      !Number.isFinite(total)||total<0||!Number.isFinite(new Date(invoice.date).getTime()))return false;
    seen.add(key);return true;
  }).sort((a,b)=>new Date(a.date)-new Date(b.date)||new Date(a.createdAt||0)-new Date(b.createdAt||0)||
    String(a.invoiceNo||a._id).localeCompare(String(b.invoiceNo||b._id)));
  let balancePaise=0;
  const rows=invoices.map(invoice=>{
    const credit=cashPaise(invoice.grandTotal)/100;
    balancePaise+=cashPaise(credit);
    return {_id:String(invoice._id||invoice.invoiceNo),invoiceId:String(invoice._id||''),
      transactionId:String(invoice.invoiceNo||invoice._id),transactionType:'SALES_INVOICE',
      date:invoice.date,createdAt:invoice.createdAt,partyGlobalId:String(invoice.customerGlobalId),
      partyName:'CASH',category:'CASH_SALE',particular:`Cash Sales - ${invoice.invoiceNo||invoice._id}`,
      remarks:invoice.remarks??'',debit:0,credit,runningBalance:balancePaise/100,
      cashNetMovement:credit,type:'RECEIPT'};
  });
  return {sourceMode:CASH_SALES_SOURCE_MODE,openingBalance:0,rows,closingBalance:balancePaise/100,
    invoiceCount:rows.length,categoryTotals:rows.length?{CASH_SALE:{count:rows.length,received:balancePaise/100,paid:0}}:{}};
}

export async function loadCashSalesCashbook({tenantKey,financialYear}) {
  const parties=await CustomerLink.find({tenantKey,systemKey:'CASH',systemManaged:true})
    .select('globalCustomerId').lean();
  const cashPartyIds=[...new Set(parties.map(p=>String(p.globalCustomerId||'')).filter(Boolean))];
  if(!cashPartyIds.length||!await financialCollectionExists(tenantKey,financialYear,'salesinvoices'))
    return buildCashSalesCashbook();
  const {SalesInvoice}=financialModels(tenantKey,financialYear);
  const salesInvoices=await SalesInvoice.find({tenantKey,financialYear,customerGlobalId:{$in:cashPartyIds},
    invoiceType:{$ne:'PERFORMA'},status:{$nin:[...excludedStatuses]}})
    .select('_id invoiceNo customerGlobalId grandTotal date createdAt invoiceType status remarks').lean();
  return buildCashSalesCashbook({salesInvoices,cashPartyIds});
}
