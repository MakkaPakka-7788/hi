import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
const loadPermanentSource = source.slice(source.indexOf('  async function loadPermanent()'), source.indexOf('  async function loadCatalog('));
const trackId = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';

function fixture(value) {
  const context = {
    permanent: null,
    permanentAt: 0,
    permanentFetching: null,
    cached: [],
    bridge: { readPermanent: async () => value },
    now: () => 500000,
    ROLLING_TRACK_ID: trackId,
    cacheWrite: (...args) => context.cached.push(args),
    STORE: 'events',
    tick() {}
  };
  return vm.runInNewContext(`(${loadPermanentSource.trim()})()`, context).then(() => context);
}

test('permanent snapshot binding rejects complete boards for another track or event kind', async () => {
  const base = { id: 'permanent-rolling-hills', kind: 'permanent', trackId, complete: true, entries: [], maxRp: 1001 };
  for (const invalid of [{ ...base, trackId: 'a'.repeat(64) }, { ...base, kind: 'weekly' }]) {
    const result = await fixture(invalid);
    assert.equal(result.permanent, null);
  }
});

test('permanent snapshot binding accepts the complete Rolling Hills board', async () => {
  const result = await fixture({ id: 'permanent-rolling-hills', kind: 'permanent', trackId, complete: true, entries: [], maxRp: 1001, sourceRevision: 1 });
  assert.equal(result.permanent.id, 'permanent-rolling-hills');
});
