const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  function updateTrackFreshnessBanner('),end=source.indexOf('\n  function ',start+1);
test('event leaderboards remove the normal weight/player infocard before painting',()=>{
 let removed=0;const board={classList:{contains:name=>name==='sq-event-board'}};
 const ctx=vm.createContext({document:{querySelector:()=>board,getElementById:()=>({remove(){removed++;}})},isElementVisible:()=>true,currentTrackLoadState:{trackId:'kodub'}});
 vm.runInContext(source.slice(start,end),ctx);ctx.updateTrackFreshnessBanner();assert.equal(removed,1);
});
test('event takeover removes an already visible normal-track infocard immediately',()=>{
 const client=fs.readFileSync(path.join(__dirname,'../events/client.mjs'),'utf8');
 assert.match(client,/board.classList.add\('sq-event-board'\);\s*document.getElementById\('polytrackTrackFreshness'\)\?\.remove\(\)/);
 assert.match(client,/points.textContent=Math.round\(Number\(row.groupRp\?\?row.rp\)\|\|0\)/);
});

test('entered event sessions suppress the infocard before takeover without hiding normal RHR',()=>{
 let removed=0;const board={classList:{contains:()=>false}};const ctx=vm.createContext({document:{querySelector:()=>board,getElementById:()=>({remove(){removed++;}})},isElementVisible:()=>true,eventUi:{isEntered:id=>id==='event'},nativeWeeklySelection:null,kodubTrackHistory:new Map(),currentTrackLoadState:{trackId:'event'}});
 vm.runInContext(source.slice(start,end),ctx);ctx.updateTrackFreshnessBanner();assert.equal(removed,1);
 ctx.currentTrackLoadState={trackId:'normal-rhr'};ctx.readTrackSnapshotCache=()=>{throw Error('normal banner path');};assert.throws(()=>ctx.updateTrackFreshnessBanner(),/normal banner path/);
});

test('current and archived Kodub normal-PB views also suppress the normal infocard',()=>{for(const archived of [false,true]){let removed=0;const ctx=vm.createContext({document:{querySelector:()=>({classList:{contains:()=>false}}),getElementById:()=>({remove(){removed++;}})},isElementVisible:()=>true,currentTrackLoadState:{trackId:'kodub'},eventUi:null,nativeWeeklySelection:archived?null:{trackId:'kodub'},kodubTrackHistory:new Map(archived?[['kodub',{}]]:[])});vm.runInContext(source.slice(start,end),ctx);ctx.updateTrackFreshnessBanner();assert.equal(removed,1);}});
