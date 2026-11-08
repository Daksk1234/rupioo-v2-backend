/**
 * Discover fiscal years containing real company data, not just profile years.
 * FY database names are tenant-specific: rupioo_<physical-tenant>_YYYY-YY.
 * No collections/databases are created by this read-only discovery.
 */
import mongoose from 'mongoose';
import { CompanyLedger, User, BankAccount, CustomerLink } from '../models/index.js';
import { getTenantDbName } from '../config/db.js';
import { resolveFinancialStorageTenantKeySync } from './financialStorageTenantService.js';
import {validFY,normalizeYears} from './financialYearDiscoveryRules.js';
export {validFY,normalizeYears,fiscalYearCandidates,firstDataYear} from './financialYearDiscoveryRules.js';

const relevant=new Set([
  'ledgerentries','payments','receipts','salesinvoices','purchaseinvoices',
  'purchaseorders','salesorders','stockmovements','stocktransfers','banktransactions',
  'bankstatementrows','salespersoncashmovements','warehousestockmovements',
  'journalentries','cashtransactions','contraentries','contravouchers',
  'banktransfers','expenses','creditnotes','bankstatementimports',
  'warehouseclosings','orderdeliveryevents','deliveries',
  'ordernotifications','orderevents','promisetopays','deliveryruns',
  'salespersondayclosings',
]);
const cache=new Map();
const ttl=30000;
const yy=start=>`${start}-${String((start+1)%100).padStart(2,'0')}`;

async function collectionHasRecords(db, name) {
  const found=await db.collection(name).findOne({},{projection:{_id:1}});
  return !!found;
}
async function yearsFromFinancialDatabases(tenantKey, configured) {
  const client=mongoose.connection.getClient();
  const physical=resolveFinancialStorageTenantKeySync(tenantKey);
  const prefix=`${getTenantDbName(physical)}_`;
  let names=[];
  try{
    const list=await client.db('admin').admin().listDatabases({nameOnly:true,authorizedDatabases:true});
    names=(list.databases||[]).map(x=>String(x.name||''));
  }catch{
    // Some MongoDB users cannot run listDatabases. Probe plausible prior FY
    // databases without creating them; never silently drop configured years.
    const today=new Date();const current=today.getUTCFullYear()-(today.getUTCMonth()<3?1:0);
    const start=Math.min(current-20,...normalizeYears(configured).map(x=>Number(x.slice(0,4))));
    names=Array.from({length:current-start+2},(_,i)=>`${prefix}${yy(start+i)}`);
  }
  const candidates=names.filter(name=>name.startsWith(prefix)&&validFY(name.slice(prefix.length)));
  const matched=await Promise.all(candidates.map(async name=>{
    try{
      const db=client.db(name);
      const collections=await db.listCollections({}, {nameOnly:true}).toArray();
      const usable=collections.map(x=>x.name).filter(x=>relevant.has(x));
      if(!usable.length)return '';
      const found=await Promise.all(usable.map(collection=>collectionHasRecords(db,collection)));
      return found.some(Boolean)?name.slice(prefix.length):'';
    }catch{return '';}
  }));
  return matched.filter(Boolean);
}

export function invalidateFinancialYearDiscovery(tenantKey){cache.delete(String(tenantKey||''));}
export async function discoverFinancialYears({tenantKey, configured=[]}={}){
  if(!tenantKey)return {discovered:[],firstDataFinancialYear:''};
  const key=String(tenantKey);
  const old=cache.get(key);
  if(old&&old.until>Date.now())return old.value;
  const [fromDatabases,ledgerOpenings,userOpenings,bankOpenings,customerOpenings]=await Promise.all([
    yearsFromFinancialDatabases(tenantKey,configured),
    CompanyLedger.find({tenantKey, 'openingBalances.0':{$exists:true}}).select('openingBalances.financialYear').lean(),
    User.distinct('openingFinancialYear',{tenantKey,openingFinancialYear:{$exists:true,$ne:''}}),
    BankAccount.find({tenantKey}).select('financialYear openingBalances.financialYear').lean(),
    CustomerLink.distinct('openingFinancialYear',{tenantKey,openingFinancialYear:{$exists:true,$ne:''}}),
  ]);
  const found=normalizeYears([
    ...fromDatabases,
    ...ledgerOpenings.flatMap(x=>(x.openingBalances||[]).map(r=>r.financialYear)),
    ...userOpenings,
    ...bankOpenings.flatMap(x=>[x.financialYear,...(x.openingBalances||[]).map(r=>r.financialYear)]),
    ...customerOpenings,
  ]);
  const value={discovered:found,firstDataFinancialYear:found[0]||''};
  cache.set(key,{value,until:Date.now()+ttl});
  return value;
}
