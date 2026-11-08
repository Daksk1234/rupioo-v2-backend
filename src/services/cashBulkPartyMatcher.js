/**
 * CASH bulk import party inference. Shared principle with BANK statement upload:
 * prefer an explicit, unique master record, then an unambiguous name in remarks.
 * Never guess a customer ledger from a partial or ambiguous narration.
 */
export const normalizeCashPartyName = value => String(value ?? "")
  .normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g,' ');
const excluded = new Set(['CASH','BANK','OTHER','GENERAL','ACCOUNT','SUSPENSE','PAYMENT','RECEIPT']);
const allowedName = name => name.length >= 4 && !excluded.has(name);

export function detectCashBulkParty({partyName='',remarks=''},directory=[]){
  const explicit=normalizeCashPartyName(partyName);
  const text=normalizeCashPartyName(remarks);
  const names=(directory||[]).flatMap(p=>[p.name,...(p.aliases||[])].map(alias=>({
    ...p,nameKey:normalizeCashPartyName(alias)
  }))).filter(x=>allowedName(x.nameKey));
  const unique = found => [...new Map(found.map(x=>[`${x.type}:${x.id}`,x])).values()];
  if(explicit){
    const exact=unique(names.filter(p=>p.nameKey===explicit || normalizeCashPartyName(p.id)===explicit));
    if(exact.length===1)return {...exact[0],confidence:'EXACT_NAME'};
    // A supplied Party Name is authoritative. Never overwrite it with a
    // different party found in Remarks; unresolved names go to Suspense.
    return null;
  }
  if(!text)return null;
  const padded=` ${text} `;
  const candidates=unique(names.filter(p=>padded.includes(` ${p.nameKey} `)));
  // Distinct parties mentioned in the same narration: cannot know which
  // is the counterparty. A more specific alias of the SAME party is fine.
  if(candidates.length!==1)return null;
  return {...candidates[0],confidence:'REMARKS_NAME'};
}

export function cashBulkAmount(raw){
  const s=String(raw??'').trim().replace(/[₹,\s]/g,'').replace(/^(?:RS\.?)?/i,'');
  if(!s)return 0;
  const number=Number(s);
  if(!Number.isFinite(number)||number<0||Math.round(number*100)/100!==number)
    throw new Error('Debit/Credit must be non-negative amounts with at most two decimal places');
  return number;
}
export function cashBulkMode(value){
  const mode=String(value??'').trim().toUpperCase();
  if(!mode||['CASH','CASH RECEIPT','CASH PAYMENT','RECEIPT','PAYMENT'].includes(mode))return 'CASH';
  throw new Error(`Mode "${String(value)}" is not CASH. Upload bank movements on BANK, or use Contra for company cash/bank transfers.`);
}
