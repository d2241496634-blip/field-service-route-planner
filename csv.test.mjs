import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv,importRows,minute,csvCell} from './csv.mjs';
test('CSV preserves quoted commas, escaped quotes and newlines',()=>{assert.deepEqual(parseCsv('\uFEFFid,name\r\na,"Smith, ""J""\nJr"\r\n'),[{id:'a',name:'Smith, "J"\nJr'}]);});
test('malformed and duplicate CSV headers are rejected',()=>{for(const csv of ['id,id\na,b','id,name\na','id,name\na,"b','id,name\na,"b"extra'])assert.throws(()=>parseCsv(csv));});
test('CSV conversion preserves missing interval and explicit false consent text',()=>{const [r]=importRows('customers','id,location,duration,skills,lastServiceDate,intervalDays,optOut\na,L0,30,general,2026-01-01,,false');assert.equal(r.intervalDays,undefined);assert.equal(r.optOut,'false');assert.deepEqual(r.skills,['general']);});
test('clock parsing rejects overflowing dates and exported cells cannot be formulas',()=>{assert.equal(minute('24:00'),1440);assert.ok(Number.isNaN(minute('25:00')));assert.ok(Number.isNaN(minute('12:60')));assert.equal(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');});
