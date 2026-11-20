import {User} from '../models/index.js';
import {financialCollectionExists,financialModels} from './accountingService.js';
import {discoverFinancialYears,normalizeYears,validFY} from './financialYearDiscoveryService.js';
import {inspectBankLedgerRows} from './bankLedgerIntegrityService.js';
import {isReceiptLedgerPosted} from './receiptAccountingRules.js';
const text=v=>String(v??'');
const money=v=>Math.round((Number(v)||0)*100)/100;
const terminal=new Set(['CANCELLED','DELETED','VOID','VOIDED','REJECTED','REVERSED','DRAFT']);
const live=row=>!terminal.has(text(row.status).toUpperCase());
export const collectionPaymentFailed=receipt=>['BOUNCED','CANCELLED','REJECTED'].includes(text(receipt.chequeStatus).toUpperCase())||
 ['BOUNCE_POSTED','VOIDED','CANCELLED'].includes(text(receipt.receiptWorkflowStatus).toUpperCase());
const key=(kind,fy,id)=>`${kind}:${fy}:${id}`;

// Orders are collection obligations before they become accounting invoices.
// Keep one identity through invoicing/delivery so the same sale is never due twice.
function buildPendingCollectionState({invoices=[],orders=[],notes=[],receipts=[],ledger=[],openingBalance=0,openingFinancialYear='',now=Date.now()}={}){
 const documents=[],aliases=new Map(),invoiceOrders=new Map();
 const activeInvoices=invoices.filter(row=>live(row)&&row.invoiceType!=='PERFORMA');
 const activeOrders=orders.filter(row=>live(row)&&!terminal.has(text(row.workflowStatus).toUpperCase()));
 const addAlias=(kind,fy,id,document)=>{if(id)aliases.set(key(kind,fy,text(id)),document);};
 const invoiceTotal=invoice=>{
  const noteAmount=notes.filter(note=>live(note)&&note.documentType!=='DEBIT_NOTE'&&note.documentType!=='DELIVERY_NOTE'&&
   note.financialYear===invoice.financialYear&&(text(note.invoiceId)===text(invoice._id)||note.invoiceNo&&note.invoiceNo===invoice.invoiceNo))
   .reduce((sum,note)=>sum+Number(note.grandTotal||0),0);
  return money(Math.max(0,invoice.netInvoiceAmount??Number(invoice.grandTotal||0)-Math.max(Number(invoice.creditNoteAmount||0),noteAmount)));
 };
 for(const order of activeOrders){
  const linked=activeInvoices.filter(invoice=>text(invoice.sourceOrderId)===text(order._id)||
   invoice.financialYear===order.financialYear&&(invoice.orderNo&&invoice.orderNo===order.orderNo||
    [order.invoice,...(order.invoices||[])].some(link=>link&&(text(link.invoiceId)===text(invoice._id)||link.invoiceNo===invoice.invoiceNo))));
  linked.forEach(invoice=>invoiceOrders.set(key('INVOICE',invoice.financialYear,text(invoice._id)),order));
  const invoiced=money(linked.reduce((sum,invoice)=>sum+invoiceTotal(invoice),0));
  const complete=['DELIVERED','COMPLETED','CLOSED'].includes(text(order.workflowStatus||order.status).toUpperCase());
  const total=linked.length&&complete?invoiced:Math.max(invoiced,money(order.grandTotal));
  const document={kind:'ORDER',id:text(order._id),number:order.orderNo,financialYear:order.financialYear,
   canonicalKey:key('ORDER',order.financialYear,text(order._id)),date:order.date,total,workflowStatus:order.workflowStatus||order.status,
   salespersonId:order.salespersonId||'',items:order.items||[],invoiceNumbers:linked.map(invoice=>invoice.invoiceNo),invoices:linked};
  documents.push(document);addAlias('ORDER',order.financialYear,order._id,document);addAlias('ORDER',order.financialYear,order.orderNo,document);
  for(const invoice of linked){addAlias('INVOICE',invoice.financialYear,invoice._id,document);addAlias('INVOICE',invoice.financialYear,invoice.invoiceNo,document);}
 }
 for(const invoice of activeInvoices){
  if(invoiceOrders.has(key('INVOICE',invoice.financialYear,text(invoice._id))))continue;
  const document={kind:'INVOICE',id:text(invoice._id),number:invoice.invoiceNo,financialYear:invoice.financialYear,
   canonicalKey:key('INVOICE',invoice.financialYear,text(invoice._id)),date:invoice.date,total:invoiceTotal(invoice),
   workflowStatus:invoice.workflowStatus||invoice.status,salespersonId:invoice.salespersonId||invoice.assignedTo||'',
   items:invoice.items||[],invoiceNumbers:[invoice.invoiceNo],invoices:[invoice]};
  documents.push(document);addAlias('INVOICE',invoice.financialYear,invoice._id,document);addAlias('INVOICE',invoice.financialYear,invoice.invoiceNo,document);
 }
 for(const note of notes.filter(row=>row.documentType==='DEBIT_NOTE'&&live(row))){
  const document={kind:'DEBIT_NOTE',id:text(note._id),number:note.documentNo||note.creditNoteNo,financialYear:note.financialYear,
   canonicalKey:key('DEBIT_NOTE',note.financialYear,text(note._id)),date:note.date,total:money(note.grandTotal),
   workflowStatus:note.status,salespersonId:'',items:note.items||[],invoiceNumbers:note.invoiceNo?[note.invoiceNo]:[],invoices:[]};
  documents.push(document);addAlias('DEBIT_NOTE',note.financialYear,note._id,document);addAlias('DEBIT_NOTE',note.financialYear,document.number,document);
 }
 // Imported parties may have an unpaid opening ledger balance with no invoice
 // documents. Keep them visible, while requiring a genuine invoice/order/debit
 // note reference before the collector can create a receipt.
 const beforeOpening=rows=>rows.filter(row=>validFY(row.financialYear)&&row.financialYear<openingFinancialYear);
 const history=validFY(openingFinancialYear)?buildPendingCollectionState({invoices:beforeOpening(invoices),notes:beforeOpening(notes),
  receipts:beforeOpening(receipts),ledger:beforeOpening(ledger),now}):null;
 const referencedOpening=history?money(history.documents.reduce((sum,document)=>sum+document.outstanding,0)):0;
 const openingRemainder=money(Math.max(0,openingBalance-referencedOpening));
 // An opening balance is already net of prior-year credits. Retain historical
 // invoice references, add only the unreferenced remainder, and reconcile any
 // difference to the authoritative balance at the opening-year boundary.
 const openingCreditAdjustment=history?money(Math.max(0,referencedOpening-Math.max(0,openingBalance))-history.unallocatedCredit):0;
 if(openingRemainder>0){
  const year=validFY(openingFinancialYear)?openingFinancialYear:'';
  documents.unshift({kind:'OPENING_BALANCE',id:'OPENING',number:'Opening balance',financialYear:year,
   canonicalKey:key('OPENING_BALANCE',year,'OPENING'),date:year?`${year.slice(0,4)}-04-01`:null,
   total:openingRemainder,workflowStatus:'REFERENCE_REQUIRED',collectible:false,
   referenceRequired:true,salespersonId:'',items:[],invoiceNumbers:[],invoices:[]});
 }
 const byKey=new Map(documents.map(document=>[document.canonicalKey,document]));
 for(const document of documents)Object.assign(document,{paid:0,reserved:0,pendingReceipts:[]});
 let allocatedPaid=0,fallbackCredits=0;
 const ledgerReceipts=new Set(ledger.filter(line=>line.transactionType==='RECEIPT').map(line=>`${line.financialYear}:${line.transactionId}`));
 for(const receipt of receipts.filter(row=>live(row)&&!collectionPaymentFailed(row))){
  const posted=isReceiptLedgerPosted(receipt);
  const expired=!posted&&receipt.customerOtpStatus==='PENDING'&&receipt.customerOtpExpiresAt&&new Date(receipt.customerOtpExpiresAt).getTime()<=now;
  if(expired)continue;
  if(posted&&!ledgerReceipts.has(`${receipt.financialYear}:${receipt.receiptNo}`))fallbackCredits=money(fallbackCredits+Number(receipt.amount||0));
  const allocations=receipt.againstDocuments?.length?receipt.againstDocuments:(receipt.againstInvoices||[]).map(row=>({
   kind:'INVOICE',financialYear:row.financialYear||receipt.financialYear,documentId:row.invoiceId||row.invoiceNo,amount:row.amount}));
  let remaining=money(receipt.amount);
  for(const allocation of allocations){
   const document=byKey.get(allocation.canonicalKey)||aliases.get(key(allocation.kind,allocation.financialYear||receipt.financialYear,allocation.documentId));
   if(!document)continue;
   const amount=money(Math.max(0,Math.min(remaining,Number(allocation.amount)||0)));
   remaining=money(remaining-amount);
   if(posted){document.paid=money(document.paid+amount);allocatedPaid=money(allocatedPaid+amount);}
   else{document.reserved=money(document.reserved+amount);document.pendingReceipts.push(receipt.receiptNo);}
  }
 }
 // Apply genuine unallocated ledger credits oldest-first after explicit links.
 // Credit notes already reduced their invoices above and must not be applied twice.
 let credit=money(Math.max(0,ledger.filter(line=>line.transactionType!=='SALES_CREDIT_NOTE').reduce((sum,line)=>sum+Number(line.credit||0)-
  (line.transactionType==='CHEQUE_BOUNCE_REVERSAL'?Number(line.debit||0):0),0)+
  fallbackCredits+Math.max(0,-openingBalance)+openingCreditAdjustment-allocatedPaid));
 documents.sort((a,b)=>new Date(a.date)-new Date(b.date)||text(a.number||a.id).localeCompare(text(b.number||b.id)));
 for(const document of documents){
  const due=Math.max(0,money(document.total-document.paid)),applied=Math.min(due,credit);
  document.paid=money(document.paid+applied);credit=money(credit-applied);
  document.outstanding=money(Math.max(0,document.total-document.paid));
  document.availableAmount=money(Math.max(0,document.outstanding-document.reserved));
  document.selectable=document.collectible!==false&&document.availableAmount>0&&document.reserved<0.005;
 }
 return {unallocatedCredit:credit,documents:documents.filter(document=>document.outstanding>0.005).map(document=>({...document,
  items:document.items.map(item=>({productId:item.productId,name:item.productNameSnapshot||item.nameSnapshot||item.name||'',
   sku:item.skuSnapshot||item.sku||'',quantity:item.qty??item.quantity,rate:item.rate,amount:item.lineTotal})),
  invoices:document.invoices.map(invoice=>({_id:invoice._id,financialYear:invoice.financialYear,invoiceNo:invoice.invoiceNo,date:invoice.date,
   grandTotal:invoice.grandTotal,netInvoiceAmount:invoice.netInvoiceAmount,sourceOrderId:invoice.sourceOrderId})),
 }))};
}

export function buildPendingCollectionDocuments(inputs={}){
 return buildPendingCollectionState(inputs).documents;
}

export async function collectionFinancialYears({tenantKey,financialYear}){
 if(!validFY(financialYear))throw Object.assign(new Error('Choose a valid financial year'),{statusCode:400});
 const discovery=await discoverFinancialYears({tenantKey});
 const years=normalizeYears([financialYear,...discovery.discovered]).filter(year=>year<=financialYear);
 if(years.length>50)throw new Error('Collection history exceeds 50 financial years');
 return years;
}
export async function loadPendingCollections({tenantKey,financialYear,customers,years}){
 if(!customers.length)return [];
 const customerIds=customers.map(customer=>customer.globalCustomerId);
 const periods=years||await collectionFinancialYears({tenantKey,financialYear});
 const sets=await Promise.all(periods.map(async year=>{
  const models=financialModels(tenantKey,year),base={tenantKey,financialYear:year,customerGlobalId:{$in:customerIds}};
  const names=['salesinvoices','salesorders','creditnotes','receipts','ledgerentries'];
  const exists=await Promise.all(names.map(name=>financialCollectionExists(tenantKey,year,name)));
  const [invoices,orders,notes,receipts,rawLedger]=await Promise.all([
   exists[0]?models.SalesInvoice.find({...base,status:{$nin:[...terminal]},invoiceType:{$ne:'PERFORMA'}}).lean():[],
   exists[1]?models.SalesOrder.find({...base,status:{$nin:[...terminal]}}).lean():[],
   exists[2]?models.CreditNote.find({tenantKey,financialYear:year,status:{$in:['ISSUED','POSTED','COMPLETED']},$or:[{customerGlobalId:{$in:customerIds}},{partyGlobalId:{$in:customerIds}}]}).lean():[],
   exists[3]?models.Receipt.find({...base,status:{$nin:['DELETED','VOID','VOIDED','CANCELLED','REVERSED','REJECTED']}}).lean():[],
   exists[4]?models.LedgerEntry.find({tenantKey,financialYear:year,partyGlobalId:{$in:customerIds},accountCode:'SYS_SUNDRY_DEBTORS',status:'POSTED'}).lean():[],
  ]);
  const checked=await inspectBankLedgerRows({tenantKey,financialYear:year,rows:rawLedger});
  const imported=receipts.filter(receipt=>receipt.statementImportId);
  const statements=imported.length?await models.BankStatementRow.find({tenantKey,financialYear:year,
   transactionId:{$in:imported.map(receipt=>receipt.receiptNo)},classification:{$in:['POSTED','SUSPENSE','UNMATCHED']}}).select('transactionId importId').lean():[];
  const validImports=new Set(statements.map(statement=>`${statement.transactionId}:${statement.importId}`));
  return {invoices,orders,notes,receipts:receipts.filter(receipt=>!receipt.statementImportId||validImports.has(`${receipt.receiptNo}:${receipt.statementImportId}`)),ledger:checked.rows};
 }));
 const sources=Object.fromEntries(['invoices','orders','notes','receipts','ledger'].map(name=>[name,sets.flatMap(set=>set[name])]));
 const salesIds=[...new Set([...customers.map(customer=>String(customer.salespersonId||'')),
  ...sources.orders.map(order=>String(order.salespersonId||'')),...sources.invoices.map(invoice=>String(invoice.salespersonId||invoice.assignedTo||''))].filter(id=>/^[a-f\d]{24}$/i.test(id)))];
 const sales=salesIds.length?await User.find({tenantKey,_id:{$in:salesIds}}).select('_id name').lean():[];
 const names=new Map(sales.map(user=>[String(user._id),user.name]));
 return customers.map(customer=>{
  const own=Object.fromEntries(Object.entries(sources).map(([name,rows])=>[name,rows.filter(row=>String(row.customerGlobalId||row.partyGlobalId)===String(customer.globalCustomerId))]));
  const profile=customer.accountingProfile||{};
  const openingBalance=validFY(profile.financialYear)&&profile.financialYear>financialYear?0:
   (text(profile.openingBalanceType).toUpperCase()==='CR'?-1:1)*Math.abs(Number(profile.openingBalance||0));
  const openingFinancialYear=validFY(profile.financialYear)&&profile.financialYear>financialYear?'':profile.financialYear||(openingBalance?financialYear:'');
  const documents=buildPendingCollectionDocuments({...own,openingBalance,openingFinancialYear}).map(document=>({...document,
   salespersonName:names.get(document.salespersonId)||names.get(String(customer.salespersonId))||'Unassigned'}));
  return {id:customer.globalCustomerId,customerLinkId:String(customer._id),name:customer.localName||customer.displayIdentifier||'Customer',
   addresses:customer.addresses||[],address:(customer.addresses||[]).map(row=>[row.address,row.area,row.city,row.district,row.state,row.pincode].filter(Boolean).join(', ')).join(' / '),
   mobile:customer.companyContactNumber||customer.ownerMobile||customer.contacts?.find(contact=>contact.active!==false)?.mobile||'',
   email:customer.contacts?.find(contact=>contact.active!==false&&contact.email)?.email||'',gstin:customer.gstin||'',
   contacts:(customer.contacts||[]).filter(contact=>contact.active!==false).map(contact=>({name:contact.name,mobile:contact.mobile,email:contact.email,designation:contact.designation})),
   paymentType:customer.paymentType,creditDays:customer.creditDays,creditLimit:customer.creditLimit,
   salespersonName:names.get(String(customer.salespersonId))||'Unassigned',documents,
   outstanding:money(documents.reduce((sum,document)=>sum+document.outstanding,0)),
   availableAmount:money(documents.filter(document=>document.selectable).reduce((sum,document)=>sum+document.availableAmount,0))};
 });
}

export function selectCollectionDocuments(party,selections){
 if(!Array.isArray(selections)||!selections.length||selections.length>200)throw Object.assign(new Error('Select between 1 and 200 invoices, orders or debit notes'),{statusCode:400});
 const chosen=[],seen=new Set();
 for(const selection of selections){
  const document=party.documents.find(row=>row.canonicalKey===selection.canonicalKey);
  if(document?.referenceRequired)throw Object.assign(new Error('Link this pending balance to an invoice, order or debit note before creating a receipt'),{statusCode:409});
  if(!document||!document.selectable||!['INVOICE','ORDER','DEBIT_NOTE'].includes(document.kind)||seen.has(document.canonicalKey))
   throw Object.assign(new Error('A selected document is paid, already being collected, duplicated or no longer available. Refresh the pending list.'),{statusCode:409});
  seen.add(document.canonicalKey);
  const raw=Number(selection.amount??document.availableAmount);
  if(!Number.isFinite(raw)||Math.abs(Math.round(raw*100)-raw*100)>1e-6)throw Object.assign(new Error('Use an amount with at most two decimal places'),{statusCode:400});
  const amount=money(raw);
  if(amount<=0||amount>document.availableAmount+0.005)throw Object.assign(new Error('Collection amount exceeds the current document balance'),{statusCode:409});
  chosen.push({...document,amount});
 }
 return chosen;
}
