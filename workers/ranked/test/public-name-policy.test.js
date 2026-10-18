import assert from 'node:assert/strict';
import test from 'node:test';

test('severe embedded slurs cannot be hidden between harmless ASCII or font-styled text',()=>{
  for(const value of ['xxniggerxx','foo𝖓ì𝕘ɢ𝖊𝖗bar','xXniggahXx'])assert.equal(moderatePublicName(value).blocked,true);
  for(const value of ['Scunthorpe','𝕊𝕔𝕦𝕟𝕥𝕙𝕠𝕣𝕡𝕖','NigerianRacer','Nigel'])assert.equal(moderatePublicName(value).blocked,false);
});
import { readFileSync } from 'node:fs';
import { computeTrackEntries } from '../src/index.js';
import { moderatePublicName, normalizeNameForCheck, safePublicName, sanitizeDisplayName } from '../src/public-name-policy.js';

const TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';

test('public-name policy matches client cleanup and avoids ordinary substring false positives', () => {
  assert.deepEqual(moderatePublicName('  Sakura  Racer  '), { blocked: false, reason: '', clean: 'Sakura Racer', match: null });
  for (const name of ['Analogue', 'Scunthorpe', 'Fukushima', 'Niño Racer', '李小龍', 'Nigerian Racer', 'Negroponte', 'Lesbian Racer', 'Queer Racer']) assert.equal(moderatePublicName(name).blocked, false, name);
  assert.equal(moderatePublicName('moderator').reason, 'reserved-name');
  assert.equal(moderatePublicName('f.u.c.k').blocked, true);
  assert.deepEqual(moderatePublicName('A\u200b  Racer'), { blocked: false, reason: '', clean: 'A Racer', match: null });
});

test('Unicode lookalikes, small-cap g, accents, and mixed-font evasion are caught with explanation', () => {
  for (const name of ['fück', 'fаggot', 'niɢɢer', 'nіɡɡer', 'fuсk']) {
    const decision = moderatePublicName(name);
    assert.equal(decision.blocked, true, name);
    assert.ok(decision.match, name);
    assert.equal(typeof decision.match.type, 'string', name);
    assert.equal(typeof decision.match.term, 'string', name);
    assert.equal(typeof decision.match.normalized, 'string', name);
  }
  assert.equal(moderatePublicName('fück').match.term, 'fuck');
  assert.equal(moderatePublicName('niɢɢer').match.term, 'nigger');
  assert.equal(normalizeNameForCheck('niɢɢer'), 'nigger');
  assert.equal(sanitizeDisplayName('  A\u200b   Racer  '), 'A Racer');
});

test('additional slur, Nazi slogan, and explicit-compound terms block separators, accents, and leet forms', () => {
  for (const name of [
    'niglet', 'nig-let', 'nïglet', 'n1glet',
    'niggah', 'nig.gah', 'nïggah', 'n1ggah',
    'sieg heil', 'sieg-heil', 'sïeg.héil', 's1eg-heil',
    'jailbait', 'jail-bait', 'jáilbait', 'j@ilbait',
    'bestiality', 'best-iality', 'bestïality', 'besti@lity',
    'necrophilia', 'necro-philia', 'necróphilia', 'necroph1lia',
    'cumdumpster', 'cum-dumpster', 'cúmdumpster', 'cumdumpst3r',
    'gas all Jews', 'gas-all-Jews', 'gás all Jews', 'g@salljews'
  ]) {
    const decision = moderatePublicName(name);
    assert.equal(decision.blocked, true, name);
    assert.ok(decision.match, name);
  }
});

test('new severe terms do not match nationality or ordinary-name substrings', () => {
  for (const name of ['Niger Racer', 'Nigerian Racer', 'Nigerien Racer', 'Nigel Racer', 'Cumbria Racer', 'Jail Racer', 'Bestia Racer']) {
    assert.equal(moderatePublicName(name).blocked, false, name);
  }
});

test('decision metadata identifies matched reserved, targeted, and ordinary blocklist terms', () => {
  assert.deepEqual(moderatePublicName('moderator').match, { type: 'reserved-name', term: 'moderator', normalized: 'moderator' });
  assert.equal(moderatePublicName('Kim Jong Un').match.type, 'targeted-exact-name');
  assert.deepEqual(moderatePublicName('fuck').match, { type: 'unsafe-word', term: 'fuck', normalized: 'fuck' });
});

test('blocked names use deterministic account-specific public fallbacks', () => {
  assert.equal(safePublicName('moderator', 'account-a'), safePublicName('moderator', 'account-a'));
  assert.notEqual(safePublicName('moderator', 'account-a'), 'moderator');
  assert.equal(safePublicName('Scunthorpe', 'account-a'), 'Scunthorpe');
});

test('targeted exact names block common separators and leet formatting without broad substring matches', () => {
  for (const value of ['Kim Jong Un','K1m-J0ng_Un','Kim-J0ng-Un99','Ngr@chio445','Ngrachio44599','Nigervaan','N1gervaan','Stephen Hawking','St3ph3n_H4wk1ng','Stephen_Hawking123']) {
    assert.equal(moderatePublicName(value).reason, 'targeted-exact-name', value);
  }
  for (const value of ['BLACKBEAUTY','Stephen Hawking Racer','Nigervaanish']) {
    assert.equal(moderatePublicName(value).blocked, false, value);
  }
});

test('political figure fan handles also follow the political-reference policy',()=>{assert.equal(moderatePublicName('Kim Jong Un fan').blocked,true);});

test('track snapshot projection sanitizes names without a database lookup', () => {
  const row = { accountId: 'account-a', trackId: TRACK, timeMs: 1000, frames: 1000, raceTimeFrames: 1000, replay: 'fixture-replay', replayHash: 'a'.repeat(64), name: 'moderator', nickname: 'moderator' };
  const entry = computeTrackEntries([row], TRACK)[0];
  assert.equal(entry.name, safePublicName('moderator', 'account-a'));
  assert.equal(entry.nickname, entry.name);
});

test('profile notification and identity update reuse the pure policy without moderation reads', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const section = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, 'Worker hook section exists');
    return source.slice(from, to);
  };
  const compute = section('export function computeTrackEntries(', 'export async function rebuildTrack(');
  const notify = section('async function notifyProfile(', 'async function processProfileJob(');
  const update = section('export async function updateTrackIdentity(', 'async function processProfileJobs(');
  assert.match(compute, /safePublicName\(row\.nickname \|\| row\.name/);
  assert.match(notify, /safePublicName\(profile\.data\.nickname \|\| profile\.data\.name/);
  assert.match(update, /safePublicName\(identity\.name, accountId\)/);
  assert.doesNotMatch(notify, /moderationNames/);
});
