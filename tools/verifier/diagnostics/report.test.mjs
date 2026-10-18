import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {encode} from '../firestore.mjs';
import {EXTRA_VERIFICATION_COLLECTION, VERIFICATION_COLLECTION} from '../../../workers/ranked/src/verification.js';
import {EXTRA_TRACK_IDS} from '../../../workers/ranked/src/extra-track-ids.js';
import {createDiagnosticReport, schedulerDiagnosis, trustedTracks} from './report.mjs';

const knownTrack = trustedTracks.keys().next().value;
const unknownTrack = 'f'.repeat(64);
const auditId = key => crypto.createHash('sha256').update(key).digest('hex');

test('bounded report joins queue, canonical, audit and published place without replay or private fields', async () => {
  const verifiedKey = 'verified-binding';
  const waitingKey = 'waiting-binding';
  const mismatchKey = 'mismatch-binding';
  const extraTrack = [...EXTRA_TRACK_IDS][0];
  const queue = {trackId: knownTrack, pending: true, notBefore: 0, slots: {
    racer: {accountId: 'racer', resultId: 'racer_' + knownTrack, trackId: knownTrack, key: verifiedKey, status: 'verified', checkedAt: 3500},
    waiting: {accountId: 'waiting', resultId: 'waiting_' + unknownTrack, trackId: unknownTrack, key: waitingKey, status: 'unavailable', reason: 'missing_trusted_track', retryAt: Number.MAX_SAFE_INTEGER}
  }};
  const extraQueue = {trackId: extraTrack, pending: true, notBefore: 0, slots: {
    mismatch: {accountId: 'mismatch', resultId: 'mismatch_' + extraTrack, trackId: extraTrack, key: mismatchKey, status: 'mismatch', reason: 'finish_time_mismatch'}
  }};
  const coreQueueWithoutRuns = {trackId: 'c'.repeat(64), pending: true, notBefore: 1, slots: {}};
  const extraQueueWithoutRuns = {trackId: 'd'.repeat(64), pending: true, notBefore: 1, slots: {}};
  const canonical = new Map([
    ['racer_' + knownTrack, {data: {accountId: 'racer', trackId: knownTrack, timeMs: 1200, uploadId: 7, pbAt: 1000, replay: 'must-not-appear', replayHash: 'private'}}],
    ['waiting_' + unknownTrack, {data: {accountId: 'waiting', trackId: unknownTrack, timeMs: 2200, uploadId: 8, pbAt: 2000, ownerUid: 'private'}}],
    ['mismatch_' + extraTrack, {data: {accountId: 'mismatch', trackId: extraTrack, timeMs: 2400, uploadId: 9, pbAt: 2500}}]
  ]);
  const audits = new Map([
    [auditId(verifiedKey), {data: {status: 'verified', reason: 'native_exact_finish', checkedAt: 3500}}],
    [auditId(waitingKey), {data: {status: 'unavailable', reason: 'missing_trusted_track', checkedAt: 3000}}],
    [auditId(mismatchKey), {data: {status: 'mismatch', reason: 'finish_time_mismatch', checkedAt: 4000}}]
  ]);
  const boards = new Map([[knownTrack, {data: {entries: [{accountId: 'racer', timeMs: 1200, uploadId: 7, rank: 2, fieldSize: 9, name: 'private name'}]}}]]);
  const calls = [];
  const db = {
    call: async (path, body) => {
      calls.push({path, body});
      assert.equal(path, ':runQuery');
      const collection = body.structuredQuery.from[0].collectionId;
      if (collection === VERIFICATION_COLLECTION) return [queue, coreQueueWithoutRuns].slice(0, body.structuredQuery.limit)
        .map(document => ({document: {name: `queues/${document.trackId}`, fields: encode(document).mapValue.fields}}));
      if (collection === EXTRA_VERIFICATION_COLLECTION) return [extraQueue, extraQueueWithoutRuns].slice(0, body.structuredQuery.limit)
        .map(document => ({document: {name: `queues/${document.trackId}`, fields: encode(document).mapValue.fields}}));
      return [];
    },
    get: async (collection, id) => collection === '0.6.2_race_results' ? canonical.get(id) :
      collection === '0.6.2_s1_verification_audit' ? audits.get(id) :
      collection === '0.6.2_s1_leaderboards_track' ? boards.get(id) : null
  };
  const report = await createDiagnosticReport(db, {now: 10000, trackLimit: 4, runLimit: 8});
  assert.deepEqual(calls.filter(call => call.body.structuredQuery.from[0].collectionId === VERIFICATION_COLLECTION || call.body.structuredQuery.from[0].collectionId === EXTRA_VERIFICATION_COLLECTION)
    .map(call => [call.body.structuredQuery.from[0].collectionId, call.body.structuredQuery.limit]), [[VERIFICATION_COLLECTION, 2], [EXTRA_VERIFICATION_COLLECTION, 2]]);
  for (const call of calls.filter(call => [VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION].includes(call.body.structuredQuery.from[0].collectionId))) {
    assert.deepEqual(call.body.structuredQuery.orderBy, [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}]);
    assert.ok(!call.body.structuredQuery.where || call.body.structuredQuery.where.fieldFilter.field.fieldPath === 'notBefore');
  }
  assert.equal(calls.length, 4);
  assert.equal(report.scope.queueLimit, 4);
  assert.equal(report.scope.coreQueueLimit + report.scope.extraQueueLimit, report.scope.queueLimit);
  assert.equal(report.scope.coreQueueDocuments, 2);
  assert.equal(report.scope.extraQueueDocuments, 2);
  assert.equal(report.scope.queueDocuments, report.scope.queueLimit);
  assert.equal(report.scope.truncated, true);
  assert.equal(report.summary.runs, 3);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.summary.waiting, 1);
  assert.equal(report.summary.mismatch, 1);
  assert.equal(report.summary.missingTrustedTracks, 1);
  assert.equal(report.summary.published, 1);
  assert.equal(report.summary.verificationLatencyMs.averageMs, 2500);
  assert.equal(report.summary.waitingAgeMs.averageMs, 8000);
  assert.deepEqual(report.runs.find(row => row.accountId === 'racer').place, {rank: 2, fieldSize: 9});
  assert.equal(report.runs.find(row => row.accountId === 'waiting').trustedTrack, false);
  assert.equal(report.runs.find(row => row.accountId === 'waiting').reason, 'missing_trusted_track');
  assert.equal(report.runs.find(row => row.accountId === 'mismatch').verificationLane, 'extra');
  assert.equal(report.people.find(person => person.accountId === 'mismatch').mismatch, 1);
  assert.equal(report.tracks.find(track => track.trackId === extraTrack).mismatch, 1);
  assert.doesNotMatch(JSON.stringify(report), /must-not-appear|private name|ownerUid|replayHash/);
});

test('report can target one queue and keeps the read bounded', async () => {
  const requested = [];
  const db = {
    call: async (_path, body) => {
      assert.notEqual(body.structuredQuery.from[0].collectionId, '0.6.2_s1_verification');
      return [];
    },
    get: async (collection, id) => {
      requested.push([collection, id]);
      if (collection === VERIFICATION_COLLECTION) return {data: {trackId: id, pending: false, slots: {}}};
      return null;
    }
  };
  const report = await createDiagnosticReport(db, {trackId: knownTrack, runLimit: 1});
  assert.deepEqual(requested.sort((a, b) => a[0].localeCompare(b[0])), [[EXTRA_VERIFICATION_COLLECTION, knownTrack], [VERIFICATION_COLLECTION, knownTrack]].sort((a, b) => a[0].localeCompare(b[0])));
  assert.equal(report.scope.queueDocuments, 1);
  assert.equal(report.scope.queueLimit, 2);
  assert.equal(report.scope.selectedRuns, 0);
});

test('recent audit history includes a verified run after its queue slot is gone', async () => {
  const key = 'archived-binding';
  const resultId = 'archived_' + knownTrack;
  const db = {
    call: async (_path, body) => {
      const collection = body.structuredQuery.from[0].collectionId;
      if (collection === '0.6.2_s1_verification') return [];
      if (collection === '0.6.2_s1_verification_audit') return [{document: {name: 'audit/doc', fields: encode({
        accountId: 'archived', trackId: knownTrack, resultId, key, status: 'verified', reason: 'native_exact_finish', checkedAt: 9000
      }).mapValue.fields}}];
      return [];
    },
    get: async (collection, id) => collection === '0.6.2_race_results' && id === resultId ? {data: {
      accountId: 'archived', trackId: knownTrack, timeMs: 1700, uploadId: 3, pbAt: 4000
    }} : null
  };
  const report = await createDiagnosticReport(db, {now: 10000, historyLimit: 1, eventLimit: 0});
  assert.equal(report.summary.runs, 1);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.runs[0].source, 'audit_history');
  assert.equal(report.runs[0].submissionTimestampSource, 'pbAt');
  assert.equal(report.runs[0].verificationLatencyMs, 5000);
});

test('bounded queue scan uses the notBefore index and filters pending locally', async () => {
  const queries = [];
  const db = {
    call: async (_path, body) => {
      const query = body.structuredQuery;
      queries.push(query);
      assert.deepEqual(query.orderBy, [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}]);
      assert.equal(query.limit, 1);
      assert.ok(!query.where, 'default bounded scan avoids a pending/notBefore composite index');
      const collection = query.from[0].collectionId;
      const row = collection === VERIFICATION_COLLECTION ? {trackId: 'completed', pending: false, notBefore: 1, slots: {}} :
        {trackId: 'pending', pending: true, notBefore: 2, slots: {}};
      return [{document: {name: `queues/${row.trackId}`, fields: encode(row).mapValue.fields}}];
    },
    get: async () => null
  };
  const report = await createDiagnosticReport(db, {now: 100, trackLimit: 2, runLimit: 1, historyLimit: 0, eventLimit: 0});

  assert.equal(queries.length, 2);
  assert.equal(report.scope.coreQueueDocuments, 0);
  assert.equal(report.scope.extraQueueDocuments, 1);
  assert.equal(report.scope.coreQueueSampledDocuments, 1);
  assert.equal(report.scope.extraQueueSampledDocuments, 1);
  assert.equal(report.scope.truncated, true, 'local filtering must not conceal that the bounded sample hit its cap');
});

test('due-only queue scan uses the verifier due gate with the same single-field ordering', async () => {
  const now = 12345;
  const queries = [];
  const db = {
    call: async (_path, body) => {
      const query = body.structuredQuery;
      queries.push(query);
      assert.deepEqual(query.where, {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL', value: {integerValue: String(now)}}});
      assert.deepEqual(query.orderBy, [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}]);
      return [];
    },
    get: async () => null
  };
  const report = await createDiagnosticReport(db, {now, trackLimit: 2, historyLimit: 0, eventLimit: 0, dueOnly: true});
  assert.equal(queries.length, 2);
  assert.equal(report.scope.dueOnly, true);
});

test('bounded event run visibility reports received-to-proof latency and event place', async () => {
  const db = {
    call: async (_path, body) => {
      const collection = body.structuredQuery.from[0].collectionId;
      if (collection === '0.6.2_event_runs') return [{document: {name: 'events/run-1', fields: encode({
        runId: 'run-1', periodId: 'period-1', accountId: 'event-racer', trackId: knownTrack, timeMs: 1800,
        receivedAt: 4000, status: 'verified', proof: {status: 'verified', reason: 'native_exact_finish', checkedAt: 9000}, completedAt: 9000
      }).mapValue.fields}}];
      return [];
    },
    get: async (collection, id) => collection === '0.6.2_event_public' && id === 'period-1' ? {data: {
      entries: [{accountId: 'event-racer', timeMs: 1800, rank: 1}]
    }} : null
  };
  const report = await createDiagnosticReport(db, {now: 10000, historyLimit: 0, eventLimit: 1});
  assert.equal(report.summary.eventRuns, 1);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.runs[0].kind, 'event');
  assert.equal(report.runs[0].submissionTimestampSource, 'receivedAt');
  assert.equal(report.runs[0].verificationLatencyMs, 5000);
  assert.deepEqual(report.runs[0].place, {rank: 1, fieldSize: null});
});

test('scheduler diagnosis distinguishes the old misleading stop from the safe stop', () => {
  const old = schedulerDiagnosis({stop: 'no_progress', events: {budgetDeferred: true}, rounds: 3, processed: 22, verified: 2, eventChecked: 16});
  assert.equal(old.status, 'action_required');
  assert.equal(old.finding, 'legacy_budget_deferred_was_reported_as_no_progress');
  const current = schedulerDiagnosis({stop: 'budget_deferred', events: {budgetDeferred: true}, rounds: 3});
  assert.equal(current.status, 'observed');
  assert.equal(current.finding, 'budget_deferred_is_explicit_and_safe_to_retry');
  assert.deepEqual(current.reservation, {eventNativeSlotsPerRound: 4, normalNativeSlotsPerRound: 12, borrowUnusedEventSlots: true, eventStageFirst: true});
});

for (const [file, captureStep] of [
  ['sync-event-catalog.yml', 'Capture public event assignments'],
  ['sync-kodub-weekly.yml', 'Capture current weekly track']
]) {
  test(`${file} checks catalog, registry, and pins on the default branch before capture`, () => {
    const workflow = fs.readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert.match(workflow, /if: github\.repository == 'StaticQuasar931\/PolyTrack-0\.6\.3-Ranked' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);

    const checkIndex = workflow.indexOf('run: node tools/extra-verification-check.mjs');
    const captureIndex = workflow.indexOf(`name: ${captureStep}`);
    assert.ok(checkIndex >= 0, 'local Extra consistency check is present');
    assert.ok(captureIndex > checkIndex, 'consistency check runs before public capture');
  });
}


test('bounded Summer1 diagnosis separates verified publication lag from infrastructure retry and stale audit', async () => {
  const {verificationKey, VERIFIER_VERSION, VERIFIER_ENGINE_DIGEST} = await import('../../../workers/ranked/src/verification.js');
  const now = 1791678399604;
  const canonical = new Map(['verified', 'retry', 'requeued'].map(accountId => [accountId + '_' + knownTrack,
    {accountId, trackId: knownTrack, timeMs: 22448, frames: 22448, uploadId: 1, replayHash: 'a'.repeat(64), pbAt: 1000}]));
  const slots = Object.fromEntries([...canonical].map(([resultId, row]) => [row.accountId, {
    accountId: row.accountId, resultId, trackId: knownTrack, key: verificationKey(row),
    verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST,
    status: row.accountId === 'verified' ? 'verified' : row.accountId === 'retry' ? 'unavailable' : 'waiting',
    reason: row.accountId === 'verified' ? 'native_exact_finish' : row.accountId === 'retry' ? 'isolate_terminated' : '',
    attempts: row.accountId === 'verified' ? 1 : 0,
    checkedAt: now - 1000,
    retryAt: row.accountId === 'verified' ? Number.MAX_SAFE_INTEGER : row.accountId === 'retry' ? now + 3600000 : 0
  }]));
  let reads = 0;
  const db = {call: async () => assert.fail('Targeted report must not query collections'), get: async (collection, id) => {
    reads++;
    if (collection === VERIFICATION_COLLECTION) return {data: {trackId: knownTrack, notBefore: 0, slots}};
    if (collection === '0.6.2_race_results') return {data: canonical.get(id)};
    if (collection === '0.6.2_s1_leaderboards_track') return {data: {updatedAt: now - 2000,
      entries: [...canonical.values()].map(row => ({accountId: row.accountId, timeMs: row.timeMs, uploadId: 1, runVerified: false}))}};
    if (collection === '0.6.2_s1_verification_audit') return {data: {status: 'verified', reason: 'old_native_exact_finish', checkedAt: now - 2000}};
    return null;
  }};
  const report = await createDiagnosticReport(db, {now, trackId: knownTrack, runLimit: 3, historyLimit: 0, eventLimit: 0});
  assert.equal(reads, 9, 'Two exact queue reads, three canonical/audit pairs, one cached board read');
  const verified = report.runs.find(row => row.accountId === 'verified');
  assert.equal(verified.publicationState, 'verified_not_published');
  assert.equal(verified.canonicalKeyMatches, true);
  assert.equal(verified.acceptedProof, true);
  assert.equal(verified.eligibility, 'not_retryable');
  assert.equal(verified.retryAt, null, 'NEVER sentinel is not rendered as a date');
  const retry = report.runs.find(row => row.accountId === 'retry');
  assert.equal(retry.status, 'unavailable');
  assert.equal(retry.reason, 'isolate_terminated');
  assert.equal(retry.eligibility, 'retry_not_due');
  assert.equal(retry.retryInMs, 3600000);
  assert.equal(retry.attempts, 0);
  assert.equal(retry.retryAt, new Date(now + 3600000).toISOString());
  const requeued = report.runs.find(row => row.accountId === 'requeued');
  assert.equal(requeued.status, 'waiting', 'Old audit must not mask the current requeued slot');
  assert.equal(requeued.reason, null);
  assert.equal(requeued.publicationState, 'not_verified');
  assert.equal(requeued.eligibility, 'due');
});
