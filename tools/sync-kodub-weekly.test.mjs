import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {mergeTrustedTrackHistory} from './sync-kodub-weekly.mjs';

test('weekly sync remembers only full-hash-checked old/current track pairs', async () => {
  const code = Buffer.from('PolyTrack2' + 'A'.repeat(100));
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const trackId = '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7';
  const stored = await mergeTrustedTrackHistory([], [
    {trackId, trackUrl:`assets/${hash}.track`},
    {trackId:'b'.repeat(64), trackUrl:'../unsafe.track'},
  ], async asset => asset === `assets/${hash}.track` ? code : assert.fail('unexpected asset path'));
  assert.deepEqual(stored, [{trackId, codeHash:hash, assetPath:`assets/${hash}.track`}]);
  assert.deepEqual(await mergeTrustedTrackHistory([], [{trackId,trackUrl:`assets/${'a'.repeat(64)}.track`}], async () => code), []);
});

test('weekly sync caps registry length and rechecks every archived asset', async () => {
  const bytes = Buffer.from('PolyTrack2' + 'B'.repeat(100));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const history = Array.from({length:521}, (_, index) => ({trackId:index.toString(16).padStart(64,'0'),codeHash:hash,assetPath:`assets/${hash}.track`}));
  const bounded = await mergeTrustedTrackHistory(history, [], async () => bytes);
  assert.equal(bounded.length, 520);
  const checked = await mergeTrustedTrackHistory([
    {trackId:'c'.repeat(64),codeHash:hash,assetPath:`assets/${hash}.track`},
  ], [], async () => { throw Error('must not read'); });
  assert.equal(checked.length, 0);
});
