/** Only documented Geoapify public API endpoints. Never include API keys in errors. */
const BASE='https://api.geoapify.com';
export const coordinate=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
export function matrixRequest(points,targets=points) {
  const entries=Object.entries(points),ends=Object.entries(targets);
  if(!entries.length||!ends.length||entries.length*ends.length>1000)throw new Error('One matrix call requires 1–1,000 cells (at most 31 locations for a square matrix)');
  if([...entries,...ends].some(([id,p])=>!id||!coordinate(p)))throw new Error('Each location needs an ID and finite [longitude, latitude]');
  return {mode:'drive',traffic:'approximated',sources:entries.map(([,p])=>({location:p})),targets:ends.map(([,p])=>({location:p}))};
}
export function decodeMatrix(points,data,targets=points) {
  const ids=Object.keys(points),ends=Object.keys(targets),rows=data?.sources_to_targets;
  if(!Array.isArray(rows)||rows.length!==ids.length)throw new Error('Routing provider returned an invalid matrix shape');
  const matrix=Object.fromEntries(ids.map(id=>[id,{}]));
  for(let i=0;i<ids.length;i++) {
    if(!Array.isArray(rows[i])||rows[i].length!==ends.length)throw new Error('Routing provider returned an invalid matrix row');
    for(let j=0;j<ends.length;j++) {
      const pair=rows[i][j];
      if(pair!==null&&(pair?.source_index!==i||pair?.target_index!==j))throw new Error('Routing response indexes do not match the requested locations');
      const seconds=pair?.time;
      if(seconds!==null&&seconds!==undefined&&(!Number.isFinite(seconds)||seconds<0))throw new Error('Routing provider returned an invalid duration');
      // Round every leg up to whole minutes so a displayed schedule remains conservative.
      matrix[ids[i]][ends[j]]=seconds===null||seconds===undefined?null:Math.ceil(seconds/60);
    }
  }
  return matrix;
}
export async function fetchRoadMatrix(points,{apiKey,fetchImpl=fetch,targets=points}={}) {
  if(typeof apiKey!=='string'||!apiKey.trim())throw new Error('A Geoapify API key is required');
  const body=matrixRequest(points,targets),url=new URL('/v1/routematrix',BASE);
  url.searchParams.set('apiKey',apiKey);
  let response;
  try {response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});}
  catch {throw new Error('Routing request failed or timed out; no synthetic fallback was used');}
  if(!response.ok)throw new Error(`Routing provider HTTP ${response.status}; response body omitted to protect credentials`);
  let data;try{data=await response.json();}catch{throw new Error('Routing provider returned invalid JSON');}
  const matrix=decodeMatrix(points,data,targets);
  return {matrix,routing:{kind:'road',provider:'Geoapify Route Matrix / OpenStreetMap',traffic:'approximated (not live traffic)',retrievedAt:new Date().toISOString(),units:'minutes; each leg rounded up',attribution:'Powered by [Geoapify](https://www.geoapify.com/); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)'},providerResponse:data};
}

export function decodeGeocode(data,{countryCode}={}) {
  if(!Array.isArray(data?.results))throw new Error('Geocoder returned an invalid response');
  const plausible=data.results.filter(r=>coordinate([r.lon,r.lat])&&['building','amenity'].includes(r.result_type)&&r.rank?.confidence>=0.9&&r.rank?.match_type==='full_match'&&(!countryCode||r.country_code===countryCode));
  const first=plausible[0];
  const candidates=data.results.slice(0,3).map(r=>({formatted:r.formatted,resultType:r.result_type,confidence:r.rank?.confidence,matchType:r.rank?.match_type,countryCode:r.country_code}));
  if(!first)return {ok:false,reason:'No high-confidence building or amenity match; supply corrected address or verified coordinates',candidates};
  const distinct=plausible.some(r=>Math.abs(r.lon-first.lon)+Math.abs(r.lat-first.lat)>0.0002);
  if(distinct)return {ok:false,reason:'Multiple plausible address matches; buyer must verify coordinates',candidates};
  return {ok:true,point:[first.lon,first.lat],formatted:first.formatted,resultType:first.result_type,confidence:first.rank.confidence};
}
export async function fetchGeocode(address,{apiKey,countryCode,fetchImpl=fetch}={}) {
  if(typeof apiKey!=='string'||!apiKey.trim())throw new Error('A Geoapify API key is required');
  if(typeof address!=='string'||address.trim().length<6||address.length>500||/[\x00-\x1f]/.test(address))return {ok:false,reason:'Address is missing, too short, too long or contains control characters'};
  if(!/^[a-z]{2}$/.test(countryCode??''))throw new Error('A two-letter country code is required');
  const url=new URL('/v1/geocode/search',BASE);
  for(const [k,v] of Object.entries({text:address.trim(),format:'json',limit:'3',filter:`countrycode:${countryCode}`,bias:'countrycode:none',apiKey}))url.searchParams.set(k,v);
  let response;
  try{response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new Error('Geocoding request failed or timed out');}
  if(!response.ok)throw new Error(`Geocoding provider HTTP ${response.status}; response body omitted`);
  let data;try{data=await response.json();}catch{throw new Error('Geocoder returned invalid JSON');}
  return {...decodeGeocode(data,{countryCode}),retrievedAt:new Date().toISOString()};
}

// Current published formula; no avoidance options are used by this adapter.
export function matrixCredits(sourceCount,targetCount,data) {
  if(!Array.isArray(data?.sources_to_targets)||data.sources_to_targets.length!==sourceCount)throw new Error('Cannot account for malformed routing response');
  let cost=Math.max(sourceCount,targetCount)*Math.min(sourceCount,targetCount,10);
  for(const row of data.sources_to_targets){
    if(!Array.isArray(row)||row.length!==targetCount)throw new Error('Cannot account for malformed routing response');
    for(const pair of row){
      if(pair===null)continue;
      if(pair.distance===null&&pair.time===null)continue;
      if(!Number.isFinite(pair.distance)||pair.distance<0)throw new Error('Routing response lacks distance required for quota accounting');
      cost+=Math.floor(pair.distance/500000);
    }
  }
  return cost;
}
