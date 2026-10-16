/** Small RFC-4180-style CSV reader. No expression evaluation or remote loading. */
export function parseCsv(text,{withHeaders=false}={}) {
  if(typeof text!=='string')throw new Error('CSV must be UTF-8 text');
  if(Buffer.byteLength(text,'utf8')>2*1024*1024) throw new Error('CSV exceeds 2 MiB');
  text=text.replace(/^\uFEFF/,'');
  const records=[];let record=[],field='',quoted=false,closed=false;
  const endField=()=>{record.push(field);field='';closed=false;};
  const endRow=()=>{endField();if(record.some(x=>x!==''))records.push(record);record=[];};
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(quoted) {if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c===','){endField();continue;}
    if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;endRow();continue;}
    if(closed) throw new Error('Unexpected text after a quoted CSV field');
    if(c==='"'){if(field.length)throw new Error('Unexpected quote in CSV field');quoted=true;}else field+=c;
  }
  if(quoted)throw new Error('Unclosed quoted CSV field');
  if(field!==''||record.length||closed)endRow();
  const headers=records.shift()?.map(x=>x.trim());
  if(!headers?.length||headers.some(x=>!x)||new Set(headers).size!==headers.length)throw new Error('CSV headers must be non-empty and unique');
  const rows=records.map((r,i)=>{if(r.length!==headers.length)throw new Error(`CSV row ${i+2} has the wrong column count`);return Object.fromEntries(headers.map((h,j)=>[h,r[j].trim()]));});
  return withHeaders?{headers,rows}:rows;
}
export function minute(s) {
  if(!/^\d{2}:\d{2}$/.test(s??''))return NaN;
  const [h,m]=s.split(':').map(Number);
  return h<=24&&m<60&&(h<24||m===0)?h*60+m:NaN;
}
const num=x=>x===''||x===undefined?undefined:Number(x);
const skills=x=>x===undefined?undefined:x.split(';').map(s=>s.trim()).filter(Boolean);
export function importRows(kind,text) {
  return parseCsv(text).map(r=>{
    if(kind==='jobs')return {...r,duration:num(r.duration),windowStart:minute(r.windowStart),windowEnd:minute(r.windowEnd),skills:skills(r.skills)};
    if(kind==='crews')return {...r,start:minute(r.start),end:minute(r.end),skills:skills(r.skills)};
    if(kind==='customers')return {...r,duration:num(r.duration),intervalDays:num(r.intervalDays),windowStart:r.windowStart?minute(r.windowStart):undefined,windowEnd:r.windowEnd?minute(r.windowEnd):undefined,skills:skills(r.skills)};
    throw new Error('Unknown CSV kind');
  });
}
// Neutralize spreadsheet formulas if input text is later opened in spreadsheet software.
export function csvCell(x) {let s=String(x??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function scheduleCsv(plan) {
  const rows=[['date','crew_id','job_id','location','start_minute','end_minute','drive_minutes']];
  for(const r of plan.routes)for(const s of r.stops)rows.push([r.crew.date,r.crew.id,s.id,s.location,s.start,s.end,s.driveMinutes]);
  return rows.map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
