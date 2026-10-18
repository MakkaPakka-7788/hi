import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {buildNamePolicy} from './build-name-policy.mjs';
import {moderatePublicName} from '../workers/ranked/src/public-name-policy.js';

test('generated browser decisions match the server policy exactly', async () => {
  await buildNamePolicy({check:true});
  const context=vm.createContext({});
  vm.runInContext(await fs.readFile(new URL('../public-name-policy.js',import.meta.url),'utf8'),context);
  for(const value of ['SunsetRacer','Scunthorpe','classic','Kim-J0ng-Un99','𝖓ì𝕘ɢ𝖊𝖗','f\u200bu\u200bc\u200bk','NigerianRacer','Administrator',
    'xxfuckxx','touchmedaddy','sendnudes','kidtoucher','staticshoulddie','2girls1cup','18+ content',
    'discord.gg/teensonly','Nixxer','Dickinson','Peacock','Therapist','ScunthorpeCunt','CP Racer','Queer Racer',
    'i touch little kids','minors being touched','kids touch controls','KidTouchControls','iLoveKidRacing',
    'KidLovesDaddy','children sexual love','kill those women','men need to die','nonbinary must die',
    'paedophile','anilingus','cunnilingus']) {
    assert.deepEqual(JSON.parse(JSON.stringify(context.__polytrackNamePolicy.moderatePublicName(value))),moderatePublicName(value));
  }
});

test('the shared policy is loaded before the client patch',async()=>{
  const html=await fs.readFile(new URL('../index.html',import.meta.url),'utf8');
  assert(html.indexOf('./public-name-policy.js?')>=0);
  assert(html.indexOf('./public-name-policy.js?')<html.indexOf('./polytrack_062_patch.js?'));
  const client=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  assert.match(client,/__polytrackNamePolicy\.moderatePublicName\(value\)/);
});
