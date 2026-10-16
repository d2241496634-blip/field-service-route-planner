import test from 'node:test';
import assert from 'node:assert/strict';
import {readRequest,buildSchedule} from './pipeline.mjs';
import {csvCell} from './csv.mjs';
import {decodeGeocode,fetchGeocode,matrixCredits} from './geoapify.mjs';
import {readFile} from 'node:fs/promises';
const csv=(headers,rows)=>[headers,...rows].map(r=>r.map(csvCell).join(',')).join('\n');
const config={startDate:'2026-10-19',endDate:'2026-10-19',timezone:'America/New_York',countryCode:'us',mapProcessingConsent:true};
function fixture(){return {config:{...config},jobsCsv:csv(['id','date','address','duration','windowStart','windowEnd','skills'],[['j1',config.startDate,'10 First Street, Test City',30,'09:00','10:00','hvac'],['j2',config.startDate,'20 First Street, Test City',30,'14:00','15:00','hvac']]),crewsCsv:csv(['id','date','address','start','end','skills'],[['a',config.startDate,'Depot Street, Test City','08:00','17:00','hvac']]),customersCsv:csv(['id','address','duration','skills','doNotContact','optOut','dueDate'],[['yes','30 First Street, Test City',30,'hvac','false','false','2026-01-01'],['no','Do not geocode this address',30,'hvac','yes','false','2026-01-01'],['maybe','Do not geocode unknown consent',30,'hvac','','false','2026-01-01']])};}
function provider(){const seen=[];let next=0;const byAddress=new Map();return {seen,async geocode(address){seen.push(address);if(address==='BAD ADDRESS')return {ok:false,reason:'Ambiguous address'};if(!byAddress.has(address))byAddress.set(address,[-74+next++*0.001,40.7]);return {ok:true,point:byAddress.get(address),formatted:address};},async matrix(from,to){return {routing:{kind:'road',provider:'TEST recorded adapter',retrievedAt:'2026-10-16T00:00:00Z',traffic:'TEST'},matrix:Object.fromEntries(Object.keys(from).map(a=>[a,Object.fromEntries(Object.keys(to).map(b=>[b,a===b?0:5]))]))};}};}
test('input contract requires explicit timezone, map permission, headers and contact flags',()=>{
  for(const change of [{timezone:undefined},{timezone:'incorrect'},{mapProcessingConsent:false},{countryCode:'USA'},{endDate:'2026-11-01'}])assert.throws(()=>readRequest({...fixture(),config:{...config,...change}}));
  assert.throws(()=>readRequest({...fixture(),customersCsv:'id,address,duration,skills\na,Address 1,30,hvac'}),/doNotContact/);
});
test('full CSV pipeline accounts for every job and never geocodes opted-out or unclear-consent customers',async()=>{
  const p=provider(),r=await buildSchedule(fixture(),p);
  assert.equal(r.result.assignedRows.length,2);assert.equal(r.result.unassigned.length,0);assert.ok(r.result.gaps.length>0);
  assert.ok(r.result.gaps.flatMap(g=>g.suggestions).some(c=>c.customerId==='yes'));
  assert.ok(r.result.gaps.flatMap(g=>g.suggestions).every(c=>c.customerId==='yes'));
  assert.ok(!p.seen.some(a=>a.startsWith('Do not')));
  assert.ok(r.result.excludedCustomers.some(c=>c.ids.includes('no')));assert.ok(r.result.excludedCustomers.some(c=>c.ids.includes('maybe')));
  assert.match(r.report,/America\/New_York/);assert.match(r.scheduleCsv,/"j1"/);
  // Independent timing audit of every offered insertion, holding later appointment starts fixed.
  for(const g of r.result.gaps)for(const s of g.suggestions){assert.ok(s.start>=g.start+5);assert.ok(s.end+5<=g.end);assert.equal(s.end-s.start,30);}
});
test('ambiguous jobs remain unassigned with explicit cause; ambiguous depots stop before schedule creation',async()=>{
  const f=fixture();f.jobsCsv=f.jobsCsv.replace('10 First Street, Test City','BAD ADDRESS');
  const r=await buildSchedule(f,provider());assert.equal(r.result.assignedRows.length+r.result.unassigned.length,2);assert.match(r.result.unassigned[0].reason,/Ambiguous/);
  f.crewsCsv=f.crewsCsv.replace('Depot Street, Test City','BAD ADDRESS');await assert.rejects(()=>buildSchedule(f,provider()),/unresolved start/);
});
test('duplicate opt-out and conflicting-address identity groups never reach geocoding',async()=>{
  const f=fixture();f.customersCsv=csv(['id','address','duration','skills','doNotContact','optOut','dueDate'],[['same','A address',30,'hvac','false','false','2026-01-01'],['same','A address',30,'hvac','false','true','2026-01-01'],['conflict','B address',30,'hvac','false','false','2026-01-01'],['conflict','C address',30,'hvac','false','false','2026-01-01']]);
  const p=provider(),r=await buildSchedule(f,p);assert.ok(!p.seen.includes('A address'));assert.ok(!p.seen.includes('B address'));assert.ok(r.result.gaps.every(g=>!g.suggestions.length));
});
test('geocoding rejects broad, low-confidence, ambiguous and wrong-country results',()=>{
  const good={lon:-74,lat:40.7,result_type:'building',country_code:'us',rank:{confidence:1,match_type:'full_match'}};
  assert.equal(decodeGeocode({results:[good]},{countryCode:'us'}).ok,true);
  for(const r of [{...good,result_type:'street'},{...good,rank:{confidence:0.5,match_type:'full_match'}},{...good,country_code:'gb'}])assert.equal(decodeGeocode({results:[r]},{countryCode:'us'}).ok,false);
  assert.equal(decodeGeocode({results:[good,{...good,lon:-73}]},{countryCode:'us'}).ok,false);
});
test('geocoder fixes host/filter, excludes automatic IP bias and redacts failed requests',async()=>{
  let observed;await fetchGeocode('10 Main Street, Test City',{apiKey:'SECRET_TEST',countryCode:'us',fetchImpl:async(url,o)=>{observed={url,o};return {ok:true,json:async()=>({results:[]})};}});
  assert.equal(observed.url.origin,'https://api.geoapify.com');assert.equal(observed.url.searchParams.get('filter'),'countrycode:us');assert.equal(observed.url.searchParams.get('bias'),'countrycode:none');assert.equal(observed.o.redirect,'error');
  await assert.rejects(()=>fetchGeocode('10 Main Street',{apiKey:'SECRET_TEST',countryCode:'us',fetchImpl:async()=>{throw new Error('SECRET_TEST');}}),e=>!e.message.includes('SECRET_TEST'));
});
test('matrix credits use directional returned distance and fail closed without usable distance',()=>{
  assert.equal(matrixCredits(1,2,{sources_to_targets:[[{distance:500001,time:500},{distance:100,time:2}]]}),3);
  assert.throws(()=>matrixCredits(1,1,{sources_to_targets:[[{time:2}]]}),/distance/);
});
test('published CSV inputs replay real recorded road/geocode responses with full row coverage',async()=>{
  const base=new URL('./examples/',import.meta.url),read=async p=>readFile(new URL(p,base),'utf8');
  const [settings,jobsCsv,crewsCsv,customersCsv,geocode,matrices]=await Promise.all(['csv-input/request.json','csv-input/jobs.csv','csv-input/crews.csv','csv-input/customers.csv','csv-road-geocode.json','csv-road-matrices.json'].map(read));
  const combined={},records=JSON.parse(matrices);for(const record of records)for(const [id,row] of Object.entries(record.matrix))Object.assign(combined[id]??={},row);
  const r=await buildSchedule({config:JSON.parse(settings),jobsCsv,crewsCsv,customersCsv},{geocode:async address=>{assert.equal(address,'Adlon Kempinski, Unter den Linden 77, 10117 Berlin, Germany');return JSON.parse(geocode);},matrix:async(from,to)=>({routing:records[0].routing,matrix:Object.fromEntries(Object.keys(from).map(a=>[a,Object.fromEntries(Object.keys(to).map(b=>{assert.ok(Object.hasOwn(combined[a],b));return [b,combined[a][b]];}))]))})});
  const rows=[...r.result.routes.flatMap(route=>route.stops.map(s=>s.row)),...r.result.unassigned.map(s=>s.row)].sort((a,b)=>a-b);
  assert.deepEqual(rows,Array.from({length:18},(_,i)=>i));assert.equal(r.counts.customers,200);assert.equal(r.result.unassigned.length,0);assert.equal(r.result.routing.kind,'road');assert.equal(r.result.gaps.length,3);
  for(const route of r.result.routes){let end=route.crew.start,from=route.crew.location;for(const stop of route.stops){assert.ok(stop.start>=end+combined[from][stop.location]);assert.ok(stop.end<=stop.windowEnd);assert.ok(stop.start>=stop.windowStart);assert.ok(stop.skills.every(s=>route.crew.skills.includes(s)));end=stop.end;from=stop.location;}assert.ok(end+combined[from][route.crew.endLocation]<=route.crew.end);}
});
