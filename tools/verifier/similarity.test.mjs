import test from 'node:test';
import assert from 'node:assert/strict';
import {compareControls,createSimilarityReviewer,similarityEvidence} from './similarity.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {encodeSnapshot} from '../snapshot-package.mjs';
import {publishResults} from './runner.mjs';
import {verificationKey,VERIFICATION_COLLECTION,VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION} from '../../workers/ranked/src/verification.js';

test('partial copied inputs flag review without denying physically verified runs',async()=>{
  const pack=lists=>{
    const parts=Object.values(lists).map(list=>{
      const bytes=Buffer.alloc(3+list.length*3);bytes.writeUIntLE(list.length,0,3);
      list.forEach((tick,i)=>bytes.writeUIntLE(tick-(i?list[i-1]:0),3+i*3,3));return bytes;
    });return deflateSync(Buffer.concat(parts)).toString('base64url');
  };
  const shared={up:[0],right:Array.from({length:12},(_,i)=>100+i*200),down:Array.from({length:12},(_,i)=>200+i*200),left:[],reset:[]};
  const a={...shared,right:[...shared.right,...Array.from({length:16},(_,i)=>5000+i*100)]};
  const b={...shared,right:[...shared.right,...Array.from({length:16},(_,i)=>5101+i*131)]};
  assert.equal(compareControls({lists:a},{lists:b},8000,8001),null);
  const jobs=[a,b].map((lists,i)=>{
    const replay=pack(lists);return {resultId:'partial-'+i,accountId:String(i+1).repeat(64),trackId:'a'.repeat(64),timeMs:8000+i*1500,replay,replayHash:createHash('sha256').update(replay).digest('hex')};
  });
  const results=jobs.map(j=>({resultId:j.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId:j.trackId,timeMs:j.timeMs,replayHash:j.replayHash}));
  await createSimilarityReviewer('/missing-snapshot')(jobs,results);
  for(const result of results){assert.equal(result.status,'verified');const evidence=similarityEvidence(result);assert.equal(evidence.kind,'similar_top_inputs');assert.equal(evidence.reviewOnly,true);assert(evidence.matchedChanges>=20);}
});
const turns=Array.from({length:24},(_,i)=>100+i*200);
const controls={lists:{up:[0],right:turns,down:[],left:[],reset:[]}};
test('complex exact inputs create advisory evidence',()=>{
  assert.equal(compareControls(controls,controls,6000,6000).inputSimilarity,1);
});
test('holding forward and short scripts are not clone evidence',()=>{
  assert.equal(compareControls({lists:{up:[0],right:[],down:[],left:[],reset:[]}}, {lists:{up:[0],right:[],down:[],left:[],reset:[]}},6000,6000),null);
});
test('exactly identical inputs without informative activity cannot block a run',()=>{
  const low={lists:{up:[0],right:[100],down:[],left:[],reset:[]}};
  assert.equal(compareControls(low,low,6000,6000),null);
});
test('different timings and mismatched lengths do not qualify',()=>{
  assert.equal(compareControls(controls,{lists:{up:[0],right:turns.map(t=>t+1),down:[],left:[],reset:[]}},6000,6000),null);
  assert.equal(compareControls(controls,controls,6000,9000),null);
});
test('client-provided evidence cannot become server review evidence',()=>{
  assert.equal(similarityEvidence({reviewEvidence:{kind:'similar_top_inputs'}}),undefined);
});
test('missing snapshot cannot interrupt physics verification',async()=>{
  const results=[{status:'verified',resultId:'x'}];
  assert.equal(await createSimilarityReviewer('/missing-snapshot')([{resultId:'x',trackId:'a'.repeat(64),replay:'bad',timeMs:6000}],results),results);
});
test('real decoded exact clones are denied, near-time matches are review-only, and low-information patterns are ignored',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'similarity-'));
  try {
    const parts=[];
    for(const list of Object.values(controls.lists)) {
      const bytes=Buffer.alloc(3+list.length*3);bytes.writeUIntLE(list.length,0,3);
      list.forEach((tick,i)=>bytes.writeUIntLE(tick-(i?list[i-1]:0),3+i*3,3));parts.push(bytes);
    }
    const replay=deflateSync(Buffer.concat(parts)).toString('base64url');
    const hash=createHash('sha256').update(replay).digest('hex'),trackId='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038',accountId='b'.repeat(64);
    const dir=path.join(root,'public-snapshots1');await fs.mkdir(dir);
    const files={};
    for(const [logical,data] of Object.entries({[`tracks/${trackId}.json`]:{updatedAt:123,entries:[{id:1,accountId,rank:1,timeMs:6000,replayHash:hash,runVerified:true,integrityVerified:true}]},'recordings/1.json':{trackId,accountId,recording:replay,replayHash:hash}})) {
      const bytes=await encodeSnapshot(data),sha256=createHash('sha256').update(bytes).digest('hex');
      files[logical]={path:sha256+'.bin',sha256};await fs.writeFile(path.join(dir,sha256+'.bin'),bytes);
    }
    await fs.writeFile(path.join(dir,'index.json'),JSON.stringify({files}));
    await fs.writeFile(path.join(root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots1'}));
    const reviewer=createSimilarityReviewer(root);
    const result={resultId:'x',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:6000};
    await reviewer([{resultId:'x',accountId:'c'.repeat(64),trackId,timeMs:6000,replay,replayHash:hash}], [result]);
    assert.equal(result.status,'mismatch');
    assert.equal(result.reason,'exact_duplicate_run');
    assert.equal(similarityEvidence(result).kind,'identical_replay');
    assert.equal(similarityEvidence(result).trackName,'Summer 1');
    assert.equal(similarityEvidence(result).referenceAccountId,accountId);
    assert.equal(similarityEvidence(result).finishGapMs,0);
    const row={accountId:'c'.repeat(64),trackId,timeMs:6000,frames:6000,raceTimeFrames:6000,uploadId:2,replay,replayHash:hash};
    const job={...row,resultId:'x',queueKey:verificationKey(row),queueCollection:VERIFICATION_COLLECTION};
    Object.assign(result,{engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,reason:'native_exact_finish'});
    let reads=0,writes;
    const db={get:async(collection)=>{reads++;return collection===VERIFICATION_COLLECTION?{data:{slots:{[row.accountId]:{accountId:row.accountId,key:job.queueKey,status:'waiting'}}}}:collection==='0.6.2_race_results'?{data:row}:null;},
      write:(collection,id,data)=>({collection,id,data}),call:async(_,{writes:batch})=>{writes=batch;return {};}};
    const totals=await publishResults(db,[job],[result]);
    assert.equal(reads,5,'only flagged runs add one review-inbox lookup');
    assert.equal(writes.length,4,'only flagged runs add one review-inbox write');
    assert.equal(writes.find(w=>w.collection==='0.6.2_s1_verification_audit').data.needsReview,true);
    assert.equal(writes.find(w=>w.collection==='0.6.2_s1_verification_audit').data.reviewEvidence.kind,'identical_replay');
    assert.equal(totals.reviewFlagged,1);
    const near={resultId:'near',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:6005};
    await reviewer([{resultId:'near',accountId:'c'.repeat(64),trackId,timeMs:6005,replay,replayHash:hash}],[near]);
    assert.equal(near.status,'verified');
    assert.equal(similarityEvidence(near).kind,'similar_top_inputs');
    assert.equal(similarityEvidence(near).finishGapMs,5);
    const batchA={resultId:'batch-a',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7000};
    const batchB={resultId:'batch-b',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7000};
    await reviewer([{resultId:'batch-b',accountId:'e'.repeat(64),trackId,timeMs:7000,replay,replayHash:hash,ingestedAt:'2026-10-11T00:00:02Z'},
      {resultId:'batch-a',accountId:'d'.repeat(64),trackId,timeMs:7000,replay,replayHash:hash,ingestedAt:'2026-10-11T00:00:01Z'}],[batchA,batchB]);
    assert.equal(batchA.status,'verified','earliest trusted ingestion remains the winner');
    assert.equal(similarityEvidence(batchA),undefined);
    assert.equal(batchB.status,'mismatch');
    assert.equal(batchB.reason,'exact_duplicate_run');
    assert.equal(similarityEvidence(batchB).referenceSnapshot,'same_batch');
    const sameAccountA={resultId:'same-account-a',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7100};
    const sameAccountB={resultId:'same-account-b',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7100};
    await reviewer([{resultId:'same-account-a',accountId:'f'.repeat(64),trackId,timeMs:7100,replay,replayHash:hash,ingestedAt:'2026-10-11T00:00:01Z'},
      {resultId:'same-account-b',accountId:'f'.repeat(64),trackId,timeMs:7100,replay,replayHash:hash,ingestedAt:'2026-10-11T00:00:02Z'}],[sameAccountA,sameAccountB]);
    assert.equal(sameAccountA.status,'verified');
    assert.equal(sameAccountB.status,'verified','same-account repetitions are not duplicate-account enforcement');
    for(const dates of [[undefined,undefined],['2026-10-11T00:00:01Z','2026-10-11T00:00:01Z'],['2026-10-11T00:00:01Z',undefined]]){
      const jobs=['a','b'].map((letter,i)=>({resultId:'ambiguous-'+letter,accountId:letter.repeat(64),trackId,timeMs:7200,replay,replayHash:hash,ingestedAt:dates[i]}));
      const results=jobs.map(job=>({resultId:job.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7200}));
      await reviewer(jobs,results);
      assert.equal(results[1].status,'unavailable','missing or tied server order never selects a losing account by ID');
      assert.equal(results[1].reason,'identical_replay_pending_manual_review');
      assert.equal(similarityEvidence(results[1]).kind,'identical_replay');
      assert.equal(results[0].status,'unavailable');
    }
    {
      const jobs=['a','b','c'].map((letter,i)=>({resultId:'three-'+letter,accountId:letter.repeat(64),trackId,timeMs:7300,replay,replayHash:hash,ingestedAt:i===2?'2026-10-11T00:00:02Z':'2026-10-11T00:00:01Z'}));
      const results=jobs.map(job=>({resultId:job.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7300}));
      await reviewer(jobs,results);assert.deepEqual(results.map(r=>r.status),['unavailable','unavailable','mismatch']);
      assert.equal(results[2].reason,'exact_duplicate_run','a definitely later copy is denied even when the original pair ties');
    }
    for(const wrap of [value=>new Date(value),value=>({__firestoreTimestamp:value})]){
      const jobs=['a','b'].map((letter,i)=>({resultId:'server-date-'+letter,accountId:letter.repeat(64),trackId,timeMs:7400,replay,replayHash:hash,ingestedAt:wrap('2026-10-11T00:00:0'+(i+1)+'Z')}));
      const results=jobs.map(job=>({resultId:job.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:7400}));
      await reviewer(jobs,results);assert.deepEqual(results.map(r=>r.status),['verified','mismatch'],'trusted Firestore timestamp representations preserve server order');
    }
    const correctedCandidate={resultId:'candidate',accountId:'f'.repeat(64),trackId,timeMs:6000,replay,replayHash:hash,correctionCandidate:{frames:6000}};
    const candidateResult={resultId:'candidate',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:6000};
    await reviewer([correctedCandidate],[candidateResult]);
    assert.equal(candidateResult.status,'verified');
    assert.equal(similarityEvidence(candidateResult),undefined);
    const self={resultId:'self',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:6000};
    await reviewer([{resultId:'self',accountId,trackId,timeMs:6000,replay,replayHash:hash}],[self]);
    assert.equal(self.status,'verified','a racer matching their own trusted history is ignored');
    assert.equal(similarityEvidence(self),undefined);
    const selfNear={resultId:'self-near',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:6005};
    await reviewer([{resultId:'self-near',accountId,trackId,timeMs:6005,replay,replayHash:hash}],[selfNear]);
    assert.equal(selfNear.status,'verified');
    assert.equal(similarityEvidence(selfNear),undefined);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('rapid-input evidence is integrated without changing a bound verified verdict',async()=>{
 const lists={up:[0],right:[],down:[],left:Array.from({length:11},(_,i)=>[i*80,i*80+1]).flat(),reset:[]};
 const parts=Object.values(lists).map(list=>{const b=Buffer.alloc(3+list.length*3);b.writeUIntLE(list.length,0,3);list.forEach((tick,i)=>b.writeUIntLE(tick-(i?list[i-1]:0),3+i*3,3));return b;});
 const replay=deflateSync(Buffer.concat(parts)).toString('base64url'),hash=createHash('sha256').update(replay).digest('hex'),trackId='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
 const result={resultId:'rate',status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackId,replayHash:hash,timeMs:2000};
 await createSimilarityReviewer('/missing-snapshot')([{resultId:'rate',accountId:'a'.repeat(64),trackId,timeMs:2000,replay,replayHash:hash}],[result]);
 assert.equal(result.status,'verified');assert.equal(similarityEvidence(result).kind,'rapid_input');
 const wrong={...result,resultId:'wrong',replayHash:'0'.repeat(64)};
 await createSimilarityReviewer('/missing-snapshot')([{resultId:'wrong',accountId:'a'.repeat(64),trackId,timeMs:2000,replay,replayHash:hash}],[wrong]);assert.equal(similarityEvidence(wrong),undefined);
});
