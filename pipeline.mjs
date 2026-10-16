import {createHash} from 'node:crypto';
import {parseCsv,importRows,scheduleCsv} from './csv.mjs';
import {coordinate} from './geoapify.mjs';
import {plan,isoDay,normalizeCustomers,dueEvidence,markdownReport} from './planner.mjs';

const fields={jobs:['id','date','duration','windowStart','windowEnd','skills'],crews:['id','date','start','end','skills'],customers:['id','duration','skills','doNotContact','optOut']};
const caps={jobs:150,crews:70,customers:500};
const idFor=p=>'L'+createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0,20);
const falseFlag=x=>['false','no','0','n'].includes(String(x).trim().toLowerCase());
const trueFlag=x=>['true','yes','1','y'].includes(String(x).trim().toLowerCase());
const rawLocation=r=>JSON.stringify([r.address??'',r.longitude??'',r.latitude??'']);

export function readRequest({config,jobsCsv,crewsCsv,customersCsv}) {
  if(!config||isoDay(config.startDate)===null||isoDay(config.endDate)===null||isoDay(config.endDate)<isoDay(config.startDate)||isoDay(config.endDate)-isoDay(config.startDate)>6*86400000)throw new Error('Planning period must be 1–7 ISO dates');
  if(typeof config.timezone!=='string')throw new Error('An explicit IANA timezone is required');
  try{new Intl.DateTimeFormat('en',{timeZone:config.timezone});}catch{throw new Error('Invalid IANA timezone');}
  if(!/^[a-z]{2}$/.test(config.countryCode??''))throw new Error('countryCode must be a lowercase two-letter code');
  if(config.mapProcessingConsent!==true)throw new Error('Buyer must agree to processing necessary addresses/coordinates with Geoapify');
  const minimum=config.minimumGapMinutes??30;
  if(!Number.isInteger(minimum)||minimum<1||minimum>1440)throw new Error('minimumGapMinutes must be 1–1,440');
  const out={config:{...config,minimumGapMinutes:minimum}};
  for(const [kind,text] of Object.entries({jobs:jobsCsv,crews:crewsCsv,customers:customersCsv})){
    const {headers,rows}=parseCsv(text,{withHeaders:true});
    const missing=fields[kind].filter(x=>!headers.includes(x));
    if(missing.length)throw new Error(`${kind}.csv missing columns: ${missing.join(', ')}`);
    if(!headers.includes('address')&&!(headers.includes('latitude')&&headers.includes('longitude')))throw new Error(`${kind}.csv needs address or both latitude and longitude columns`);
    if(rows.length>caps[kind])throw new Error(`${kind}.csv exceeds ${caps[kind]} rows`);
    out[kind]=importRows(kind,text).map(r=>({...r,location:rawLocation(r)}));
  }
  if(!out.crews.length)throw new Error('At least one crew-day row is required');
  if(out.crews.some(c=>c.date<config.startDate||c.date>config.endDate))throw new Error('Every crew date must be inside the planning period');
  if(out.crews.some(c=>!c.id||isoDay(c.date)===null||!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start>=c.end||!Array.isArray(c.skills)))throw new Error('Crew rows require ID, ISO date, valid working hours and skills');
  if(new Set(out.crews.map(c=>`${c.date}/${c.id}`)).size!==out.crews.length)throw new Error('Duplicate crew-day rows need correction');
  out.customers=out.customers.map(c=>({...c,contactFlagsUnclear:[c.doNotContact,c.optOut].some(x=>!falseFlag(x)&&!trueFlag(x))}));
  return out;
}
export function distanceKm(a,b){
  const rad=Math.PI/180,dy=(b[1]-a[1])*rad,dx=(b[0]-a[0])*rad;
  const h=Math.sin(dy/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dx/2)**2;
  return 12742*Math.asin(Math.sqrt(Math.min(1,h)));
}

/** No network except injected maps; no arbitrary URLs, executables, outreach or LLM calls. */
export async function buildSchedule(request,maps) {
  const {config,jobs,crews,customers}=readRequest(request),points={},labels={},review=[];
  const normalized=normalizeCustomers(customers),dates=[...new Set(crews.map(c=>c.date))];
  let anchor;
  const locate=async(r,kind,row,end=false)=>{
    const address=String(end?r.endAddress??'':r.address??'').trim();
    const lon=end?r.endLongitude:r.longitude,lat=end?r.endLatitude:r.latitude;
    let point,label=address,reason;
    if((lon!==undefined&&lon!=='')||(lat!==undefined&&lat!=='')){
      if(lon===''||lon===undefined||lat===''||lat===undefined||!coordinate([Number(lon),Number(lat)]))reason='Invalid or incomplete longitude/latitude';
      else point=[Number(lon),Number(lat)];
    }else if(address){
      const geo=await maps.geocode(address,config.countryCode);
      if(geo.ok){point=geo.point;label=geo.formatted||address;}else reason=geo.reason;
    }else reason='Missing address or verified coordinates';
    if(point&&anchor&&distanceKm(anchor,point)>150){reason='Outside the supported 150-km local service radius; buyer review required';point=null;}
    if(!point){review.push({kind,row:row+1,id:r.id,field:end?'endAddress':'address',reason});return null;}
    if(!anchor)anchor=point;
    const key=idFor(point);points[key]=point;labels[key]=label||`${point[1]}, ${point[0]}`;return key;
  };
  const resolvedCrews=[];
  for(let i=0;i<crews.length;i++){
    const c=crews[i],location=await locate(c,'crews',i);
    if(!location)throw new Error(`Crew row ${i+1} has an unresolved start address; correct it before planning`);
    const hasEnd=c.endAddress||c.endLongitude||c.endLatitude;
    const endLocation=hasEnd?await locate(c,'crews',i,true):location;
    if(!endLocation)throw new Error(`Crew row ${i+1} has an unresolved end address; correct it before planning`);
    resolvedCrews.push({...c,location,endLocation});
  }
  const resolvedJobs=[];
  for(let i=0;i<jobs.length;i++){
    const j=jobs[i];
    if(j.date<config.startDate||j.date>config.endDate){review.push({kind:'jobs',row:i+1,id:j.id,reason:'Job date is outside the planning period'});resolvedJobs.push({...j,location:null});continue;}
    const location=await locate(j,'jobs',i);resolvedJobs.push({...j,location,address:location?labels[location]:j.address});
  }
  const coreIds=[...new Set([...resolvedCrews.flatMap(c=>[c.location,c.endLocation]),...resolvedJobs.map(j=>j.location)].filter(Boolean))];
  const matrix={},retrievals=[];let routing;
  const merge=async(sourceIds,targetIds)=>{
    const from=Object.fromEntries(sourceIds.map(id=>[id,points[id]])),to=Object.fromEntries(targetIds.map(id=>[id,points[id]]));
    if(!sourceIds.length||!targetIds.length)return;
    if(sourceIds.every(a=>targetIds.every(b=>Object.hasOwn(matrix[a]??{},b))))return;
    const result=await maps.matrix(from,to);routing=result.routing;retrievals.push(routing.retrievedAt);
    for(const [a,row] of Object.entries(result.matrix))Object.assign(matrix[a]??=(Object.create(null)),row);
  };
  // Small batches permit a conservative write-ahead reservation within the free budget.
  for(let i=0;i<coreIds.length;i+=16)for(let j=0;j<coreIds.length;j+=16)await merge(coreIds.slice(i,i+16),coreIds.slice(j,j+16));
  const baseInput={jobs:resolvedJobs,crews:resolvedCrews,customers:[],matrix,routing,minimumGapMinutes:config.minimumGapMinutes};
  const base=plan(baseInput),resolvedCustomers=[];
  for(let i=0;i<normalized.usable.length;i++){
    const c=normalized.usable[i];
    if(!dates.some(d=>dueEvidence(c,d))){review.push({kind:'customers',row:i+1,id:c.id,reason:'No valid due evidence during the planning period'});continue;}
    if(!Number.isFinite(c.duration)||c.duration<=0||!Array.isArray(c.skills)){review.push({kind:'customers',row:i+1,id:c.id,reason:'Missing valid duration or skills'});continue;}
    const location=await locate(c,'customers',i);
    if(location)resolvedCustomers.push({...c,location,address:labels[location]});
  }
  // Each original gap evaluates the 12 closest eligible candidates by geometric detour.
  // Geometry only selects candidates; every advertised drive time and fit uses road routing.
  const screened=new Set(),shortlists=[];
  for(const gap of base.gaps){
    const crew=resolvedCrews.find(c=>c.id===gap.crewId&&c.date===gap.date);
    const eligible=resolvedCustomers.filter(c=>dueEvidence(c,gap.date)&&c.skills.every(s=>crew.skills.includes(s))&&!base.routes.some(r=>r.crew.date===gap.date&&r.jobs.some(j=>j.customerId===c.id)));
    const candidates=eligible.map(c=>({c,score:distanceKm(points[gap.from],points[c.location])+distanceKm(points[c.location],points[gap.to])-distanceKm(points[gap.from],points[gap.to])})).sort((a,b)=>a.score-b.score||String(a.c.id).localeCompare(String(b.c.id))).slice(0,12).map(x=>x.c);
    const ids=[...new Set(candidates.map(c=>c.location))];candidates.forEach(c=>screened.add(c.id));
    shortlists.push({gapId:gap.id,eligible:eligible.length,roadCheckedCandidates:candidates.map(c=>c.id)});
    await merge([gap.from],ids);await merge(ids,[gap.to]);
  }
  const result=plan({...baseInput,customers:resolvedCustomers,routing:{...routing,retrievedAt:[...new Set(retrievals)].sort().join(' to ')}});
  for(const g of result.gaps)g.area=`Between ${labels[g.from]} and ${labels[g.to]}`;
  result.excludedCustomers.push(...normalized.excluded,...review.filter(r=>r.kind==='customers').map(r=>({ids:[r.id??'(missing ID)'],reason:r.reason})));
  for(const u of result.unassigned){const issue=review.find(r=>r.kind==='jobs'&&r.row===u.row+1);if(issue)u.reason=issue.reason;}
  for(const c of resolvedCustomers)if(!screened.has(c.id)&&!base.gaps.some(g=>Number.isFinite(matrix[g.from]?.[c.location])&&Number.isFinite(matrix[c.location]?.[g.to])))result.excludedCustomers.push({ids:[c.id],reason:'Outside the nearest-12 candidate shortlist for every gap; no road-feasibility claim'});
  result.notes.push(`Planning period: ${config.startDate} through ${config.endDate}; local timezone: ${config.timezone}.`,
    'Backfill search targets the 12 nearest eligible customers per gap for road checks; already-known road pairs can cover additional customers. It does not guarantee exhaustive coverage or the globally best backfill.',
    'Addresses/coordinates are processed by Geoapify. Customer names, contact details and service history are not sent to the map provider.');
  return {result,report:markdownReport(result),scheduleCsv:scheduleCsv(result),review,shortlists,config,counts:{jobs:jobs.length,crewDays:crews.length,customers:customers.length}};
}
