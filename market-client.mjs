import {createHash} from 'node:crypto';
const BASE='https://market.near.ai';
export const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export const digest=x=>createHash('sha256').update(x).digest('hex');
export class MarketError extends Error {constructor(status){super(`Marketplace HTTP ${status}; response details omitted`);this.status=status;}}
async function limitedBytes(response,max){
  const size=Number(response.headers?.get('content-length'));if(Number.isFinite(size)&&size>max)throw new Error('Marketplace response exceeds size limit');
  if(!response.body){const b=Buffer.from(await response.arrayBuffer());if(b.length>max)throw new Error('Marketplace response exceeds size limit');return b;}
  const parts=[];let length=0;
  for await(const part of response.body){length+=part.length;if(length>max)throw new Error('Marketplace response exceeds size limit');parts.push(Buffer.from(part));}
  return Buffer.concat(parts);
}
export class MarketClient {
  constructor({apiToken,fetchImpl=fetch}){if(!apiToken)throw new Error('Marketplace agent credential is required');this.apiToken=apiToken;this.fetchImpl=fetchImpl;}
  url(path){const url=new URL(path,BASE);if(url.origin!==BASE||!url.pathname.startsWith('/v1/')||url.username||url.password||url.hash)throw new Error('Marketplace URL is outside its allowed origin/path');return url;}
  async request(method,path,body,{raw=false,max=2097152}={}){
    const url=this.url(path);let r;
    try{r=await this.fetchImpl(url,{method,headers:{authorization:`Bearer ${this.apiToken}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new Error('Marketplace request failed or timed out');}
    if(!r.ok)throw new MarketError(r.status);
    const bytes=await limitedBytes(r,max);if(raw)return bytes;
    try{return bytes.length?JSON.parse(bytes.toString('utf8')):{};}catch{throw new Error('Marketplace returned invalid JSON');}
  }
  async assignments(){const all=[];for(let offset=0;offset<1000;offset+=100){const r=await this.request('GET',`/v1/agents/me/assignments?status=all&limit=100&offset=${offset}`);if(!Array.isArray(r.assignments))throw new Error('Invalid assignment list');all.push(...r.assignments);if(r.assignments.length<100)return all;}throw new Error('Assignment pagination limit reached; operator review required');}
  async messages(id){if(!uuid(id))throw new Error('Invalid assignment ID');const all=[];for(let offset=0;offset<1000;offset+=100){const r=await this.request('GET',`/v1/assignments/${id}/messages?limit=100&offset=${offset}`);if(!Array.isArray(r.messages))throw new Error('Invalid message list');all.push(...r.messages);if(r.messages.length<100)return all;}throw new Error('Message pagination limit reached');}
  async attachment(jobId,file){
    if(!uuid(jobId)||!uuid(file.id)||!Number.isInteger(file.byteSize)||file.byteSize<1||file.byteSize>2097152||!/^[a-f0-9]{64}$/i.test(file.sha256??''))throw new Error('Attachment metadata is invalid or file exceeds 2 MiB');
    // Build the documented party-scoped path; never follow a buyer-supplied URL.
    const bytes=await this.request('GET',`/v1/jobs/${jobId}/attachments/${file.id}/raw`,undefined,{raw:true,max:2097152});
    if(bytes.length!==file.byteSize||digest(bytes)!==file.sha256.toLowerCase())throw new Error('Attachment checksum or size mismatch');
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('Attachment must be valid UTF-8 text');}
  }
  async start(id){if(!uuid(id))throw new Error('Invalid assignment ID');return this.request('POST',`/v1/assignments/${id}/start`);}
  async message(id,body){if(!uuid(id)||body.length>4000)throw new Error('Invalid assignment message');return this.request('POST',`/v1/assignments/${id}/messages`,{body,clientRequestId:`route-${digest(id+'|'+body)}`});}
  async submit(id,markdown,files=[]){if(!uuid(id)||!markdown||Buffer.byteLength(markdown)>262144)throw new Error('Invalid deliverable');return this.request('POST',`/v1/assignments/${id}/submit`,{deliverableMarkdown:markdown,files});}
  async reconcile(id,markdown){
    const response=await this.request('GET',`/v1/assignments/${id}/deliverable/versions`),last=response.versions?.at(-1);
    if(!last?.deliverableUrl)return false;
    const url=this.url(last.deliverableUrl);
    if(!url.pathname.startsWith(`/v1/assignments/${id}/deliverable/`))return false;
    const bytes=await this.request('GET',url.href,undefined,{raw:true,max:262144});return bytes.toString('utf8')===markdown;
  }
  async uploadCsv(text,onReserved){
    const bytes=Buffer.from(text,'utf8');
    const receipt=await this.request('POST','/v1/files',{filename:'schedule.csv',byteSize:bytes.length,link:false});
    if(!uuid(receipt.fileId))throw new Error('Invalid upload receipt');
    await onReserved(receipt.fileId);
    const url=new URL(receipt.directUploadUrl);let response;
    // The authenticated reserve API currently returns this storage origin. Fail closed on a change.
    if(url.protocol!=='https:'||url.origin!=='https://t3.storageapi.dev'||url.username||url.password||url.hash)throw new Error('Unrecognized upload storage origin; operator review required');
    // Follow the documented direct PUT flow: bytes only, never the agent bearer or extra headers.
    try{response=await this.fetchImpl(url,{method:'PUT',body:bytes,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new Error('File upload failed or timed out');}
    if(!response.ok)throw new MarketError(response.status);
    const completed=await this.request('POST',`/v1/files/${receipt.fileId}/complete`);
    if(completed.fileId!==receipt.fileId||completed.byteSize!==bytes.length||completed.sha256!==digest(bytes))throw new Error('Completed upload checksum or size mismatch');
    return receipt.fileId;
  }
}
