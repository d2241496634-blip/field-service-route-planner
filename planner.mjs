/** Deterministic scheduling prototype. All durations are minutes; dates are local ISO days.
 * Routing is injected. A synthetic matrix must never be presented as road travel time.
 */
const DAY = 86400000;
const isId = x => typeof x === 'string' && x.trim().length > 0;
const validMinute = x => Number.isInteger(x) && x >= 0 && x <= 1440;
const bool = x => x === true || ['true', 'yes', '1', 'y'].includes(String(x).trim().toLowerCase());
const clean = x => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const allSkills = (crew, job) => (job.skills ?? []).every(s => crew.skills.includes(s));
export function isoDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const n = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? n : null;
}
export function matrixTravel(matrix) {
  return (a, b) => {
    if (a === b) return 0;
    const n = matrix?.[a]?.[b];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : Infinity;
  };
}

export function evaluateRoute(crew, jobs, travel) {
  let clock = crew.start, place = crew.location, drive = 0;
  const stops = [];
  for (const job of jobs) {
    if (job.date !== crew.date || !allSkills(crew, job)) return null;
    const leg = travel(place, job.location);
    if (!Number.isFinite(leg)) return null;
    const arrival = clock + leg;
    const start = Math.max(arrival, job.windowStart);
    const end = start + job.duration;
    // Windows cover the complete visit, not just arrival.
    if (end > job.windowEnd || end > crew.end) return null;
    stops.push({ ...job, arrival, start, end, driveMinutes: leg });
    drive += leg; clock = end; place = job.location;
  }
  const endLocation = crew.endLocation ?? crew.location;
  const homeLeg = travel(place, endLocation);
  if (!Number.isFinite(homeLeg) || clock + homeLeg > crew.end) return null;
  return { crew, jobs, stops, driveMinutes: drive + homeLeg, returnMinutes: homeLeg, finish: clock + homeLeg };
}

function validateJob(j) {
  if (!isId(j.id)) return 'Missing job ID';
  if (isoDay(j.date) === null) return 'Invalid planning date';
  if (!isId(j.location)) return 'Missing or unresolved address/location';
  if (!(typeof j.duration === 'number' && Number.isFinite(j.duration) && j.duration > 0)) return 'Invalid visit duration';
  if (!validMinute(j.windowStart) || !validMinute(j.windowEnd) || j.windowStart >= j.windowEnd) return 'Invalid time window';
  if (!Array.isArray(j.skills) || !j.skills.every(isId)) return 'Missing or invalid required skills list';
  if (j.duration > j.windowEnd - j.windowStart) return 'Visit cannot fit its time window';
  return null;
}
function validateCrew(c) {
  if (!isId(c.id) || isoDay(c.date) === null || !isId(c.location) || !validMinute(c.start) || !validMinute(c.end) || c.start >= c.end || !Array.isArray(c.skills) || !c.skills.every(isId)) {
    throw new Error('Crew rows require ID, valid date, resolved location, working hours, and skills');
  }
}

function schedule(jobs, crews, travel, optimize) {
  const routes = crews.map(c => evaluateRoute(c, [], travel));
  if (routes.some(x => x === null)) throw new Error('A crew cannot reach its end location during its shift');
  const assigned = new Set(), failures = [];
  const pending = jobs.map((j, row) => ({...j, row}));
  const counts = new Map();
  for (const j of pending) if (isId(j.id)) counts.set(j.id, (counts.get(j.id) ?? 0) + 1);
  const valid = [];
  for (const j of pending) {
    const reason = validateJob(j) ?? (counts.get(j.id) > 1 ? 'Duplicate job ID; all conflicting rows need review' : null);
    if (reason) failures.push({row:j.row, id:j.id ?? '', reason}); else valid.push(j);
  }
  if (optimize) valid.sort((a,b) => (a.windowEnd-a.duration)-(b.windowEnd-b.duration) || b.skills.length-a.skills.length || a.row-b.row);
  for (const job of valid) {
    let best = null;
    for (let r = 0; r < routes.length; r++) {
      const route = routes[r];
      const from = optimize ? 0 : route.jobs.length;
      for (let pos = from; pos <= route.jobs.length; pos++) {
        const order = route.jobs.toSpliced(pos, 0, job);
        const result = evaluateRoute(route.crew, order, travel);
        if (!result) continue;
        const extra = result.driveMinutes - route.driveMinutes;
        if (!best || extra < best.extra || (extra === best.extra && result.finish < best.result.finish)) best = {r, result, extra};
      }
    }
    if (best) { routes[best.r] = best.result; assigned.add(job.row); }
    else {
      const eligible = crews.filter(c => c.date === job.date && allSkills(c, job));
      const reason = eligible.length === 0 ? 'No crew on this date has all required skills' :
        eligible.every(c => evaluateRoute(c, [job], travel) === null) ? 'No feasible isolated visit: shift, window, or routing prevents access' :
        'No feasible insertion found in this schedule; heuristic result, not proof of global infeasibility';
      failures.push({row:job.row, id:job.id, reason});
    }
  }
  // Bounded relocation improvement, preserving all hard constraints.
  if (optimize) for (let pass = 0; pass < 2; pass++) for (let r = 0; r < routes.length; r++) {
    for (let from = 0; from < routes[r].jobs.length; from++) for (let to = 0; to < routes[r].jobs.length; to++) {
      const order = [...routes[r].jobs], [j] = order.splice(from, 1); order.splice(to, 0, j);
      const candidate = evaluateRoute(routes[r].crew, order, travel);
      if (candidate && candidate.driveMinutes + 1e-8 < routes[r].driveMinutes) routes[r] = candidate;
    }
  }
  return {routes, unassigned:failures.sort((a,b) => a.row-b.row), assignedRows:[...assigned].sort((a,b)=>a-b), driveMinutes:routes.reduce((s,r)=>s+r.driveMinutes,0)};
}

// Group duplicate identity evidence conservatively; suppress the whole group if any row opts out.
export function normalizeCustomers(customers) {
  const parent = customers.map((_,i)=>i);
  const root = i => { while(parent[i] !== i) {parent[i] = parent[parent[i]]; i=parent[i];} return i; };
  const keys = new Map();
  customers.forEach((c,i) => {
    const identities = [isId(c.id) ? `id:${clean(c.id)}` : null, clean(c.email) ? `email:${clean(c.email)}` : null,
      clean(c.phone) ? `phone:${String(c.phone).replace(/\D/g,'')}` : null,
      clean(c.name) && clean(c.address) ? `name-address:${clean(c.name)}|${clean(c.address)}` : null].filter(Boolean);
    for (const k of identities) { if (keys.has(k)) parent[root(i)] = root(keys.get(k)); else keys.set(k,i); }
  });
  const groups = new Map();
  customers.forEach((c,i) => {const key=root(i); if(!groups.has(key)) groups.set(key,[]); groups.get(key).push(c);});
  const usable = [], excluded = [];
  for (const rows of groups.values()) {
    const ids = rows.map(c=>c.id ?? '(missing ID)');
    if (rows.some(c=>bool(c.doNotContact) || bool(c.optOut))) {excluded.push({ids,reason:'Opt-out or do-not-contact in identity group'}); continue;}
    const canonical = rows[0];
    // No silent merge of dates, intervals, consent or addresses.
    const same = rows.every(c=> ['location','lastServiceDate','intervalDays','dueDate','openQuote','quoteDate','duration','windowStart','windowEnd','service'].every(k => String(c[k] ?? '')===String(canonical[k] ?? '')) && JSON.stringify(c.skills ?? [])===JSON.stringify(canonical.skills ?? []));
    if (!same) {excluded.push({ids,reason:'Conflicting duplicate records; buyer review required'}); continue;}
    usable.push({...canonical, duplicateCount:rows.length});
  }
  return {usable, excluded};
}
export function dueEvidence(c, date) {
  const now=isoDay(date), reasons=[];
  if(now === null) return null;
  // Invalid provided dates and future service dates are quarantined, not ignored.
  for(const key of ['dueDate','lastServiceDate','quoteDate']) if(c[key] && isoDay(c[key]) === null) return null;
  if(c.lastServiceDate && isoDay(c.lastServiceDate)>now) return null;
  if(c.dueDate && isoDay(c.dueDate)<=now) reasons.push({reason:`Explicit due date ${c.dueDate}`, overdueDays:(now-isoDay(c.dueDate))/DAY, confidence:'high'});
  if(c.lastServiceDate && Number.isInteger(c.intervalDays) && c.intervalDays>0) {
    const due=isoDay(c.lastServiceDate)+c.intervalDays*DAY;
    if(due<=now) reasons.push({reason:`Last service ${c.lastServiceDate}; buyer-provided interval ${c.intervalDays} days; due ${new Date(due).toISOString().slice(0,10)}`,overdueDays:(now-due)/DAY,confidence:'high'});
  }
  if(bool(c.openQuote) && c.quoteDate && isoDay(c.quoteDate)<=now) reasons.push({reason:`Open quote dated ${c.quoteDate}; service need inferred from buyer-provided open quote, confirm interest`,overdueDays:(now-isoDay(c.quoteDate))/DAY,confidence:'medium'});
  return reasons.sort((a,b)=>(a.confidence==='high'?-1:1)-(b.confidence==='high'?-1:1) || b.overdueDays-a.overdueDays)[0] ?? null;
}

export function routeGaps(route, travel, minimum) {
  const {crew,stops}=route, gaps=[];
  for(let i=0;i<=stops.length;i++) {
    const before=stops[i-1], after=stops[i];
    const from=before?.location ?? crew.location, to=after?.location ?? crew.endLocation ?? crew.location;
    const start=before?.end ?? crew.start, deadline=after?.start ?? crew.end;
    const direct=travel(from,to), available=deadline-start-direct;
    if(available+1e-8>=minimum) gaps.push({id:`${crew.date}/${crew.id}/${i}`,crewId:crew.id,date:crew.date,index:i,start,end:deadline,directDriveMinutes:direct,availableMinutes:available,from,to,area:`Between ${from} and ${to}`,suggestions:[]});
  }
  return gaps;
}

export function plan(input) {
  const {jobs,crews,customers=[],matrix,routing}=input;
  if(!Array.isArray(jobs)||!Array.isArray(crews)||!crews.length||!Array.isArray(customers)) throw new Error('Jobs, crews and customers must be arrays; at least one crew is required');
  if(jobs.length>150 || crews.length>70 || customers.length>500) throw new Error('Prototype input limit: 150 jobs, 70 crew-day rows, 500 customers');
  if(!routing?.provider || !['synthetic','road'].includes(routing.kind)) throw new Error('Routing provenance must identify provider and kind (synthetic or road)');
  crews.forEach(validateCrew);
  if(new Set(crews.map(c=>`${c.date}/${c.id}`)).size!==crews.length) throw new Error('Duplicate crew-day rows are not allowed');
  const travel=matrixTravel(matrix), minimum=input.minimumGapMinutes ?? 30;
  if(!Number.isFinite(minimum)||minimum<=0) throw new Error('Minimum gap must be positive');
  const baseline=schedule(jobs,crews,travel,false), optimized=schedule(jobs,crews,travel,true);
  const sameSet=JSON.stringify(baseline.assignedRows)===JSON.stringify(optimized.assignedRows);
  // Never advertise a saving achieved by silently dropping a job.
  const result=baseline.assignedRows.length>optimized.assignedRows.length || (sameSet&&baseline.driveMinutes<optimized.driveMinutes) ? baseline : optimized;
  let comparison;
  if(JSON.stringify(baseline.assignedRows)!==JSON.stringify(result.assignedRows)) comparison='Not directly comparable: the input-order baseline serves a different set of jobs. Assignment coverage takes priority; no drive-time saving claimed.';
  else if(result.driveMinutes<baseline.driveMinutes-1e-8) comparison=`Same-job input-order baseline: ${baseline.driveMinutes.toFixed(1)} min; planned: ${result.driveMinutes.toFixed(1)} min; saving ${(baseline.driveMinutes-result.driveMinutes).toFixed(1)} min.`;
  else comparison='No reduction found versus the feasible input-order baseline for the same assigned jobs. Time windows, skills and the bounded heuristic can limit improvement; global optimality is not claimed.';
  const normalized=normalizeCustomers(customers), exclusions=[...normalized.excluded];
  const gapGroups=[];
  for(const route of result.routes) {
    const gaps=routeGaps(route,travel,minimum);
    for(const c of normalized.usable) {
      const due=dueEvidence(c,route.crew.date);
      if(!due) continue;
      if(!isId(c.id)||!isId(c.location)||!Number.isFinite(c.duration)||c.duration<=0||!Array.isArray(c.skills)) continue;
      // An existing scheduled visit for this customer needs no new backfill suggestion.
      if(result.routes.some(r=>r.crew.date===route.crew.date&&r.jobs.some(j=>j.customerId===c.id))) continue;
      for(const gap of gaps) {
        const job={id:`backfill:${c.id}`,date:route.crew.date,location:c.location,duration:c.duration,skills:c.skills,
          windowStart:c.windowStart ?? route.crew.start,windowEnd:c.windowEnd ?? route.crew.end};
        if(validateJob(job)) continue;
        // Fit entirely in the original gap. Later appointments are held at their original starts.
        const arrival=gap.start+travel(gap.from,c.location), start=Math.max(arrival,job.windowStart), end=start+c.duration;
        const onward=travel(c.location,gap.to);
        if(!Number.isFinite(end)||!Number.isFinite(onward)||end>job.windowEnd||end+onward>gap.end||!allSkills(route.crew,job)) continue;
        const order=route.jobs.toSpliced(gap.index,0,job);
        if(!evaluateRoute(route.crew,order,travel)) continue;
        const extra=travel(gap.from,c.location)+onward-gap.directDriveMinutes;
        gap.suggestions.push({customerId:c.id,name:c.name ?? c.id,start,end,extraDriveMinutes:extra,reason:due.reason,confidence:due.confidence,overdueDays:due.overdueDays,duplicateCount:c.duplicateCount,
          draft:`Hello ${c.name ?? c.id}, we have an opening on ${gap.date} at ${formatTime(start)} for ${c.service ?? 'your requested service'}. Would this work for you? Please reply to confirm. This is an offer, not a confirmed appointment.`});
      }
    }
    for(const gap of gaps) {gap.suggestions.sort((a,b)=>(a.confidence==='high'?0:1)-(b.confidence==='high'?0:1)||a.extraDriveMinutes-b.extraDriveMinutes||b.overdueDays-a.overdueDays||a.customerId.localeCompare(b.customerId));gap.suggestions=gap.suggestions.slice(0,5);}
    gapGroups.push(...gaps);
  }
  for(const c of normalized.usable) {
    let reason=null;
    if(!isId(c.id)||!isId(c.location)) reason='Missing ID or unresolved address';
    else if(!Number.isFinite(c.duration)||c.duration<=0||!Array.isArray(c.skills)) reason='Missing duration or skills';
    else if(!crews.some(r=>dueEvidence(c,r.date))) reason='No valid due evidence during the planning period';
    if(reason) exclusions.push({ids:[c.id ?? '(missing ID)'],reason});
  }
  return {...result,routing,minimumGapMinutes:minimum,baselineDriveMinutes:baseline.driveMinutes,comparison,gaps:gapGroups,excludedCustomers:exclusions,
    notes:['Suggestions are alternatives. Choose one per gap and rerun after accepting; a customer may appear in several alternative gaps.', 'No customer messages are sent. No default service interval is invented.', 'Travel times are estimates. All times use the buyer-selected local timezone; overnight shifts must be split into date rows.', 'Unassigned heuristic results are not proofs that no feasible schedule exists.']};
}
export const formatTime = m => `${String(Math.floor(Math.ceil(m)/60)).padStart(2,'0')}:${String(Math.ceil(m)%60).padStart(2,'0')}`;
const cell=x=>String(x??'').replaceAll('|','\\|').replaceAll('\n',' ');
export function markdownReport(p) {
  const lines=['# Field service schedule', '', `Routing: **${cell(p.routing.provider)}** (${p.routing.kind}).`,
    p.routing.kind==='synthetic'?'**DEMO ONLY: synthetic travel times. This is not a road-routing or live-agent acceptance result.**':'Road times are provider estimates, not a live traffic guarantee.',
    ...(p.routing.kind==='road'?[`Retrieved: ${cell(p.routing.retrievedAt ?? 'not supplied')}. Traffic model: ${cell(p.routing.traffic ?? 'not supplied')}.`,p.routing.attribution ?? '']:[]),
    '',p.comparison,'',`Assigned ${p.assignedRows.length}; unassigned ${p.unassigned.length}. Total drive time including return legs: ${p.driveMinutes.toFixed(1)} minutes.`];
  for(const r of p.routes) {
    lines.push('',`## ${cell(r.crew.date)} — ${cell(r.crew.id)}`,'','| Job | Location | Start | End | Drive min |','|---|---|---:|---:|---:|');
    for(const s of r.stops) lines.push(`| ${cell(s.id)} | ${cell(s.location)} | ${formatTime(s.start)} | ${formatTime(s.end)} | ${s.driveMinutes.toFixed(1)} |`);
    lines.push('',`Return drive ${r.returnMinutes.toFixed(1)} min; route finishes ${formatTime(r.finish)}.`);
  }
  lines.push('','## Unassigned input rows','');
  lines.push(...(p.unassigned.length?p.unassigned.map(x=>`- Row ${x.row+1}, ${cell(x.id)}: ${x.reason}`):['None.']));
  lines.push('','## Gaps and optional backfill','',`Minimum useful gap: ${p.minimumGapMinutes} minutes after direct travel. Each suggestion fits individually; do not book all alternatives.`);
  for(const g of p.gaps) {
    lines.push('',`### ${g.date} / ${cell(g.crewId)} / ${formatTime(g.start)}–${formatTime(g.end)}`,`Area: ${cell(g.area)}. Available service time after direct travel: ${g.availableMinutes.toFixed(1)} minutes.`);
    if(!g.suggestions.length) lines.push('No eligible, due customer fits this gap with the supplied routing and data.');
    for(const s of g.suggestions) lines.push('',`- **${cell(s.customerId)}**, ${formatTime(s.start)}–${formatTime(s.end)}; extra drive ${s.extraDriveMinutes.toFixed(1)} min; ${s.confidence} confidence. ${s.reason}`,`  Draft (not sent): ${cell(s.draft)}`);
  }
  lines.push('','## Data requiring review','',...p.excludedCustomers.map(e=>`- ${e.ids.map(cell).join(', ')}: ${e.reason}`),'','## Planning notes','',...p.notes.map(n=>`- ${n}`));
  return lines.join('\n')+'\n';
}
