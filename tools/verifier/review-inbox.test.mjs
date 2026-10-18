import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewInboxWrite,reviewRecord,REVIEW_COLLECTION} from './review-inbox.mjs';
test('ordinary verified and unavailable runs never read or write the inbox',async()=>{
  const db={get:()=>{throw Error('unexpected read');}};
  for(const status of ['verified','unavailable'])assert.equal(await reviewInboxWrite(db,'id',{}, {status}),null);
});
test('flagged finding is separate and resolved decisions survive retries',async()=>{
  const db={get:async()=>null,write:(collection,id,data)=>({collection,id,data})};
  const write=await reviewInboxWrite(db,'id',{accountId:'racer',trackId:'track',resultId:'run',timeMs:123},{status:'mismatch',reason:'finish_mismatch'});
  assert.equal(write.collection,REVIEW_COLLECTION);assert.equal(write.data.status,'open');
  assert.equal(write.data.category,'verification_mismatch');
  assert.equal(await reviewInboxWrite({...db,get:async()=>({data:{status:'resolved'}})},'id',{}, {status:'mismatch'}),null);
});
test('event exact duplicates use a stable result identity and a non-punitive category',()=>{
  const record=reviewRecord('audit',{accountId:'racer',trackId:'track',runId:'event-run',periodId:'daily',timeMs:123},
    {status:'mismatch',reason:'exact_duplicate_run'},{kind:'identical_replay'});
  assert.equal(record.resultId,'event-run');assert.equal(record.periodId,'daily');
  assert.equal(record.category,'exact_duplicate');
  assert.match(record.notice,/not an account penalty or cheating verdict/);
});
test('normal exact-duplicate findings share the queryable category',async()=>{
  const write=await reviewInboxWrite({get:async()=>null,write:(collection,id,data)=>({collection,id,data})},'audit',
    {accountId:'racer',trackId:'track',resultId:'normal-run',timeMs:123},
    {status:'mismatch',reason:'exact_duplicate_run'},{kind:'identical_replay'});
  assert.equal(write.data.category,'exact_duplicate');
  assert.equal(write.data.reason,'exact_duplicate_run');
});
test('event advisory evidence is reviewable without converting a verified verdict',()=>{
  const record=reviewRecord('audit',{accountId:'racer',trackId:'track',runId:'event-run',timeMs:123},
    {status:'verified',reason:'native_exact_finish'},{kind:'similar_top_inputs'});
  assert.equal(record.category,'input_similarity');assert.equal(record.verdict,'verified');
});

test('rapid input stays advisory with its own review category',()=>{const record=reviewRecord('audit',{accountId:'racer',trackId:'track'},{status:'verified',reason:'native_exact_finish'},{kind:'rapid_input'});assert.equal(record.category,'input_rate');assert.equal(record.verdict,'verified');assert.match(record.notice,/not a cheating verdict/);});
