import {mkdir,readFile,writeFile,open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {JsonStore,QuotaLedger,exclusiveLease} from './storage.mjs';
import {MapsService} from './maps-service.mjs';
import {fixture} from './fixtures.mjs';
import {plan,markdownReport} from './planner.mjs';
import {scheduleCsv} from './csv.mjs';

// Public geographic points in central Berlin. No user/customer locations are sent.
const points={A:[13.3777,52.5163],B:[13.3695,52.5251],C:[13.4132,52.5219],D:[13.3762,52.5096],E:[13.3762,52.5186]};
const stateDir=new URL('./state/',import.meta.url),examples=new URL('./examples/',import.meta.url);
await mkdir(stateDir,{recursive:true});await mkdir(examples,{recursive:true});
const lockPath=new URL('road-demo.lock',stateDir);
let lock;
try {lock=await open(lockPath,'wx');} catch {throw new Error('Road demo lock exists; inspect its state before another run.');}
try {
  const resultPath=new URL('road-demo-provider.json',stateDir);
  let saved;
  try {saved=JSON.parse(await readFile(resultPath,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;}
  if(!saved) {
    const limitPath=new URL('road-demo-quota.json',stateDir),today=new Date().toISOString().slice(0,10);
    let quota={date:today,attempts:0,reservedCredits:0};
    try {const old=JSON.parse(await readFile(limitPath,'utf8'));if(old.date===today)quota=old;} catch(e) {if(e.code!=='ENOENT')throw e;}
    // This proof command permits ONE request per UTC day, even after a timeout.
    // Five-by-five local-city matrix: 25 baseline credits. Reserve 500 conservatively.
    // Also use the service-wide rolling ledger; no command-specific bypass.
    if(quota.attempts>=1)throw new Error('Daily road-demo request cap reached; no automatic retry or paid upgrade');
    await writeFile(limitPath,JSON.stringify({date:today,attempts:1,reservedCredits:500})+'\n');
    const shared=fileURLToPath(new URL('./state/service/',import.meta.url)),release=await exclusiveLease(shared);
    try{const maps=new MapsService({apiKey:process.env.GEOAPIFY_API_KEY,quota:new QuotaLedger(new JsonStore(shared)),cache:new JsonStore(fileURLToPath(new URL('./state/demo-cache/',import.meta.url)))});saved=await maps.matrix(points);}
    finally{await release();}
    await writeFile(resultPath,JSON.stringify(saved,null,2)+'\n');
  }
  const ids=Object.keys(points),input=fixture();
  for(const c of input.crews)c.location='A';
  input.jobs.forEach((j,i)=>j.location=ids[i%ids.length]);
  input.customers.forEach((c,i)=>{c.location=ids[i%ids.length];c.address=`Fictional customer at public coordinate ${c.location}`;});
  input.matrix=saved.matrix;input.routing={...saved.routing,attribution:'Powered by [Geoapify](https://www.geoapify.com/); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)'};
  const p=plan(input);
  const header='> Integration demo: real provider travel times between five public coordinates, with 18 fictional jobs, 3 fictional crews and 200 fictional customers. This is not a live customer job or a hosted Agent Market service.\n\n';
  await writeFile(new URL('road-report.md',examples),header+markdownReport(p));
  await writeFile(new URL('road-schedule.csv',examples),scheduleCsv(p));
  await writeFile(new URL('road-input.json',examples),JSON.stringify(input,null,2)+'\n');
  await writeFile(new URL('road-result.json',examples),JSON.stringify(p,null,2)+'\n');
  await writeFile(new URL('road-provenance.json',examples),JSON.stringify({points,routing:saved.routing,matrix:saved.matrix},null,2)+'\n');
  console.log(JSON.stringify({provider:saved.routing.provider,retrievedAt:saved.routing.retrievedAt,realRoadTimes:true,fictionalJobs:true,jobs:input.jobs.length,assigned:p.assignedRows.length,unassigned:p.unassigned.length,gaps:p.gaps.length,driveMinutes:p.driveMinutes,baselineDriveMinutes:p.baselineDriveMinutes,customerMessagesSent:0}));
} finally {
  await lock.close();
  const {unlink}=await import('node:fs/promises');await unlink(lockPath);
}
