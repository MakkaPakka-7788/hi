import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('weekly Kodub asset is offered only for selected jobs with its exact current track ID', () => {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'events/kodub/current.json'), 'utf8')).current;
  const [track] = loadWeeklyTrustedTrack(root, [{trackId: current.trackId}]);
  assert.equal(track.trackId, current.trackId);
  assert.equal(track.codeHash, current.trackUrl.match(/^assets\/([a-f0-9]{64})\.track$/)[1]);
  assert.equal(track.code.length > 32, true);
  assert.deepEqual(loadWeeklyTrustedTrack(root, [{trackId: 'b'.repeat(64)}]), []);
});

test('malformed pointers and content-hash mismatches never produce trusted tracks', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-track-'));
  const directory = path.join(temporary, 'events', 'kodub');
  fs.mkdirSync(path.join(directory, 'assets'), {recursive: true});
  try {
    fs.writeFileSync(path.join(directory, 'current.json'), JSON.stringify({current: {
      trackId: '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7',
      trackUrl: 'assets/aa5e949dbd8e18caab0fc3697f9ef10c72cf1d5acccfd0b9d618663f35131542.track',
    }}));
    fs.writeFileSync(path.join(directory, 'assets', 'aa5e949dbd8e18caab0fc3697f9ef10c72cf1d5acccfd0b9d618663f35131542.track'), 'PolyTrack2' + 'A'.repeat(64));
    const trackId = '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7';
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
    fs.writeFileSync(path.join(directory, 'current.json'), JSON.stringify({current: {
      trackId, trackUrl: '../outside.track',
    }}));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('archived registry supplies only selected jobs with checked exact ID and hash', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-history-'));
  const directory = path.join(temporary, 'events', 'kodub');
  const asset = 'PolyTrack2' + 'A'.repeat(100);
  const hash = crypto.createHash('sha256').update(asset).digest('hex');
  const trackId = '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7';
  fs.mkdirSync(path.join(directory, 'assets'), {recursive: true});
  try {
    fs.writeFileSync(path.join(directory, 'assets', `${hash}.track`), asset);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId, codeHash: hash, assetPath: `assets/${hash}.track`},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId: 'b'.repeat(64)}]), []);
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), [{trackId, code: asset, codeHash: hash}]);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId:'b'.repeat(64),codeHash:'c'.repeat(64),assetPath:`assets/${'c'.repeat(64)}.track`},
      {trackId,codeHash:hash,assetPath:`assets/${hash}.track`},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary,[{trackId:'b'.repeat(64)},{trackId}]),[{trackId,code:asset,codeHash:hash}]);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId, codeHash: hash, assetPath: '../outside.track'},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId, codeHash: 'a'.repeat(64), assetPath: `assets/${'a'.repeat(64)}.track`},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
