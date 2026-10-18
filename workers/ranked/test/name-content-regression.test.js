import test from 'node:test';
import assert from 'node:assert/strict';
import { moderatePublicName } from '../src/public-name-policy.js';

const blockedNames = [
  'send me nudes',
  'send noods',
  'send n00ds',
  'sendnudes',
  'freenudes',
  'free nudes on my insta',
  'onlyfans.com',
  'pornhub.com',
  'xxx.com/videos',
  '18+ content',
  'adult chat',
  'touch me daddy',
  'finger my pussy',
  'jerk me off',
  '2 girls 1 cup',
  'golden shower',
  'period blood in my mouth',
  'kidtoucher',
  'childtoucher',
  'touch my kid',
  'touch my child',
  'kid touches me',
  'child touches me',
  'kid loves sex',
  'child loves sex',
  'kids love sex',
  'children love sex',
  'child lover',
  'minor lover',
  'epstein touches me',
  'I will kill you',
  'kill all Jews',
  'kill yourself',
  'fuck off',
  'shithead',
  'D1ck',
  'n!gga',
  'xxniggerxx'
];

const allowedNames = [
  'Niger',
  'Nigerian Racer',
  'Nigerien Drift',
  'Nigeria',
  'Gay',
  'Gay Racer',
  'Trans Driver',
  'Muslim Racer',
  'Jewish Racer',
  'Black Racer',
  'Latina Drift',
  'Chinese Racer',
  'Dickinson',
  'Dickson',
  'Benedict',
  'Peacock',
  'Cockpit Racer',
  'Cockatoo',
  'CockneyRacer',
  'Cock-a-doodle-doo',
  'Grapevine',
  'Draper',
  'Therapist',
  'Scunthorpe',
  'Peniscola',
  'Pussini',
  'noogre',
  'こんにちは',
  'مرحبا',
  'София',
  'José',
  'Zoë'
];

test('school-unsafe solicitation, abuse, threats, and strong profanity compounds are blocked', () => {
  for (const name of blockedNames) {
    assert.equal(moderatePublicName(name).blocked, true, name);
  }
});

test('identity, nationality, names, places, racing handles, and ordinary substrings remain allowed', () => {
  for (const name of allowedNames) {
    assert.equal(moderatePublicName(name).blocked, false, name);
  }
});

test('combining marks and zero-width separators do not silently defeat explicit high-confidence checks', () => {
  const accentSeparatedProfanity = 'f\u0301uck';
  const zeroWidthSeparatedSolicitation = 'send\u200Bnudes';
  assert.equal(moderatePublicName(accentSeparatedProfanity).blocked, true, accentSeparatedProfanity);
  assert.equal(moderatePublicName(zeroWidthSeparatedSolicitation).blocked, true, zeroWidthSeparatedSolicitation);
});

test('confusable checks stay scoped to high-confidence abuse terms, not whole scripts', () => {
  assert.equal(moderatePublicName('раypal').blocked, false, 'mixed Cyrillic/Latin ordinary handle');
  assert.equal(moderatePublicName('рornhub').blocked, true, 'high-confidence confusable adult-site promotion');
  assert.equal(moderatePublicName('日本語レーサー').blocked, false, 'Japanese name is not transliterated into an insult');
});

test('new compound rules generalize across padding, elongation, formatting, and explicit recruitment',()=>{
  for(const name of ['zzfuckzz','FuuuuckRacer','LllPussyahh','myPenisIsBig','xxkysxx','kid-toucher',
    'womeeentoucher','n!gj@','nigher','niiiigher','ni!!er','blackrapsist','touchmyclit',
    'instagram/freenudes','discord.gg/under18','discord.gg/teensonly','adult-content',
    'tradecp','youShouldDie','go-kill-yourself']){
    const verdict=moderatePublicName(name);assert.equal(verdict.blocked,true,name);assert.ok(verdict.match,name);
  }
  for(const name of ['ni𝕘𝕘er','ni\u1AB0gger','f\uFE0Fuck'])assert.equal(moderatePublicName(name).blocked,true,name);
});

test('child-directed sexual compounds block obfuscations without penalizing benign racing names',()=>{
  for(const name of ['touch-my-kid','tоuchMyChild','k1dL0vesS3x','childlovessex','kids-love-sex']) {
    const verdict=moderatePublicName(name);
    assert.equal(verdict.blocked,true,name);
    assert.ok(verdict.match,name);
  }
  for(const name of ['KidLovesRacing','KidLovesDrifting','ChildRacer','KidsLoveRacing']) {
    assert.equal(moderatePublicName(name).blocked,false,name);
  }
});

test('obfuscation and lexical exceptions never exempt a different unsafe section',()=>{
  for(const name of ['Sćunthorpe','PeacockPilot','Cöckburn','GrapefruitRacer','BenedictRacer','Rapper','Scrapper','Wrapper'])assert.equal(moderatePublicName(name).blocked,false,name);
  for(const name of ['PeacockFuck','TherapistRapist','DicksonBigDick','ScunthorpeCunt','CockneyFuck','PeniscolaPorn','Cock-a-doodle-dooFuck'])assert.equal(moderatePublicName(name).blocked,true,name);
  for(const name of ['TeenRacer','ChildRacer','TouchTheFinish','FingerPainter','GoldenRacer'])assert.equal(moderatePublicName(name).blocked,false,name);
});
