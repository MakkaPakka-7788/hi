import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeveloperReport } from './developer-diagnostics.mjs';

const id = 'a'.repeat(64);

test('report preserves the v1 structure and omits public ID by default', () => {
 const report = buildDeveloperReport({ publicId: id, email: 'private@example.test', token: 'secret' });
 assert.equal(report.schema, 'polytrack-developer-diagnostics-v1');
 assert.equal(report.privacy.automaticUpload, false);
 assert.equal(report.publicRacerId, undefined);
 assert.doesNotMatch(JSON.stringify(report), /private@example|secret|token/);
 assert.equal(buildDeveloperReport({ publicId: id, includePublicId: true }).publicRacerId, id);
});

test('local results reuse the loaded-results whitelist and rejects secrets', () => {
 const report = buildDeveloperReport({ localResults: [{ trackId: id, timeMs: 42, rank: 1, fieldSize: 5, code: 'private-code', replay: 'secret', token: 'secret' }] });
 assert.deepEqual(report.localResults[0], { trackId: id, timeMs: 42, rank: 1, fieldSize: 5, weight: null, cachedAt: 0, snapshotCapturedAt: 0, runVerified: null, integrityVerified: null, local: false, placementKnown: true });
 assert.doesNotMatch(JSON.stringify(report.localResults), /private-code|secret|replay|token/);
});

test('insights, tracks, and settings export only bounded schema fields', () => {
 const report = buildDeveloperReport({
  insights: { version: 1, startedAt: 3, revisions: [{ revision: 7, firstAt: 1, lastAt: 2, visits: 4, token: 'secret' }], tracks: { [id]: { plays: 2, sources: { planner: 1, password: 'secret' }, token: 'secret' } }, transitions: { [`${id}:${id}`]: 5 }, metrics: { BOARD: { count: 2, totalMs: 20, maxMs: 15, over5s: 1, arbitrary: 'secret' } }, actions: { 'planner-track-click': 1 }, token: 'secret' },
  extraTracks: [{ id, name: 'Track', author: 'Maker', code: 'secret', script: 'secret' }],
  settings: { music: true, volume: 0.5, token: 'secret', privateSetting: 'secret', debug: false }
 });
 assert.deepEqual(report.extraTracks, [{ trackId: id, name: 'Track', author: 'Maker' }]);
 assert.deepEqual(report.settings, { music: true, volume: 0.5 });
 assert.equal(report.insights.tracks[id].sources.planner, 1);
 assert.doesNotMatch(JSON.stringify(report.insights), /secret|token|password/);
});

test('local results and extra-track metadata allow 5000 rows and report truncation', () => {
 const rows = Array.from({ length: 5001 }, (_, index) => ({ trackId: String(index), name: 'Track ' + index, timeMs: index }));
 const report = buildDeveloperReport({ localResults: rows, extraTracks: rows });
 assert.equal(report.localResults.length, 5000);
 assert.equal(report.extraTracks.length, 5000);
 assert.deepEqual(report.truncation, { localResults: { omitted: 1 }, extraTracks: { omitted: 1 } });
 assert.equal(report.extraTracks[0].trackId, '0');
 assert.equal(report.extraTracks[0].timeMs, undefined);
});

test('practice aggregate stats include active time, starts, finishes, resets and notes', () => {
 const report = buildDeveloperReport({ practice: [
  { activeMs: 200, attempts: 3, finishes: 0, restarts: 2, respawns: 1, recentFinishes: [{ timingNote: true }] },
  { activeMs: 300, attempts: 2, finishes: 1, restarts: 4, respawns: 0, recentFinishes: [{ timingNote: false }] }
 ] });
 assert.deepEqual(report.practiceSummary, { activeMs: 500, starts: 5, finishes: 1, resets: 7, tracksNeverFinished: 1, timingNotes: 1 });
});

test('unknown result placement remains unknown and sensitive fields never escape', () => {
 const result = buildDeveloperReport({ finishes: [{ rank: Infinity, fieldSize: Infinity, weight: null, connectionCode: 'secret' }] }).loadedResults[0];
 assert.equal(result.rank, null); assert.equal(result.fieldSize, null); assert.equal(result.placementKnown, false);
 assert.doesNotMatch(JSON.stringify(result), /secret|connectionCode/);
});
