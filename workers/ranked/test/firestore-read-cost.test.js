import test from 'node:test';
import assert from 'node:assert/strict';
import {recordFirestoreReads} from '../src/firestore-read-cost.js';
import {handleRequest} from '../src/index.js';
test('read diagnostics count documents, empty queries and batch misses, not HTTP calls or writes', () => {
  const audit={collections:{},documentReadEstimate:0};
  const query={body:JSON.stringify({structuredQuery:{from:[{collectionId:'boards'}]}})};
  recordFirestoreReads(audit,':runQuery',query,[{document:{}},{document:{}}]);
  recordFirestoreReads(audit,':runQuery',query,[]);
  recordFirestoreReads(audit,'/meta/current',{},null);
  recordFirestoreReads(audit,':batchGet',{body:JSON.stringify({documents:['projects/p/databases/(default)/documents/profiles/a','projects/p/databases/(default)/documents/profiles/b']})},[{found:{}},{missing:'b'}]);
  recordFirestoreReads(audit,':commit',{method:'POST',body:JSON.stringify({writes:[
    {update:{name:'projects/p/databases/(default)/documents/profiles/a'}},
    {update:{name:'projects/p/databases/(default)/documents/profiles/b'}},
    {delete:'projects/p/databases/(default)/documents/profiles/old'}
  ]})},{});
  assert.equal(audit.documentReadEstimate,6);
  assert.deepEqual(audit.collections,{boards:3,meta:1,profiles:2});
  assert.deepEqual(audit.writeCollections,{profiles:{writes:2,deletes:1}});
  assert.equal(audit.writeEstimate,2);
  assert.equal(audit.deleteEstimate,1);
});

test('successful PATCH and DELETE are counted by collection without double-counting reads',()=>{
  const audit={collections:{},documentReadEstimate:0};
  recordFirestoreReads(audit,'/profiles/a',{method:'PATCH'},{});
  recordFirestoreReads(audit,'/profiles/b',{method:'DELETE'},null);
  assert.deepEqual(audit.writeCollections,{profiles:{writes:1,deletes:1}});
  assert.equal(audit.writeEstimate,1);
  assert.equal(audit.deleteEstimate,1);
  assert.deepEqual(audit.collections,{});
  assert.equal(audit.documentReadEstimate,0);
});

test('failed Firestore calls increment failure count but never reach write cost recorder',async()=>{
  const origin='https://staticquasar931.github.io';
  const previousCaches=globalThis.caches;
  const originalLog=console.log, lines=[];
  delete globalThis.caches;
  console.log=(...args)=>lines.push(args.join(' '));
  try {
    const response=await handleRequest(new Request('https://ranked.example/v1/status',{headers:{Origin:origin}}),{
      ALLOWED_ORIGINS:origin,__TEST_FIRESTORE:async()=>{throw Error('simulated_failure');}});
    assert.equal(response.status,503);
    const record=JSON.parse(lines[0].slice('Ranked request Firestore reads '.length));
    assert.equal(record.httpRequests,1);
    assert.equal(record.failedRequests,1);
    assert.equal(record.documentReadEstimate,0);
    assert.equal(record.writeEstimate,undefined);
    assert.equal(record.deleteEstimate,undefined);
    assert.equal(record.writeCollections,undefined);
  } finally {
    console.log=originalLog;
    if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
  }
});
