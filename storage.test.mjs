import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {JsonStore,QuotaLedger,exclusiveLease,QuotaExceeded} from './storage.mjs';
import {MapsService} from './maps-service.mjs';
// Keep all test artifacts on the caller's project drive, not OS TEMP on C:.
async function temp(t){const root=path.resolve(process.cwd()),dir=await mkdtemp(path.join(root,'.test-state-'));t.after(()=>{if(path.dirname(path.resolve(dir))!==root||!path.basename(dir).startsWith('.test-state-'))throw new Error('Unsafe test cleanup path');return rm(dir,{recursive:true,force:true});});return dir;}
test('persistent store rejects traversal and corrupted state; lease refuses simultaneous processes',async t=>{
  const dir=await temp(t),store=new JsonStore(dir);await store.set('x',{a:1});assert.deepEqual(await store.get('x'),{a:1});assert.throws(()=>store.file('../x'));
  const release=await exclusiveLease(dir);await assert.rejects(()=>exclusiveLease(dir),/lock/);await release();
  await writeFile(store.file('x'),'{');await assert.rejects(()=>store.get('x'),/unreadable/);
});
test('quota serializes concurrent attempts, persists failures and allows only rolling-window expiry',async t=>{
  const dir=await temp(t),store=new JsonStore(dir);let now=100000000;
  const opts={limit:10,spacingMs:0,now:()=>now};const q=new QuotaLedger(store,opts);
  const outcomes=await Promise.allSettled([q.reserve(6),q.reserve(6)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.ok(outcomes.some(r=>r.reason instanceof QuotaExceeded));
  const restarted=new QuotaLedger(new JsonStore(dir),opts);await assert.rejects(()=>restarted.reserve(6),QuotaExceeded);
  now+=86400001;assert.ok(await restarted.reserve(6));
});
test('quota settles documented cost, preserves remaining headroom and freezes on unexpected cost',async t=>{
  const store=new JsonStore(await temp(t)),q=new QuotaLedger(store,{limit:100,spacingMs:0});
  const id=await q.reserve(80);await q.settle(id,10);const id2=await q.reserve(80);await assert.rejects(()=>q.settle(id2,81),/frozen/);await assert.rejects(()=>q.reserve(1),/frozen/);
});
test('map cache is isolated by job directory; cached reruns consume no request; failed calls retain reservation',async t=>{
  const dir=await temp(t),quota=new QuotaLedger(new JsonStore(dir),{spacingMs:0});let calls=0;
  const fetchImpl=async()=>{calls++;return {ok:true,json:async()=>({results:[]})};};
  const a=new MapsService({apiKey:'TEST',quota,cache:new JsonStore(path.join(dir,'job-a')),fetchImpl});
  await a.geocode('Address in city','us');await a.geocode('Address in city','us');assert.equal(calls,1);
  const b=new MapsService({apiKey:'TEST',quota,cache:new JsonStore(path.join(dir,'job-b')),fetchImpl});await b.geocode('Address in city','us');assert.equal(calls,2);
  const bad=new MapsService({apiKey:'TEST',quota,cache:new JsonStore(path.join(dir,'job-c')),fetchImpl:async()=>{throw new Error('TEST');}});await assert.rejects(()=>bad.geocode('Address in city','us'));
  const state=JSON.parse(await readFile(path.join(dir,'geo-quota.json'),'utf8'));assert.equal(state.entries.filter(e=>e.status==='reserved').length,1);
});
