import {mkdir,readFile,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

/** Caller uses one exclusive process lease for this directory. No untrusted path segments. */
export class JsonStore {
  constructor(root){this.root=path.resolve(root);}
  file(key){if(!/^[a-zA-Z0-9_-]{1,160}$/.test(key))throw new Error('Invalid storage key');return path.join(this.root,`${key}.json`);}
  async get(key,fallback=null){try{return JSON.parse(await readFile(this.file(key),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw new Error('Persistent state is unreadable; operator review required');}}
  async set(key,value){
    await mkdir(this.root,{recursive:true});
    const file=this.file(key),temp=`${file}.${randomUUID()}.tmp`;
    const handle=await open(temp,'wx');
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    await rename(temp,file);
  }
}
export async function exclusiveLease(root){
  await mkdir(root,{recursive:true});const file=path.join(root,'process.lock');
  let handle;
  try{handle=await open(file,'wx');}catch(e){if(e.code==='EEXIST')throw new Error('Process lock exists. Confirm its recorded process has stopped before removing the lock.');throw e;}
  await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await handle.sync();
  return async()=>{await handle.close();await unlink(file);};
}

export class QuotaExceeded extends Error {constructor(){super('Map budget is reserved or exhausted; wait for rolling 24-hour reservations to expire');this.name='QuotaExceeded';}}
/** Serialized, write-ahead reservations survive failures/restarts. No automatic financial upgrade. */
export class QuotaLedger {
  constructor(store,{limit=2000,maxRequests=400,now=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),spacingMs=1100}={}){
    if(!Number.isInteger(limit)||limit<1||limit>2000)throw new Error('Map credit limit must be 1–2,000');
    this.store=store;this.limit=limit;this.maxRequests=maxRequests;this.now=now;this.sleep=sleep;this.spacingMs=spacingMs;this.tail=Promise.resolve();
  }
  reserve(credits){const work=this.tail.then(()=>this._reserve(credits));this.tail=work.catch(()=>{});return work;}
  async _reserve(credits){
    if(!Number.isInteger(credits)||credits<1)throw new Error('Invalid quota reservation');
    const state=await this.store.get('geo-quota',{entries:[],lastRequestAt:0});
    if(state.frozen)throw new Error('Map quota frozen after an unexpected provider cost; operator review required');
    state.entries=state.entries.filter(e=>e.at>this.now()-86400000);
    if(state.entries.length>=this.maxRequests||state.entries.reduce((s,e)=>s+e.credits,0)+credits>this.limit)throw new QuotaExceeded();
    const wait=Math.max(0,state.lastRequestAt+this.spacingMs-this.now());if(wait)await this.sleep(wait);
    const entry={id:randomUUID(),at:this.now(),credits,status:'reserved'};
    state.entries.push(entry);state.lastRequestAt=entry.at;
    await this.store.set('geo-quota',state);return entry.id;
  }
  settle(id,credits){const work=this.tail.then(async()=>{
    if(!Number.isInteger(credits)||credits<0)throw new Error('Invalid settled credit cost');
    const state=await this.store.get('geo-quota'),entry=state?.entries.find(e=>e.id===id);
    if(!entry)throw new Error('Quota reservation missing');
    if(entry.status!=='reserved')throw new Error('Quota reservation already settled');
    const unexpected=credits>entry.credits;
    entry.credits=credits;entry.status='completed';if(unexpected)state.frozen=true;
    await this.store.set('geo-quota',state);
    if(unexpected)throw new Error('Provider cost exceeded reserved margin; further map calls frozen');
  });this.tail=work.catch(()=>{});return work;}
}
