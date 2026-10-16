import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {JsonStore,QuotaLedger,QuotaExceeded,exclusiveLease} from './storage.mjs';
import {MarketClient,digest,uuid} from './market-client.mjs';
import {MapsService} from './maps-service.mjs';
import {readRequest,buildSchedule} from './pipeline.mjs';

export const INPUT_NAMES=['request.json','jobs.csv','crews.csv','customers.csv'];
const manualNote='This assignment requires operator review; it has not been automatically started or submitted.';
export function chooseFiles(attachments){
  const files=new Map();
  for(const a of [...attachments].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)))){
    const name=String(a.filename??'').toLowerCase();
    if(!INPUT_NAMES.includes(name))continue;
    const old=files.get(name);
    if(old&&old.createdAt===a.createdAt&&old.sha256!==a.sha256)throw new Error(`Conflicting versions of ${name}; upload one unambiguous latest version`);
    files.set(name,a);
  }
  const missing=INPUT_NAMES.filter(n=>!files.has(n));if(missing.length)throw new Error(`Please attach ${missing.join(', ')}. Use the listing templates, including planning dates, timezone and Geoapify processing agreement in request.json.`);
  return Object.fromEntries(files);
}
export class AssignmentWorker {
  constructor({client,store,mapsFactory,build=buildSchedule,config={},now=()=>Date.now()}){Object.assign(this,{client,store,mapsFactory,build,config,now});}
  async tick(){
    const rows=await this.client.assignments(),summary=[];
    for(const row of rows){
      const a=row.assignment,id=a?.assignmentId;
      if(!uuid(id)||!uuid(a.jobId)||row.job?.jobId!==a.jobId)throw new Error('Marketplace assignment identity mismatch');
      const key=`assignment-${id}`;let state=await this.store.get(key,{assignmentId:id,jobId:a.jobId,phase:'new'});
      const save=async()=>this.store.set(key,state);
      if(state.phase==='submit_pending'){
        try{if(await this.client.reconcile(id,state.deliverable)){state.phase='submitted';state.confirmedAt=new Date(this.now()).toISOString();await save();}}
        catch{state.lastError='Submission confirmation unavailable; no automatic resubmission';await save();}
        if(state.phase==='submit_pending'){summary.push({id,phase:state.phase});continue;}
      }
      if(a.status!=='in_progress'){
        state.remoteStatus=a.status;state.lastSeenAt=new Date(this.now()).toISOString();await save();summary.push({id,phase:a.status});continue;
      }
      if(!this.config.processInstantHires||row.job.jobKind!=='instant'||(this.config.manualJobIds??[]).includes(a.jobId)||a.escrowToken!=='USDC'||!Number.isFinite(Number(a.escrowAmount))||Number(a.escrowAmount)<=0){
        state.phase='operator_review';state.note=manualNote;await save();summary.push({id,phase:state.phase});continue;
      }
      if(state.phase==='upload_pending'||state.phase==='submitted'&&!a.submittedAt){summary.push({id,phase:'operator_review'});continue;}
      if(state.retryAfter&&state.retryAfter>this.now()){summary.push({id,phase:state.phase});continue;}
      if(!Number.isFinite(Date.parse(a.slaDeadlineAt))||Date.parse(a.slaDeadlineAt)<=this.now()){state.phase='operator_review';state.note='Delivery deadline is invalid or has passed; inspect the assignment before proceeding';await save();summary.push({id,phase:state.phase});continue;}
      try{
        const messages=await this.client.messages(id);
        // senderAgentId excludes our own uploads; all files remain scoped to this job.
        const files=chooseFiles([...(row.job.attachments??[]),...messages.filter(m=>!m.senderAgentId).flatMap(m=>m.attachments??[])]);
        const fingerprint=digest(JSON.stringify(INPUT_NAMES.map(n=>[n,files[n].id,files[n].sha256])));
        if(a.submittedAt&&state.inputFingerprint===fingerprint){state.phase='operator_review';state.note='Revision requested without changed input files; inspect buyer feedback';await save();summary.push({id,phase:state.phase});continue;}
        if(state.inputFingerprint!==fingerprint){state={assignmentId:id,jobId:a.jobId,phase:'reading',inputFingerprint:fingerprint};await save();}
        const text={};for(const n of INPUT_NAMES)text[n]=await this.client.attachment(a.jobId,files[n]);
        const request={config:JSON.parse(text['request.json']),jobsCsv:text['jobs.csv'],crewsCsv:text['crews.csv'],customersCsv:text['customers.csv']};
        const checked=readRequest(request);
        if(!a.startedAt)await this.client.start(id);
        await this.client.message(id,`Planning ${checked.config.startDate} through ${checked.config.endDate} in ${checked.config.timezone}: ${checked.jobs.length} jobs, ${checked.crews.length} crew-day rows, ${checked.customers.length} customer records. Necessary addresses/coordinates go to Geoapify under the provided agreement. Customer outreach will be drafts only.`);
        state.phase='planning';await save();
        const output=await this.build(request,this.mapsFactory(id));
        state.deliverable=output.report;state.scheduleCsv=output.scheduleCsv;state.phase='prepared';await save();
        // Read fresh authoritative state immediately before an external delivery.
        const fresh=(await this.client.assignments()).find(r=>r.assignment.assignmentId===id);
        if(!fresh||fresh.assignment.status!=='in_progress'||fresh.assignment.slaDeadlineAt!==a.slaDeadlineAt){state.phase='operator_review';state.note='Assignment changed while planning; output retained for review';await save();summary.push({id,phase:state.phase});continue;}
        state.phase='upload_pending';await save();
        state.fileId=await this.client.uploadCsv(output.scheduleCsv,async fileId=>{state.fileId=fileId;await save();});
        state.phase='submit_pending';state.attemptedAt=new Date(this.now()).toISOString();await save();
        await this.client.submit(id,state.deliverable,[state.fileId]);
        state.phase='submitted';state.confirmedAt=new Date(this.now()).toISOString();await save();
      }catch(e){
        state.lastError=['upload_pending','submit_pending'].includes(state.phase)?'External delivery outcome needs reconciliation; no automatic duplicate attempt':e instanceof SyntaxError?'Invalid request.json':String(e.message).slice(0,400);
        if(!['upload_pending','submit_pending'].includes(state.phase)){
          state.phase=e instanceof QuotaExceeded?'waiting_for_quota':'needs_review';
          state.retryAfter=this.now()+(e instanceof QuotaExceeded?1800000:300000);
        }
        await save();
      }
      summary.push({id,phase:state.phase});
    }
    await this.store.set('heartbeat',{checkedAt:new Date(this.now()).toISOString(),mode:this.config.processInstantHires?'process-instant-usdc':'observe',assignments:summary});return summary;
  }
}

export async function runWorker(stateDirectory,configFile,{once=false}={}){
  const release=await exclusiveLease(stateDirectory),store=new JsonStore(stateDirectory);
  try{
    const config=JSON.parse(await readFile(configFile,'utf8'));
    const client=new MarketClient({apiToken:process.env.AGENT_API_TOKEN}),quota=new QuotaLedger(store);
    const worker=new AssignmentWorker({client,store,config,mapsFactory:id=>new MapsService({apiKey:process.env.GEOAPIFY_API_KEY,quota,cache:new JsonStore(path.join(stateDirectory,'buyer-data',id))})});
    let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
    do{
      try{const assignments=await worker.tick();console.log(JSON.stringify({at:new Date().toISOString(),checked:true,assignments}));}
      catch{await store.set('heartbeat-error',{at:new Date().toISOString(),error:'Marketplace polling failed; next cycle will retry'});console.error('Marketplace polling failed; next cycle will retry');}
      if(once||stop)break;
      // A STOP marker is data controlled by the local operator, not by buyers.
      if(await store.get('stop',false))break;
      await new Promise(r=>setTimeout(r,60000));
      if(await store.get('stop',false))break;
    }while(!stop);
  }finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length<4){console.error('Usage: node worker.mjs STATE_DIRECTORY CONFIG_JSON [--once]');process.exitCode=1;}
  else try{await runWorker(process.argv[2],process.argv[3],{once:process.argv.includes('--once')});}catch(e){console.error(e.message);process.exitCode=1;}
}
