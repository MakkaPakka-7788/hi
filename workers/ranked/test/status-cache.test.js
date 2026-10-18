import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';

const origin = 'https://staticquasar931.github.io';
const request = (suffix = '', source = origin, ip = '203.0.113.1') => new Request('https://ranked.example/v1/status' + suffix,
  {headers: {Origin: source, 'CF-Connecting-IP': ip}});

test('status shares cold reads, ignores cache-busters and expires after 30 seconds', async () => {
  const previous = globalThis.caches, stored = new Map();
  let reads = 0, permits = 0, now = 0;
  globalThis.caches = {default: {
    match: async key => {const item = stored.get(key.url); return item && item.until > now ? item.response.clone() : null;},
    put: async (key, response) => {assert.equal(response.headers.get('Cache-Control'), 'public, max-age=30'); stored.set(key.url, {until: now + 30000, response: response.clone()});}
  }};
  const env = {ALLOWED_ORIGINS: origin, PUBLIC_READ_RATE_LIMITER: {limit: async () => {permits++; return {success: true};}},
    __TEST_FIRESTORE: async () => {reads++; await new Promise(resolve => setTimeout(resolve, 10)); return {fields: {revision: {integerValue: String(reads)}}};}};
  try {
    const responses = await Promise.all(Array.from({length: 8}, (_, i) => handleRequest(request('?r=' + i), env)));
    for (const response of responses) assert.equal((await response.json()).revision, 1);
    assert.equal(reads, 1); assert.equal(permits, 8, 'each cold caller is admitted independently');
    now = 29999;
    assert.equal((await handleRequest(request('?r=another'), env)).status, 200);
    assert.equal(permits, 8, 'cached school-network requests consume no cold-read permit');
    now = 30001;
    assert.equal((await (await handleRequest(request(), env)).json()).revision, 2);
    assert.equal(reads, 2);
  } finally {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});

test('status rejects disallowed origins and limited requests before database access', async () => {
  let reads = 0;
  const env = {ALLOWED_ORIGINS: origin, PUBLIC_READ_RATE_LIMITER: {limit: async () => ({success: false})},
    __TEST_FIRESTORE: async () => {reads++; return null;}};
  assert.equal((await handleRequest(request('', 'https://untrusted.example'), env)).status, 403);
  assert.equal((await handleRequest(request(), env)).status, 429);
  assert.equal(reads, 0);
});

test('status failures release the in-flight request and cannot masquerade as healthy data', async () => {
  let reads = 0;
  const env = {ALLOWED_ORIGINS: origin, __TEST_FIRESTORE: async () => {reads++; if (reads === 1) throw Error('synthetic failure'); return null;}};
  const failed = await handleRequest(request(), env);
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get('Cache-Control'), /no-store/);
  assert.equal((await handleRequest(request(), env)).status, 200);
  assert.equal(reads, 2);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

for (const endpoint of ['/v1/status', '/v1/snapshot/overall']) {
const endpointRequest = (ip) => new Request('https://ranked.example' + endpoint, {headers: {Origin: origin, 'CF-Connecting-IP': ip}});
test('a denied cold leader cannot share its 429 with an allowed caller: ' + endpoint, async () => {
  const previous = globalThis.caches;
  const entered = deferred(), admission = deferred();
  const permits = [];
  let reads = 0, puts = 0, pending = [];
  globalThis.caches = {default: {
    match: async () => null,
    put: async (_key, response) => {assert.equal(response.status, 200); puts++;}
  }};
  const env = {ALLOWED_ORIGINS: origin, PUBLIC_READ_RATE_LIMITER: {limit: async ({key}) => {
    permits.push(key);
    if (key === '203.0.113.1') {entered.resolve(); await admission.promise; return {success: false};}
    return {success: true};
  }}, __TEST_FIRESTORE: async () => {reads++; return {fields: {revision: {integerValue: '7'}}};}};
  try {
    pending.push(handleRequest(endpointRequest('203.0.113.1'), env, {waitUntil: () => {}}));
    await entered.promise;
    pending.push(handleRequest(endpointRequest('203.0.113.2'), env, {waitUntil: () => {}}));
    await new Promise(resolve => setImmediate(resolve));
    admission.resolve();
    const [denied, allowed] = await Promise.all(pending);
    assert.equal(denied.status, 429);
    assert.match(denied.headers.get('Cache-Control'), /no-store/);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).revision, 7);
    assert.deepEqual(permits, ['203.0.113.1', '203.0.113.2']);
    assert.equal(reads, 1); assert.equal(puts, 1);
  } finally {
    admission.resolve(); await Promise.allSettled(pending);
    if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;
  }
});

test('a denied cold follower cannot bypass admission by joining an allowed read: ' + endpoint, async () => {
  const previous = globalThis.caches;
  const entered = deferred(), database = deferred();
  const permits = [];
  let reads = 0, pending = [];
  globalThis.caches = {default: {match: async () => null, put: async () => {}}};
  const env = {ALLOWED_ORIGINS: origin, PUBLIC_READ_RATE_LIMITER: {limit: async ({key}) => {
    permits.push(key); return {success: key === '203.0.113.2'};
  }}, __TEST_FIRESTORE: async () => {reads++; entered.resolve(); await database.promise; return null;}};
  try {
    pending.push(handleRequest(endpointRequest('203.0.113.2'), env));
    await entered.promise;
    pending.push(handleRequest(endpointRequest('203.0.113.1'), env));
    await new Promise(resolve => setImmediate(resolve));
    database.resolve();
    const [allowed, denied] = await Promise.all(pending);
    assert.equal(allowed.status, endpoint === '/v1/status' ? 200 : 404);
    assert.equal(denied.status, 429);
    assert.match(denied.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(permits, ['203.0.113.2', '203.0.113.1']);
    assert.equal(reads, 1);
  } finally {
    database.resolve(); await Promise.allSettled(pending);
    if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;
  }
});
}

test('warm status cache hits skip even a denying limiter', async () => {
  const previous = globalThis.caches;
  const cached = new Response(JSON.stringify({revision: 9}), {headers: {'Cache-Control': 'public, max-age=30'}});
  let permits = 0, reads = 0;
  globalThis.caches = {default: {match: async () => cached.clone()}};
  const env = {ALLOWED_ORIGINS: origin, PUBLIC_READ_RATE_LIMITER: {limit: async () => {permits++; return {success: false};}},
    __TEST_FIRESTORE: async () => {reads++; return null;}};
  try {
    const response = await handleRequest(request(), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).revision, 9);
    assert.equal(permits, 0); assert.equal(reads, 0);
  } finally {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});


test('public leaderboards share a one-minute cache without caching failures', async () => {
  const previous = globalThis.caches, stored = new Map(), fills = [];
  let reads = 0, now = 0;
  globalThis.caches = {default: {
    match: async key => {const item = stored.get(key.url); return item && item.until > now ? item.response.clone() : null;},
    put: async (key, response) => {
      assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60, stale-while-revalidate=30');
      stored.set(key.url, {until: now + 60000, response: response.clone()});
    }
  }};
  const env = {ALLOWED_ORIGINS: origin, __TEST_FIRESTORE: async () => {
    reads++; return {fields: {revision: {integerValue: String(reads)}, entries: {arrayValue: {values: []}}}};
  }};
  const context = {waitUntil: promise => fills.push(promise)};
  const boardRequest = suffix => new Request('https://ranked.example/v1/snapshot/overall' + suffix, {headers: {Origin: origin}});
  try {
    const first = await handleRequest(boardRequest(''), env, context);
    assert.equal(first.status, 200); await Promise.all(fills);
    now = 59999;
    assert.equal((await (await handleRequest(boardRequest('?cachebuster=1'), env, context)).json()).revision, 1);
    assert.equal(reads, 1);
    now = 60001;
    assert.equal((await (await handleRequest(boardRequest(''), env, context)).json()).revision, 2);
    await Promise.all(fills);
    now = 120002;
    env.__TEST_FIRESTORE = async () => {throw Error('synthetic failure');};
    await assert.rejects(handleRequest(boardRequest(''), env, context), /synthetic failure/);
    env.__TEST_FIRESTORE = async () => {reads++; return {fields: {revision: {integerValue: String(reads)}}};};
    assert.equal((await (await handleRequest(boardRequest(''), env, context)).json()).revision, 3);
    await Promise.all(fills);
  } finally {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});
