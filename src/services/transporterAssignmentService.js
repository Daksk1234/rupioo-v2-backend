import crypto from "node:crypto";
import { Transporter, GlobalTransporterMaster, GlobalTransporterStation, Pincode, CustomerLink } from "../models/index.js";

const clean=v=>String(v??"").trim();
const upper=v=>clean(v).toUpperCase();
const oid=v=>/^[a-fA-F0-9]{24}$/.test(clean(v));
const exact=v=>new RegExp(`^${clean(v).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}$`,"i");
const digits=v=>clean(v).replace(/\D/g,"").slice(0,6);
const stationIdFor=(globalId,name,pincode)=>`GTS-${crypto.createHash("sha1").update(`${globalId}|${clean(name).toLowerCase()}|${digits(pincode)}`).digest("hex").slice(0,12).toUpperCase()}`;
const globalKeyFor=(name,mobile="",address="")=>crypto.createHash("sha1").update(`${clean(name).toLowerCase()}|${clean(mobile)}|${clean(address).toLowerCase()}`).digest("hex");
const globalIdFor=key=>`GTR-${key.slice(0,12).toUpperCase()}`;

async function geoFromPincode(pincode){
  const pin=digits(pincode);if(pin.length!==6)return {pincode:pin};
  const row=await Pincode.findOne({pincode:pin,status:{$ne:"INACTIVE"}}).sort({area:1}).lean();
  return {pincode:pin,area:clean(row?.area),city:clean(row?.city||row?.area),district:clean(row?.district),state:clean(row?.state)};
}

export async function resolveCompanyTransporter({tenantKey,ref="",globalTransporterId="",name=""}={}){
  const value=clean(ref),gid=clean(globalTransporterId),label=clean(name||(!oid(value)?value:""));
  const ors=[];
  if(oid(value))ors.push({_id:value});
  if(value)ors.push({"migration.legacyId":value});
  if(gid)ors.push({globalTransporterId:gid});
  if(label)ors.push({name:exact(label)});
  if(!ors.length)return null;
  return Transporter.findOne({tenantKey,status:{$ne:"INACTIVE"},$or:ors}).lean();
}

function embeddedLegacyTransporter(customer={}){
  const raw=customer?.migration?.sourceData||{};
  const item=Array.isArray(raw?.assignTransporter)?raw.assignTransporter[0]:null;
  if(item&&typeof item==="object")return item;
  return null;
}

export async function ensureLegacyCustomerTransporter({tenantKey,customer,saveCustomer=true}={}){
  if(!customer)return {transporter:null,bookingStation:null};
  let transporter=await resolveCompanyTransporter({tenantKey,ref:customer.assignedTransport,globalTransporterId:customer.assignedTransportGlobalId});
  if(transporter){
    if(saveCustomer&&(String(customer.assignedTransport||"")!==String(transporter._id)||(!customer.assignedTransportGlobalId&&transporter.globalTransporterId))){
      await CustomerLink.updateOne({_id:customer._id,tenantKey},{$set:{assignedTransport:String(transporter._id),...(transporter.globalTransporterId?{assignedTransportGlobalId:transporter.globalTransporterId}:{})}}).catch(()=>{});
      customer.assignedTransport=String(transporter._id);if(transporter.globalTransporterId)customer.assignedTransportGlobalId=transporter.globalTransporterId;
    }
    return {transporter,bookingStation:null};
  }

  if(!customer?.migration?.legacyId)return {transporter:null,bookingStation:null};
  const embedded=embeddedLegacyTransporter(customer);
  const legacyName=clean(customer.assignedTransport||embedded?.companyName||embedded?.name);
  if(!legacyName)return {transporter:null,bookingStation:null};

  const address=clean(embedded?.address1||embedded?.address||embedded?.registeredAddress);
  const pincode=digits(embedded?.pincode);
  const phone=clean(embedded?.contactNumber||embedded?.mobileNumber||embedded?.mobile);
  const email=clean(embedded?.email).toLowerCase();
  const geo=await geoFromPincode(pincode);

  let global=await GlobalTransporterMaster.findOne({status:"ACTIVE",name:exact(legacyName)});
  if(!global){
    const key=globalKeyFor(legacyName,phone,address),gid=globalIdFor(key);
    global=await GlobalTransporterMaster.findOne({$or:[{globalTransporterId:gid},{masterKey:key}]});
    if(!global)global=new GlobalTransporterMaster({masterKey:key,globalTransporterId:gid});
    global.name=legacyName;global.address=address;global.pincode=pincode;global.mobile=phone;global.email=email;global.status="ACTIVE";global.sourceName="Previous DMS Migration";await global.save();
  }

  let bookingStation=null;
  if(address||pincode||geo.city){
    const stationName=clean(embedded?.city||geo.city||legacyName),stationId=stationIdFor(global.globalTransporterId,stationName,pincode);
    bookingStation=await GlobalTransporterStation.findOneAndUpdate({stationId},{$set:{stationId,globalTransporterId:global.globalTransporterId,name:stationName,stationType:"BOOKING",address,pincode,area:geo.area||"",city:clean(embedded?.city||geo.city),district:geo.district||"",state:clean(embedded?.state||geo.state),contacts:(phone||email)?[{name:clean(embedded?.contactPerson||embedded?.ownerName),designation:"",phone,email,active:true}]:[],servicePincodes:[pincode].filter(Boolean),serviceCities:[clean(embedded?.city||geo.city)].filter(Boolean),serviceStates:[clean(embedded?.state||geo.state)].filter(Boolean),status:"ACTIVE"}},{upsert:true,new:true,setDefaultsOnInsert:true}).lean();
  }

  const stations=bookingStation?[{name:bookingStation.name,type:"BOOKING",address:bookingStation.address,pincode:bookingStation.pincode,contacts:bookingStation.contacts||[]}]:[];
  let local=await Transporter.findOne({tenantKey,status:{$ne:"INACTIVE"},$or:[{globalTransporterId:global.globalTransporterId},{name:exact(legacyName)}]});
  if(!local)local=new Transporter({tenantKey,name:legacyName,status:"ACTIVE"});
  local.name=legacyName;local.globalTransporterId=global.globalTransporterId;local.gstin=upper(embedded?.gstNumber||embedded?.gstin);local.pan=upper(embedded?.panNo||embedded?.pan);if(stations.length)local.stations=stations;local.status="ACTIVE";await local.save();
  transporter=local.toObject();

  if(saveCustomer){
    const set={assignedTransport:String(local._id),assignedTransportGlobalId:global.globalTransporterId};
    if(bookingStation&&!customer.assignedTransportBookingStationId)set.assignedTransportBookingStationId=bookingStation.stationId;
    await CustomerLink.updateOne({_id:customer._id,tenantKey},{$set:set}).catch(()=>{});
    Object.assign(customer,set);
  }
  return {transporter,bookingStation};
}
