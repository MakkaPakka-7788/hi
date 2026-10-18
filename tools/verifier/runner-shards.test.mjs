import test from 'node:test';
import assert from 'node:assert/strict';
import {selectJobs,publishResults} from './runner.mjs';
import {pendingSlot,VERIFICATION_COLLECTION as C,VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION,verificationKey} from '../../workers/ranked/src/verification.js';
import {verificationShardId} from '../../workers/ranked/src/verification-shards.js';

const track='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const canonical=accountId=>({accountId,trackId:track,timeMs:10000,frames:10000,raceTimeFrames:10000,uploadId:1,replay:'fixture',replayHash:'a'.repeat(64)});
function fixture(){
 const data=new Map(),writes=[],reads=[];
 const rows=['outside-page-five','second-shard'].map(canonical);
 const docs=rows.map(row=>{const queueId=verificationShardId(track,row.accountId),doc={name:'projects/fixture/databases/(default)/documents/'+C+'/'+queueId,updateTime:'v1',queueCollection:C,data:{trackId:track,queueId,storageVersion:2,slots:{[row.accountId]:pendingSlot(row,0)}}};data.set(C+'/'+queueId,doc);data.set('0.6.2_race_results/'+row.accountId+'_'+track,{data:row,updateTime:'v1'});return doc;});
 const db={get:async(c,id)=>{reads.push(c+'/'+id);return data.get(c+'/'+id)||null;},write:(collection,id,value,prior)=>({collection,id,data:value,prior}),call:async(path,body)=>{
   assert.equal(path,':commit');for(const w of body.writes){const old=data.get(w.collection+'/'+w.id);assert.equal(w.prior?.updateTime,old?.updateTime);}
   for(const w of body.writes){writes.push(w);data.set(w.collection+'/'+w.id,{data:w.data,updateTime:'v2'});}return {writeResults:body.writes.map(()=>({updateTime:'v2'}))};}};
 return {db,data,docs,rows,writes,reads};
}
const result=job=>({resultId:job.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION});
test('multiple queue shards on one track publish only their own CAS-protected documents',async()=>{
 const f=fixture(),selected=await selectJobs(f.db,f.docs,1000);assert.equal(selected.jobs.length,2);
 assert.equal(new Set(selected.jobs.map(j=>j.queueId)).size,2);
 const totals=await publishResults(f.db,selected.jobs,selected.jobs.map(result));assert.equal(totals.verified,2);
 const queued=f.writes.filter(w=>w.collection===C);assert.equal(queued.length,2);assert.ok(queued.every(w=>w.id!==track&&Object.keys(w.data.slots).length===1));
});
test('a newer canonical PB supersedes a migrated shard completion without publishing stale proof',async()=>{
 const f=fixture(),selected=await selectJobs(f.db,[f.docs[0]],1000),job=selected.jobs[0];
 const row={...f.rows[0],timeMs:9999,frames:9999,raceTimeFrames:9999,uploadId:2};f.data.set('0.6.2_race_results/'+job.resultId,{data:row,updateTime:'v2'});
 const totals=await publishResults(f.db,[job],[result(job)]);assert.equal(totals.superseded,1);assert.equal(f.writes.length,0);
 assert.notEqual(job.queueKey,verificationKey(row));
});
