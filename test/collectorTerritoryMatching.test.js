import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorTerritoryFilter,customerCollectionPincodes} from '../src/services/collectorTerritoryService.js';
import {matchesMongo} from './helpers/mongoPredicate.js';

test('collector territory matches canonical, padded and numeric business pincodes',()=>{
 const filter=collectorTerritoryFilter([' 781001 ','781001','invalid']);
 for(const pin of ['781001',' 781001 ',781001])assert.equal(matchesMongo({addresses:[{pincode:pin}]},filter),true);
 assert.equal(matchesMongo({addresses:[{pincode:'110001'}]},filter),false);
 assert.equal(matchesMongo({addresses:[{pincode:'781001'}]},collectorTerritoryFilter([])),false);
});
test('onboarding business pincode works until the billing address is completed; owner personal pincode never grants access',()=>{
 const filter=collectorTerritoryFilter(['781001']);
 assert.equal(matchesMongo({registrationMeta:{pincode:' 781001 '}},filter),true);
 assert.equal(matchesMongo({ownerPincode:'781001'},filter),false);
 const outside={addresses:[{pincode:'110001'}],registrationMeta:{pincode:'781001'}};
 assert.equal(matchesMongo(outside,filter),false);
 assert.deepEqual(customerCollectionPincodes(outside),['110001']);
 assert.deepEqual(customerCollectionPincodes({registrationMeta:{pincode:' 781001 '}}),['781001']);
});
test('search and tenant constraints cannot overwrite the collector territory',()=>{
 const query={tenantKey:'COMPANY-1',status:'ACTIVE',...collectorTerritoryFilter(['781001']),$or:[{localName:/assam/i}]};
 const customer={tenantKey:'COMPANY-1',status:'ACTIVE',localName:'Assam Supply Syndicate',addresses:[{pincode:'781001'}]};
 assert.equal(matchesMongo(customer,query),true);
 assert.equal(matchesMongo({...customer,tenantKey:'COMPANY-2'},query),false);
 assert.equal(matchesMongo({...customer,addresses:[{pincode:'110001'}]},query),false);
 assert.equal(matchesMongo({...customer,status:'INACTIVE'},query),false);
});
