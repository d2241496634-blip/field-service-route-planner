/** Only documented Geoapify public API endpoints. Never include API keys in errors. */
const BASE='https://api.geoapify.com';
const coordinate=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
export function matrixRequest(points) {
  const entries=Object.entries(points);
  if(!entries.length||entries.length**2>1000)throw new Error('One matrix call requires 1–31 unique locations (at most 1,000 cells)');
  if(entries.some(([id,p])=>!id||!coordinate(p)))throw new Error('Each location needs an ID and finite [longitude, latitude]');
  return {mode:'drive',traffic:'approximated',sources:entries.map(([,p])=>({location:p})),targets:entries.map(([,p])=>({location:p}))};
}
export function decodeMatrix(points,data) {
  const ids=Object.keys(points),rows=data?.sources_to_targets;
  if(!Array.isArray(rows)||rows.length!==ids.length)throw new Error('Routing provider returned an invalid matrix shape');
  const matrix=Object.fromEntries(ids.map(id=>[id,{}]));
  for(let i=0;i<ids.length;i++) {
    if(!Array.isArray(rows[i])||rows[i].length!==ids.length)throw new Error('Routing provider returned an invalid matrix row');
    for(let j=0;j<ids.length;j++) {
      const pair=rows[i][j];
      if(pair!==null&&(pair?.source_index!==i||pair?.target_index!==j))throw new Error('Routing response indexes do not match the requested locations');
      const seconds=pair?.time;
      if(seconds!==null&&seconds!==undefined&&(!Number.isFinite(seconds)||seconds<0))throw new Error('Routing provider returned an invalid duration');
      // Round every leg up to whole minutes so a displayed schedule remains conservative.
      matrix[ids[i]][ids[j]]=seconds===null||seconds===undefined?null:Math.ceil(seconds/60);
    }
  }
  return matrix;
}
export async function fetchRoadMatrix(points,{apiKey,fetchImpl=fetch}={}) {
  if(typeof apiKey!=='string'||!apiKey.trim())throw new Error('A Geoapify API key is required');
  const body=matrixRequest(points),url=new URL('/v1/routematrix',BASE);
  url.searchParams.set('apiKey',apiKey);
  let response;
  try {response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});}
  catch {throw new Error('Routing request failed or timed out; no synthetic fallback was used');}
  if(!response.ok)throw new Error(`Routing provider HTTP ${response.status}; response body omitted to protect credentials`);
  let data;try{data=await response.json();}catch{throw new Error('Routing provider returned invalid JSON');}
  const matrix=decodeMatrix(points,data);
  return {matrix,routing:{kind:'road',provider:'Geoapify Route Matrix / OpenStreetMap',traffic:'approximated (not live traffic)',retrievedAt:new Date().toISOString(),units:'minutes; each leg rounded up',attribution:'Powered by [Geoapify](https://www.geoapify.com/); © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)'},providerResponse:data};
}
