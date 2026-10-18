const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'polytrack_062_patch.js'), 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('placement provider retains its latest complete snapshot during partial cache replacement', () => {
  const context = vm.createContext({
    trackCacheGeneration: 1,
    trackSnapshotStore: () => ({ track: { complete: true, revision: 4, entries: [{ accountId: 'other', timeMs: 1000, replay: 'large payload' }] } })
  });
  vm.runInContext(`let placementSnapshotGeneration=-1;const MAX_RETAINED_PLACEMENT_SNAPSHOTS=64;const placementCompleteSnapshotCache=new Map();${extract('isNewerPlacementSnapshot')}${extract('recordPlacementSnapshots')}`, context);
  assert.equal(context.recordPlacementSnapshots().track.revision, 4);
  context.trackSnapshotStore = () => ({ track: { complete: false, source: 'local', revision: 5, entries: [{ accountId: 'me' }] } });
  context.trackCacheGeneration = 2;
  assert.equal(context.recordPlacementSnapshots().track.revision, 4, 'partial local data must not invalidate the prior complete snapshot');
  assert.equal(context.recordPlacementSnapshots().track.entries[0].replay, undefined, 'retained rows omit replay payloads');
  context.trackSnapshotStore = () => ({ track: { complete: true, revision: 6, fetchedAt: 200, entries: [{ accountId: 'newer' }] } });
  context.trackCacheGeneration = 3;
  assert.equal(context.recordPlacementSnapshots().track.revision, 6, 'a newer complete snapshot replaces the retained one');
});

test('higher-revision complete board wins even when its loaded timestamp is older', () => {
  let current = { track: {
    complete: true, revision: 4, sourceRevision: 4, fetchedAt: 300, totalEntries: 3,
    entries: [{ accountId: 'me', timeMs: 900 }, { accountId: 'fast', timeMs: 800 }, { accountId: 'slow', timeMs: 1000 }]
  } };
  const context = vm.createContext({
    trackCacheGeneration: 1,
    localRaceGeneration: 1,
    trackSnapshotStore: () => current,
    localBestRowsForAccount: () => [{ trackId: 'track', accountId: 'me', timeMs: 900 }],
    canonicalRaceTimeMs: row => Number(row?.timeMs) || 0,
    cleanUserId: value => String(value || '')
  });
  vm.runInContext(`let placementSnapshotGeneration=-1;const MAX_RETAINED_PLACEMENT_SNAPSHOTS=64;const placementCompleteSnapshotCache=new Map();let provisionalPlacementGeneration=-1,provisionalPlacementAccount='',provisionalPlacementRows=new Map();let provisionalPlacementTrackGeneration=-1,provisionalPlacementSnapshots={};const provisionalPlacementCache=new Map();${extract('isNewerPlacementSnapshot')}${extract('recordPlacementSnapshots')}${extract('estimateLocalRecordPlacement')}`, context);
  assert.equal(context.estimateLocalRecordPlacement('track', 900, 'me').label, '~2/3');
  current = { track: {
    complete: true, revision: 5, sourceRevision: 5, fetchedAt: 200, totalEntries: 4,
    entries: [{ accountId: 'me', timeMs: 900 }, { accountId: 'fast', timeMs: 800 }, { accountId: 'slow', timeMs: 1000 }, { accountId: 'new', timeMs: 850 }]
  } };
  context.trackCacheGeneration = 2;
  assert.equal(context.estimateLocalRecordPlacement('track', 900, 'me').label, '~3/4', 'rank numerator and field denominator use the newest loaded complete board');
});

test('same-revision complete board replacement refreshes placement field size', () => {
  let current = { track: { complete: true, revision: 7, fetchedAt: 200, entries: [{ accountId: 'a' }, { accountId: 'b' }] } };
  const context = vm.createContext({ trackCacheGeneration: 1, trackSnapshotStore: () => current });
  vm.runInContext(`let placementSnapshotGeneration=-1;const MAX_RETAINED_PLACEMENT_SNAPSHOTS=64;const placementCompleteSnapshotCache=new Map();${extract('isNewerPlacementSnapshot')}${extract('recordPlacementSnapshots')}`, context);
  assert.equal(context.recordPlacementSnapshots().track.entries.length, 2);
  current = { track: { complete: true, revision: 7, fetchedAt: 200, entries: [{ accountId: 'a' }, { accountId: 'b' }, { accountId: 'c' }] } };
  context.trackCacheGeneration = 2;
  assert.equal(context.recordPlacementSnapshots().track.entries.length, 3, 'equal revision and freshness may still carry a complete replacement');
});

test('local PB estimate refuses incomplete boards even when they declare a larger field size', () => {
  const trackId = 'track-a';
  const context = vm.createContext({
    Map,
    Number,
    Array,
    localRaceGeneration: 1,
    localRaceRows: [{ trackId, accountId: 'me', timeMs: 900 }],
    localBestRowsForAccount: () => [{ trackId, timeMs: 900 }],
    canonicalRaceTimeMs: row => Number(row?.timeMs) || 0,
    cleanUserId: value => String(value || ''),
    trackCacheGeneration: 1,
    trackSnapshotStore: () => ({ [trackId]: {
      complete: false,
      totalEntries: 9,
      entries: [
        { accountId: 'faster', timeMs: 800 },
        { accountId: 'slower', timeMs: 1100 }
      ]
    } })
  });
  vm.runInContext(`let placementSnapshotGeneration=-1;const MAX_RETAINED_PLACEMENT_SNAPSHOTS=64;const placementCompleteSnapshotCache=new Map();let provisionalPlacementGeneration=-1,provisionalPlacementAccount='',provisionalPlacementRows=new Map();let provisionalPlacementTrackGeneration=-1,provisionalPlacementSnapshots={};const provisionalPlacementCache=new Map();${extract('isNewerPlacementSnapshot')}${extract('recordPlacementSnapshots')}${extract('estimateLocalRecordPlacement')}`, context);
  assert.equal(context.estimateLocalRecordPlacement(trackId, 900, 'me'), null, 'partial rows cannot safely establish numeric rank');
  assert.equal(context.estimateLocalRecordPlacement(trackId, 901, 'me'), null, 'only the currently saved local PB may be estimated');
});

test('new local PB uses the retained complete board after the current cache becomes partial', () => {
  const trackId = 'track-a';
  const completeBoard = {
    complete: true,
    totalEntries: 3,
    revision: 4,
    sourceRevision: 4,
    source: 'edge',
    fetchedAt: 100,
    checkedAt: 110,
    entries: [
      { accountId: 'me', userId: 'me', trackId, timeMs: 1000, timingVersion: 2, replay: 'large replay' },
      { accountId: 'faster', userId: 'faster', trackId, timeMs: 800, timingVersion: 2 },
      { accountId: 'slower', userId: 'slower', trackId, timeMs: 1100, timingVersion: 2 }
    ]
  };
  const context = vm.createContext({
    Map,
    Number,
    Array,
    localRaceGeneration: 1,
    localBestRowsForAccount: () => [{ trackId, timeMs: 900 }],
    canonicalRaceTimeMs: row => Number(row?.timeMs) || 0,
    cleanUserId: value => String(value || ''),
    trackCacheGeneration: 1,
    trackSnapshotStore: () => ({ [trackId]: completeBoard })
  });
  vm.runInContext(`let placementSnapshotGeneration=-1;const MAX_RETAINED_PLACEMENT_SNAPSHOTS=64;const placementCompleteSnapshotCache=new Map();let provisionalPlacementGeneration=-1,provisionalPlacementAccount='',provisionalPlacementRows=new Map();let provisionalPlacementTrackGeneration=-1,provisionalPlacementSnapshots={};const provisionalPlacementCache=new Map();${extract('isNewerPlacementSnapshot')}${extract('recordPlacementSnapshots')}${extract('estimateLocalRecordPlacement')}`, context);
  assert.equal(context.estimateLocalRecordPlacement(trackId, 900, 'me').label, '~2/3');
  context.trackSnapshotStore = () => ({ [trackId]: { complete: false, source: 'local', revision: 5, entries: [{ accountId: 'me', timeMs: 900 }] } });
  context.trackCacheGeneration = 2;
  const result = context.estimateLocalRecordPlacement(trackId, 900, 'me');
  assert.equal(result.label, '~2/3');
  assert.equal(result.estimated, true);
  assert.equal(context.recordPlacementSnapshots()[trackId].entries[0].replay, undefined, 'the retained estimate board is compact');
});

test('retained complete snapshot cache is capped at 64 boards', () => {
  const complete = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`track-${index}`, {
    complete: true, revision: 1, entries: [{ accountId: 'racer', timeMs: 1000 }]
  }]));
  let current = complete;
  const context = vm.createContext({ trackCacheGeneration: 1, trackSnapshotStore: () => current });
  vm.runInContext(`let placementSnapshotGeneration=-1;const MAX_RETAINED_PLACEMENT_SNAPSHOTS=64;const placementCompleteSnapshotCache=new Map();${extract('isNewerPlacementSnapshot')}${extract('recordPlacementSnapshots')}`, context);
  context.recordPlacementSnapshots();
  current = Object.fromEntries(Object.keys(complete).map(trackId => [trackId, { complete: false, entries: [] }]));
  context.trackCacheGeneration = 2;
  const retained = context.recordPlacementSnapshots();
  assert.equal(Object.values(retained).filter(snapshot => snapshot.complete === true).length, 64);
});

test('placement render scheduling coalesces repeated PB refresh requests', () => {
  const timers = [];
  let renders = 0;
  const context = vm.createContext({
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    decoratePersonalBestPodiums() { renders += 1; }
  });
  vm.runInContext(`let placementRenderTimer=0;${extract('schedulePersonalBestPlacementRender')}`, context);
  context.schedulePersonalBestPlacementRender();
  context.schedulePersonalBestPlacementRender();
  context.schedulePersonalBestPlacementRender();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 100);
  timers[0].callback();
  assert.equal(renders, 1);
  assert.equal(context.placementRenderTimer, undefined, 'timer state remains private to the source closure');
});

test('an old cached board checked recently cannot override newer bundled content at the same revision',()=>{
  const context=vm.createContext({Number,Math});vm.runInContext(extract('isNewerPlacementSnapshot'),context);
  const older={revision:4,serverUpdatedAt:100,checkedAt:900,fetchedAt:900};
  const newer={revision:4,serverUpdatedAt:200,checkedAt:0,fetchedAt:500};
  assert.equal(context.isNewerPlacementSnapshot(newer,older),true);
  assert.equal(context.isNewerPlacementSnapshot(older,newer),false);
});
