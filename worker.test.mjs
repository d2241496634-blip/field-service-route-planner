import test from 'node:test';
import assert from 'node:assert/strict';
import {AssignmentWorker,chooseFiles} from './worker.mjs';
import {MarketClient,digest} from './market-client.mjs';
const id='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const files={
  'request.json':JSON.stringify({startDate:'2026-10-19',endDate:'2026-10-19',timezone:'America/New_York',countryCode:'us',mapProcessingConsent:true}),
  'jobs.csv':'id,date,address,duration,windowStart,windowEnd,skills\nj,2026-10-19,Some Street 1,30,09:00,17:00,general',
  'crews.csv':'id,date,address,start,end,skills\nc,2026-10-19,Some Street 1,08:00,17:00,general',
  'customers.csv':'id,address,duration,skills,doNotContact,optOut\nx,Some Street 1,30,general,true,false'
};
const attachments=Object.entries(files).map(([filename,text],i)=>({filename,id:`33333333-3333-4333-8333-33333333333${i}`,sha256:digest(text),byteSize:Buffer.byteLength(text),createdAt:'2026-10-16T00:00:00Z'}));
function environment(){
  const state=new Map(),calls=[];
  const store={get:async(k,f=null)=>state.has(k)?structuredClone(state.get(k)):f,set:async(k,v)=>{state.set(k,structuredClone(v));}};
  const row={assignment:{assignmentId:id,jobId,status:'in_progress',escrowAmount:'10',escrowToken:'USDC',slaDeadlineAt:'2099-01-01T00:00:00Z',startedAt:null,submittedAt:null},job:{jobId,jobKind:'instant',attachments},latestMessage:null};
  const client={assignments:async()=>[structuredClone(row)],messages:async()=>[],attachment:async(j,a)=>files[a.filename],start:async()=>calls.push('start'),message:async()=>calls.push('message'),uploadCsv:async(text,onReserved)=>{calls.push('upload');await onReserved('44444444-4444-4444-8444-444444444444');return '44444444-4444-4444-8444-444444444444';},submit:async()=>{calls.push('submit');row.assignment.status='submitted';row.assignment.submittedAt='2026-10-16T01:00:00Z';},reconcile:async()=>false};
  const build=async()=>{calls.push('build');return {report:'# Valid test report',scheduleCsv:'id\n1'};};
  return {state,store,row,client,build,calls,mapsFactory:()=>({}),config:{processInstantHires:true}};
}
test('observe mode, standard bounty and non-USDC work cause no external writes',async()=>{
  for(const change of ['observe','standard','USD']){
    const e=environment();if(change==='observe')e.config.processInstantHires=false;else if(change==='standard')e.row.job.jobKind='standard';else e.row.assignment.escrowToken='USD';
    await new AssignmentWorker(e).tick();assert.deepEqual(e.calls,[]);assert.equal(e.state.get(`assignment-${id}`).phase,'operator_review');
  }
});
test('funded instant hire starts before map compute and uploads/submits once across repeated polls',async()=>{
  const e=environment(),w=new AssignmentWorker(e);await w.tick();await w.tick();assert.deepEqual(e.calls,['start','message','build','upload','submit']);assert.equal(e.state.get(`assignment-${id}`).phase,'submitted');
});
test('submission timeout is reconciled across restart and never blindly submitted twice',async()=>{
  const e=environment();e.client.submit=async()=>{e.calls.push('submit');throw new Error('timeout');};
  await new AssignmentWorker(e).tick();assert.equal(e.state.get(`assignment-${id}`).phase,'submit_pending');
  await new AssignmentWorker(e).tick();assert.equal(e.calls.filter(x=>x==='submit').length,1);
  e.client.reconcile=async()=>true;e.row.assignment.status='submitted';await new AssignmentWorker(e).tick();assert.equal(e.state.get(`assignment-${id}`).phase,'submitted');
});
test('upload timeout leaves a durable receipt for review and never reserves a duplicate file',async()=>{
  const e=environment();e.client.uploadCsv=async(text,onReserved)=>{e.calls.push('upload');await onReserved('44444444-4444-4444-8444-444444444444');throw new Error('timeout');};
  await new AssignmentWorker(e).tick();await new AssignmentWorker(e).tick();assert.equal(e.calls.filter(x=>x==='upload').length,1);assert.ok(e.state.get(`assignment-${id}`).fileId);
});
test('cancellation during compute prevents upload and submission',async()=>{
  const e=environment();e.build=async()=>{e.row.assignment.status='cancelled';return {report:'# Test',scheduleCsv:'id\n1'};};await new AssignmentWorker(e).tick();assert.ok(!e.calls.includes('upload'));assert.ok(!e.calls.includes('submit'));
});
test('request changes without new input is held for review rather than resending the same output',async()=>{
  const e=environment();await new AssignmentWorker(e).tick();e.row.assignment.status='in_progress';e.row.assignment.startedAt='2026-10-16T00:00:00Z';await new AssignmentWorker(e).tick();assert.equal(e.calls.filter(x=>x==='submit').length,1);assert.match(e.state.get(`assignment-${id}`).note,/Revision/);
});
test('missing or conflicting attachments are rejected without starting compute',async()=>{
  const e=environment();e.row.job.attachments=[];await new AssignmentWorker(e).tick();assert.ok(!e.calls.includes('start'));assert.ok(!e.calls.includes('build'));
  assert.throws(()=>chooseFiles([...attachments,{...attachments[0],sha256:'other'}]),/Conflicting/);
});
test('market client keeps auth on its origin, validates downloaded bytes and uses message idempotency',async()=>{
  const calls=[],text=files['jobs.csv'];const client=new MarketClient({apiToken:'SECRET_TEST',fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(options.method==='GET'?text:'{}',{status:200});}});
  await assert.rejects(()=>client.request('GET','https://evil.example/v1/steal'),/origin/);assert.equal(calls.length,0);
  assert.equal(await client.attachment(jobId,attachments[1]),text);
  await assert.rejects(()=>client.attachment(jobId,{...attachments[1],sha256:'a'.repeat(64)}),/checksum/);
  await client.message(id,'Planning your schedule');await client.message(id,'Planning your schedule');assert.equal(calls.at(-1).options.body,calls.at(-2).options.body);assert.match(calls.at(-1).options.body,/clientRequestId/);assert.equal(calls.at(-1).options.redirect,'error');
});
test('market file upload uses private attachment, verifies stored checksum and never sends auth to storage',async()=>{
  const calls=[],fileId='44444444-4444-4444-8444-444444444444';
  const client=new MarketClient({apiToken:'SECRET_TEST',fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(url.pathname==='/v1/files'?{fileId,directUploadUrl:'https://t3.storageapi.dev/test-only'}:{fileId,byteSize:4,sha256:digest('id\n1')}),{status:200});}});
  let recorded;await client.uploadCsv('id\n1',async id=>{recorded=id;});assert.equal(recorded,fileId);assert.equal(JSON.parse(calls[0].options.body).link,false);assert.equal(calls[1].options.headers,undefined);
});
