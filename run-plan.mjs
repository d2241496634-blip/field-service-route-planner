import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {JsonStore,QuotaLedger,exclusiveLease} from './storage.mjs';
import {MapsService} from './maps-service.mjs';
import {buildSchedule} from './pipeline.mjs';

export async function run(inputDirectory,outputDirectory,stateDirectory){
  const release=await exclusiveLease(stateDirectory);
  try{
    const input=path.resolve(inputDirectory),out=path.resolve(outputDirectory);
    const [config,jobsCsv,crewsCsv,customersCsv]=await Promise.all(['request.json','jobs.csv','crews.csv','customers.csv'].map(f=>readFile(path.join(input,f),'utf8')));
    const maps=new MapsService({apiKey:process.env.GEOAPIFY_API_KEY,quota:new QuotaLedger(new JsonStore(stateDirectory)),cache:new JsonStore(path.join(out,'private-map-cache'))});
    const result=await buildSchedule({config:JSON.parse(config),jobsCsv,crewsCsv,customersCsv},maps);
    await mkdir(out,{recursive:true});
    await writeFile(path.join(out,'report.md'),result.report);
    await writeFile(path.join(out,'schedule.csv'),result.scheduleCsv);
    await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));
    return {assigned:result.result.assignedRows.length,unassigned:result.result.unassigned.length,gaps:result.result.gaps.length};
  }finally{await release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==5){console.error('Usage: node run-plan.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY SHARED_STATE_DIRECTORY');process.exitCode=1;}
  else try{console.log(JSON.stringify(await run(...process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=1;}
}
