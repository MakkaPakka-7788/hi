import test from 'node:test';
import assert from 'node:assert/strict';
import {moderatePublicName} from '../src/public-name-policy.js';

function blocks(name, term) {
  assert.ok(name.length<=24,'Fixture must fit the displayed name: '+name);
  const result=moderatePublicName(name);
  assert.equal(result.blocked,true,name);
  assert.ok(result.match,name);
  if(term){
    assert.equal(result.reason,'contextual-unsafe-phrase',name);
    assert.equal(result.match.term,term,name);
  }
}

test('touch grammar covers inflections, child groups, and both orders',()=>{
  for(const target of ['kids','child','children','minors','baby','teens']){
    for(const action of ['touch','touches','touching','touched']){
      blocks(action+' the '+target,'child-directed-touch');
      blocks(target+' '+action,'child-directed-touch');
      blocks(target+' '+action+' me','child-directed-touch');
    }
  }
  for(const name of ['i touch little kids','touch my young child','touching those minors',
    'kids are being touched','children were touched','minors touched by me',
    'grooming children','groping young children','fondling the kids'])blocks(name,'child-directed-touch');
  for(const name of ['toucher of children','minors lover','lover of little kids','children groomer'])blocks(name,'child-abuse-role');
});

test('love requires a sexual cue rather than merely a child word',()=>{
  for(const name of ['kids really love sex','i love kids sexually','children love sex',
    'sex with little minors','kids want sexual love'])blocks(name,'child-sexual-context');
  for(const name of ['KidLovesRacing','iLoveKidRacing','KidLovesDaddy','ChildLovesDaddy',
    'KidsLoveRacing','i love my kids','children love racing','TeenLovesKarting']){
    assert.equal(moderatePublicName(name).blocked,false,name);
  }
});

test('violent grammar treats target groups symmetrically in both orders',()=>{
  for(const target of ['men','women','nonbinary','jews','muslims','christians','asians','trans people','gay people','immigrants']){
    for(const action of ['kill','shoot','hang','gas'])blocks(action+' those '+target,'targeted-violence');
    blocks(target+' need to die','targeted-violence');
    blocks(target+' must die','targeted-violence');
  }
  for(const name of ['kill all of the men','shoot the young women','murder those girls','gassing the boys',
    'women deserve to die','men should be killed'])blocks(name,'targeted-violence');
});

test('context grammar survives spelling evasions and handle formatting',()=>{
  for(const name of ['t0uch1ng k1d5','k\u0456ds t\u043euch\u0435d','touch\u200bmy\u200bkids',
    't\u0301ouching kids','TouchingTheKids','xxTouchKidsxx','touchkids931',
    'sh00t th0se w0men','men n33d t0 d1e'])blocks(name);
  for(const word of ['touchkids','kidstouched','shootwomen']){
    for(const value of [word.split('').join(' '),word.split('').join('-'),
      word.split('').map(letter=>letter+letter).join('')])blocks(value);
    const styled=Array.from(word,c=>String.fromCodePoint(0x1d5ee+c.charCodeAt(0)-97)).join('');
    assert.equal(moderatePublicName(styled).blocked,true,word+' in mathematical font');
  }
});

test('ordinary objects, identities, lexical collisions, and sport names stay allowed',()=>{
  for(const name of ['KidTouchControls','KidsTouchControls','kid touch controls','kid loves touch controls',
    'ChildTouchingControls','KidsTouchedTheFinish','kids touch the finish','MinorTouchControls',
    'KidTouchscreen','TouchdownKids','KidsTouchdown','touching kidney','MinorityDriver',
    'KillSwitchRacer','DieCastRacer','MenShootingClub','WomenShootHoops','HangOutWithKids',
    'GroomMyDog','ManifoldRacer','Womanizer','JewishRacer','TransRacer','NonbinaryRacer',
    'KidsLoveKillSwitch','KidsAreKillingIt']){
    assert.equal(moderatePublicName(name).blocked,false,name);
  }
  // A benign activity does not exempt a separate abusive clause.
  blocks('KidTouchControls killmen');
  blocks('iLoveKidRacing touchkids');
});

test('curated explicit terms cover clear omissions while preserving ordinary names',()=>{
  for(const name of ['paedophile','p@ed0ph1le','anilingus','a n i l i n g u s','cunnilingus','cunn1l1ngus'])blocks(name);
  for(const name of ['PedalRacer','Annika','Cunningham','CunningRacer']){
    assert.equal(moderatePublicName(name).blocked,false,name);
  }
});
