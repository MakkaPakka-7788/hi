import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const patchPath = new URL('../polytrack_062_patch.js',import.meta.url);
const patch = await readFile(patchPath, 'utf8');

function functionSource(name) {
  const start = patch.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const brace = patch.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escape = false;
  for (let i = brace; i < patch.length; i++) {
    const char = patch[i];
    if (quote) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return patch.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function makeSortHarness(profileSort, profileSortDirection) {
  const context = {
    profileSort,
    profileSortDirection,
    knownFinishWeight: row => row.weight,
    trackInfo: trackId => ({name: trackId}),
  };
  const source = `let {profileSort,profileSortDirection,knownFinishWeight,trackInfo}=deps;${functionSource('sortProfileFinishes')};return sortProfileFinishes;`;
  return new Function('deps', source)(context);
}

for (const mode of ['place', 'track', 'weight', 'time']) {
  for (const direction of [1, -1]) {
    test(`${mode} sort keeps every unknown placement after placed rows (direction ${direction})`, () => {
      const rows = [
        {id: 'unknown-rank-zero', rank: 0, fieldSize: 900, trackId: 'A', weight: 0, timeMs: 9000},
        {id: 'placed-slow', rank: 2, fieldSize: 5, trackId: 'B', weight: 2, timeMs: 20000},
        {id: 'unknown-rank-null', rank: null, fieldSize: 300, trackId: 'C', weight: 0, timeMs: 1000},
        {id: 'placed-fast', rank: 1, fieldSize: 5, trackId: 'D', weight: 4, timeMs: 10000},
        {id: 'unknown-field', rank: 3, fieldSize: null, trackId: 'E', weight: 8, timeMs: 500},
        {id: 'unknown-rank-missing', fieldSize: 1000, trackId: 'F', weight: null, timeMs: null},
      ];
      const sorted = makeSortHarness(mode, direction)(rows);
      const placedIds = new Set(['placed-slow', 'placed-fast']);
      const firstUnknown = sorted.findIndex(row => !placedIds.has(row.id));

      assert.ok(firstUnknown >= 0);
      assert.ok(sorted.slice(0, firstUnknown).every(row => placedIds.has(row.id)));
      assert.ok(sorted.slice(firstUnknown).every(row => !placedIds.has(row.id)));
      assert.equal(sorted.length, rows.length);
    });
  }
}

test('complete cached board recomputes placement after merging a faster local result', () => {
  const trackId = 'release-156-track';
  const accountId = 'self';
  const snapshot = {
    complete: true,
    totalEntries: 3,
    serverUpdatedAt: 100,
    entries: [
      {accountId: 'rival', timeMs: 15000, rank: 1, position: 1},
      {accountId: 'third', timeMs: 18000, rank: 2, position: 2},
      {accountId, timeMs: 20000, rank: 3, position: 3},
    ],
  };
  const localRows = [{accountId, trackId, timeMs: 14000, createdAt: 200, id: 'local-pb'}];
  const profileSnapshotResults = new Map();
  const deps = {
    cleanUserId: value => String(value || ''),
    canonicalRaceTimeMs: row => Number(row?.timeMs || 0),
    trackSnapshotStore: () => ({[trackId]: snapshot}),
    readLocalRaceRows: () => localRows,
    localRaceRowsForTrack: id => localRows.filter(row => row.trackId === id),
    safeRecordingId: value => value || '',
    buildRecordingId: () => 'generated-local-recording',
    localPbCloudConfirmed: () => false,
    entryTimeMs: row => Number(row?.timeMs || 0),
    pbTimestamp: row => Number(row?.createdAt || row?.pbAt || 0),
    knownFinishWeight: ({rank, fieldSize}) => rank && fieldSize ? fieldSize / rank : null,
    overallLoadState: {},
    readOverallSnapshotCache: () => null,
    activeRankedAccountId: () => accountId,
    profileSnapshotResults,
    sortProfileFinishes: rows => rows,
  };
  const functions = [
    'profileBoardIsComplete',
    'localTrackDisplayEntries',
    'visibleTrackEntries',
    'cachedProfileFinishes',
  ].map(functionSource).join('\n');
  const source = `
    const {cleanUserId,canonicalRaceTimeMs,trackSnapshotStore,readLocalRaceRows,
      localRaceRowsForTrack,safeRecordingId,buildRecordingId,localPbCloudConfirmed,
      entryTimeMs,pbTimestamp,knownFinishWeight,overallLoadState,readOverallSnapshotCache,
      activeRankedAccountId,profileSnapshotResults,sortProfileFinishes}=deps;
    ${functions}
    return cachedProfileFinishes;
  `;
  const cachedProfileFinishes = new Function('deps', source)(deps);
  const [finish] = cachedProfileFinishes(accountId, {});

  assert.equal(finish.timeMs, 14000);
  assert.equal(finish.rank, 1);
  assert.equal(finish.fieldSize, 3);
  assert.equal(finish.local, true);
});
