import {createHash} from 'node:crypto';
import {fetchGeocode,fetchRoadMatrix,matrixCredits,matrixRequest} from './geoapify.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export class MapsService {
  constructor({apiKey,quota,cache,fetchImpl=fetch}){Object.assign(this,{apiKey,quota,cache,fetchImpl});}
  async geocode(address,countryCode){
    const key=`geocode-${hash([address.trim().toLowerCase(),countryCode])}`,cached=await this.cache.get(key);
    if(cached)return cached;
    const reservation=await this.quota.reserve(1);
    const result=await fetchGeocode(address,{apiKey:this.apiKey,countryCode,fetchImpl:this.fetchImpl});
    await this.quota.settle(reservation,1);await this.cache.set(key,result);return result;
  }
  async matrix(sources,targets=sources){
    matrixRequest(sources,targets);
    const key=`matrix-${hash([sources,targets,'approximated'])}`,cached=await this.cache.get(key);
    if(cached)return cached;
    const s=Object.keys(sources).length,t=Object.keys(targets).length;
    // Reserve two 500-km distance increments per pair plus headroom, then account from returned distances.
    // This is a conservative local-service estimate, NOT a provider-enforced billing cap.
    const reserved=Math.max(s,t)*Math.min(s,t,10)+s*t*2+50;
    const reservation=await this.quota.reserve(reserved);
    const result=await fetchRoadMatrix(sources,{targets,apiKey:this.apiKey,fetchImpl:this.fetchImpl});
    await this.quota.settle(reservation,matrixCredits(s,t,result.providerResponse));
    const compact={matrix:result.matrix,routing:result.routing};
    await this.cache.set(key,compact);return compact;
  }
}
