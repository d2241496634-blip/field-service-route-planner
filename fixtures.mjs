/** Fictional people, grid locations and synthetic drive times. No private data. */
export function fixture({days=1,seed=7}={}) {
  let state=seed>>>0;
  const random=()=>{state=(1664525*state+1013904223)>>>0;return state/2**32;};
  const points={depot:[0,0]};
  for(let i=0;i<40;i++) points[`L${i}`]=[Math.floor(random()*20),Math.floor(random()*20)];
  const matrix={};
  for(const [a,p] of Object.entries(points)) {matrix[a]={};for(const [b,q] of Object.entries(points))matrix[a][b]=a===b?0:2+Math.abs(p[0]-q[0])+Math.abs(p[1]-q[1]);}
  const crews=[],jobs=[];
  for(let day=0;day<days;day++) {
    const date=`2026-10-${String(19+day).padStart(2,'0')}`;
    for(let c=0;c<3;c++) crews.push({id:`crew-${c+1}`,date,location:'depot',start:480,end:1020,skills:c===0?['general','specialist']:['general']});
    const count=days>1&&[1,3].includes(day)?3:18;
    for(let j=0;j<count;j++) jobs.push({id:`job-${day}-${j}`,date,location:`L${Math.floor(random()*40)}`,duration:30,windowStart:480,windowEnd:1020,skills:j%9===0?['specialist']:['general']});
  }
  const customers=Array.from({length:200},(_,i)=>({id:`customer-${i}`,name:`Example Customer ${i}`,location:`L${i%40}`,address:`Fictional Grid ${i%40}`,duration:25,skills:['general'],lastServiceDate:i%7===0?'':'2026-07-01',intervalDays:i%7===0?undefined:60,doNotContact:i%11===0,optOut:i%13===0,service:'scheduled maintenance'}));
  return {jobs,crews,customers,matrix,minimumGapMinutes:30,routing:{kind:'synthetic',provider:'Deterministic fictional grid; no road-network or traffic claims'}};
}
