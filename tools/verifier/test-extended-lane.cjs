'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {LIMITS,EXTENDED_LOCAL_LIMITS,resourceLimits,checkJob,decodeReplay,sha256}=require('./replay.cjs');
const {verifyBatch}=require('./verify.cjs');
function replay(left=[]){return zlib.deflateSync(Buffer.concat(['up','right','down','left','reset'].map(name=>{
 const list=name==='left'?left:[],b=Buffer.alloc(3+list.length*3);b.writeUIntLE(list.length,0,3);
 list.forEach((t,i)=>b.writeUIntLE(t-(i?list[i-1]:0),3+i*3,3));return b;
}))).toString('base64url');}
function job(timeMs,recording=replay()){return{resultId:'test',trackId:'0'.repeat(64),timeMs,replay:recording,replayHash:sha256(recording)};}
test('extended local resources are explicit, finite and leave defaults unchanged',()=>{
 assert.equal(resourceLimits(),LIMITS);assert.equal(resourceLimits('extended-local'),EXTENDED_LOCAL_LIMITS);
 assert.equal(LIMITS.frames,300000);assert.equal(LIMITS.jobs,16);assert.equal(LIMITS.cpuMs,20000);
 assert.equal(EXTENDED_LOCAL_LIMITS.jobs,1);assert.equal(EXTENDED_LOCAL_LIMITS.frames,3600000);
 assert.throws(()=>resourceLimits({frames:Infinity}));assert.throws(()=>resourceLimits('unlimited'));
 assert.throws(()=>checkJob(job(3600000)),e=>e.reason==='time_limit');
 assert.ok(checkJob(job(3600000),'extended-local'));
 assert.throws(()=>checkJob(job(3600001),'extended-local'),e=>e.reason==='time_limit');
});
test('extended lane permits extra bounded work but still checks original replay hashes and syntax',()=>{
 const r=replay(Array.from({length:5284},(_,i)=>i));
 assert.throws(()=>checkJob(job(100000,r)),e=>e.reason==='transition_limit');
 assert.equal(checkJob(job(100000,r),'extended-local').transitions,5284);
 assert.throws(()=>checkJob({...job(100000,r),replayHash:'0'.repeat(64)},'extended-local'),e=>e.reason==='replay_hash_mismatch');
 assert.throws(()=>decodeReplay('!invalid',100000,'extended-local'),e=>e.reason==='invalid_base64url');
 assert.throws(()=>decodeReplay(replay([100001]),100000,'extended-local'),e=>e.reason==='transition_after_claim');
 assert.throws(()=>decodeReplay(replay(Array.from({length:10001},(_,i)=>i)),100000,'extended-local'),e=>e.reason==='transition_limit');
});
test('extended lane cannot run multiple jobs or accept caller-created profiles',async()=>{
 await assert.rejects(verifyBatch('',[job(1),job(1)],[],{profile:'extended-local'}),/at most 1/);
 await assert.rejects(verifyBatch('',[],[],{profile:'unlimited'}),/Unknown verifier resource profile/);
});
test('extended publication needs explicit approval before any database calls',async()=>{
 const {publishResults}=await import('./runner.mjs');
 let calls=0;const db={get:async()=>{calls++;},call:async()=>{calls++;}};
 await assert.rejects(publishResults(db,[],[{binding:{resourceProfile:'extended-local'}}]),/not authorized|Invalid extended/);
 await assert.rejects(publishResults(db,[],[{binding:{resourceProfile:'extended-local'}}],{allowExtendedLocal:true}),/Invalid extended/);
 await assert.rejects(publishResults(db,[],[{binding:{resourceProfile:'unlimited'}}],{allowExtendedLocal:true}),/not authorized/);
 assert.equal(calls,0);
});
test('extended receipts and audits retain compute profile and verifier provenance',async()=>{
 const {publishResults}=await import('./runner.mjs');
 const {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION,verificationKey,verificationCollectionForTrack}=await import('../../workers/ranked/src/verification.js');
 const row={...job(100000),accountId:'racer',frames:100000,uploadId:1};
 const j={...row,resultId:'racer_'+row.trackId,queueKey:verificationKey(row),queueCollection:verificationCollectionForTrack(row.trackId)};
 const binding={resourceProfile:'extended-local',verifierFingerprint:'a'.repeat(64),engineDigest:VERIFIER_ENGINE_DIGEST,
  trackId:row.trackId,timeMs:row.timeMs,replayHash:row.replayHash,actualReplayHash:row.replayHash};
 const result={...j,status:'verified',reason:'native_exact_finish',engineDigest:VERIFIER_ENGINE_DIGEST,
  verifierVersion:VERIFIER_VERSION,deterministic:true,binding};
 let writes;
 const db={get:async collection=>collection===j.queueCollection?{data:{slots:{racer:{accountId:'racer',key:j.queueKey,status:'waiting'}}}}:
  collection==='0.6.2_race_results'?{data:row}:null,
  write:(collection,id,data)=>({collection,id,data}),call:async(_,body)=>{writes=body.writes;return{};}};
 const totals=await publishResults(db,[j],[result],{allowExtendedLocal:true});assert.equal(totals.verified,1);
 const slot=writes.find(w=>w.collection===j.queueCollection).data.slots.racer;
 const audit=writes.find(w=>w.collection==='0.6.2_s1_verification_audit').data;
 for(const data of [slot,audit]){assert.equal(data.resourceProfile,'extended-local');assert.equal(data.verifierFingerprint,binding.verifierFingerprint);}
});
test('extended candidates still obtain control proofs and exact-copy rejection',async()=>{
 const {createSimilarityReviewer,verifiedControlProof,similarityEvidence}=await import('./similarity.mjs');
 const {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION}=await import('../../workers/ranked/src/verification.js');
 const recording=replay(Array.from({length:5284},(_,i)=>i*7));
 const a={...job(100000,recording),accountId:'a'.repeat(64),resultId:'a',ingestedAt:1000};
 const b={...a,accountId:'b'.repeat(64),resultId:'b',ingestedAt:2000};
 const make=j=>({...j,status:'verified',reason:'native_exact_finish',engineDigest:VERIFIER_ENGINE_DIGEST,
  verifierVersion:VERIFIER_VERSION,binding:{resourceProfile:'extended-local'}});
 const results=[make(a),make(b)];
 await createSimilarityReviewer('/missing-snapshot')([a,b],results);
 assert.equal(verifiedControlProof(results[0]).transitions,5284);
 assert.equal(results[0].status,'verified');assert.equal(results[1].status,'mismatch');
 assert.equal(results[1].reason,'exact_duplicate_run');assert.equal(similarityEvidence(results[1]).kind,'identical_replay');
});
test('native verdict bindings survive Firestore serialization as usable cross-batch control proofs',async()=>{
 const {createSimilarityReviewer,verifiedControlProof}=await import('./similarity.mjs');
 const {publishResults,verifiedControlReference}=await import('./runner.mjs');
 const {encode,decode}=await import('./firestore.mjs');
 const {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION,verificationKey,verificationCollectionForTrack,pendingSlot}=await import('../../workers/ranked/src/verification.js');
 const {verdict}=require('./verify.cjs')._internals;
 const recording=replay(Array.from({length:30},(_,i)=>i*150));
 const row={...job(100000,recording),accountId:'racer',frames:100000,uploadId:1};
 const j={...row,resultId:'racer_'+row.trackId,queueKey:verificationKey(row),queueCollection:verificationCollectionForTrack(row.trackId)};
 const make=(j,status='verified')=>verdict(j,status,status==='verified'?'native_exact_finish':'native_engine_error',
  {engineFingerprint:VERIFIER_ENGINE_DIGEST},{id:j.trackId,hash:'c'.repeat(64)}, {deterministic:status==='verified'});
 const native=make(j);assert.equal(native.verifierVersion,undefined);assert.equal(native.binding.verifierVersion,VERIFIER_VERSION);
 await createSimilarityReviewer('/missing-snapshot')([j],[native]);assert(verifiedControlProof(native)?.informative);
 let queue={data:{trackId:row.trackId,slots:{racer:pendingSlot(row)}},updateTime:'q1'},writes=[];
 const db={get:async collection=>collection===j.queueCollection?queue:collection==='0.6.2_race_results'?{data:row}:null,
  write:(collection,id,data)=>({collection,id,data}),call:async(_,body)=>{writes=body.writes;return{};}};
 const totals=await publishResults(db,[j],[native]);assert.equal(totals.verified,1);
 const saved=decode(encode(writes.find(w=>w.collection===j.queueCollection).data));
 const ref=verifiedControlReference(saved.slots.racer,j.trackId);assert(ref);assert.equal(saved.slots.racer.controlProof.verifierVersion,VERIFIER_VERSION);
 const clone={...j,accountId:'clone',resultId:'clone_'+j.trackId,verifiedControlReferences:[ref]},copy=make(clone);
 await createSimilarityReviewer('/missing-snapshot')([clone],[copy]);assert.equal(copy.reason,'exact_duplicate_run');
 queue={data:saved,updateTime:'q2'};writes=[];
 const preserved=await publishResults(db,[j],[make(j,'unavailable')]);
 assert.equal(preserved.reasons.accepted_proof_preserved,1);assert.equal(writes.length,0);
});

