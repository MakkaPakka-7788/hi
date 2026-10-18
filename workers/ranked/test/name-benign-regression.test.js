import test from 'node:test';
import assert from 'node:assert/strict';
import { moderatePublicName } from '../src/public-name-policy.js';

const allowedNames = [
  // Common names and surnames that contain short prohibited substrings.
  'Dickinson', 'Dickson', 'Benedict', 'Cockburn',
  'Peacock', 'Hancock', 'Woodcock', 'Cockpit', 'Cockatoo',
  // Places and ordinary words with lexical substring collisions.
  'Scunthorpe', 'Grape', 'Drape', 'Scrape', 'Therapist', 'Middlesex', 'Essex',
  // Racing handles and mixed-format benign identifiers.
  'NeonApex', 'TurboRacer', 'Quasar_931', 'StaticQuasar', 'GrapeDrift',
  // Identity and nationality terms are not unsafe by themselves.
  'Gay', 'Lesbian', 'Queer', 'Trans', 'Bisexual', 'Black', 'Asian',
  'Nigerian', 'Niger', 'Japanese', 'French', 'Filipino'
];

test('allows benign public names, places, handles, and neutral identity terms', () => {
  for (const name of allowedNames) {
    const result = moderatePublicName(name);
    assert.equal(result.blocked, false, `${JSON.stringify(name)} should be allowed; got ${result.reason}`);
  }
});

test('does not broadly block a benign phrase because it contains a short substring', () => {
  for (const name of ['The grape drift', 'A therapist racer', 'Neon cockpit', 'Queer racer']) {
    const result = moderatePublicName(name);
    assert.equal(result.blocked, false, `${JSON.stringify(name)} should be allowed; got ${result.reason}`);
  }
});

test('keeps the explicit targeted exact-name list authoritative', () => {
  const result = moderatePublicName('Stephen Hawking');
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'targeted-exact-name');
});

test('retains strict standalone profanity rules without rejecting innocent longer names',()=>{
  for(const name of ['Dick','Gaylord'])assert.equal(moderatePublicName(name).blocked,true,name);
  for(const name of ['Rapper','Scrapper','Wrapper','CP Racer','CheckpointRacer','TeenRacer'])assert.equal(moderatePublicName(name).blocked,false,name);
  assert.equal(moderatePublicName('ScunthorpeCunt').blocked,true,'a protected word cannot exempt another unsafe occurrence');
});

test('follow-up lexical collisions are exempt without exempting a separate unsafe phrase',()=>{
  for(const name of ['Scraper','Puss In Boots','Shittim','Dickey','Dickman','Cockrell','Cockermouth','Cockerell','CockerSpaniel'])assert.equal(moderatePublicName(name).blocked,false,name);
  for(const name of ['ScraperFuck','DickmanPussy','PussInBootsPorn','CockrellBigDick'])assert.equal(moderatePublicName(name).blocked,true,name);
});
