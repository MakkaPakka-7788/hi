import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import {decodeAnalysisReplay} from './analysis-replay-decoder.mjs';

const names = ['up', 'right', 'down', 'left', 'reset'];

function pack(counts, values = []) {
  const parts = [];
  let offset = 0;
  for (const count of counts) {
    const header = Buffer.alloc(3); header.writeUIntLE(count, 0, 3); parts.push(header);
    for (const delta of values.slice(offset, offset + count)) {
      const bytes = Buffer.alloc(3); bytes.writeUIntLE(delta, 0, 3); parts.push(bytes);
    }
    offset += count;
  }
  return Buffer.concat(parts);
}

function replay(bytes) { return zlib.deflateSync(bytes).toString('base64url'); }

test('analysis decoder accepts larger-but-bounded valid replay data', () => {
  const counts = [2000, 2000, 2000, 2000, 2000];
  const values = Array.from({length: 10000}, (_, index) => index % 2000 === 0 ? 0 : 1);
  const decoded = decodeAnalysisReplay(replay(pack(counts, values)), 300000);
  assert.equal(decoded.transitions, 10000);
  assert.equal(decoded.lists.reset.length, 2000);
});

test('rejects malformed and noncanonical encodings, appended compressed bytes, and trailing payload', () => {
  const valid = replay(pack([0, 0, 0, 0, 0]));
  assert.throws(() => decodeAnalysisReplay(`${valid}!`, 10), /invalid_base64url/);
  assert.throws(() => decodeAnalysisReplay(`${valid}A`, 10), /invalid_base64url|noncanonical_base64url|trailing_compressed_bytes/);
  const compressed = Buffer.from(valid, 'base64url');
  assert.throws(() => decodeAnalysisReplay(Buffer.concat([compressed, Buffer.from([0])]).toString('base64url'), 10), /trailing_compressed_bytes/);
  assert.throws(() => decodeAnalysisReplay(replay(Buffer.concat([pack([0, 0, 0, 0, 0]), Buffer.from([1])])), 10), /trailing_transition_bytes/);
});

test('enforces per-channel, aggregate transition, tick, and claim-time bounds', () => {
  assert.throws(() => decodeAnalysisReplay(replay(pack([20001, 0, 0, 0, 0])), 30000), /analysis_channel_transition_limit/);
  assert.throws(() => decodeAnalysisReplay(replay(pack([10001, 10000, 10000, 10000, 10000], Array(50001).fill(0))), 30000), /analysis_transition_limit/);
  assert.throws(() => decodeAnalysisReplay(replay(pack([1, 0, 0, 0, 0], [6000000])), 5999999), /analysis_frame_limit/);
  assert.throws(() => decodeAnalysisReplay(replay(pack([1, 0, 0, 0, 0], [11])), 10), /transition_after_claim/);
  assert.throws(() => decodeAnalysisReplay(replay(pack([0, 0, 0, 0, 0])), 6000000), /analysis_time_limit/);
});

test('rejects non-increasing ticks, truncated lists, and inflate bombs within fixed bounds', () => {
  assert.throws(() => decodeAnalysisReplay(replay(pack([2, 0, 0, 0, 0], [1, 0])), 20), /non_increasing_transitions/);
  assert.throws(() => decodeAnalysisReplay(replay(pack([0, 0, 0, 0, 1])), 20), /truncated_transition_list/);
  const bomb = zlib.deflateSync(Buffer.alloc(150019)).toString('base64url');
  assert.throws(() => decodeAnalysisReplay(bomb, 20), /analysis_inflated_size_limit/);
});
