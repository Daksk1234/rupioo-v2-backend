import crypto from "crypto";
import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import XLSX from "xlsx";
import { CustomerLink, GlobalCustomer, CustomerGrade, Pincode, Transporter, GlobalTransporterStation, Lead, LegacyMigrationItem } from "../models/index.js";
import { requireAuth } from "../middleware/auth.js";
import { fail, ok, pageMeta } from "../utils/http.js";
import { makeId } from "../utils/ids.js";
import { readRows, resolveColumns, valueFor } from "../utils/bulkSpreadsheet.js";
import { searchTaxpayer, getReturnFilingStatus } from "../services/gstService.js";
import { customerHealth } from "../services/healthService.js";
import { syncCustomerLedger } from "../services/companyAccountingService.js";
import { hierarchyVisibilityForUser, resolveCustomerSalesperson } from "../services/assignmentHierarchyService.js";
import { financialModels } from "../services/accountingService.js";
import { referencedPartyIds } from "../services/referenceIntegrityService.js";
import { resolveBankDetails } from "../services/ifscMasterService.js";
import { resolveCustomerDeliveryMode } from "../services/deliveryLocalityService.js";
import { resolveCompanyTransporter, ensureLegacyCustomerTransporter } from "../services/transporterAssignmentService.js";
import { isSystemCashRecord } from "../services/systemCashAccountService.js";

const router=express.Router();
router.use(requireAuth);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024}});
const upper=v=>String(v||"").trim().toUpperCase();
const cleanText=v=>String(v??"").trim();
const hashAadhaar=v=>crypto.createHash("sha256").update(String(v||"").replace(/\D/g,"")).digest("hex");
const displayId=({gstin,pan,aadhaar})=>upper(gstin)||upper(pan)||(aadhaar?`XXXX-XXXX-${String(aadhaar).replace(/\D/g,"").slice(-4)}`:"");
const canApprove=req=>req.auth?.role==="MASTER"||req.auth?.role==="SUPERADMIN"||(req.auth?.permissions||[]).includes("*")||(req.auth?.permissions||[]).includes("customers.approve");
const canEdit=req=>canApprove(req)||(req.auth?.permissions||[]).includes("customers.edit")||(req.auth?.permissions||[]).includes("customers.create");
const canDelete=req=>canApprove(req)||(req.auth?.permissions||[]).includes("customers.delete")||canEdit(req);

const objectIdText=v=>/^[a-fA-F0-9]{24}$/.test(cleanText(v));
async function findGlobalCustomerByRef(ref){
  const value=cleanText(ref);if(!value)return null;
  if(objectIdText(value))return GlobalCustomer.findOne({$or:[{hiddenId:value},{_id:value}]});
  return GlobalCustomer.findOne({hiddenId:value});
}
async function resolveCustomerPair(tenantKey,ref){
  const value=cleanText(ref);
  let link=await CustomerLink.findOne({tenantKey,globalCustomerId:value});
  let global=await findGlobalCustomerByRef(value);
  if(!global&&link)global=await findGlobalCustomerByRef(link.globalCustomerId);
  if(!link&&global){
    const refs=[global.hiddenId,String(global._id)].filter(Boolean);
    link=await CustomerLink.findOne({tenantKey,globalCustomerId:{$in:refs}});
  }
  return {global,link};
}
function customerPendingFields(link,global){
  const billing=(link?.addresses||[]).find(x=>x?.type==="BILLING")||(link?.addresses||[])[0]||{};
  const primary=(link?.contacts||[]).find(x=>x?.primary)||(link?.contacts||[])[0]||{};
  const missing=[];
  if(!cleanText(link?.localName||global?.legalName))missing.push("Party Name");
  if(!cleanText(billing.address||global?.registeredAddress))missing.push("Address");
  if(!cleanText(link?.companyContactNumber||link?.ownerMobile||primary.mobile||global?.mobiles?.[0]?.value))missing.push("Mobile");
  if(digits(billing.pincode).length!==6)missing.push("Pincode");
  return missing;
}
async function refreshMigrationCompletion(link,global,userId){
  if(!link?.migration?.legacyId)return [];
  const missing=customerPendingFields(link,global);
  link.migration.profileComplete=missing.length===0;
  link.migration.status=missing.length?"IMPORTED_WITH_PENDING_FIELDS":"IMPORTED";
  await link.save();
  await LegacyMigrationItem.updateMany({tenantKey:link.tenantKey,entity:"customers",legacyId:link.migration.legacyId},{$set:{missingFields:missing,status:missing.length?"NEEDS_COMPLETION":"RESOLVED",resolvedAt:missing.length?null:new Date(),resolvedBy:missing.length?"":userId||""}}).catch(()=>{});
  return missing;
}

const digits=v=>String(v||"").replace(/\D/g,"");
const validDate=v=>{if(!v)return undefined;const d=new Date(v);return Number.isNaN(d.getTime())?undefined:d;};
const sameText=(a,b)=>cleanText(a).toLowerCase()===cleanText(b).toLowerCase();
const servicesDestination=(station,address={})=>{
  const pin=digits(address.pincode).slice(0,6),city=cleanText(address.city),state=cleanText(address.state);
  if(pin&&(String(station.pincode||"")===pin||(station.servicePincodes||[]).includes(pin)))return true;
  if(city&&(sameText(station.city,city)||(station.serviceCities||[]).some(x=>sameText(x,city))))return true;
  if(state&&(sameText(station.state,state)||(station.serviceStates||[]).some(x=>sameText(x,state))))return true;
  return false;
};
async function validateCustomerTransportAssignment({tenantKey,link}){
  // Delivery locality is CITY based, not GST/state based. GST state code is used
  // only for CGST/SGST vs IGST. Same firm city = local delivery; every other
  // destination city requires a transporter.
  const locality=await resolveCustomerDeliveryMode({tenantKey,customer:link});
  link.regionType=locality.mode;
  if(!locality.requiresTransport){
    link.assignedTransport="";link.assignedTransportGlobalId="";link.assignedTransportBookingStationId="";link.assignedTransportDeliveryStationId="";
    link.serviceArea=locality.customerCity;
    return locality;
  }
  if(!cleanText(link.assignedTransportGlobalId))throw Object.assign(new Error(`Assign a transporter serving ${locality.customerCity} before saving this customer`),{statusCode:400});
  if(!cleanText(link.assignedTransport))throw Object.assign(new Error("Selected transporter must be linked to the company transporter master"),{statusCode:400});
  if(!cleanText(link.assignedTransportDeliveryStationId))throw Object.assign(new Error(`Select a delivery station serving ${locality.customerCity}`),{statusCode:400});
  let local=await resolveCompanyTransporter({tenantKey,ref:link.assignedTransport,globalTransporterId:link.assignedTransportGlobalId});
  if(!local&&link.migration?.legacyId){const repaired=await ensureLegacyCustomerTransporter({tenantKey,customer:link});local=repaired.transporter;}
  if(!local)throw Object.assign(new Error("Selected transporter is not active in the company transporter master"),{statusCode:400});
  link.assignedTransport=String(local._id);if(!link.assignedTransportGlobalId&&local.globalTransporterId)link.assignedTransportGlobalId=local.globalTransporterId;
  if(link.migration?.legacyId&&!cleanText(link.assignedTransportDeliveryStationId)){link.serviceArea=cleanText(link.serviceArea||local.stations?.[0]?.name||local.name);return locality;}
  const delivery=await GlobalTransporterStation.findOne({stationId:link.assignedTransportDeliveryStationId,globalTransporterId:link.assignedTransportGlobalId,status:"ACTIVE",stationType:{$in:["DELIVERY","BOTH"]}}).lean();
  if(!delivery)throw Object.assign(new Error("Selected delivery station is not active for this transporter"),{statusCode:400});
  const destination=locality.destination||{};
  if(!servicesDestination(delivery,destination))throw Object.assign(new Error(`Selected delivery station does not serve ${locality.customerCity||destination.pincode||"the customer delivery location"}`),{statusCode:400});
  if(link.assignedTransportBookingStationId){
    const booking=await GlobalTransporterStation.findOne({stationId:link.assignedTransportBookingStationId,globalTransporterId:link.assignedTransportGlobalId,status:"ACTIVE",stationType:{$in:["BOOKING","BOTH"]}}).lean();
    if(!booking)throw Object.assign(new Error("Selected booking station is not active for this transporter"),{statusCode:400});
  }
  link.serviceArea=cleanText(link.serviceArea||delivery.name||delivery.city||locality.customerCity);
  return locality;
}
const pinGeo=async(value,fallback={})=>{
  const pincode=digits(value).slice(0,6);if(pincode.length!==6)return {pincode,area:cleanText(fallback.area),city:cleanText(fallback.city),district:cleanText(fallback.district),state:cleanText(fallback.state)};
  const rows=await Pincode.find({pincode,status:{$ne:"INACTIVE"}}).sort({area:1}).lean();
  const wanted=cleanText(fallback.area).toLowerCase();
  const row=(wanted&&rows.find(x=>cleanText(x.area).toLowerCase()===wanted))||rows.find(x=>cleanText(x.city))||rows[0];
  return {pincode,area:cleanText(fallback.area||row?.area),city:cleanText(row?.city||fallback.city||fallback.area||row?.area),district:cleanText(row?.district||fallback.district),state:cleanText(row?.state||fallback.state)};
};

async function applyPreviousDmsCustomerFields(link,body={},options={}){
  const textFields=["firstName","lastName","ownerName","ownerMobile","ownerPan","passportNumber","ownerAddress","partyType","registrationType","businessType","firmType","gstStatus","gstRange","eInvoiceStatus","filingFrequency","customerCode","dealsInProducts","address2","companyContactNumber","shopSize","category","assignedTransport","assignedTransportGlobalId","assignedTransportBookingStationId","assignedTransportDeliveryStationId","serviceArea"];
  for(const key of textFields)if(body[key]!==undefined)link[key]=key==="ownerPan"?upper(body[key]):cleanText(body[key]);
  if(body.annualTurnover!==undefined)link.annualTurnover=Math.max(0,Number(body.annualTurnover||0));
  if(body.dueDate!==undefined)link.dueDate=validDate(body.dueDate);

  if(body.ownerAadhaar!==undefined||body.aadhaar!==undefined){
    const a=digits(body.ownerAadhaar??body.aadhaar).slice(0,12);
    if(a && a.length!==12)throw Object.assign(new Error("Owner Aadhaar must contain 12 digits"),{statusCode:400});
    if(a){link.ownerAadhaarHash=hashAadhaar(a);link.ownerAadhaarMasked=`XXXX-XXXX-${a.slice(-4)}`;}
  }

  if(body.ownerPincode!==undefined){
    const ownerGeo=await pinGeo(body.ownerPincode,{area:body.ownerArea,city:body.ownerCity,district:body.ownerDistrict,state:body.ownerState});
    link.ownerPincode=ownerGeo.pincode;link.ownerArea=ownerGeo.area;link.ownerCity=ownerGeo.city;link.ownerDistrict=ownerGeo.district;link.ownerState=ownerGeo.state;
  }else{
    for(const key of ["ownerArea","ownerCity","ownerDistrict","ownerState"])if(body[key]!==undefined)link[key]=cleanText(body[key]);
  }

  if(Array.isArray(body.bankDetails)){
    const entered=body.bankDetails.filter(x=>x&&(x.bankName||x.accountName||x.accountNumber||x.ifsc));
    const resolved=[];
    for(const item of entered){
      const ifsc=upper(item.ifsc);
      if(options.allowIncomplete && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)){
        // Preserve legacy bank information while the missing IFSC is completed later.
        resolved.push({ifsc,bankName:cleanText(item.bankName),branchName:cleanText(item.branchName||item.branchArea),branchArea:cleanText(item.branchArea),bankAddress:cleanText(item.bankAddress),city:cleanText(item.city||item.bankCity),state:cleanText(item.state||item.bankState),stdCode:cleanText(item.stdCode||item.bankStdCode),phone:cleanText(item.phone||item.bankPhone),contactNo:cleanText(item.contactNo||item.bankContactNo),accountName:cleanText(item.accountName),accountNumber:cleanText(item.accountNumber)});
        continue;
      }
      const bank=await resolveBankDetails({...item,ifsc},{optional:false});
      resolved.push({...bank,accountName:cleanText(item.accountName),accountNumber:cleanText(item.accountNumber)});
    }
    link.bankDetails=resolved;
  }

  const geoText=cleanText(body.geotagging);
  if(geoText){
    const [lat,lng]=geoText.split(",").map(Number);
    if(Number.isFinite(lat)&&Number.isFinite(lng))link.location={latitude:lat,longitude:lng,accuracy:Number(body.locationAccuracy||0)||undefined,capturedAt:new Date()};
  }else if(body.latitude!==undefined&&body.longitude!==undefined){
    const lat=Number(body.latitude),lng=Number(body.longitude);if(Number.isFinite(lat)&&Number.isFinite(lng))link.location={latitude:lat,longitude:lng,accuracy:Number(body.locationAccuracy||0)||undefined,capturedAt:new Date()};
  }

  if(body.portalLoginEnabled!==undefined && !body.password)link.portalLoginEnabled=Boolean(body.portalLoginEnabled);
  if(body.password){
    const password=String(body.password);if(password.length<6)throw Object.assign(new Error("Customer password must be at least 6 characters"),{statusCode:400});
    link.portalPasswordHash=await bcrypt.hash(password,12);link.portalLoginEnabled=true;
  }
}

function normaliseTerms(body={}){
  const paymentType=upper(body.paymentType||"CASH")==="CREDIT"?"CREDIT":"CASH";
  return {
    paymentType,
    creditDays:paymentType==="CREDIT"?Math.max(0,Number(body.creditDays||0)):0,
    creditLimit:paymentType==="CREDIT"?Math.max(0,Number(body.creditLimit||0)):0,
    graceDays:paymentType==="CREDIT"?Math.max(0,Number(body.graceDays||0)):0,
    priceList:cleanText(body.priceList||"STANDARD")
  };
}

function normaliseContacts(body={}){
  if(Array.isArray(body.contacts))return body.contacts.filter(x=>x?.mobile||x?.email||x?.name).map((x,i)=>({name:cleanText(x.name),designation:cleanText(x.designation),mobile:cleanText(x.mobile),email:cleanText(x.email).toLowerCase(),mobileVerified:Boolean(x.mobileVerified),emailVerified:Boolean(x.emailVerified),primary:Boolean(x.primary??i===0),active:x.active!==false}));
  if(body.mobile||body.email)return [{name:cleanText(body.contactName),designation:cleanText(body.contactDesignation),mobile:cleanText(body.mobile),email:cleanText(body.email).toLowerCase(),mobileVerified:false,emailVerified:false,primary:true,active:true}];
  return [];
}

function normaliseAddresses(body={}){
  if(Array.isArray(body.addresses))return body.addresses.filter(x=>x?.address||x?.pincode).map(x=>({type:upper(x.type||"BILLING"),address:cleanText(x.address),pincode:cleanText(x.pincode),area:cleanText(x.area),city:cleanText(x.city),district:cleanText(x.district),state:cleanText(x.state),latitude:Number(x.latitude)||undefined,longitude:Number(x.longitude)||undefined,accuracy:Number(x.accuracy)||undefined,capturedAt:x.capturedAt||undefined,verified:Boolean(x.verified)}));
  if(body.address||body.pincode)return [{type:"BILLING",address:cleanText(body.address),pincode:cleanText(body.pincode),area:cleanText(body.area),city:cleanText(body.city),district:cleanText(body.district),state:cleanText(body.state),latitude:Number(body.latitude)||undefined,longitude:Number(body.longitude)||undefined,accuracy:Number(body.accuracy)||undefined,capturedAt:body.latitude?new Date():undefined,verified:Boolean(body.locationVerified)}];
  return [];
}

async function applyGlobalIdentityChanges(globalId, changes={}){
  const global=await findGlobalCustomerByRef(globalId);
  if(!global)return null;
  if(changes.legalName)global.legalName=cleanText(changes.legalName);
  if(changes.tradeName!==undefined)global.tradeName=cleanText(changes.tradeName);
  if(changes.registeredAddress!==undefined)global.registeredAddress=cleanText(changes.registeredAddress);
  if(changes.pan)global.pan=upper(changes.pan);
  if(changes.aadhaar){const a=digits(changes.aadhaar).slice(0,12);if(a.length===12){global.aadhaarHash=hashAadhaar(a);global.aadhaarMasked=`XXXX-XXXX-${a.slice(-4)}`;}}
  if(changes.gstin){const gstin=upper(changes.gstin);if(gstin&&!global.gstins.some(x=>x.value===gstin))global.gstins.push({value:gstin,status:"UNVERIFIED"});}
  await global.save();
  return global;
}

async function upsertCustomerIdentity({tenantKey,body,actorId,actorRole="",allowIncomplete=false}){
  const gstin=upper(body.gstin),pan=upper(body.pan||body.ownerPan),aadhaar=String(body.aadhaar||"").replace(/\D/g,""),legalName=cleanText(body.legalName),mobile=cleanText(body.mobile),email=cleanText(body.email).toLowerCase();
  if(!gstin&&!pan&&!aadhaar)throw Object.assign(new Error("GSTIN, PAN or Aadhaar is required for global identity"),{statusCode:400});
  const clauses=[];if(gstin)clauses.push({"gstins.value":gstin});if(pan)clauses.push({pan});if(aadhaar)clauses.push({aadhaarHash:hashAadhaar(aadhaar)});
  let global=await GlobalCustomer.findOne({$or:clauses});
  if(!global){
    global=new GlobalCustomer({hiddenId:makeId("GC"),legalName:legalName||gstin||pan||"Customer",tradeName:cleanText(body.tradeName),registeredAddress:cleanText(body.registeredAddress||body.address),customerType:body.customerType||"BUSINESS",pan:pan||undefined,aadhaarHash:aadhaar?hashAadhaar(aadhaar):undefined,aadhaarMasked:aadhaar?`XXXX-XXXX-${aadhaar.slice(-4)}`:undefined,gstins:gstin?[{value:gstin,status:body.gstStatus||"UNVERIFIED"}]:[],mobiles:mobile?[{value:mobile,verified:false,primary:true}]:[],emails:email?[{value:email,verified:false,primary:true}]:[],linkedTenants:[{tenantKey,linkedAt:new Date()}]});
  }else{
    if(gstin&&!global.gstins.some(x=>x.value===gstin))global.gstins.push({value:gstin,status:"UNVERIFIED"});
    if(pan&&!global.pan)global.pan=pan;
    if(aadhaar&&!global.aadhaarHash){global.aadhaarHash=hashAadhaar(aadhaar);global.aadhaarMasked=`XXXX-XXXX-${aadhaar.slice(-4)}`;}
    if(mobile&&!global.mobiles.some(x=>x.value===mobile))global.mobiles.push({value:mobile,verified:false,primary:false});
    if(email&&!global.emails.some(x=>x.value===email))global.emails.push({value:email,verified:false,primary:false});
    if(!global.linkedTenants.some(x=>x.tenantKey===tenantKey))global.linkedTenants.push({tenantKey,linkedAt:new Date()});
    if(legalName)global.legalName=legalName;
    if(body.tradeName)global.tradeName=cleanText(body.tradeName);
    if(body.registeredAddress||body.address)global.registeredAddress=cleanText(body.registeredAddress||body.address);
  }
  await global.save();

  const requested=normaliseTerms(body);
  const gradeCode=upper(body.gradeCode);
  const grade=gradeCode?await CustomerGrade.findOne({tenantKey,code:gradeCode,status:"ACTIVE"}).lean():null;
  const contacts=normaliseContacts(body);
  const addresses=normaliseAddresses(body);
  if(addresses[0]?.pincode){const geo=await pinGeo(addresses[0].pincode,addresses[0]);addresses[0]={...addresses[0],...geo};}
  let link=await CustomerLink.findOne({tenantKey,globalCustomerId:global.hiddenId});
  const created=!link;
  if(!link)link=new CustomerLink({tenantKey,globalCustomerId:global.hiddenId,displayIdentifier:displayId({gstin,pan,aadhaar}),localName:legalName||global.legalName,customerType:body.customerType||"BUSINESS"});
  if(body.sourceLeadId)link.sourceLeadId=cleanText(body.sourceLeadId);
  link.localName=legalName||link.localName||global.legalName;
  link.displayIdentifier=displayId({gstin,pan,aadhaar})||link.displayIdentifier;
  await applyPreviousDmsCustomerFields(link,body,{allowIncomplete});
  const assignmentPincode=cleanText(body.pincode||addresses?.[0]?.pincode||link.addresses?.[0]?.pincode).replace(/\D/g,"").slice(0,6);
  if(assignmentPincode){
    try{
      const assignment=await resolveCustomerSalesperson({tenantKey,pincode:assignmentPincode,requestedUserId:body.salespersonId??link.salespersonId??"",requireAssignment:!allowIncomplete});
      if(assignment.salespersonId)link.salespersonId=assignment.salespersonId;
    }catch(e){
      if(!allowIncomplete)throw e;
      if(body.salespersonId)link.salespersonId=cleanText(body.salespersonId);
    }
  }
  if(gradeCode){link.gradeCode=gradeCode;link.gradeDiscountPct=Number(grade?.discountPct??body.gradeDiscountPct??0);}
  else if(body.gradeDiscountPct!==undefined)link.gradeDiscountPct=Number(body.gradeDiscountPct||0);
  link.contacts=contacts.length?contacts:link.contacts;
  link.addresses=addresses.length?addresses:link.addresses;
  if(!allowIncomplete)await validateCustomerTransportAssignment({tenantKey,link});
  link.requestedTerms={...requested,requestedBy:actorId,requestedAt:new Date()};
  link.paymentType=requested.paymentType; link.creditDays=requested.creditDays; link.creditLimit=requested.creditLimit; link.graceDays=requested.graceDays; link.priceList=requested.priceList;
  const autoApprove=["MASTER","SUPERADMIN"].includes(upper(actorRole));
  link.status=body.status==="DRAFT"?"DRAFT":(autoApprove?"ACTIVE":"PENDING_APPROVAL");
  link.approval=link.status==="DRAFT"
    ?{status:"DRAFT",submittedBy:actorId}
    :autoApprove
      ?{status:"APPROVED",submittedBy:actorId,submittedAt:new Date(),reviewedBy:actorId,reviewedAt:new Date(),decision:"AUTO_APPROVED_SUPERADMIN",remarks:"Created by Superadmin / Master"}
      :{status:"PENDING",submittedBy:actorId,submittedAt:new Date()};
  if(autoApprove)link.approvedTerms={...requested,approvedBy:actorId,approvedAt:new Date()};
  const customerAccountCode=upper(body.partyType||link.partyType)==="CREDITOR"?"SYS_SUNDRY_CREDITORS":"SYS_SUNDRY_DEBTORS";
  link.accountingProfile={systemAccountCode:customerAccountCode,ledgerName:body.ledgerName||`${link.localName} A/c`,openingBalance:Number(body.openingBalance||0),openingBalanceType:upper(body.openingBalanceType||"DR")==="CR"?"CR":"DR",financialYear:cleanText(body.financialYear)};
  link.approvalHistory.push({action:autoApprove?(created?"CREATED_AUTO_APPROVED":"UPDATED_AUTO_APPROVED"):(created?"CREATED":"RESUBMITTED"),by:actorId,at:new Date(),remarks:body.remarks||"",changes:{requestedTerms:requested}});
  await link.save();
  if(autoApprove&&link.status==="ACTIVE")await syncCustomerLedger(link);
  return {global,link,created,autoApproved:autoApprove};
}

async function enrichedItems(filter,{page=1,limit=50}={}){
  const [items,total]=await Promise.all([CustomerLink.find(filter).sort({createdAt:-1}).skip((page-1)*limit).limit(limit).lean(),CustomerLink.countDocuments(filter)]);
  const ids=[...new Set(items.map(x=>x.globalCustomerId).filter(Boolean))];
  const transporterRefs=[...new Set(items.map(x=>String(x.assignedTransport||"")).filter(Boolean))];
  const transporterIds=transporterRefs.filter(objectIdText);
  const transporterNames=transporterRefs.filter(x=>!objectIdText(x));
  const stationIds=[...new Set(items.flatMap(x=>[x.assignedTransportBookingStationId,x.assignedTransportDeliveryStationId]).map(String).filter(Boolean))];
  const objectIds=ids.filter(objectIdText);
  const globalFilter=ids.length?{$or:[{hiddenId:{$in:ids}},...(objectIds.length?[{_id:{$in:objectIds}}]:[])]}:{hiddenId:{$in:[]}};
  const [globals,transporters,stations]=await Promise.all([
    GlobalCustomer.find(globalFilter).select("hiddenId legalName tradeName registeredAddress gstins pan aadhaarMasked mobiles emails globalHealth gstProfile").lean(),
    (transporterIds.length||transporterNames.length)?Transporter.find({tenantKey:filter.tenantKey,status:{$ne:"INACTIVE"},$or:[...(transporterIds.length?[{_id:{$in:transporterIds}}]:[]),...(transporterNames.length?[{name:{$in:transporterNames.map(x=>new RegExp(`^${x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`,"i"))}}]:[])]}).select("_id name globalTransporterId status").lean():[],
    stationIds.length?GlobalTransporterStation.find({stationId:{$in:stationIds}}).select("stationId name stationType address pincode city state").lean():[],
  ]);
  const gm=new Map();for(const g of globals){gm.set(String(g.hiddenId),g);gm.set(String(g._id),g);}
  const tm=new Map();for(const t of transporters){tm.set(String(t._id),t);tm.set(String(t.name||"").toLowerCase(),t);}const sm=new Map(stations.map(st=>[String(st.stationId),st]));
  return {items:items.map(x=>({...x,global:gm.get(String(x.globalCustomerId))||null,assignedTransportDetails:x.assignedTransport?{transporter:tm.get(String(x.assignedTransport))||tm.get(String(x.assignedTransport).toLowerCase())||null,bookingStation:sm.get(String(x.assignedTransportBookingStationId||""))||null,deliveryStation:sm.get(String(x.assignedTransportDeliveryStationId||""))||null}:null})),total};
}

async function customerHierarchyFilter(req,filter){
  const visibility=await hierarchyVisibilityForUser(req.auth);
  if(!visibility.unrestricted){
    const hierarchyClause={$or:[{systemKey:"CASH"},{salespersonId:{$in:visibility.userIds}}]};
    if(Array.isArray(filter.$or)&&filter.$or.length){
      const searchClause={$or:filter.$or};delete filter.$or;
      filter.$and=[...(Array.isArray(filter.$and)?filter.$and:[]),searchClause,hierarchyClause];
    }else filter.$or=hierarchyClause.$or;
  }
  return visibility;
}
async function canSeeCustomer(req,link){
  if(!link)return false;
  if(isSystemCashRecord(link))return true;
  const visibility=await hierarchyVisibilityForUser(req.auth);
  return visibility.unrestricted||visibility.userIds.includes(String(link.salespersonId||""));
}

const refText=(value)=>{
  if(value===undefined||value===null)return "";
  if(typeof value==="object")return cleanText(value.$oid||value.oid||value._id||"");
  return cleanText(value);
};
const uniqueRefs=(values=[])=>[...new Set(values.map(refText).filter(Boolean))];
const customerReferenceAliases=(link={})=>uniqueRefs([
  link.globalCustomerId,
  link.migration?.legacyId,
  link.migration?.sourceData?._id,
  link.migration?.sourceData?.id,
  link.migration?.sourceData?.sId,
]);

async function protectedCustomerGlobalIds(tenantKey,links=[]){
  const aliases=uniqueRefs(links.flatMap(customerReferenceAliases));
  const found=new Set();
  // Keep $in sizes moderate for large customer masters.
  for(let i=0;i<aliases.length;i+=500){
    const chunk=aliases.slice(i,i+500);
    const used=await referencedPartyIds(tenantKey,chunk);
    for(const value of used)found.add(String(value));
  }
  const protectedIds=new Set();
  for(const link of links){
    if(customerReferenceAliases(link).some(value=>found.has(String(value))))protectedIds.add(String(link.globalCustomerId));
  }
  return protectedIds;
}

async function deactivateCustomerLinks(req,links=[],action="BULK_DEACTIVATED"){
  const protectedIds=await protectedCustomerGlobalIds(req.auth.tenantKey,links);
  for(const link of links){if(isSystemCashRecord(link))protectedIds.add(String(link.globalCustomerId||""));}
  const deletableIds=links.map(x=>String(x.globalCustomerId||"")).filter(id=>id&&!protectedIds.has(id));
  const protectedRows=links.filter(x=>protectedIds.has(String(x.globalCustomerId))).map(x=>({
    id:String(x.globalCustomerId||""),name:x.localName||x.globalCustomerId||"Customer",partyType:x.partyType||"PARTY",systemManaged:isSystemCashRecord(x)
  }));
  let modifiedCount=0;
  if(deletableIds.length){
    const result=await CustomerLink.updateMany(
      {tenantKey:req.auth.tenantKey,globalCustomerId:{$in:deletableIds},status:{$ne:"DEACTIVATED"}},
      {$set:{status:"DEACTIVATED"},$push:{approvalHistory:{action,by:req.auth.sub,at:new Date()}}}
    );
    modifiedCount=Number(result.modifiedCount||0);
  }
  return {modifiedCount,protectedRows,deletableIds};
}

router.get("/",async(req,res)=>{
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q);const filter={tenantKey:req.auth.tenantKey,status:{$ne:"DEACTIVATED"}};
  if(req.query.status)filter.status=upper(req.query.status);if(req.query.approvalStatus)filter["approval.status"]=upper(req.query.approvalStatus);if(String(req.query.unassigned||"").toLowerCase()==="true")filter.$and=[...(filter.$and||[]),{$or:[{salespersonId:""},{salespersonId:null},{salespersonId:{$exists:false}}]}];else if(req.query.salespersonId)filter.salespersonId=req.query.salespersonId;
  if(q)filter.$or=[{displayIdentifier:new RegExp(q,"i")},{localName:new RegExp(q,"i")},{"contacts.mobile":new RegExp(q,"i")},{"contacts.email":new RegExp(q,"i")}];
  await customerHierarchyFilter(req,filter);
  const {items,total}=await enrichedItems(filter,{page,limit});return ok(res,{items,meta:pageMeta(page,limit,total)});
});


const customerDownloadColumns=[
  {key:"legalName",label:"Company Name"},{key:"tradeName",label:"Trade Name"},{key:"gstin",label:"GSTIN"},{key:"pan",label:"Company PAN"},{key:"partyType",label:"Party Type"},{key:"registrationType",label:"Registration Type"},
  {key:"ownerName",label:"Owner Name"},{key:"ownerMobile",label:"Owner Mobile",text:true},{key:"ownerPan",label:"Owner PAN"},{key:"ownerAadhaar",label:"Owner Aadhaar"},{key:"ownerPincode",label:"Owner Pincode",text:true},{key:"ownerAddress",label:"Owner Address"},
  {key:"email",label:"Email"},{key:"companyContactNumber",label:"Contact Number",text:true},{key:"pincode",label:"Company Pincode",text:true},{key:"address",label:"Address 1"},{key:"address2",label:"Address 2"},
  {key:"dealsInProducts",label:"Deals in Product"},{key:"annualTurnover",label:"Annual Turnover"},{key:"shopSize",label:"Shop Size"},{key:"category",label:"Category"},{key:"paymentType",label:"Payment Term"},{key:"dueDate",label:"Due Date"},{key:"creditDays",label:"Credit Period"},{key:"creditLimit",label:"Amount Limit"},{key:"graceDays",label:"Grace Days"},
  {key:"assignedTransport",label:"Assigned Transport"},{key:"serviceArea",label:"Service Area"},{key:"salespersonId",label:"Salesperson ID"},{key:"gradeCode",label:"Customer Grade"},{key:"gradeDiscountPct",label:"Grade Discount %"},{key:"priceList",label:"Price List"},{key:"openingBalance",label:"Opening Balance"},{key:"openingBalanceType",label:"Balance Type"},{key:"financialYear",label:"Opening Financial Year"}
];
const firstCustomerValue=(items=[])=>{const row=(items||[]).find(x=>x?.primary&&x?.value)||(items||[]).find(x=>x?.value)||(items||[])[0];return row?.value||""};
const excelDateText=v=>v?String(v).slice(0,10):"";
function makeTemplateWorkbook(columns,rows,sheetName){
  const aoa=[columns.map(c=>c.label),...rows.map(row=>columns.map(c=>row?.[c.key]??""))];
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=columns.map(c=>({wch:Math.min(36,Math.max(12,String(c.label).length+3))}));
  columns.forEach((col,colIndex)=>{
    if(!col.text)return;
    for(let rowIndex=1;rowIndex<aoa.length;rowIndex+=1){
      const address=XLSX.utils.encode_cell({r:rowIndex,c:colIndex});
      if(!ws[address])ws[address]={t:"s",v:""};
      ws[address].t="s";ws[address].v=String(ws[address].v??"");ws[address].z="@";
    }
  });
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,sheetName);return XLSX.write(wb,{type:"buffer",bookType:"xlsx"});
}

router.get("/export-data.xlsx",async(req,res)=>{
  if(String(req.auth?.role||"").toUpperCase()!=="SUPERADMIN")return fail(res,"Superadmin access required",403);
  try{
    const filter={tenantKey:req.auth.tenantKey,status:{$ne:"DEACTIVATED"}};
    const all=[];let page=1,total=0;
    do{const batch=await enrichedItems(filter,{page,limit:200});all.push(...(batch.items||[]));total=batch.total||0;page+=1;}while(all.length<total);
    const rows=all.map(r=>{const g=r.global||{};const billing=(r.addresses||[]).find(x=>x?.type==="BILLING")||(r.addresses||[])[0]||{};const primary=(r.contacts||[]).find(x=>x?.primary)||(r.contacts||[])[0]||{};return {
      legalName:g.legalName||r.localName||"",tradeName:g.tradeName||"",gstin:firstCustomerValue(g.gstins),pan:g.pan||"",partyType:r.partyType||"",registrationType:r.registrationType||"",ownerName:r.ownerName||"",ownerMobile:r.ownerMobile||"",ownerPan:r.ownerPan||"",ownerAadhaar:"",ownerPincode:r.ownerPincode||"",ownerAddress:r.ownerAddress||"",email:primary.email||firstCustomerValue(g.emails),companyContactNumber:r.companyContactNumber||primary.mobile||firstCustomerValue(g.mobiles),pincode:billing.pincode||"",address:billing.address||g.registeredAddress||"",address2:r.address2||"",dealsInProducts:r.dealsInProducts||"",annualTurnover:r.annualTurnover??"",shopSize:r.shopSize||"",category:r.category||"",paymentType:r.paymentType||"",dueDate:excelDateText(r.dueDate),creditDays:r.creditDays??"",creditLimit:r.creditLimit??"",graceDays:r.graceDays??"",assignedTransport:r.assignedTransport||"",serviceArea:r.serviceArea||"",salespersonId:r.salespersonId||"",gradeCode:r.gradeCode||"",gradeDiscountPct:r.gradeDiscountPct??"",priceList:r.priceList||"",openingBalance:r.accountingProfile?.openingBalance??"",openingBalanceType:r.accountingProfile?.openingBalanceType||"",financialYear:r.accountingProfile?.financialYear||""
    }});
    const buffer=makeTemplateWorkbook(customerDownloadColumns,rows,"Customers");
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",`attachment; filename="customers-data-${new Date().toISOString().slice(0,10)}.xlsx"`);
    return res.send(buffer);
  }catch(e){return fail(res,e.message||"Unable to export customers",500);}
});

router.get("/approvals",async(req,res)=>{
  if(!canApprove(req))return fail(res,"Customer approval permission required",403);
  const page=Math.max(1,Number(req.query.page||1)),limit=Math.min(200,Math.max(10,Number(req.query.limit||50))),q=cleanText(req.query.q);const filter={tenantKey:req.auth.tenantKey,status:{$in:["PENDING_APPROVAL","ON_HOLD"]},"approval.status":{$in:["PENDING","SENT_BACK","HOLD"]}};
  if(q)filter.$or=[{displayIdentifier:new RegExp(q,"i")},{localName:new RegExp(q,"i")}];
  await customerHierarchyFilter(req,filter);
  const {items,total}=await enrichedItems(filter,{page,limit});return ok(res,{items,meta:pageMeta(page,limit,total)});
});

router.post("/resolve",async(req,res)=>{const {gstin,pan,aadhaar}=req.body;if(!gstin&&!pan&&!aadhaar)return fail(res,"GSTIN, PAN or Aadhaar is required");const clauses=[];if(gstin)clauses.push({"gstins.value":upper(gstin)});if(pan)clauses.push({pan:upper(pan)});if(aadhaar)clauses.push({aadhaarHash:hashAadhaar(aadhaar)});const customer=await GlobalCustomer.findOne({$or:clauses}).select("-aadhaarHash").lean();return ok(res,{found:Boolean(customer),customer});});

router.post("/",async(req,res)=>{try{
  const result=await upsertCustomerIdentity({tenantKey:req.auth.tenantKey,body:req.body,actorId:req.auth.sub,actorRole:req.auth.role});
  const sourceLeadId=cleanText(req.body.sourceLeadId||result.link?.sourceLeadId);
  if(sourceLeadId){
    const lead=await Lead.findOne({tenantKey:req.auth.tenantKey,leadId:sourceLeadId});
    if(lead){
      const now=new Date();
      lead.conversion={...(lead.conversion?.toObject?.()||lead.conversion||{}),status:result.autoApproved?"ACTIVE":"PENDING_VERIFICATION",submittedAt:now,customerGlobalId:result.link.globalCustomerId,customerStatus:result.link.status};
      if(result.autoApproved){lead.stage="CUSTOMER";lead.conversion.verifiedAt=now;lead.conversion.verifiedBy=req.auth.sub;}
      else lead.stage="PENDING_VERIFICATION";
      lead.activities.push({type:"CUSTOMER_SUBMITTED",outcome:result.link.status,note:`Customer ${result.link.globalCustomerId} created from lead`,at:now,userId:req.auth.sub});
      lead.lastActivityAt=now;
      await lead.save();
    }
  }
  const message=result.autoApproved?(result.created?"Customer created and activated":"Customer updated and activated"):(result.created?"Customer created and sent for approval":"Customer updated and resubmitted for approval");
  return ok(res,result,message,201);
}catch(e){return fail(res,e.message,e.statusCode||400);}});

const customerBulkFields=[
  {key:"legalName",label:"Company Name",aliases:["customer name","legal name","name","CompanyName","companyname"],required:true},
  {key:"tradeName",label:"Business Name",aliases:["trade name","business name"]},{key:"partyType",label:"Party Type",aliases:["party type"]},{key:"registrationType",label:"GST Type",aliases:["registration type","gst type"]},
  {key:"businessType",label:"Business Type",aliases:["nature of business","business type"]},{key:"firmType",label:"Firm Type",aliases:["constitution","firm type"]},{key:"gstStatus",label:"GST Status",aliases:["gst status"]},{key:"gstRange",label:"GST Range",aliases:["range","centre jurisdiction"]},{key:"eInvoiceStatus",label:"E-Invoice Status",aliases:["e invoice status","einvoice status"]},{key:"filingFrequency",label:"Filing Frequency",aliases:["filing frequency"]},
  {key:"gstin",label:"GSTIN",aliases:["gst no","gst number","gstNumber"]},{key:"pan",label:"Company PAN",aliases:["pan","comPanNo","company pan no"]},
  {key:"firstName",label:"First Name",aliases:["first name"]},{key:"lastName",label:"Last Name",aliases:["last name"]},{key:"ownerName",label:"Owner Name",aliases:["owner name"]},{key:"ownerMobile",label:"Owner Mobile",aliases:["owner mobile","mobileNumber"]},{key:"ownerPan",label:"Owner PAN",aliases:["owner pan","panNo"]},{key:"ownerAadhaar",label:"Owner Aadhaar",aliases:["aadhaar","aadhar","aadharNo","aadhaar no"]},{key:"passportNumber",label:"Passport Number",aliases:["passport","passPortNo"]},
  {key:"ownerAddress",label:"Owner Address",aliases:["owner address"]},{key:"ownerPincode",label:"Owner Pincode",aliases:["owner pincode","personalPincode"]},{key:"ownerArea",label:"Owner Area"},{key:"ownerCity",label:"Owner City",aliases:["Pcity"]},{key:"ownerDistrict",label:"Owner District"},{key:"ownerState",label:"Owner State",aliases:["Pstate"]},
  {key:"email",label:"Email"},{key:"companyContactNumber",label:"Contact Number",aliases:["mobile","phone","mobile number","contactNumber"]},
  {key:"pincode",label:"Company Pincode",aliases:["pincode","pin code"]},{key:"area",label:"Area",aliases:["post office","company area"]},{key:"city",label:"City",aliases:["City"]},{key:"district",label:"District"},{key:"state",label:"State",aliases:["State"]},{key:"address",label:"Address 1",aliases:["address"]},{key:"address2",label:"Address 2"},{key:"regionType",label:"Region Type",aliases:["regionType"]},
  {key:"dealsInProducts",label:"Deals in Product",aliases:["dealsInProducts"]},{key:"annualTurnover",label:"Annual Turnover",type:"number",aliases:["annualTurnover"]},{key:"shopSize",label:"Shop Size",aliases:["shopSize"]},{key:"category",label:"Category"},
  {key:"paymentType",label:"Payment Term",aliases:["payment type","cash/credit","paymentTerm"]},{key:"dueDate",label:"Due Date",aliases:["duedate"]},{key:"creditDays",label:"Credit Period",type:"number",aliases:["requested credit days","lockInTime"]},{key:"creditLimit",label:"Amount Limit",type:"number",aliases:["requested credit limit","limit"]},{key:"graceDays",label:"Grace Days",type:"number"},
  {key:"assignedTransport",label:"Assigned Transport"},{key:"assignedTransportGlobalId",label:"Transport Global ID"},{key:"assignedTransportBookingStationId",label:"Booking Station ID"},{key:"assignedTransportDeliveryStationId",label:"Delivery Station ID"},{key:"serviceArea",label:"Service Area"},{key:"legacyAssignTransporter",label:"Legacy Assigned Transporter",aliases:["assignTransporter"]},{key:"salespersonId",label:"Salesperson ID",aliases:["assigned salesperson","sales person id"]},
  {key:"gradeCode",label:"Customer Grade",aliases:["grade"]},{key:"gradeDiscountPct",label:"Grade Discount %",type:"number"},{key:"priceList",label:"Price List"},{key:"geotagging",label:"Geotagging"},{key:"password",label:"Customer Password"},{key:"portalLoginEnabled",label:"Portal Login Enabled"},
  {key:"bankDetails",label:"Bank Details",aliases:["bankDetails"]},{key:"openingBalance",label:"Opening Balance",type:"number",aliases:["OpeningBalance"]},{key:"openingBalanceType",label:"Balance Type",aliases:["Type"]},{key:"financialYear",label:"Opening Financial Year",aliases:["financial year","openingFinancialYear"]},{key:"remarks",label:"Remarks"}
];
function customerBulkColumns(firstRow={}){
  return resolveColumns(firstRow,customerBulkFields);
}
function parseBulkJsonArray(value){
  if(Array.isArray(value))return value;
  const text=cleanText(value);if(!text)return [];
  try{const parsed=JSON.parse(text);return Array.isArray(parsed)?parsed:[]}catch{return []}
}
function normalizeBulkEnumFields(body={}){
  if(body.partyType){const p=upper(body.partyType);body.partyType=p==="1"?"DEBITOR":p==="2"?"CREDITOR":p==="ECOMMERCE"?"ECOMMERCE":p==="DEBITOR"||p==="DEBTOR"?"DEBITOR":p==="CREDITOR"?"CREDITOR":upper(body.partyType);}
  if(body.registrationType){const r=upper(body.registrationType);body.registrationType=r==="0"||r==="REGULAR"?"REGULAR":r==="COMPOSITION"?"COMPOSITION":r==="UNREGISTERED"?"UNREGISTERED":r||"UNKNOWN";}
  if(body.paymentType)body.paymentType=upper(body.paymentType)==="CREDIT"?"CREDIT":"CASH";
  if(body.openingBalanceType)body.openingBalanceType=upper(body.openingBalanceType).startsWith("C")?"CR":"DR";
  if(body.regionType)body.regionType=upper(body.regionType)==="OUTSIDE"?"OUTSIDE":"LOCAL";
  if(body.portalLoginEnabled!==undefined){const v=upper(body.portalLoginEnabled);body.portalLoginEnabled=body.portalLoginEnabled===true||["TRUE","YES","1","ON"].includes(v);}
  return body;
}
function normalizeLegacyTransporter(body={}){
  if(cleanText(body.assignedTransport))return body;
  const legacy=parseBulkJsonArray(body.legacyAssignTransporter);
  const first=legacy[0]||{};
  if(first&&typeof first==="object")body.assignedTransport=cleanText(first._id?.$oid||first._id||first.id||first.companyName||first.name);
  delete body.legacyAssignTransporter;
  return body;
}
function normalizeCustomerBulkBody(source={},cols={}){
  const body={};
  for(const field of customerBulkFields){
    const value=valueFor(source,cols[field.key],field.type);
    if(value!==undefined&&value!=="")body[field.key]=value;
  }
  if(body.bankDetails)body.bankDetails=parseBulkJsonArray(body.bankDetails);
  normalizeLegacyTransporter(body);normalizeBulkEnumFields(body);
  body.aadhaar=body.ownerAadhaar||body.aadhaar||"";
  body.mobile=body.companyContactNumber||body.ownerMobile||body.mobile||"";
  if(!body.pan)body.pan=body.ownerPan||"";
  return body;
}
function normalizeCustomerBulkEditedBody(source={}){
  const body={};
  for(const field of customerBulkFields){
    let value=source?.[field.key];
    if(value===undefined||value===null||value==="")continue;
    if(field.key==="bankDetails"){const banks=parseBulkJsonArray(value);if(banks.length)body.bankDetails=banks;continue;}
    if(field.type==="number"){const n=Number(value);value=Number.isFinite(n)?n:0;}
    else if(typeof value==="boolean"){}else if(typeof value==="object"){body[field.key]=value;continue;}else value=String(value).trim();
    body[field.key]=value;
  }
  if(Array.isArray(source.bankDetails))body.bankDetails=source.bankDetails;
  normalizeLegacyTransporter(body);normalizeBulkEnumFields(body);
  body.aadhaar=body.ownerAadhaar||source.aadhaar||"";
  body.mobile=body.companyContactNumber||body.ownerMobile||source.mobile||"";
  if(!body.pan)body.pan=body.ownerPan||"";
  return body;
}
function validateCustomerBulkBody(body={}){
  const errors=[];
  if(!cleanText(body.legalName))errors.push("Company Name is required");
  if(!cleanText(body.gstin)&&!cleanText(body.pan)&&!cleanText(body.ownerPan)&&!digits(body.ownerAadhaar||body.aadhaar))errors.push("GSTIN, Company PAN, Owner PAN or Owner Aadhaar is required");
  return errors;
}

router.post("/bulk-preview",upload.single("file"),async(req,res)=>{
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);
  let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}
  if(!rows.length)return fail(res,"Uploaded file has no rows",400);
  const cols=customerBulkColumns(rows[0]);
  if(!cols.legalName)return fail(res,"Missing column: Customer Name / Legal Name",400);
  const previewRows=rows.map((source,index)=>{
    const body=normalizeCustomerBulkBody(source,cols);
    const errors=validateCustomerBulkBody(body);
    return {sourceRow:index+2,...body,_sourceData:source,_errors:errors};
  });
  const invalid=previewRows.filter(row=>row._errors.length).length;
  return ok(res,{received:previewRows.length,valid:previewRows.length-invalid,invalid,rows:previewRows},"Customer file parsed for review. Nothing has been imported yet.");
});

router.post("/bulk-commit",async(req,res)=>{
  const rows=Array.isArray(req.body?.rows)?req.body.rows:[];
  if(!rows.length)return fail(res,"No reviewed customer rows were supplied",400);
  if(rows.length>5000)return fail(res,"A maximum of 5000 customers can be imported at one time",400);
  let inserted=0,updated=0;const errors=[],rejectedRows=[];
  for(let index=0;index<rows.length;index++){
    const source=rows[index]||{};
    const body=normalizeCustomerBulkEditedBody(source);
    const validation=validateCustomerBulkBody(body);
    const sourceRow=Number(source.sourceRow||index+2);
    if(validation.length){
      const error=validation.join("; ");
      errors.push({row:sourceRow,error});
      rejectedRows.push({sourceRow,...body,_sourceData:source._sourceData||{},_errors:validation,error});
      continue;
    }
    try{
      const result=await upsertCustomerIdentity({tenantKey:req.auth.tenantKey,body,actorId:req.auth.sub,actorRole:req.auth.role,allowIncomplete:true});
      result.created?inserted++:updated++;
    }catch(e){
      const error=e.message||"Unable to import customer";
      errors.push({row:sourceRow,error});
      rejectedRows.push({sourceRow,...body,_sourceData:source._sourceData||{},_errors:[error],error});
    }
  }
  return ok(res,{received:rows.length,inserted,updated,invalid:errors.length,errors:errors.slice(0,200),rejectedRows},errors.length?"Customer import completed with rows requiring correction":"All reviewed customers were imported successfully");
});

router.post("/bulk-upload",upload.single("file"),async(req,res)=>{
  if(!req.file?.buffer)return fail(res,"Excel/CSV file is required",400);let rows;try{rows=readRows(req.file.buffer);}catch{return fail(res,"Unable to read Excel/CSV file",400);}if(!rows.length)return fail(res,"Uploaded file has no rows",400);
  const cols=customerBulkColumns(rows[0]);if(!cols.legalName)return fail(res,"Missing column: Customer Name / Legal Name",400);const errors=[];let inserted=0,updated=0;
  for(let i=0;i<rows.length;i++){const body=normalizeCustomerBulkBody(rows[i],cols);const validation=validateCustomerBulkBody(body);if(validation.length){if(errors.length<100)errors.push({row:i+2,error:validation.join("; ")});continue;}try{const result=await upsertCustomerIdentity({tenantKey:req.auth.tenantKey,body,actorId:req.auth.sub,actorRole:req.auth.role});result.created?inserted++:updated++;}catch(e){if(errors.length<100)errors.push({row:i+2,error:e.message});}}
  return ok(res,{received:rows.length,inserted,updated,invalid:errors.length,errors},"Customer bulk upload completed. Credit customers remain pending approval.");
});

router.post("/bulk-edit",async(req,res)=>{
  const ids=(req.body.selection?.ids||[]).filter(Boolean);if(!ids.length)return fail(res,"Select at least one customer",400);
  const allowed=["priceList","gradeCode"],changes={};
  for(const k of allowed)if(req.body.changes?.[k]!==undefined&&req.body.changes[k]!=="")changes[k]=req.body.changes[k];
  if(changes.gradeCode){const g=await CustomerGrade.findOne({tenantKey:req.auth.tenantKey,code:upper(changes.gradeCode),status:"ACTIVE"}).lean();if(!g)return fail(res,"Customer Grade not found",400);changes.gradeCode=g.code;changes.gradeDiscountPct=Number(g.discountPct||0);}
  if(!Object.keys(changes).length)return fail(res,"Bulk edit can safely change Grade or Price List. Salesperson assignment is controlled by the hierarchy pincode page. Sensitive credit/accounting fields require approval.",400);
  const filter={tenantKey:req.auth.tenantKey,globalCustomerId:{$in:ids},$or:[{systemManaged:{$ne:true}},{systemKey:{$ne:"CASH"}}]};await customerHierarchyFilter(req,filter);
  const result=await CustomerLink.updateMany(filter,{$set:changes});
  return ok(res,{matched:result.matchedCount,updated:result.modifiedCount},`${result.modifiedCount} customer(s) updated`);
});
router.post("/bulk-delete",async(req,res)=>{
  if(!canDelete(req))return fail(res,"Customer delete permission required",403);
  const ids=uniqueRefs(req.body.selection?.ids||[]);if(!ids.length)return fail(res,"Select at least one customer",400);
  const filter={tenantKey:req.auth.tenantKey,globalCustomerId:{$in:ids},status:{$ne:"DEACTIVATED"}};await customerHierarchyFilter(req,filter);
  const visible=await CustomerLink.find(filter).select("globalCustomerId localName partyType migration status systemManaged systemKey systemNote").lean();
  if(!visible.length)return ok(res,{requested:ids.length,deleted:0,protected:0,notVisible:ids.length,soft:true},"No active selected customers were available to delete");
  const outcome=await deactivateCustomerLinks(req,visible,"BULK_DEACTIVATED");
  const message=`${outcome.modifiedCount} customer(s) deleted from the active list${outcome.protectedRows.length?`; ${outcome.protectedRows.length} protected because they are used in transactions`:""}`;
  return ok(res,{requested:ids.length,deleted:outcome.modifiedCount,protected:outcome.protectedRows.length,protectedCustomers:outcome.protectedRows,notVisible:Math.max(0,ids.length-visible.length),soft:true},message);
});

router.post("/delete-all",async(req,res)=>{
  if(!canDelete(req))return fail(res,"Customer delete permission required",403);
  const filter={tenantKey:req.auth.tenantKey,status:{$ne:"DEACTIVATED"}};
  await customerHierarchyFilter(req,filter);
  const visible=await CustomerLink.find(filter).select("globalCustomerId localName partyType migration status systemManaged systemKey systemNote").lean();
  if(!visible.length)return ok(res,{requested:0,deleted:0,protected:0,soft:true},"No active customers to delete");
  const outcome=await deactivateCustomerLinks(req,visible,"DELETE_ALL_DEACTIVATED");
  const message=`${outcome.modifiedCount} customer(s) deleted from the active list${outcome.protectedRows.length?`; ${outcome.protectedRows.length} protected because they are used in transactions`:""}`;
  return ok(res,{requested:visible.length,deleted:outcome.modifiedCount,protected:outcome.protectedRows.length,protectedCustomers:outcome.protectedRows,soft:true},message);
});

router.get("/:globalId/360",async(req,res)=>{
  const pair=await resolveCustomerPair(req.auth.tenantKey,req.params.globalId);
  const global=pair.global?.toObject?pair.global.toObject():pair.global;const link=pair.link?.toObject?pair.link.toObject():pair.link;
  if(!global||!link)return fail(res,"Customer not found",404);if(!(await canSeeCustomer(req,link)))return fail(res,"Customer is outside your department hierarchy",403);
  let financial={sales:0,receipts:0,outstanding:0,orders:0,lastInvoice:null,lastReceipt:null};const fy=cleanText(req.query.financialYear);
  if(fy){const {SalesInvoice,Receipt,LedgerEntry}=financialModels(req.auth.tenantKey,fy);const [salesAgg,receiptAgg,ledgerAgg,lastInvoice,lastReceipt]=await Promise.all([
    SalesInvoice.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear:fy,customerGlobalId:req.params.globalId,status:"POSTED"}},{$group:{_id:null,total:{$sum:"$grandTotal"},count:{$sum:1}}}]),
    Receipt.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear:fy,customerGlobalId:req.params.globalId,status:"POSTED"}},{$group:{_id:null,total:{$sum:"$amount"}}}]),
    LedgerEntry.aggregate([{$match:{tenantKey:req.auth.tenantKey,financialYear:fy,partyGlobalId:req.params.globalId,accountCode:"SYS_SUNDRY_DEBTORS",status:"POSTED"}},{$group:{_id:null,debit:{$sum:"$debit"},credit:{$sum:"$credit"}}}]),
    SalesInvoice.findOne({tenantKey:req.auth.tenantKey,financialYear:fy,customerGlobalId:req.params.globalId,status:"POSTED"}).sort({date:-1}).select("date invoiceNo grandTotal").lean(),
    Receipt.findOne({tenantKey:req.auth.tenantKey,financialYear:fy,customerGlobalId:req.params.globalId,status:"POSTED"}).sort({date:-1}).select("date receiptNo amount").lean()
  ]);financial={sales:Number(salesAgg[0]?.total||0),orders:Number(salesAgg[0]?.count||0),receipts:Number(receiptAgg[0]?.total||0),outstanding:Number(ledgerAgg[0]?.debit||0)-Number(ledgerAgg[0]?.credit||0),lastInvoice,lastReceipt};}
  return ok(res,{global,company:link,financial});
});

router.get("/:globalId",async(req,res)=>{const pair=await resolveCustomerPair(req.auth.tenantKey,req.params.globalId);if(!pair.global||!pair.link)return fail(res,"Customer not found",404);if(!(await canSeeCustomer(req,pair.link)))return fail(res,"Customer is outside your department hierarchy",403);const global=pair.global.toObject?pair.global.toObject():pair.global;delete global.aadhaarHash;return ok(res,{global,company:pair.link});});

router.put("/:globalId",async(req,res)=>{
  if(!canEdit(req))return fail(res,"Customer edit permission required",403);const pair=await resolveCustomerPair(req.auth.tenantKey,req.params.globalId);const link=pair.link;const global=pair.global;if(!link)return fail(res,"Customer relationship not found",404);if(isSystemCashRecord(link))return fail(res,"CASH is a system-managed party and cannot be edited, assigned or deleted",409);if(!(await canSeeCustomer(req,link)))return fail(res,"Customer is outside your department hierarchy",403);const migrated=Boolean(link.migration?.legacyId);
  const normal=["localName","contacts","addresses","documents","verification","location"];
  for(const k of normal)if(req.body[k]!==undefined)link[k]=req.body[k];
  await applyPreviousDmsCustomerFields(link,req.body,{allowIncomplete:migrated});
  const assignmentPincode=cleanText(req.body.pincode||req.body.addresses?.[0]?.pincode||link.addresses?.[0]?.pincode).replace(/\D/g,"").slice(0,6);
  if(assignmentPincode){
    try{const assignment=await resolveCustomerSalesperson({tenantKey:req.auth.tenantKey,pincode:assignmentPincode,requestedUserId:req.body.salespersonId??link.salespersonId??"",requireAssignment:!migrated});if(assignment?.salespersonId)link.salespersonId=assignment.salespersonId;}
    catch(e){if(!migrated)throw e;}
  }
  if(!migrated)await validateCustomerTransportAssignment({tenantKey:req.auth.tenantKey,link});
  else{try{await validateCustomerTransportAssignment({tenantKey:req.auth.tenantKey,link});}catch(_){/* Previous-DMS profiles may be completed progressively. */}}
  const sensitive={};for(const k of ["paymentType","creditDays","creditLimit","graceDays","priceList","gradeCode","gradeDiscountPct","accountingProfile"])if(req.body[k]!==undefined)sensitive[k]=req.body[k];
  const identity={};for(const k of ["legalName","tradeName","gstin","pan","aadhaar","registeredAddress"])if(req.body[k]!==undefined&&req.body[k]!=="")identity[k]=req.body[k];
  const requestedChanges={...sensitive,...(Object.keys(identity).length?{identity}: {})};
  if(Object.keys(requestedChanges).length){
    if(link.status==="ACTIVE"&&!canApprove(req)){const requestId=makeId("CCR");link.changeRequests.push({requestId,requestedBy:req.auth.sub,requestedAt:new Date(),changes:requestedChanges,status:"PENDING"});link.approvalHistory.push({action:"CHANGE_REQUESTED",by:req.auth.sub,at:new Date(),changes:requestedChanges});await link.save();return ok(res,{customer:link,changeRequestId:requestId},"Normal details updated. Sensitive identity/commercial/accounting changes were sent for approval.");}
    if(Object.keys(identity).length)await applyGlobalIdentityChanges(link.globalCustomerId,identity);
    Object.assign(link,sensitive);if(link.paymentType==="CASH"){link.creditDays=0;link.creditLimit=0;link.graceDays=0;}
  }
  link.approvalHistory.push({action:"EDITED",by:req.auth.sub,at:new Date(),changes:req.body});await link.save();
  const missing=await refreshMigrationCompletion(link,global,req.auth.sub);
  return ok(res,{...link.toObject(),pendingProfileFields:missing},missing.length?`Customer updated. ${missing.length} profile field(s) can be completed later.`:"Customer updated");
});

router.post("/:globalId/assign-salesperson",async(req,res)=>{
  if(!canEdit(req))return fail(res,"Customer edit permission required",403);
  const link=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:req.params.globalId,status:{$ne:"DEACTIVATED"}});
  if(!link)return fail(res,"Customer relationship not found",404);
  if(isSystemCashRecord(link))return fail(res,"CASH is a system-managed party and cannot be assigned",409);
  const pincode=cleanText(req.body.pincode||link.addresses?.find?.(x=>upper(x?.type)==="BILLING")?.pincode||link.addresses?.[0]?.pincode).replace(/\D/g,"").slice(0,6);
  if(pincode.length!==6)return fail(res,"Customer does not have a valid 6-digit pincode",409);
  try{
    const assignment=await resolveCustomerSalesperson({tenantKey:req.auth.tenantKey,pincode,requestedUserId:req.body.salespersonId,requireAssignment:true});
    link.salespersonId=assignment.salespersonId;
    link.approvalHistory.push({action:"SALESPERSON_ASSIGNED",by:req.auth.sub,at:new Date(),changes:{pincode,salespersonId:assignment.salespersonId}});
    await link.save();
    return ok(res,{globalCustomerId:link.globalCustomerId,salespersonId:link.salespersonId,pincode},"Customer assigned to Sales Person");
  }catch(error){return fail(res,error.message,error.statusCode||409);}
});

router.post("/:globalId/submit",async(req,res)=>{
  const link=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:req.params.globalId});
  if(!link)return fail(res,"Customer relationship not found",404);
  if(!(await canSeeCustomer(req,link)))return fail(res,"Customer is outside your department hierarchy",403);
  const now=new Date(),remarks=cleanText(req.body.remarks);
  link.status="PENDING_APPROVAL";
  link.approval={status:"PENDING",submittedBy:req.auth.sub,submittedAt:now,remarks};
  link.approvalHistory.push({action:"SUBMITTED",by:req.auth.sub,at:now,remarks});
  await link.save();
  if(link.sourceLeadId){
    const lead=await Lead.findOne({tenantKey:req.auth.tenantKey,leadId:link.sourceLeadId});
    if(lead){
      lead.stage="PENDING_VERIFICATION";
      lead.conversion={...(lead.conversion?.toObject?.()||lead.conversion||{}),status:"PENDING_VERIFICATION",submittedAt:now,customerGlobalId:link.globalCustomerId,customerStatus:link.status,remarks};
      lead.activities.push({type:"CUSTOMER_RESUBMITTED",outcome:link.status,note:remarks||"Customer conversion resubmitted for approval",at:now,userId:req.auth.sub});
      lead.lastActivityAt=now;
      await lead.save();
    }
  }
  return ok(res,link,"Customer submitted for approval");
});

router.post("/:globalId/approval",async(req,res)=>{
  if(!canApprove(req))return fail(res,"Customer approval permission required",403);const link=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:req.params.globalId});if(!link)return fail(res,"Customer relationship not found",404);if(isSystemCashRecord(link))return fail(res,"CASH is system-managed and its status/accounting cannot be changed",409);const action=upper(req.body.action);
  if(!["APPROVE","APPROVE_WITH_CHANGES","SEND_BACK","REJECT","HOLD","BLOCK","ACTIVATE"].includes(action))return fail(res,"Invalid approval action",400);
  const remarks=cleanText(req.body.remarks);let changes={};
  if(["APPROVE","APPROVE_WITH_CHANGES"].includes(action)){
    const terms=normaliseTerms({...link.requestedTerms.toObject?.(),...link.requestedTerms,...req.body});link.paymentType=terms.paymentType;link.creditDays=terms.creditDays;link.creditLimit=terms.creditLimit;link.graceDays=terms.graceDays;link.priceList=terms.priceList;
    if(req.body.gradeCode!==undefined){const gc=upper(req.body.gradeCode);const g=gc?await CustomerGrade.findOne({tenantKey:req.auth.tenantKey,code:gc,status:"ACTIVE"}).lean():null;link.gradeCode=gc;link.gradeDiscountPct=Number(g?.discountPct??req.body.gradeDiscountPct??0);}
    else if(req.body.gradeDiscountPct!==undefined)link.gradeDiscountPct=Number(req.body.gradeDiscountPct||0);
    if(req.body.accountingProfile)link.accountingProfile={...link.accountingProfile.toObject?.(),...link.accountingProfile,...req.body.accountingProfile};
    link.approvedTerms={...terms,approvedBy:req.auth.sub,approvedAt:new Date()};link.status="ACTIVE";if(link.migration?.legacyId){link.migration.profileComplete=true;link.migration.verified=true;link.migration.status="VERIFIED";}link.approval={status:"APPROVED",submittedBy:link.approval?.submittedBy,submittedAt:link.approval?.submittedAt,reviewedBy:req.auth.sub,reviewedAt:new Date(),remarks,decision:action};changes={approvedTerms:terms,accountingProfile:link.accountingProfile};
    await link.save();await syncCustomerLedger(link);
  }else if(action==="SEND_BACK"){link.status="PENDING_APPROVAL";link.approval.status="SENT_BACK";link.approval.reviewedBy=req.auth.sub;link.approval.reviewedAt=new Date();link.approval.remarks=remarks;link.approval.decision=action;await link.save();}
  else if(action==="REJECT"){link.status="REJECTED";link.approval.status="REJECTED";link.approval.reviewedBy=req.auth.sub;link.approval.reviewedAt=new Date();link.approval.remarks=remarks;link.approval.decision=action;await link.save();}
  else if(action==="HOLD"){link.status="ON_HOLD";link.hold={reason:remarks,by:req.auth.sub,at:new Date()};link.approval.status="HOLD";await link.save();}
  else if(action==="BLOCK"){link.status="BLOCKED";link.hold={reason:remarks,by:req.auth.sub,at:new Date()};await link.save();}
  else if(action==="ACTIVATE"){link.status="ACTIVE";link.hold={};await link.save();}
  link.approvalHistory.push({action,by:req.auth.sub,at:new Date(),remarks,changes});await link.save();
  if(link.sourceLeadId){
    const lead=await Lead.findOne({tenantKey:req.auth.tenantKey,leadId:link.sourceLeadId});
    if(lead){
      const now=new Date();
      const conv={...(lead.conversion?.toObject?.()||lead.conversion||{}),customerGlobalId:link.globalCustomerId,customerStatus:link.status,remarks};
      if(["APPROVE","APPROVE_WITH_CHANGES","ACTIVATE"].includes(action)){
        lead.stage="CUSTOMER";conv.status="ACTIVE";conv.verifiedAt=now;conv.verifiedBy=req.auth.sub;
      }else if(action==="REJECT"){
        lead.stage="CONVERSION_IN_PROGRESS";conv.status="REJECTED";conv.rejectedAt=now;conv.rejectedBy=req.auth.sub;
      }else if(action==="SEND_BACK"){
        lead.stage="CONVERSION_IN_PROGRESS";conv.status="SENT_BACK";
      }else if(action==="HOLD"){
        lead.stage="PENDING_VERIFICATION";conv.status="HOLD";
      }else if(action==="BLOCK"){
        lead.stage="CONVERSION_IN_PROGRESS";conv.status="BLOCKED";
      }
      lead.conversion=conv;
      lead.activities.push({type:`CUSTOMER_${action}`,outcome:link.status,note:remarks,at:now,userId:req.auth.sub});
      lead.lastActivityAt=now;
      await lead.save();
    }
  }
  return ok(res,link,`Customer ${action.toLowerCase().replaceAll("_"," ")}`);
});

router.post("/:globalId/change-requests/:requestId/review",async(req,res)=>{if(!canApprove(req))return fail(res,"Customer approval permission required",403);const link=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:req.params.globalId});if(!link)return fail(res,"Customer not found",404);const cr=link.changeRequests.find(x=>x.requestId===req.params.requestId);if(!cr)return fail(res,"Change request not found",404);const action=upper(req.body.action);if(!["APPROVE","REJECT"].includes(action))return fail(res,"Action must be APPROVE or REJECT",400);if(action==="APPROVE"){const changes=cr.changes?.toObject?.()||cr.changes||{};if(changes.identity)await applyGlobalIdentityChanges(link.globalCustomerId,changes.identity);const localChanges={...changes};delete localChanges.identity;Object.assign(link,localChanges);if(link.paymentType==="CASH"){link.creditDays=0;link.creditLimit=0;link.graceDays=0;}if(localChanges.accountingProfile)await syncCustomerLedger(link);}cr.status=action==="APPROVE"?"APPROVED":"REJECTED";cr.reviewedBy=req.auth.sub;cr.reviewedAt=new Date();cr.remarks=cleanText(req.body.remarks);link.approvalHistory.push({action:`CHANGE_${cr.status}`,by:req.auth.sub,at:new Date(),remarks:cr.remarks,changes:cr.changes});await link.save();return ok(res,link,`Change request ${cr.status.toLowerCase()}`);});

router.delete("/:globalId",async(req,res)=>{
  if(!canDelete(req))return fail(res,"Customer delete permission required",403);
  const pair=await resolveCustomerPair(req.auth.tenantKey,req.params.globalId);const link=pair.link;
  if(!link)return fail(res,"Customer relationship not found",404);
  if(isSystemCashRecord(link))return fail(res,"CASH is a protected system party and cannot be deleted or deactivated",409);
  if(!(await canSeeCustomer(req,link)))return fail(res,"Customer is outside your department hierarchy",403);
  if(link.status==="DEACTIVATED")return ok(res,{deleted:0,alreadyDeleted:true,soft:true},"Customer is already deleted from the active list");
  const protectedIds=await protectedCustomerGlobalIds(req.auth.tenantKey,[link.toObject?link.toObject():link]);
  if(protectedIds.has(String(link.globalCustomerId)))return fail(res,`${link.localName||"Party"} (${link.partyType||"PARTY"}) is used in invoices, receipts, payments or ledger and is protected from deletion. Edit/deactivate transaction-independent fields instead.`,409);
  link.status="DEACTIVATED";
  link.approvalHistory.push({action:"DEACTIVATED",by:req.auth.sub,at:new Date(),remarks:cleanText(req.body?.remarks)});
  await link.save();
  return ok(res,{deleted:1,soft:true,customer:{globalCustomerId:link.globalCustomerId,localName:link.localName}},"Customer deleted from active list (safely deactivated).");
});

router.post("/:globalId/verify-gst",async(req,res)=>{const pair=await resolveCustomerPair(req.auth.tenantKey,req.params.globalId);const g=pair.global;if(!g)return fail(res,"Customer not found",404);const gstin=req.body.gstin||g.gstins[0]?.value;if(!gstin)return fail(res,"GSTIN not available");const[profile,filing]=await Promise.all([searchTaxpayer(gstin),getReturnFilingStatus(gstin)]);g.gstProfile={taxpayerType:profile.taxpayerType||profile.dty||"",constitution:profile.constitution||profile.ctb||"",registrationDate:profile.registrationDate||profile.rgdt||undefined,lastVerifiedAt:new Date(),filingStatus:filing.filingStatus||"UNKNOWN"};g.tradeName=profile.tradeName||profile.tradeNam||g.tradeName;g.registeredAddress=profile.principalAddress||profile.address||g.registeredAddress;const health=customerHealth({gstScore:(filing.filingStatus||"").toUpperCase().includes("REGULAR")?100:60,paymentScore:75,receiptScore:75,bounceScore:100,overdueScore:75,relationshipScore:60});g.globalHealth={...health,confidence:"MEDIUM",updatedAt:new Date()};await g.save();const link=pair.link;if(link){link.verification.identity=true;link.approvalHistory.push({action:"GST_VERIFIED",by:req.auth.sub,at:new Date()});await link.save();}return ok(res,{profile,filing,globalHealth:g.globalHealth},"GST verified");});

// Backward compatibility with earlier UI button.
router.post("/:globalId/approve",async(req,res)=>{req.body={...req.body,action:"APPROVE_WITH_CHANGES"};if(!canApprove(req))return fail(res,"Customer approval permission required",403);const link=await CustomerLink.findOne({tenantKey:req.auth.tenantKey,globalCustomerId:req.params.globalId});if(!link)return fail(res,"Customer relationship not found",404);const terms=normaliseTerms({...link.requestedTerms.toObject?.(),...link.requestedTerms,...req.body});link.paymentType=terms.paymentType;link.creditDays=terms.creditDays;link.creditLimit=terms.creditLimit;link.graceDays=terms.graceDays;link.priceList=terms.priceList;link.approvedTerms={...terms,approvedBy:req.auth.sub,approvedAt:new Date()};link.status="ACTIVE";if(link.migration?.legacyId){link.migration.profileComplete=true;link.migration.verified=true;link.migration.status="VERIFIED";}link.approval={...link.approval,status:"APPROVED",reviewedBy:req.auth.sub,reviewedAt:new Date(),decision:"APPROVE"};link.approvalHistory.push({action:"APPROVE",by:req.auth.sub,at:new Date(),changes:{approvedTerms:terms}});await link.save();await syncCustomerLedger(link);return ok(res,link,"Customer approved and accounting ledger linked");});

export default router;
