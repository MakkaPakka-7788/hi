import assert from 'node:assert/strict';
import test from 'node:test';
import {compareInputSegment} from './segment-similarity.mjs';

function controls(offset = 0) {
  const lists = {up: [], right: [], down: [], left: [], reset: []};
  for (let index = 0; index < 24; index++) lists[index % 2 ? 'down' : 'right'].push(offset + 100 + index * 100);
  return lists;
}

test('reports exact steering segment and full five-channel agreement with shifted timestamps', () => {
  const result = compareInputSegment({lists: controls()}, {lists: controls(3000)}, 8000, 11000);
  assert.ok(result);
  assert.equal(result.inputSimilarity, 1);
  assert.equal(result.transitionSimilarity, 1);
  assert.equal(result.matchedChanges, 24);
  assert.equal(result.informativeMs >= 1000, true);
  assert.equal(result.offsetTicks, 3000);
  assert.equal(result.reviewOnly, true);
});

test('requires at least 95 percent five-channel overlap, including up/throttle state', () => {
  const nearA = controls(), nearB = controls(3000);
  nearA.up.push(2350);
  const near = compareInputSegment({lists: nearA}, {lists: nearB}, 8000, 11000);
  assert.ok(near);
  assert.ok(near.inputSimilarity >= 0.95 && near.inputSimilarity < 1);

  const farA = controls(), farB = controls(3000);
  farA.up.push(200);
  assert.equal(compareInputSegment({lists: farA}, {lists: farB}, 8000, 11000), null);
});

test('returns null for malformed or oversized controls instead of doing unbounded work', () => {
  const badOrder = controls(); badOrder.up.push(4, 3);
  assert.equal(compareInputSegment({lists: badOrder}, {lists: controls()}, 8000, 8000), null);
  const tooMany = controls(); tooMany.reset = Array.from({length: 20001}, (_, index) => index + 1);
  assert.equal(compareInputSegment({lists: tooMany}, {lists: controls()}, 30000, 30000), null);
  assert.equal(compareInputSegment({lists: controls()}, {lists: controls()}, 6000000, 6000000), null);
});
