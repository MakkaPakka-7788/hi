import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import {analyzeSegmentPairs, findCopiedSteeringSegment, loadPrivateSegmentJobs, runSegmentAudit} from './segment-audit.mjs';

const TRACK = 'a'.repeat(64), A = 'b'.repeat(64), B = 'c'.repeat(64), C = 'd'.repeat(64);

function replayFromEvents(events) {
  const lists = {up: [], right: [], down: [], left: [], reset: []};
  for (const event of events) lists[['up', 'right', 'down', 'left', 'reset'][event.channel]].push(event.tick);
  for (const values of Object.values(lists)) values.sort((a, b) => a - b);
  const parts = [];
  for (const name of ['up', 'right', 'down', 'left', 'reset']) {
    const values = lists[name], count = Buffer.alloc(3); count.writeUIntLE(values.length, 0, 3); parts.push(count);
    let previous = 0;
    for (const tick of values) { const delta = Buffer.alloc(3); delta.writeUIntLE(tick - previous, 0, 3); parts.push(delta); previous = tick; }
  }
  return zlib.deflateSync(Buffer.concat(parts)).toString('base64url');
}

function sequence(offset = 0, prefix = []) {
  return [...prefix, ...Array.from({length: 24}, (_, i) => ({channel: i % 2 ? 2 : 1, tick: offset + 100 + i * 100}))];
}

function job(accountId, events, source, kind = 'normal', timeMs = 8000) {
  const replay = replayFromEvents(events);
  return {accountId, trackId: TRACK, timeMs, replay, replayHash: crypto.createHash('sha256').update(replay).digest('hex'),
    source, kind, resultId: source};
}

test('shifted copied steering windows identify exact contiguous sequences and signed offset', async () => {
  const left = job(A, sequence(), 'recordings/1.json');
  const right = job(B, sequence(3000, [{channel: 3, tick: 100}, {channel: 3, tick: 150}]), 'recordings/2.json');
  const result = await analyzeSegmentPairs([left, right]);
  assert.equal(result.counts.crossAccountPairs, 1);
  assert.equal(result.counts.crossAccountPairsCompared, 1);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].fullExactSameTicks, false);
  assert.equal(result.findings[0].segment.matchedTransitions, 24);
  assert.equal(result.findings[0].segment.score, 1);
  assert.equal(result.findings[0].segment.offsetTicks, 3000);
  assert.equal(result.findings[0].segment.steeringActiveMsLeft >= 1000, true);
  assert.equal(result.counts.segmentCandidatePairs, 1);
  assert.equal(result.coverage.completeSegmentCandidateIndex, true);
  assert.equal(result.findings[0].segment.allChannelStateAgreement, 1);
});

test('same steering with different throttle remains lower-confidence advisory evidence', async () => {
  const left = job(A, sequence(), 'recordings/throttle-a.json');
  const throttle = Array.from({length: 12}, (_, i) => ({channel: 0, tick: 200 + i * 300}));
  const right = job(B, sequence(3000, throttle.map(event => ({...event, tick: event.tick + 15}))), 'recordings/throttle-b.json');
  const result = await analyzeSegmentPairs([left, right]);
  assert.equal(result.counts.segmentPairs, 1);
  assert.ok(result.findings[0].segment.allChannelStateAgreement < 0.95);
  assert.equal(result.findings[0].evidenceKind, 'steering_segment_other_controls_differ');
});

test('analysis-only decode can compare runs rejected by native scan-work limits without making them native-eligible', async () => {
  const events = [];
  for (let channel = 0; channel < 5; channel++) {
    for (let tick = 0; tick < 2000; tick++) events.push({channel, tick});
  }
  const result = await analyzeSegmentPairs([job(A, events, 'recordings/native-scan-limit.json', 'normal', 300000)]);
  assert.equal(result.counts.decodeUnavailable, 0);
  assert.equal(result.counts.analysisOnlyRuns, 1);
  assert.equal(result.counts.nativeEligibleRuns, 0);
  assert.equal(result.counts.nativeIneligibilityReasons.scan_work_limit, 1);
});

test('normal/event aliases collapse within an account and same-account evidence is excluded', async () => {
  const normal = job(A, sequence(), 'recordings/1.json');
  const event = {...normal, source: 'event-replays/week/A.json', kind: 'event'};
  const other = job(A, sequence(3000), 'recordings/2.json');
  const result = await analyzeSegmentPairs([normal, event, other]);
  assert.equal(result.counts.uniqueRuns, 2);
  assert.equal(result.counts.duplicateSourcesCollapsed, 1);
  assert.equal(result.counts.crossAccountPairs, 0);
  assert.equal(result.counts.sameAccountPairsExcluded, 1);
  assert.equal(result.findings.length, 0);
});

test('full exact low-information and forward-only activity are not reported', async () => {
  const forward = events => events.map(event => ({channel: 0, tick: event.tick}));
  const left = job(A, forward(sequence()), 'recordings/1.json');
  const right = job(B, forward(sequence()), 'recordings/2.json');
  const emptyA = job(A, [], 'recordings/3.json');
  const emptyB = job(B, [], 'recordings/4.json');
  const result = await analyzeSegmentPairs([left, right, emptyA, emptyB]);
  assert.equal(result.counts.crossAccountPairs, 4);
  assert.equal(result.counts.fullExactLowInformation, 2);
  assert.equal(result.counts.segmentPairs, 0);
  assert.equal(result.findings.length, 0);
});

test('invalid input pairs and work limits remain explicit and bounded', async () => {
  const good = job(A, sequence(), 'recordings/1.json');
  const bad = {...job(B, sequence(3000), 'recordings/2.json'), replay: 'not-compressed'};
  const result = await analyzeSegmentPairs([good, bad]);
  assert.equal(result.counts.crossAccountPairs, 1);
  assert.equal(result.counts.crossAccountPairsCompared, 0);
  assert.equal(result.counts.pairsSkippedDecodeUnavailable, 1);
  assert.equal(result.coverage.completeInputPairComparison, false);
  assert.equal(result.coverage.completeSegmentSearch, false);
  assert.equal(result.coverage.completeDecodedSegmentSearch, true);
  const workLimited = await analyzeSegmentPairs([good, job(B, sequence(3000), 'recordings/3.json')],
    {maxPairs: 1, maxSegmentWork: 1});
  assert.equal(workLimited.counts.segmentPairsSkippedWork, 1);
  assert.equal(workLimited.coverage.completeSegmentSearch, false);
  const indexLimited = await analyzeSegmentPairs([good, job(B, sequence(3000), 'recordings/index.json')], {maxIndexWindows: 1});
  assert.equal(indexLimited.coverage.completeSegmentCandidateIndex, false);
  const candidateLimited = await analyzeSegmentPairs([good, job(B, sequence(3000), 'recordings/candidate-b.json'),
    job(C, sequence(5000), 'recordings/candidate-c.json')], {maxCandidateOperations: 1});
  assert.equal(candidateLimited.coverage.completeSegmentCandidateEnumeration, false);
  await assert.rejects(analyzeSegmentPairs([good, job(B, sequence(3000), 'recordings/3.json'),
    job('d'.repeat(64), sequence(5000), 'recordings/4.json')], {maxPairs: 1}), /Cross-account pair cap/);
});

test('private report path is enforced before reading snapshot data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-segment-audit-'));
  const root = path.join(dir, 'repo'); await fs.mkdir(root);
  try { await assert.rejects(runSegmentAudit({root, report: path.join(root, 'audit')}), /outside the Git repository/); }
  finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('private current-audit jobs are schema and hash validated before analysis', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-private-segment-'));
  const root = path.join(directory, 'repo'); await fs.mkdir(root);
  const replay = replayFromEvents(sequence());
  const captured = path.join(directory, 'current.json');
  const row = {accountId: A, trackId: TRACK, timeMs: 8000, replay,
    replayHash: crypto.createHash('sha256').update(replay).digest('hex'), recordId: 'record-1',
    resultId: `${A}_${TRACK}`, kind: 'private-current'};
  try {
    await fs.writeFile(captured, JSON.stringify({schema: 'polytrack-private-current-audit-v1', jobs: [row]}));
    const loaded = await loadPrivateSegmentJobs({root, extraFile: captured});
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].kind, 'private-current');
    const result = await analyzeSegmentPairs([job(B, sequence(), 'recordings/snapshot.json'), ...loaded]);
    assert.equal(result.counts.uniqueRuns, 2);
    assert.equal(result.counts.crossAccountPairs, 1);
    await fs.writeFile(captured, JSON.stringify({schema: 'polytrack-private-current-audit-v1',
      jobs: [{...row, replayHash: '0'.repeat(64)}]}));
    await assert.rejects(loadPrivateSegmentJobs({root, extraFile: captured}), /binding or hash mismatch/);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
