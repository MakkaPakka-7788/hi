import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEventService,EVENT_COLLECTIONS as C,eventPeriod} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION,pendingSlot,VERIFICATION_COLLECTION} from '../src/verification.js';
import {mergeCanonicalResultIntoTrack} from '../src/index.js';
import {PERMANENT_ROLLING_HILLS as R} from '../src/permanent-rolling-hills.js';
import {advanceEventPublication,publishEventCapacity} from '../src/event-publication.js';
import {EVENT_RETENTION_COLLECTION} from '../src/event-capacity.js';
import {loadPublicationEntries,decodePublicationPage,preparePublicationPages,PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';

const track='a'.repeat(64),hash=v=>createHash('sha256').update(v).digest('hex');
const capacity={policyVersion:'event-capacity-test-v2',entrants:531,admissionsPerPeriod:2048,replayBytesPerPeriod:16777216,minIntervalMs:1000,verificationsPerDay:1536,storageVersion:2};
const period={id:'capacity_day',trackId:track,enabled:true,startsAt:1000,endsAt:86401000,graceMs:1000,targetMs:10000,maxRp:100,kind:'daily',eligibility:'best-submitted-during-period',capacity};
function fixture(){
 const data=new Map(),counts=[],calls=[];let time=0,nonce=0,snapshot=null;
 const store={transaction:async fn=>{
   const copy=structuredClone(data),reads=new Set();let writing=false,writes=0;
   const get=async key=>{assert.equal(writing,false);reads.add(key);assert.ok(reads.size<=16);return structuredClone(copy.get(key)||null);};
   const write=(key,value,mode)=>{writing=true;assert.ok(++writes<=16);if(mode!=='create')assert.ok(reads.has(key));if(mode==='create')assert.equal(copy.has(key),false);if(mode==='delete')copy.delete(key);else copy.set(key,structuredClone(mode==='patch'?{...copy.get(key),...value}:value));};
   const result=await fn({get,set:(k,v)=>write(k,v,'set'),create:(k,v)=>write(k,v,'create'),patch:(k,v)=>write(k,v,'patch'),delete:k=>write(k,null,'delete')});
   data.clear();for(const [k,v]of copy)data.set(k,v);counts.push({reads:reads.size,writes});return result;
 }};
 const base='projects/polytrack-052/databases/(default)/documents/';
 const wire=(key,source=data)=>({name:base+key,fields:eventEncode(source.get(key)).mapValue.fields,updateTime:'v1'});
 const request=async(route,init={})=>{
   calls.push(route);const body=init.body?JSON.parse(init.body):null;
   if(route===':runQuery'){
     if(!body.readTime)snapshot=structuredClone(data);
     const source=body.readTime?snapshot:data,q=body.structuredQuery,collection=q.from[0].collectionId;
     const after=q.startAt?.values?.[0]?.referenceValue||'',filter=q.where?.fieldFilter;
     const rows=[...source].filter(([key,value])=>key.startsWith(collection+'/')&&base+key>after&&(!filter||value[filter.field.fieldPath]===filter.value.stringValue)).sort(([a],[b])=>a.localeCompare(b)).slice(0,q.limit);
     return rows.length?rows.map(([key])=>({document:wire(key,source),readTime:new Date(time).toISOString()})):[{readTime:new Date(time).toISOString()}];
   }
   if(route===':batchGet'){const source=body.readTime?snapshot:data;return body.documents.map(name=>source.has(name.slice(base.length))?{found:wire(name.slice(base.length),source)}:{missing:name});}
   if(route===':commit'){for(const w of body.writes)data.set(w.update.name.slice(base.length),eventDecode({mapValue:{fields:w.update.fields}}));return {};}
   const key=route.slice(1);return data.has(key)?wire(key):null;
 };
 const service=createEventService({store,now:()=>time,hash,randomId:()=>`lease_${nonce++}`});
 const runtime={store,service,request,now:()=>time,projectId:'polytrack-052'};
 return {data,counts,calls,service,runtime,time:t=>time=t,wire};
}
const verdict=job=>({resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,
 binding:{resultId:job.resultId,trackId:job.trackId,nativeTrackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:job.replayHash,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}});

test('storage-v2 admits racer 201, preserves pre-upgrade bindings, and pages real verified PBs and totals',async()=>{
 const f=fixture();await f.service.createPeriod({...period,capacity:{...capacity,storageVersion:undefined,entrants:200}});f.time(2000);
 let oldest;
 for(let i=0;i<201;i++){
   const accountId=hash('event-racer-'+i),ownerUid='owner-'+i;f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid,name:'Racer '+i});
   if(i===1)await f.service.upgradeCapacity(period.id,capacity);
   const submitted=await f.service.submit(period.id,ownerUid,{accountId,trackId:track,attemptId:'attempt',timeMs:10000+i,frames:10000+i,replay:'abcd',carStyle:'style'});
   if(!i)oldest={...f.data.get(C.runs+'/'+submitted.runId)};
 }
 const queue=f.data.get(C.queues+'/'+period.id);
 assert.equal(queue.entrants,201);assert.equal(queue.runIds.length,1);assert.equal(queue.subjects.length,1);assert.equal(queue.retentionPages,2);
 for(const [key,value]of f.data)if(key.startsWith(EVENT_RETENTION_COLLECTION+'/'))assert.ok(value.runIds.length<=100);
 assert.equal(f.data.get(C.runs+'/'+oldest.runId).eventKey,oldest.eventKey);
 for(let batch=0;batch<51;batch++)await f.service.processBatch(period.id,async jobs=>jobs.map(verdict));
 assert.equal(f.data.get(C.pbs+'/'+period.id+'_'+oldest.accountId).timeMs,10000);
 assert.equal(f.data.get(C.queues+'/'+period.id).slots.length,0);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[period.id]);
 const built=await advanceEventPublication(f.runtime,period.id);assert.equal(built.totalEntries,201);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 const board=await f.service.snapshot(period.id);assert.equal(board.entries.length,200);assert.equal(board.totalEntries,201);assert.equal(board.sourceComplete,true);
 const last=await f.service.publicPage('event',period.id,board.pagination.generation,2);assert.equal(last.entries.length,1);assert.equal(last.entries[0].name,'Racer 200');
 const replay=await f.service.replay(period.id,hash('event-racer-200'));assert.equal(replay.verified,true);
 const totals=await advanceEventPublication(f.runtime);assert.equal(totals.totalEntries,201);
 const publicTotals=await f.service.totals();assert.equal(publicTotals.entries.length,200);assert.equal(publicTotals.totalEntries,201);
 assert.ok(f.counts.every(c=>c.reads<=16&&c.writes<=16));
 f.time(period.endsAt+period.graceMs);await f.service.archivePeriod(period.id);const archived=await f.service.snapshot(period.id);assert.equal(archived.pagination.totalEntries,201);
});

test('531 event PBs and 1001 finite totals publish all rows with cross-page tied ranks',async()=>{
 const f=fixture();await f.service.createPeriod(period);f.time(2000);
 for(let i=0;i<1001;i++){
   const accountId=hash('fixture-'+i),timeMs=10000+Math.floor(i/2);
   f.data.set(C.totals+'/'+accountId,{accountId,name:'Full Racer '+i,rp:1000-Math.floor(i/2),events:1});
   if(i<531)f.data.set(C.pbs+'/'+period.id+'_'+accountId,{periodId:period.id,accountId,name:'Full Racer '+i,timeMs,submittedAt:2000,carStyle:'style'});
 }
 f.data.set(C.live+'/'+period.id,{period:eventPeriod(period),entries:[],racerCount:531,publicationPending:true,revision:531});
 f.data.set(C.public+'/totals',{entries:[],publicationPending:true,revision:1001});
 for(const target of [period.id,null]){let result;for(let pass=0;pass<8;pass++){const start=f.calls.length;result=await advanceEventPublication(f.runtime,target);assert.ok(f.calls.length-start<50);if(!result.pending)break;}assert.equal(result.published,true);}
 const board=await f.service.snapshot(period.id),entries=await loadPublicationEntries(board,'event',period.id,async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(entries.length,531);assert.equal(entries[99].rank,99);assert.equal(entries[100].rank,101);
 const totals=await f.service.totals(),all=await loadPublicationEntries(totals,'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(all.length,1001);assert.equal(all[999].rank,999);assert.equal(all[1000].rank,1001);
});

test('large per-page planner data is compressed at rest and fully retained on the wire',async()=>{
 const rows=Array.from({length:100},(_,i)=>({userId:'racer-'+i,resultSamples:Array.from({length:200},(_,j)=>({trackId:'track-'+j,rank:i+1,fieldSize:1001,weight:3.234,competition:1,timeMs:20000+i+j,pbAt:1000}))}));
 const paged=await preparePublicationPages('overall','main',rows,{sourceRevision:7});
 assert.equal(paged.documents.length,1);assert.ok(paged.documents[0].data.pageBundle);assert.ok(JSON.stringify(paged.documents[0].data).length<800000);
 const decoded=await decodePublicationPage(paged.documents[0].data);assert.deepEqual(decoded.entries,rows);
});


async function combinedFixture(){
 const f=fixture(),a=hash('rolling-a'),b=hash('rolling-b'),c=hash('finite-c');
 const canonical=(accountId,timeMs,uploadId=1)=>({accountId,userId:accountId,trackId:R.trackId,timeMs,frames:timeMs,raceTimeFrames:timeMs,
   replay:'abcd',replayHash:hash('abcd'),uploadId,createdAt:1000,updatedAt:1000,pbAt:1000,name:accountId===a?'Rolling A':'Rolling B'});
 const rows=[canonical(a,10000),canonical(b,20000)];
 for(const row of rows)f.data.set('0.6.2_race_results/'+row.accountId+'_'+R.trackId,row);
 f.data.set(VERIFICATION_COLLECTION+'/'+R.trackId,{trackId:R.trackId,slots:Object.fromEntries(rows.map(row=>[row.accountId,
   {...pendingSlot(row,1000),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}]))});
 f.data.set(R.collection+'/'+R.trackId,{trackId:R.trackId,algorithmVersion:R.algorithmVersion,schemaVersion:R.minimumSchemaVersion,
   revision:1,sourceRevision:1,signature:'valid_rolling_snapshot_1',builtAt:2000,updatedAt:2000,complete:true,totalEntries:2,
   entries:rows.map((row,i)=>({...row,runVerified:true,integrityVerified:true,rank:i+1,position:i+1,fieldSize:2}))});
 const finite=[{accountId:b,name:'Rolling B',rp:400,events:1},{accountId:c,name:'Finite C',rp:950,events:1}];
 for(const row of finite)f.data.set(C.totals+'/'+row.accountId,row);
 f.data.set(C.public+'/totals',{entries:finite,totalEntries:2,complete:true,revision:7,publicationPending:true});
 f.time(2000);assert.equal((await advanceEventPublication(f.runtime)).published,true);
 const commits=[];
 const env={__TEST_FIRESTORE:async(route,init)=>{if(route===':commit')commits.push(JSON.parse(init.body));return f.runtime.request(route,init);}};
 const improve=async(timeMs=9000,uploadId=2)=>{
   const row=canonical(b,timeMs,uploadId);f.time(2000+uploadId*1000);
   f.data.set('0.6.2_race_results/'+b+'_'+R.trackId,row);
   const queue=f.data.get(VERIFICATION_COLLECTION+'/'+R.trackId);
   queue.slots[b]={...pendingSlot(row,3000),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION};
   const result=await mergeCanonicalResultIntoTrack(env,R.trackId,row,true);
   return {result,row};
 };
 return {...f,a,b,c,improve,env,commits};
}

test('Rolling Hills-only PB invalidates combined RP atomically, preserves last good generation, and rebuilds ranks',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 assert.deepEqual(prior.entries.map(row=>[row.accountId,row.rp,row.rank]),[[f.a,1001,1],[f.c,950,2],[f.b,900,3]]);
 const finite=structuredClone([...f.data].filter(([key])=>key.startsWith(C.totals+'/')));
 const {result,row}=await f.improve();assert.equal(result.changed,true);
 assert.equal(result.entries.find(value=>value.accountId===f.b).runVerified,true);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal(f.data.get(C.public+'/totals').revision,7);
 assert.deepEqual([...f.data].filter(([key])=>key.startsWith(C.totals+'/')),finite);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 const mutation=f.commits.find(commit=>commit.writes.some(w=>w.update.name.endsWith('/'+R.collection+'/'+R.trackId)));
 assert.ok(mutation);
 for(const path of [R.collection+'/'+R.trackId,C.public+'/totals']){
   const write=mutation.writes.find(w=>w.update.name.endsWith('/'+path));assert.ok(write);assert.equal(write.currentDocument.updateTime,'v1');
 }
 const after=f.calls.length;assert.equal((await publishEventCapacity(f.runtime)).published,true);assert.ok(f.calls.length-after<50);
 const current=f.data.get(C.public+'/totals_full');assert.notEqual(current.pagination.generation,prior.pagination.generation);
 assert.deepEqual(current.entries.map(value=>[value.accountId,value.rp,value.rank]),[[f.b,1401,1],[f.c,950,2],[f.a,900,3]]);
 assert.equal(current.dynamicComponents.permanentRollingHills.sourceRevision,2);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 assert.equal((await f.service.publicPage('event_totals','main',prior.pagination.generation,0)).entries[0].accountId,f.a);
 const beforeDuplicate=f.calls.length;assert.equal((await mergeCanonicalResultIntoTrack(f.env,R.trackId,row,true)).changed,false);
 assert.ok(!f.calls.slice(beforeDuplicate).includes('/'+C.public+'/totals'));
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 assert.ok(f.counts.every(value=>value.reads<=16&&value.writes<=16));
});

test('combined publication defers an unavailable permanent source without replacing last good totals',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 await f.improve();const rolling=f.data.get(R.collection+'/'+R.trackId);rolling.complete=false;
 const result=await publishEventCapacity(f.runtime);assert.equal(result.reason,'permanent_source_unavailable');assert.equal(result.pending,true);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 f.data.get(R.collection+'/'+R.trackId).complete=true;assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,2);
});

test('PB racing immutable page staging cannot publish obsolete combined ranks or clear durable work',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 await f.improve();const request=f.runtime.request;let raced=false,staged=[];
 f.runtime.request=async(route,init)=>{
   const result=await request(route,init);
   if(route===':commit'&&!raced){
     const writes=JSON.parse(init.body).writes;
     if(writes.some(w=>w.update.name.includes('/'+PUBLIC_PAGE_COLLECTION+'/'))){raced=true;staged=writes;await f.improve(8000,3);}
   }
   return result;
 };
 const result=await publishEventCapacity(f.runtime);assert.equal(raced,true);assert.equal(result.reason,'permanent_source_changed');
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 const stagedGeneration=eventDecode({mapValue:{fields:staged[0].update.fields}}).generation;
 await assert.rejects(()=>f.service.publicPage('event_totals','main',stagedGeneration,0));
 f.runtime.request=request;assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,3);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
});

test('idle event coordinator reads exactly one dirty-signal document and never writes or scans',async()=>{
 const f=fixture();assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
 f.data.set(C.public+'/totals',{revision:4,publicationPending:false,pendingPeriodIds:[]});
 f.calls.length=0;const transactions=f.counts.length;
 for(let i=0;i<10;i++)assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
 assert.deepEqual(f.calls,Array(10).fill('/'+C.public+'/totals'));assert.equal(f.counts.length,transactions);
});


test('blocked permanent dependency yields to pending event periods without acknowledging combined work',async()=>{
 const f=await combinedFixture();f.time(0);await f.service.createPeriod(period);await f.improve();
 f.data.get(R.collection+'/'+R.trackId).complete=false;
 f.data.get(C.public+'/totals').pendingPeriodIds=[period.id];
 f.data.set(C.public+'/'+period.id,{period:eventPeriod(period),entries:[],publicationPending:true,revision:1,racerCount:1});
 f.data.set(C.pbs+'/'+period.id+'_'+f.a,{periodId:period.id,accountId:f.a,name:'Rolling A',timeMs:10000,submittedAt:2000});
 assert.equal((await publishEventCapacity(f.runtime)).reason,'permanent_source_unavailable');
 const result=await publishEventCapacity(f.runtime);assert.equal(result.published,true);assert.equal(result.id,period.id);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
});


test('legacy inline event publication leaves no period work behind or perpetual polling',async()=>{
 const f=fixture();await f.service.createPeriod({...period,capacity:{...capacity,storageVersion:undefined,entrants:200}});f.time(2000);
 const accountId=hash('legacy-inline'),ownerUid='legacy-owner';
 f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid,name:'Legacy Racer'});
 f.data.set(C.public+'/totals',{entries:[],revision:0,pendingPeriodIds:[period.id]});
 await f.service.submit(period.id,ownerUid,{accountId,trackId:track,attemptId:'legacy',timeMs:10000,frames:10000,replay:'abcd',carStyle:'style'});
 await f.service.processBatch(period.id,async jobs=>jobs.map(verdict));
 assert.equal(f.data.get(C.public+'/'+period.id).publicationPending,false);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 const start=f.calls.length,transactions=f.counts.length;
 assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
 assert.deepEqual(f.calls.slice(start),['/'+C.public+'/totals']);assert.equal(f.counts.length,transactions);
});
