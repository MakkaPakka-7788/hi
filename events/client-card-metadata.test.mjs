import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const start=source.indexOf('  function cardStandings(period){');
const end=source.indexOf('  function selectView(',start);
assert.ok(start>=0&&end>start,'event card renderers exist');
const renderers=source.slice(start,end).replace(/^  /gm,'');
const trackId='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';

function render({board=null,permanentSnapshot=null}={}){
 const context={
  cache:new Map(),read:()=>board,STORE:'events',bridge:{accountId:()=> 'mine',thumbnail:()=>'<img>',formatTime:ms=>String(ms),displayName:(_id,name)=>name},
  knownPeriods:new Map(),escape:value=>String(value??''),displayName:(_row)=>'Leader',recordMarkup:()=> 'No record',periodName:p=>p.trackName,
  now:()=>100,reset:()=> 'Sunday',time:ms=>String(ms),ROLLING_TRACK_ID:trackId,
  PERMANENT_ROLLING:{id:'permanent-rolling-hills',kind:'permanent',trackId,trackName:'Rolling Hills Racer'},
  permanent:permanentSnapshot,archivePeriodCounts:(_period,snapshot)=>{
   if(!snapshot)return {racers:null,verified:null,verifiedEntries:[],winner:null};
   return {racers:snapshot.racerCount??snapshot.entries.length,verified:snapshot.entries.length,verifiedEntries:snapshot.entries,winner:snapshot.entries[0]||null};
  }
 };
 return vm.runInNewContext(`(()=>{${renderers};return {cardStandings,cards,permanentCard}})()`,context);
}

test('live card standings preserve unknown counts and omit invented point totals',()=>{
 const ui=render({board:{entries:[{accountId:'a',name:'Leader',timeMs:123}]}});
 const result=ui.cardStandings({id:'weekly'});
 assert.match(result,/1 loaded racers · 1 verified/);
 assert.doesNotMatch(result,/0 Event RP|up to 200 racers/);
});

test('live card uses published count and point metadata when present',()=>{
 const ui=render({board:{racerCount:12,entrantCount:15,totalRp:420,entries:[{accountId:'a',name:'Leader',timeMs:123}]}});
 const result=ui.cardStandings({id:'weekly'});
 assert.match(result,/12 racers · 1 verified · 420 Event RP awarded/);
});

test('Kodub weekly card labels its reward as ERP and does not invent a cap or racer limit',()=>{
 const ui=render();
 const markup=ui.cards([{id:'kodub',kind:'kodub',trackId,trackName:'Kodub Track',endsAt:200}],{details:true});
 assert.match(markup,/KODUB WEEKLY/);
 assert.match(markup,/Event RP \(ERP\)/);
 assert.doesNotMatch(markup,/Up to 0 Event RP|Up to 0 racers/);
});

test('permanent Rolling Hills card shows available counts and verified points only',()=>{
 const ui=render({permanentSnapshot:{racerCount:3,entries:[{accountId:'mine',name:'Me',timeMs:123,rp:87}]}});
 const markup=ui.permanentCard();
 assert.match(markup,/87 Event RP/);
 assert.match(markup,/3 racers · 1 verified/);
 assert.doesNotMatch(markup,/0 Event RP/);
});

test('permanent Rolling Hills card leaves unavailable counts and points undisplayed',()=>{
 const ui=render({permanentSnapshot:{entries:[{accountId:'mine',name:'Me',timeMs:123}]}});
 const markup=ui.permanentCard();
 assert.match(markup,/Normal RP \+ up to 1001 Event RP/);
 assert.doesNotMatch(markup,/0 racers|0 verified|0 Event RP/);
});
