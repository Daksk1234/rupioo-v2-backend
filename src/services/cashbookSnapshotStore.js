import { randomUUID } from 'node:crypto';

// A summary and its month pages share one short-lived read snapshot. Refresh
// always creates a new snapshot. Every API mutation invalidates that tenant,
// including a backdated posting, failed partial import, or opening correction.
export function createCashbookSnapshotStore({ttl=60000,maxEntries=32,maxRows=100000,now=Date.now}={}) {
  const entries=new Map(),pending=new Set();
  const removeExpired=()=>{for(const [id,s] of entries)if(s.until<=now())entries.delete(id);};
  const invalidate=tenantKey=>{
    for(const [id,s] of entries)if(s.tenantKey===tenantKey)entries.delete(id);
    for(const task of pending)if(task.tenantKey===tenantKey)task.invalidated=true;
  };
  const read=(id,tenantKey,financialYear)=>{
    removeExpired();const item=entries.get(id);
    return item?.tenantKey===tenantKey&&item.financialYear===financialYear?item.value:null;
  };
  const build=async(tenantKey,financialYear,loader)=>{
    const task={tenantKey,invalidated:false};pending.add(task);
    try{
      const value=await loader();removeExpired();
      const count=value.adjusted?.rows?.length||0;
      if(task.invalidated||count>maxRows)return {...value,snapshotId:''};
      let totalRows=[...entries.values()].reduce((n,x)=>n+x.count,0);
      while(entries.size>=maxEntries||totalRows+count>maxRows){
        const first=entries.keys().next().value;if(!first)break;
        totalRows-=entries.get(first).count;entries.delete(first);
      }
      const snapshotId=randomUUID(),snapshot={...value,snapshotId};
      entries.set(snapshotId,{tenantKey,financialYear,count,until:now()+ttl,value:snapshot});
      return snapshot;
    }finally{pending.delete(task);}
  };
  return {read,build,invalidate};
}

export const cashbookSnapshots=createCashbookSnapshotStore();
export function invalidateCashbookAfterMutation(req,res,next) {
  if(!['GET','HEAD','OPTIONS'].includes(req.method))res.on('finish',()=>{
    if(req.auth?.tenantKey)cashbookSnapshots.invalidate(req.auth.tenantKey);
  });
  next();
}
