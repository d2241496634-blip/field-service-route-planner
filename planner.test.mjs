import test from 'node:test';
import assert from 'node:assert/strict';
import {plan,evaluateRoute,matrixTravel,normalizeCustomers,dueEvidence,isoDay,formatTime} from './planner.mjs';
import {fixture} from './fixtures.mjs';

function audit(input,p) {
  const travel=matrixTravel(input.matrix), seen=[];
  for(const r of p.routes) {
    let time=r.crew.start, location=r.crew.location;
    for(const s of r.stops) {
      seen.push(s.row);
      assert.ok(s.start>=time+travel(location,s.location)-1e-8);
      assert.ok(s.start>=s.windowStart && s.end<=s.windowEnd && s.end<=r.crew.end);
      assert.equal(s.end-s.start,s.duration);
      assert.ok(s.skills.every(skill=>r.crew.skills.includes(skill)));
      time=s.end;location=s.location;
    }
    assert.ok(time+travel(location,r.crew.endLocation??r.crew.location)<=r.crew.end);
    // Independently enumerate all waiting intervals including start/end of shift.
    const expected=[];
    for(let i=0;i<=r.stops.length;i++) {
      const a=r.stops[i-1],b=r.stops[i],from=a?.location??r.crew.location,to=b?.location??r.crew.endLocation??r.crew.location;
      if((b?.start??r.crew.end)-(a?.end??r.crew.start)-travel(from,to)>=p.minimumGapMinutes-1e-8) expected.push(i);
    }
    const gaps=p.gaps.filter(g=>g.crewId===r.crew.id&&g.date===r.crew.date);
    assert.deepEqual(gaps.map(g=>g.index),expected);
    for(const gap of gaps) for(const s of gap.suggestions) {
      const c=input.customers.find(x=>x.id===s.customerId);
      assert.ok(!c.doNotContact&&!c.optOut);
      assert.ok(s.start>=gap.start+travel(gap.from,c.location)-1e-8);
      assert.ok(s.end+travel(c.location,gap.to)<=gap.end+1e-8);
      assert.ok(dueEvidence(c,gap.date));
      assert.match(s.draft,/reply to confirm/);
    }
  }
  const rows=[...seen,...p.unassigned.map(j=>j.row)].sort((a,b)=>a-b);
  assert.deepEqual(rows,input.jobs.map((_,i)=>i));
  assert.equal(new Set(seen).size,seen.length);
}
test('3 crews / 18 jobs / 200 customers satisfy independent schedule and gap invariants',()=>{const x=fixture();const p=plan(x);audit(x,p);assert.equal(p.assignedRows.length,18);assert.ok(p.gaps.some(g=>g.suggestions.length));});
test('one week includes all empty/light days',()=>{const x=fixture({days:7});const p=plan(x);audit(x,p);assert.equal(p.routes.length,21);assert.ok(p.gaps.some(g=>g.date==='2026-10-20'));assert.ok(p.gaps.some(g=>g.date==='2026-10-22'));});
test('impossible window is explicitly unassigned',()=>{const x=fixture();x.jobs.push({id:'impossible',date:'2026-10-19',location:'L0',duration:90,windowStart:500,windowEnd:510,skills:['general']});const p=plan(x);audit(x,p);assert.ok(p.unassigned.find(j=>j.id==='impossible'&&/window/.test(j.reason)));});
test('no matching skills, missing address, and unreachable travel are explicit',()=>{const x=fixture();x.jobs=x.jobs.slice(0,3);x.jobs[0].skills=['nuclear'];x.jobs[1].location='';x.jobs[2].location='unreachable';const p=plan(x);audit(x,p);assert.equal(p.unassigned.length,3);});
test('duplicate job IDs preserve both input rows for review',()=>{const x=fixture();x.jobs[1].id=x.jobs[0].id;const p=plan(x);audit(x,p);assert.equal(p.unassigned.filter(j=>/Duplicate/.test(j.reason)).length,2);});
test('duplicate opt-out propagates through linked identities',()=>{const c={id:'a',email:'A@example.test',location:'L1',lastServiceDate:'2026-01-01',intervalDays:30};const p=normalizeCustomers([c,{...c,id:'b',email:' a@example.test ',phone:'12345'},{...c,id:'c',email:'other@example.test',phone:'12345',optOut:'YES'}]);assert.equal(p.usable.length,0);assert.equal(p.excluded.length,1);});
test('conflicting duplicates are not silently merged',()=>{const p=normalizeCustomers([{id:'a',location:'L0'},{id:'a',location:'L1'}]);assert.equal(p.usable.length,0);assert.match(p.excluded[0].reason,/Conflicting/);});
test('missing and invalid due dates do not invent service intervals',()=>{assert.equal(dueEvidence({lastServiceDate:'2025-01-01'},'2026-10-19'),null);assert.equal(dueEvidence({lastServiceDate:'2026-02-30',intervalDays:30},'2026-10-19'),null);assert.equal(dueEvidence({lastServiceDate:'2026-11-01',intervalDays:30},'2026-10-19'),null);assert.equal(dueEvidence({dueDate:'2026-11-01'},'2026-10-19'),null);assert.ok(dueEvidence({openQuote:true,quoteDate:'2026-10-01'},'2026-10-19'));assert.equal(isoDay('2026-02-30'),null);});
test('time windows require full service and return travel must fit shift',()=>{const c={id:'c',date:'2026-10-19',location:'A',start:480,end:540,skills:[]};const j={id:'j',date:c.date,location:'B',duration:30,windowStart:480,windowEnd:540,skills:[]};assert.equal(evaluateRoute(c,[j],()=>20),null);assert.equal(evaluateRoute({...c,end:600},[{...j,windowEnd:520}],()=>20),null);});
test('backfill cannot delay a fixed appointment',()=>{const x={crews:[{id:'crew',date:'2026-10-19',location:'A',start:480,end:660,skills:[]}],jobs:[{id:'fixed',date:'2026-10-19',location:'B',duration:30,windowStart:570,windowEnd:600,skills:[]}],customers:[{id:'too-far',location:'C',duration:30,skills:[],dueDate:'2026-10-01'}],matrix:{A:{B:10,C:60},B:{A:10,C:60},C:{A:60,B:60}},routing:{kind:'synthetic',provider:'Test fixture'}};const p=plan(x);assert.ok(p.gaps.length);assert.ok(p.gaps.every(g=>g.suggestions.length===0));audit(x,p);});
test('finite bounded sizes and unique crew days are enforced',()=>{const x=fixture();x.crews.push(x.crews[0]);assert.throws(()=>plan(x),/Duplicate crew/);assert.throws(()=>plan({...fixture(),minimumGapMinutes:-1}),/positive/);assert.throws(()=>plan({...fixture(),routing:null}),/provenance/);});
test('deterministic randomized cases preserve coverage, shifts, skills and all gap constraints',()=>{for(let seed=0;seed<40;seed++){const x=fixture({seed});x.jobs.forEach((j,i)=>{if(i%3===0)j.windowEnd=600;if(i%5===0)j.windowStart=540;});audit(x,plan(x));}});
test('display rounds fractional minutes without invalid :60',()=>{assert.equal(formatTime(539.9),'09:00');assert.equal(formatTime(1440),'24:00');});
