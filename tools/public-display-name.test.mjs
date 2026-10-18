import test from 'node:test';
import assert from 'node:assert/strict';
import {publicDisplayName} from './public-display-name.mjs';

test('public names preserve normal names and remove unsafe display characters',()=>{
  assert.equal(publicDisplayName('Static'), 'Static');
  assert.equal(publicDisplayName('  Racer\u202e<>\n  '), 'Racer');
  assert.equal(publicDisplayName(null), 'Racer');
  assert.equal(publicDisplayName('a'.repeat(100)).length,24);
});

test('obvious offensive names and disguised common variants use a neutral display name',()=>{
  for(const value of ['fuck','sh1t','Master of Baiting','Gildedisass','www.example.com','https://example.com'])assert.equal(publicDisplayName(value),'Racer');
  assert.equal(publicDisplayName('Classical Racer'),'Classical Racer');
});

test('public display filtering uses the shared Unicode and severe-term policy',()=>{
  for(const value of ['nïglet','n1ggah','s1eg-heil','jáilbait','best-iality','necróphilia','cum-dumpster','g@salljews'])
    assert.equal(publicDisplayName(value),'Racer',value);
  for(const value of ['Niger Racer','Nigerian Racer','Nigel Racer','Cumbria Racer'])
    assert.equal(publicDisplayName(value),value,value);
});

test('reserved public role names remain displayable and URLs remain hidden',()=>{
  for(const value of ['admin','moderator','owner','official','Official Owner','Official Owner Racer','support'])
    assert.equal(publicDisplayName(value),value,value);
  for(const value of ['Owner niglet','Official cum-dumpster'])
    assert.equal(publicDisplayName(value),'Racer',value);
  for(const value of ['www.example.com','https://example.com','http://example.com'])
    assert.equal(publicDisplayName(value),'Racer',value);
});

test('requested exact-name policy is shared without importing the broad server blocklist',()=>{
  for(const value of ['Kim Jong Un','K1m-J0ng_Un','Kim-J0ng-Un99','Ngr@chio445','Ngrachio44599','N1gervaan','St3ph3n_H4wk1ng','Stephen_Hawking123'])
    assert.equal(publicDisplayName(value),'Racer',value);
  // The shared political-reference policy also rejects political fan handles.
  assert.equal(publicDisplayName('Kim Jong Un fan'),'Racer');
  for(const value of ['BLACKBEAUTY','Stephen Hawking fan'])
    assert.equal(publicDisplayName(value),value,value);
});
