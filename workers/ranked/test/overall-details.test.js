import assert from 'node:assert/strict';
import test from 'node:test';
import {compactOverallEntries, unpackOverallDetails} from '../src/overall-details.js';
import {plannerDocumentBytes} from '../src/planner-results.js';

const detailFields = [
  'weightedResults', 'bestTracks', 'opportunityTracks', 'strongestTrack',
  'worstTrack', 'improvementTrack', 'cosmeticUnlocks', 'serverAchievements',
  'betaEntitlement'
];

test('overall details bundle compacts main below 900 KB and round-trips every entry field', async () => {
  const entries = Array.from({length: 200}, (_, index) => ({
    userId: `racer-${index}`,
    name: `Player ${index}`,
    score: index / 10,
    carStyle: {paint: `color-${index}`},
    profileCosmetics: {badge: `badge-${index}`},
    bestTracks: Array.from({length: 2}, (_, n) => ({trackId: `track-${(index + n) % 78}`, rank: n + 1, fieldSize: 40})),
    weightedResults: Array.from({length: 2}, (_, n) => ({trackId: `track-${(index + n) % 78}`, rank: n + 1, fieldSize: 40})),
    opportunityTracks: Array.from({length: 3}, (_, n) => ({trackId: `track-${(index + n) % 78}`, rank: n + 2, fieldSize: 40})),
    strongestTrack: {trackId: `track-${index % 78}`, rank: 1, fieldSize: 40},
    worstTrack: {trackId: `track-${index % 78}`, rank: 38, fieldSize: 40},
    improvementTrack: {trackId: `track-${index % 78}`, rank: 3, fieldSize: 40},
    cosmeticUnlocks: ['paint-a', 'paint-b'],
    serverAchievements: {casual: {count: 18, rp: 125}, beatOwner: {targetAccountId: 'a'.repeat(64), count: 4, unlocks: [{cosmeticId: 'badge-x'}]}},
    betaEntitlement: {id: 'beta-tester', source: 'ranked-overall-snapshot', sourceRevision: 4, issuedAt: 1780000000000, cutoffAt: 0}
  }));
  const compacted = await compactOverallEntries(entries);
  assert.equal(compacted.entryDetailsVersion, 1);
  assert.ok(compacted.entryDetailsBundle);
  assert.ok(compacted.entries.every(row => detailFields.every(field => !(field in row))));
  const main = {entries: compacted.entries, entryDetailsBundle: compacted.entryDetailsBundle,
    entryDetailsVersion: compacted.entryDetailsVersion, revision: 4};
  assert.ok(plannerDocumentBytes(main) < 900_000);
  assert.deepEqual(await unpackOverallDetails(main), {entries, revision: 4});
});

test('overall details decoder rejects mismatched, malformed, and oversized bundles', async () => {
  const packed = await compactOverallEntries([{userId: 'racer', name: 'Racer', bestTracks: [{trackId: 'track'}]}]);
  await assert.rejects(unpackOverallDetails({...packed, entries: [{userId: 'other', name: 'Other'}]}), /OVERALL_DETAILS_INVALID/);
  await assert.rejects(unpackOverallDetails({entries: [], entryDetailsVersion: 1, entryDetailsBundle: '%%%='}), /OVERALL_DETAILS_INVALID/);
  await assert.rejects(unpackOverallDetails({entries: [], entryDetailsVersion: 1, entryDetailsBundle: 'A'.repeat(700_004)}), /OVERALL_DETAILS_INVALID/);
});

test('overall details compactor keeps all original fields inline if entries cannot be safely bundled', async () => {
  const entries = [{userId: 'duplicate'}, {userId: 'duplicate', bestTracks: [{trackId: 'track'}]}];
  const result = await compactOverallEntries(entries);
  assert.deepEqual(result, {entries});
});
