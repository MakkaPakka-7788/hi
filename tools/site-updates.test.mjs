import test from 'node:test';
import assert from 'node:assert/strict';
import { installSiteUpdates } from './site-updates.mjs';
import { readFileSync } from 'node:fs';

class FakeDocument extends EventTarget {
  constructor() {
    super(); this.visibilityState = 'visible'; this.baseURI = 'https://game.example/path/';
    this.body = { append: (element) => { this.button = element; } };
  }
  hasFocus() { return true; }
  createElement() { return { style: {}, dataset: {}, listeners: {}, setAttribute(name, value) { this[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; }, remove() { this.removed = true; } }; }
}

function harness({ response = { revision: 44 }, isIdle = () => true, revision = 43 } = {}) {
  const document = new FakeDocument(); let time = 1000, calls = 0, reloadChecks = 0, nextTimer = 0, currentResponse=response;
  const timers = new Map();
  const handle = installSiteUpdates({ revision, document, now: () => time, isIdle,
    fetch: async (url, options) => { calls++; const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,'https://game.example/path/site-version.json');
      assert.equal(parsed.searchParams.get('_updateCheck'),String(time));assert.equal(options.cache, 'no-store'); return { ok: true, json: async () => currentResponse }; },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), canReload: () => { reloadChecks++; return false; } });
  return { document, handle, timers, get calls() { return calls; }, get reloadChecks() { return reloadChecks; }, setTime: (value) => { time = value; }, setResponse: value => { currentResponse=value; } };
}

test('checks same-origin version and offers reload only from a user-clickable notification', async () => {
  const h = harness(); await h.handle.check();
  assert.equal(h.calls, 1); assert.equal(h.document.button.textContent, 'Update available');
  assert.equal(h.document.button.dataset.siteUpdate, 'available');
  assert.equal(h.reloadChecks, 0, 'finding an update must not interrupt the current session');
  h.document.button.listeners.click();
  assert.equal(h.reloadChecks, 1, 'reload safety is checked only after an explicit click');
  h.handle.dispose();
});

test('clears an obsolete update badge when the loaded revision is current', async () => {
  const h=harness();await h.handle.check();
  const badge=h.document.button;assert.equal(badge.dataset.siteUpdate,'available');
  h.setTime(1000+30*60*1000);h.setResponse({revision:'44'});await h.handle.check();
  assert.equal(badge.removed,undefined,'an invalid response must not clear a valid notification');
  h.setTime(1000+60*60*1000);h.setResponse({revision:43});await h.handle.check();
  assert.equal(badge.removed,true);assert.equal(h.document.button,badge);
  h.setTime(1000+90*60*1000);h.setResponse({revision:45});await h.handle.check();
  assert.notEqual(h.document.button,badge);assert.equal(h.document.button.dataset.siteUpdate,'available');
  h.handle.dispose();
});

test('new bootstrap revision clears stale remote state but retains a genuinely newer release',async()=>{
  const h=harness({revision:114,response:{revision:115}});await h.handle.check();
  const badge=h.document.button;assert.ok(badge);
  h.setTime(1000+30*60*1000);h.setResponse({revision:112});await h.handle.check();
  assert.equal(badge.removed,true,'a stale remote manifest cannot leave the old badge visible');
  h.setTime(1000+60*60*1000);h.setResponse({revision:115});await h.handle.check();
  assert.equal(h.document.button.dataset.siteUpdate,'available','a revision newer than the loaded client remains visible');
  h.handle.dispose();
});

test('deduplicates installations and throttles interval and visibility-resume checks', async () => {
  const h = harness();
  assert.equal(installSiteUpdates({ revision: 43, document: h.document, fetch: async () => assert.fail('duplicate') }), h.handle);
  await h.handle.check(); assert.equal(h.calls, 1);
  h.document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); assert.equal(h.calls, 1);
  h.setTime(1000 + 30 * 60 * 1000); await h.handle.check(); assert.equal(h.calls, 2); h.handle.dispose();
});

test('does not check while hidden or not idle', async () => {
  let idle = false; const h = harness({ isIdle: () => idle }); await h.handle.check();
  h.document.visibilityState = 'hidden'; idle = true; await h.handle.check(); assert.equal(h.calls, 0);
  h.document.visibilityState = 'visible'; await h.handle.check(); assert.equal(h.calls, 1); h.handle.dispose();
});

test('rejects invalid revisions and never requests a cross-origin endpoint', async () => {
  for (const response of [{ revision: 43 }, { revision: '44' }, { revision: -1 }]) {
    const h = harness({ response }); await h.handle.check(); assert.equal(h.document.button, undefined); h.handle.dispose();
  }
  const document = new FakeDocument();
  const h = installSiteUpdates({ revision: 43, document, endpoint: 'https://other.example/site-version.json',
    fetch: async () => assert.fail('cross-origin request') });
  await h.check(); h.dispose();
});

test('contains fetch failures and removes the notification on disposal', async () => {
  const h = harness(); await h.handle.check(); h.handle.dispose(); assert.equal(h.document.button.removed, true);
  const document = new FakeDocument();
  const failed = installSiteUpdates({ revision: 43, document, fetch: async () => { throw Error('offline'); } });
  await failed.check(); assert.equal(document.button, undefined); failed.dispose();
});

test('checked-in updater, client loader and published revision agree', () => {
  const root=new URL('../',import.meta.url);
  const revision=JSON.parse(readFileSync(new URL('site-version.json',root),'utf8')).revision;
  const patch=readFileSync(new URL('polytrack_062_patch.js',root),'utf8');
  const index=readFileSync(new URL('index.html',root),'utf8');
  assert.ok(patch.includes(`installSiteUpdates({revision:${revision},`));
  assert.ok(patch.includes(`site-updates.mjs?v=${revision}`));
  assert.ok(index.includes(`polytrack_062_patch.js?v=${revision}`));
});
