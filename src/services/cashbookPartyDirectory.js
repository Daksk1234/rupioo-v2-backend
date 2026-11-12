import { CustomerLink, GlobalCustomer, User, Transporter } from '../models/index.js';

export async function loadCashBulkPartyDirectory(tenantKey) {
  const [customers,users,transporters]=await Promise.all([
    CustomerLink.find({tenantKey,status:{$nin:['INACTIVE','DEACTIVATED']},systemKey:{$ne:'CASH'}})
      .select('globalCustomerId localName displayIdentifier').lean(),
    User.find({tenantKey,status:'ACTIVE',systemManaged:{$ne:true},ledgerNodeKind:{$ne:'GROUP'},
      'accountingProfile.systemAccountCode':{$ne:'SYS_CASH'}}).select('_id name').lean(),
    Transporter.find({tenantKey,status:'ACTIVE'}).select('_id name').lean(),
  ]);
  const ids=[...new Set(customers.map(x=>String(x.globalCustomerId||'')).filter(Boolean))];
  const objectIds=ids.filter(x=>/^[a-f0-9]{24}$/i.test(x));
  const globals=ids.length?await GlobalCustomer.find({$or:[{hiddenId:{$in:ids}},
    ...(objectIds.length?[{_id:{$in:objectIds}}]:[])]}).select('_id hiddenId legalName tradeName').lean():[];
  const byId=new Map();
  for(const g of globals){byId.set(String(g._id),g);if(g.hiddenId)byId.set(String(g.hiddenId),g);}
  return [
    ...customers.map(x=>{const g=byId.get(String(x.globalCustomerId));return {
      name:x.localName||g?.tradeName||g?.legalName,id:x.globalCustomerId,type:'CUSTOMER',
      aliases:[x.displayIdentifier,g?.tradeName,g?.legalName],
    };}),
    ...users.map(x=>({name:x.name,id:`USER:${x._id}`,type:'USER'})),
    ...transporters.map(x=>({name:x.name,id:`TRANSPORTER:${x._id}`,type:'TRANSPORTER'})),
  ].filter(x=>x.id&&x.name&&String(x.name).trim().toUpperCase()!=='CASH');
}
