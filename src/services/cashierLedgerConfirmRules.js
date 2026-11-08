// Financial correctness guard for cashier acknowledgements. The party's cash
// receipt must have been posted ONCE by customer OTP verification; confirming
// physical custody must never create a second ledger posting.
const money=n=>Math.round((Number(n||0)+Number.EPSILON)*100)/100;
const sum=(rows,key)=>money(rows.reduce((n,r)=>n+Number(r?.[key]||0),0));
const close=(a,b)=>Math.abs(money(a)-money(b))<0.009;

export function validateCashierLedgerConfirmation(receipt,lines=[]){
  if(!receipt||String(receipt.mode||'').toUpperCase()!=='CASH'||receipt.collectionSource!=='SALESPERSON_APP')
    return {ok:false,reason:'Not an original salesperson cash receipt'};
  if(receipt.status!=='POSTED'||receipt.customerOtpStatus!=='VERIFIED'||receipt.cashDepositStatus!=='DEPOSITED_TO_CASHIER')
    return {ok:false,reason:'Cash must be OTP verified, posted and physically accepted by Cashier'};
  if(!receipt.ledgerPostedAt)return {ok:false,reason:'Original ledger posting has not been confirmed'};
  const amount=money(receipt.amount);
  if(!(amount>0))return {ok:false,reason:'Receipt amount must be positive'};
  const posted=lines.filter(x=>x.status==='POSTED'&&x.transactionType==='RECEIPT'&&String(x.transactionId)===String(receipt.receiptNo));
  if(!posted.length)return {ok:false,reason:'Original posted ledger journal not found'};
  const cashDebits=sum(posted.filter(x=>x.accountCode==='SYS_CASH'),'debit');
  const customerCredits=sum(posted.filter(x=>String(x.partyGlobalId||'')===String(receipt.customerGlobalId||'')&&x.accountCode!=='SYS_CASH'&&x.accountCode!=='SYS_SUSPENSE'),'credit');
  if(!close(cashDebits,amount)||!close(customerCredits,amount)||!close(sum(posted,'debit'),amount)||!close(sum(posted,'credit'),amount))
    return {ok:false,reason:'Original ledger journal is missing, mismatched or contains extra postings'};
  return {ok:true,amount,receiptNo:receipt.receiptNo};
}
