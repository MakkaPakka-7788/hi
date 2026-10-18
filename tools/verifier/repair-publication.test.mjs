import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {repairVerifiedPublication} from './repair-publication.mjs';
import {computeTrackEntries} from '../../workers/ranked/src/index.js';
import {verificationKey, VERIFIER_VERSION, VERIFIER_ENGINE_DIGEST} from '../../workers/ranked/src/verification.js';
import {encode, decode} from './firestore.mjs';

const trackId = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const resultId = 'racer_' + trackId;
function fixture({staleProof = false, badReplay = false, complete = true, conflict = false} = {}) {
  const replay = 'repair-fixture';
  const row = {accountId: 'racer', trackId, timeMs: 22448, frames: 22448, raceTimeFrames: 22448, uploadId: 12,
    replay, replayHash: badReplay ? 'a'.repeat(64) : createHash('sha256').update(replay).digest('hex')};
  const proof = {key: verificationKey(staleProof ? {...row, uploadId: 11} : row),
    status: 'verified', verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST};
  const data = new Map([
    ['0.6.2_race_results/' + resultId, row],
    ['0.6.2_s1_verification/' + trackId, {slots: {racer: proof}}],
    ['0.6.2_s1_leaderboards_track/' + trackId, {trackId,
      entries: computeTrackEntries([{...row, integrityVerified: true}], trackId), totalEntries: 1, complete,
      revision: 525, schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'stale-board'}],
    ['0.6.2_s1_release_meta/current', {revision: 525, builtRevision: 525, dirty: false, rankedWritesEnabled: false, multiplayerEnabled: false}]
  ]);
  const calls = [], commits = [];
  const db = {call: async (path, body) => {
    calls.push(path);
    if (path === ':commit') {
      if (conflict) throw Object.assign(Error('CAS conflict'), {code: 'FAILED_PRECONDITION'});
      commits.push(body);
      return {};
    }
    assert.ok(path.startsWith('/'), 'Queries and scans forbidden');
    const key = decodeURIComponent(path.slice(1));
    assert.ok(data.has(key), 'Only exact allowed documents may be read');
    return {name: 'projects/polytrack-052/databases/(default)/documents/' + key,
      fields: encode(data.get(key)).mapValue.fields, updateTime: key.endsWith('/current') ? 'meta-v1' : 'v1'};
  }};
  return {db, calls, commits};
}

test('bounded repair dry run computes proof-based publication with four exact reads and zero writes', async () => {
  const f = fixture();
  const result = await repairVerifiedPublication(f.db, {trackId, resultId});
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldChange, true);
  assert.equal(result.applied, false);
  assert.equal(result.reads, 4);
  assert.equal(result.requests, 4);
  assert.equal(f.commits.length, 0);
});

test('apply publishes exact proof and dirty metadata atomically with canonical and proof CAS guards', async () => {
  const f = fixture();
  const result = await repairVerifiedPublication(f.db, {trackId, resultId, apply: true});
  assert.equal(result.applied, true);
  assert.equal(result.overallDirtied, true);
  assert.equal(result.requests, 5);
  assert.equal(f.commits.length, 1);
  const writes = f.commits[0].writes;
  assert.equal(writes.length, 4);
  const updates = writes.filter(write => write.update);
  assert.equal(updates.length, 2);
  assert.ok(updates.every(write => write.currentDocument.updateTime));
  const board = decode({mapValue: {fields: updates[0].update.fields}});
  assert.equal(board.entries[0].runVerified, true);
  assert.equal(board.entries[0].integrityVerified, true);
  assert.equal(board.revision, 526);
  const meta = decode({mapValue: {fields: updates[1].update.fields}});
  assert.equal(meta.rankedWritesEnabled, false);
  assert.equal(meta.multiplayerEnabled, false);
  const verifies = writes.filter(write => write.verify);
  assert.equal(verifies.length, 2);
  assert.ok(verifies.some(write => write.verify.endsWith('/0.6.2_race_results/' + resultId)));
  assert.ok(verifies.some(write => write.verify.endsWith('/0.6.2_s1_verification/' + trackId)));
  assert.ok(verifies.every(write => write.currentDocument.updateTime === 'v1'));
});

for (const [options, reason] of [[{staleProof: true}, /Matching current verified proof/],
  [{badReplay: true}, /exact proof and replay integrity/], [{complete: false}, /full-track fallback refused/]]) {
  test('repair fails closed without scans or writes: ' + Object.keys(options)[0], async () => {
    const f = fixture(options);
    await assert.rejects(repairVerifiedPublication(f.db, {trackId, resultId, apply: true}), reason);
    assert.equal(f.commits.length, 0);
    assert.ok(f.calls.length <= 4);
  });
}

test('repair never retries a publication CAS conflict', async () => {
  const f = fixture({conflict: true});
  await assert.rejects(repairVerifiedPublication(f.db, {trackId, resultId, apply: true}), /CAS conflict/);
  assert.equal(f.calls.filter(path => path === ':commit').length, 1);
  assert.equal(f.calls.length, 5);
});
