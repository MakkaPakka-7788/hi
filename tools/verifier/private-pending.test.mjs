import {encode} from './firestore.mjs';
import {verificationShardId} from '../../workers/ranked/src/verification-shards.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION,
  verificationCollectionForTrack, verificationKey} from '../../workers/ranked/src/verification.js';
import {capturePending, publishPrivateCapture, readPrivateCapture, verifyPrivateCapture} from './private-pending.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TRACK = 'a'.repeat(64);
const REPLAY = 'private-replay-fixture';
const HASH = crypto.createHash('sha256').update(REPLAY).digest('hex');
const ROW = {accountId: 'racer', trackId: TRACK, timeMs: 1200,
  uploadId: 4, replay: REPLAY, replayHash: HASH};
const QUEUE_KEY = verificationKey(ROW);
const SAFE_JOB = {accountId: ROW.accountId, resultId: `${ROW.accountId}_${TRACK}`, trackId: TRACK,
  timeMs: ROW.timeMs, sourceTimeMs: ROW.timeMs, replayHash: HASH, replay: REPLAY, frames: null,
  raceTimeFrames: null, uploadId: ROW.uploadId, id: null, queueKey: QUEUE_KEY,
  queueCollection: verificationCollectionForTrack(TRACK), queueId: TRACK, correctionCandidate: null};

async function withPrivateDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-private-'));
  try { await run(directory); } finally { await fs.rm(directory, {recursive: true, force: true}); }
}

async function saveCapture(file, jobs = [SAFE_JOB], extra = {}) {
  await fs.writeFile(file, JSON.stringify({schema: 'polytrack-private-pending-v1',
    capturedAt: new Date(0).toISOString(), engineDigest: VERIFIER_ENGINE_DIGEST,
    verifierVersion: VERIFIER_VERSION, jobs, ...extra}), {mode: 0o600});
}

test('capture makes bounded read-only queue discovery and writes only a private file', async () => {
  await withPrivateDirectory(async directory => {
    const file = path.join(directory, 'pending.json');
    const calls = [];
    const db = {call: async (endpoint, body) => {
      calls.push(endpoint);
      if (endpoint === ':runQuery') return [];
      assert.fail(`capture attempted a write: ${endpoint}`);
    }, queryCount: () => 2, returnedDocuments: () => 0, estimatedDocumentReads: () => 2,
    emptyQueryMinimumReads: () => 2};
    const result = await capturePending({file, root: ROOT, credentials: 'test-only', now: 100,
      validateEngine: async () => {}, connectDatabase: async () => db});
    assert.equal(result.jobs, 0);
    assert.equal(result.requests, 2);
    assert.equal(result.estimatedDocumentReads, 2);
    assert.equal(result.emptyQueryMinimumReads, 2);
    assert.deepEqual(calls, [':runQuery', ':runQuery']);
    const stat = await fs.stat(file);
    assert.equal(stat.isFile(), true);
    assert.equal((await readPrivateCapture(file, {root: ROOT})).jobs.length, 0);
  });
});

test('capture never deletes a pre-existing private output after exclusive-create failure', async () => {
  await withPrivateDirectory(async directory => {
    const file = path.join(directory, 'pending.json');
    const original = 'existing private capture';
    await fs.writeFile(file, original, {mode: 0o600});
    const db = {call: async endpoint => endpoint === ':runQuery' ? [] : assert.fail(`unexpected ${endpoint}`)};
    await assert.rejects(capturePending({file, root: ROOT, credentials: 'test-only', now: 100,
      validateEngine: async () => {}, connectDatabase: async () => db}), /EEXIST/);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  });
});

test('capture jobLimit is validated before credentials or database access', async () => {
  let connected = false;
  await assert.rejects(capturePending({file: path.join(os.tmpdir(), 'unused-private-capture.json'),
    root: ROOT, jobLimit: 17, credentials: 'test-only', connectDatabase: async () => {connected = true;}}), /jobLimit/);
  assert.equal(connected, false);
});

test('offline verify ignores imported results and does not connect to Firebase', async () => {
  await withPrivateDirectory(async directory => {
    const file = path.join(directory, 'pending.json');
    await saveCapture(file, [SAFE_JOB], {results: [{resultId: SAFE_JOB.resultId, status: 'verified'}]});
    let verified = 0, connected = false;
    const outcome = await verifyPrivateCapture({file, root: ROOT, validateEngine: async () => {},
      verifyNative: async (_root, jobs, trusted) => {
        verified++;
        assert.equal(trusted.length, 0);
        assert.equal(jobs[0].replay, REPLAY);
        return [{resultId: jobs[0].resultId, status: 'mismatch', reason: 'fresh_native_result',
          trackId: TRACK, timeMs: jobs[0].timeMs, replayHash: HASH}];
      }, connectDatabase: async () => { connected = true; throw Error('must not connect'); }});
    assert.equal(verified, 1);
    assert.equal(connected, false);
    assert.equal(outcome.results[0].reason, 'fresh_native_result');
  });
});

test('offline verify accepts a sparse unavailable result but rejects duplicate result IDs', async () => {
  await withPrivateDirectory(async directory => {
    const file = path.join(directory, 'pending.json');
    await saveCapture(file);
    const outcome = await verifyPrivateCapture({file, root: ROOT, validateEngine: async () => {},
      verifyNative: async () => [{resultId: SAFE_JOB.resultId, status: 'unavailable', reason: 'isolate_terminated'}]});
    assert.equal(outcome.results[0].reason, 'isolate_terminated');
    await saveCapture(file, [SAFE_JOB, SAFE_JOB]);
    await assert.rejects(verifyPrivateCapture({file, root: ROOT, validateEngine: async () => {},
      verifyNative: async () => []}), /Duplicate captured result ID/);
  });
});

test('publish reruns native verification before connecting and forwards only fresh bound results', async () => {
  await withPrivateDirectory(async directory => {
    const file = path.join(directory, 'pending.json');
    await saveCapture(file, [SAFE_JOB], {results: [{resultId: SAFE_JOB.resultId, status: 'verified',
      trackId: TRACK, timeMs: ROW.timeMs, replayHash: HASH, engineDigest: 'forged'}]});
    const sequence = [];
    const fresh = {resultId: SAFE_JOB.resultId, status: 'verified', trackId: TRACK,
      timeMs: ROW.timeMs, replayHash: HASH, engineDigest: VERIFIER_ENGINE_DIGEST,
      verifierVersion: VERIFIER_VERSION};
    const published = await publishPrivateCapture({file, root: ROOT, credentials: 'test-only',
      validateEngine: async () => sequence.push('pin'),
      verifyNative: async (_root, jobs) => {
        sequence.push('native');
        return [{...fresh, trackId: jobs[0].trackId, timeMs: jobs[0].timeMs, replayHash: jobs[0].replayHash}];
      },
      connectDatabase: async () => { sequence.push('connect'); return {call: async () => {}}; },
      publish: async (_db, jobs, results) => {
        sequence.push('publish');
        assert.equal(jobs[0].queueKey, QUEUE_KEY);
        assert.equal(results[0].engineDigest, VERIFIER_ENGINE_DIGEST);
        assert.notEqual(results[0].engineDigest, 'forged');
        return {verified: 1};
      }});
    assert.deepEqual(sequence, ['pin', 'native', 'connect', 'publish']);
    assert.equal(published.verified, 1);
    assert.ok(published.requests <= 100);
  });
});

test('capture reader rejects repository paths, wrong engine, modified replay, and excess jobs', async () => {
  await assert.rejects(readPrivateCapture(path.join(ROOT, 'private-pending.test.mjs'), {root: ROOT}), /outside/);
  await withPrivateDirectory(async directory => {
    const file = path.join(directory, 'pending.json');
    await saveCapture(file, [SAFE_JOB], {engineDigest: 'old-engine'});
    await assert.rejects(readPrivateCapture(file, {root: ROOT}), /schema or pinned engine/);
    await saveCapture(file, [{...SAFE_JOB, replay: 'changed'}]);
    await assert.rejects(readPrivateCapture(file, {root: ROOT}), /hash mismatch/);
    await saveCapture(file, Array.from({length: 17}, () => SAFE_JOB));
    await assert.rejects(readPrivateCapture(file, {root: ROOT}), /schema or pinned engine/);
  });
});


test('private captures retain only safe root or account-shard queue bindings',async()=>{
 await withPrivateDirectory(async directory=>{
  const file=path.join(directory,'shard.json'),queueId=verificationShardId(TRACK,ROW.accountId);
  await saveCapture(file,[{...SAFE_JOB,queueId}]);assert.equal((await readPrivateCapture(file,{root:ROOT})).jobs[0].queueId,queueId);
  await saveCapture(file,[{...SAFE_JOB,queueId:'other-account-shard'}]);await assert.rejects(readPrivateCapture(file,{root:ROOT}),/queue document binding/);
  const legacy={...SAFE_JOB};delete legacy.queueId;await saveCapture(file,[legacy]);assert.equal((await readPrivateCapture(file,{root:ROOT})).jobs[0].queueId,TRACK,'old captures never guess a shard');
 });
});
test('private publication reads and writes the captured shard rather than the legacy root',async()=>{
 await withPrivateDirectory(async directory=>{
  const file=path.join(directory,'shard.json'),queueId=verificationShardId(TRACK,ROW.accountId);await saveCapture(file,[{...SAFE_JOB,queueId}]);let writes;
  const document=data=>({updateTime:'version-1',fields:encode(data).mapValue.fields});
  const db={call:async(endpoint,body)=>{
   if(endpoint===':commit'){writes=body.writes;return {writeResults:body.writes.map(()=>({updateTime:'version-2'}))};}
   if(endpoint==='/'+VERIFICATION_COLLECTION+'/'+queueId)return document({trackId:TRACK,queueId,slots:{racer:{accountId:'racer',trackId:TRACK,key:QUEUE_KEY,status:'waiting'}}});
   if(endpoint==='/0.6.2_race_results/'+SAFE_JOB.resultId)return document(ROW);
   if(endpoint==='/'+VERIFICATION_COLLECTION+'/'+TRACK)assert.fail('wrong root queue lookup');
   return null;
  },write:(collection,id,data,prior)=>({update:{name:collection+'/'+id,fields:encode(data).mapValue.fields},currentDocument:prior?{updateTime:prior.updateTime}:{exists:false}})};
  const result=await publishPrivateCapture({file,root:ROOT,credentials:'fixture',validateEngine:async()=>{},connectDatabase:async()=>db,
   verifyNative:async()=>[{resultId:SAFE_JOB.resultId,status:'verified',reason:'native_exact_finish',trackId:TRACK,timeMs:ROW.timeMs,replayHash:HASH,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}]});
  assert.equal(result.verified,1);assert.equal(writes[0].update.name,VERIFICATION_COLLECTION+'/'+queueId);
 });
});


test('capturePending round-trips a discovered account shard into the private file',async()=>{
 await withPrivateDirectory(async directory=>{
  const file=path.join(directory,'captured.json'),queueId=verificationShardId(TRACK,ROW.accountId);
  const fields=data=>encode(data).mapValue.fields;
  const db={call:async(endpoint,body)=>{
   if(endpoint===':runQuery')return body.structuredQuery.from[0].collectionId===VERIFICATION_COLLECTION?[{document:{name:'projects/fixture/databases/(default)/documents/'+VERIFICATION_COLLECTION+'/'+queueId,updateTime:'v1',fields:fields({trackId:TRACK,queueId,notBefore:0,slots:{racer:{accountId:'racer',resultId:SAFE_JOB.resultId,trackId:TRACK,key:QUEUE_KEY,status:'waiting',retryAt:0}}})}}]:[];
   if(endpoint==='/0.6.2_race_results/'+SAFE_JOB.resultId)return {fields:fields(ROW),updateTime:'v1'};
   if(endpoint===':commit')assert.fail('capture must not write');
   return null;
  }};
  const captured=await capturePending({file,root:ROOT,credentials:'fixture',now:100,validateEngine:async()=>{},connectDatabase:async()=>db});
  assert.equal(captured.jobs,1);assert.equal((await readPrivateCapture(file,{root:ROOT})).jobs[0].queueId,queueId);
 });
});
