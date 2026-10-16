import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {plan,markdownReport} from './planner.mjs';
import {fixture} from './fixtures.mjs';
await mkdir(new URL('./examples/',import.meta.url),{recursive:true});
for(const [name,days] of [['day',1],['week',7]]) {
  const input=fixture({days}),start=performance.now(),result=plan(input),elapsed=performance.now()-start;
  await writeFile(new URL(`./examples/${name}-input.json`,import.meta.url),JSON.stringify(input,null,2)+'\n');
  await writeFile(new URL(`./examples/${name}-report.md`,import.meta.url),markdownReport(result));
  await writeFile(new URL(`./examples/${name}-result.json`,import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({scenario:name,fictional:true,jobs:input.jobs.length,customers:input.customers.length,crewDayRows:input.crews.length,assigned:result.assignedRows.length,unassigned:result.unassigned.length,gaps:result.gaps.length,gapsWithSuggestions:result.gaps.filter(g=>g.suggestions.length).length,driveMinutes:result.driveMinutes,baselineDriveMinutes:result.baselineDriveMinutes,elapsedMs:Number(elapsed.toFixed(2))}));
}
