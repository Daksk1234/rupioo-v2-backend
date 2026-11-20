import {Pincode} from '../models/index.js';
export const collectorRoles=['COLLECTION_EXECUTIVE','COLLECTOR'];
export const isCollectorRole=role=>collectorRoles.includes(String(role||'').toUpperCase());
export const normalizedCollectorPincodes=values=>[...new Set((Array.isArray(values)?values:[]).map(value=>String(value??'').trim()).filter(pin=>/^\d{6}$/.test(pin)))];
export const customerCollectionPincodes=customer=>{
 const pins=normalizedCollectorPincodes((Array.isArray(customer?.addresses)?customer.addresses:[]).map(row=>row.pincode));
 // Self-onboarding can capture the business pincode before a billing address
 // has been completed. Personal/owner addresses never confer collection access.
 return pins.length?pins:normalizedCollectorPincodes([customer?.registrationMeta?.pincode]);
};
export const collectorTerritoryFilter=pincodes=>{
 const pins=normalizedCollectorPincodes(pincodes);
 if(!pins.length)return {'addresses.pincode':{$in:[]}};
 const normalized=value=>({$trim:{input:{$convert:{input:value,to:'string',onError:'',onNull:''}}}});
 const addresses={$map:{input:{$cond:[{$isArray:'$addresses'},'$addresses',[]]},as:'address',in:normalized('$$address.pincode')}};
 const validAddresses={$filter:{input:addresses,as:'pin',cond:{$regexMatch:{input:'$$pin',regex:'^[0-9]{6}$'}}}};
 const effectivePins={$cond:[{$gt:[{$size:validAddresses},0]},validAddresses,[normalized('$registrationMeta.pincode')]]};
 // Keep territory in its own AND clause so a customer-name search cannot
 // overwrite the OR used by the normalized-address fallback.
 return {$and:[{$or:[{'addresses.pincode':{$in:pins}},{$expr:{$gt:[{$size:{$setIntersection:[effectivePins,pins]}},0]}}]}]};
};
export const collectorForCustomerFilter=customer=>({collectorPincodes:{$in:customerCollectionPincodes(customer)}});
export async function validateCollectorPincodes(raw){
 if(!Array.isArray(raw)||!raw.length)throw Object.assign(new Error('Assign at least one pincode to the Collection Executive'),{statusCode:400});
 const pins=[...new Set(raw.map(value=>String(value).trim()))];
 if(pins.length>100000||pins.some(pin=>!/^\d{6}$/.test(pin)))throw Object.assign(new Error('Choose valid six-digit MASTER pincodes'),{statusCode:400});
 const found=await Pincode.aggregate([{$match:{status:{$ne:'INACTIVE'},$expr:{$in:[{$toString:'$pincode'},pins]}}},{$group:{_id:{$toString:'$pincode'}}}]);
 const known=new Set(found.map(row=>String(row._id))),missing=pins.filter(pin=>!known.has(pin));
 if(missing.length)throw Object.assign(new Error(`Pincodes not found in MASTER: ${missing.slice(0,20).join(', ')}`),{statusCode:400});
 return pins.sort();
}
