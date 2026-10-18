import assert from 'node:assert/strict';
import test from 'node:test';
import { moderatePublicName } from '../src/public-name-policy.js';

test('Unicode formatting does not hide high-confidence abusive terms', () => {
  for (const name of [
    'n\uFE0Figger',
    'ni\u0301gger',
    'n\u200Bi\u200Dgger',
    'nіgger', // Cyrillic small i in otherwise Latin text.
    'nigggeeer'
  ]) {
    assert.equal(moderatePublicName(name).blocked, true, name);
  }
});

test('combining marks from every Unicode block cannot overlay blocked words', () => {
  for (const name of ['n\u0488igger', 'f\u0488uck', 'touch\u0488kids']) {
    assert.equal(moderatePublicName(name).blocked, true, name);
  }
  assert.equal(moderatePublicName('Sof\u0488ia Racer').blocked, false);
});

test('Unicode policy preserves benign multilingual names and repeated-letter handles', () => {
  for (const name of [
    'NigerianRacer',
    'Nigerien Racer',
    'Søren Racer',
    'İpek',
    '李小龍',
    '山田太郎',
    'محمد',
    'Алексей',
    'SooooonRacer',
    'Sheeeeeesh'
  ]) {
    assert.equal(moderatePublicName(name).blocked, false, name);
  }
});

test('Unicode abuse checks do not become short-substring or identity-word filters', () => {
  for (const name of [
    'Scunthorpe',
    'Fukushima',
    'DicksonRacing',
    'Cockburn',
    'NigerRacer',
    'LesbianRacer',
    'QueerRacer',
    'MuslimRacer',
    'JewishRacer',
    'GayRacer'
  ]) {
    assert.equal(moderatePublicName(name).blocked, false, name);
  }
});

test('dotless i and c-shaped lunate sigma are interpreted without confusing ordinary Greek sigma with i',()=>{
  for(const name of ['chıldtoucher','fuϲk','fυck']){
    assert.equal(moderatePublicName(name).blocked,true,name);
  }
  for(const name of ['Işık','Ipek','İpek','Σοφία','Υanni','Sofia'])assert.equal(moderatePublicName(name).blocked,false,name);
  assert.equal(moderatePublicName('Ngraϲhio445').reason,'targeted-exact-name');
});
