import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function extract(name){let start=source.indexOf('  function '+name+'(');if(start<0)start=source.indexOf('  async function '+name+'(');const end=source.indexOf('\n  }',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+4);}
test('confirmed duplicate replay is skipped only for the exact account, hash, style and frame binding',async()=>{
 const map=new Map([['upload',{accountId:'self',replayHash:'hash',carStyle:'style',frames:10000}]]);
 const context=vm.createContext({confirmedRecordingUploads:map,activeRankedAccountId:()=> 'self',sha256Hex:async value=>value==='replay'?'hash':'other'});
 vm.runInContext(extract('recordingUploadAlreadyConfirmed'),context);
 assert.equal(await context.recordingUploadAlreadyConfirmed('upload','replay',{},'style'),true);
 for(const [id,replay,payload,style] of [['missing','replay',{},'style'],['upload','changed',{},'style'],['upload','replay',{frames:999},'style'],['upload','replay',{frames:0},'style'],['upload','replay',{frames:'invalid'},'style'],['upload','replay',{carColors:'new'},'style'],['upload','replay',{},'new']])assert.equal(await context.recordingUploadAlreadyConfirmed(id,replay,payload,style),false);
 context.activeRankedAccountId=()=> 'other';assert.equal(await context.recordingUploadAlreadyConfirmed('upload','replay',{},'style'),false);
});
test('legacy recording repair never invents a one-millisecond frame count and skips identical writes',()=>{
 const context=vm.createContext({});vm.runInContext(extract('recordingRepairPatch'),context);
 assert.deepEqual(JSON.parse(JSON.stringify(context.recordingRepairPatch({replay:'same',raceTimeFrames:20000},'same',{},null,null,null))),{});
 const patch=context.recordingRepairPatch({},'replay',{frames:12345},'style',null,null);assert.equal(patch.raceTimeFrames,12345);
 assert.equal(context.recordingRepairPatch({},'',{},null,null,null),null);
});
test('practice-aware order uses bounded hints without changing projected points',()=>{
 const context=vm.createContext({});vm.runInContext(extract('orderedPlannerRoutes'),context);
 const rows=[{trackId:'a',value:100,practice:{factor:.9}},{trackId:'b',value:95,practice:{factor:1.1}},{trackId:'c',value:200,practice:{factor:.9}}];
 assert.equal(context.orderedPlannerRoutes([],rows,8,'practice')[0].trackId,'c');
 assert.equal(context.orderedPlannerRoutes([],rows,8,'practice')[1].trackId,'b');
 assert.equal(context.orderedPlannerRoutes([],rows,8,'impact')[1].trackId,'a');
 assert.deepEqual(rows.map(row=>row.value),[100,95,200]);
});
test('startup and practice preloading request static previews only and honor data-saving preferences',()=>{
 const body=extract('warmPracticeTrack');assert.match(body,/saveData/);assert.match(body,/practicePreloadedTracks.size>=12/);assert.match(body,/readPublicSnapshotBackup\('track-preview'/);assert.doesNotMatch(body,/fetchRankedSnapshot|\bdb\(|readPublicSnapshotBackup\('track',/);
 const boot=extract('boot');assert.doesNotMatch(boot,/track-preview',id\)\.then/);
});
test('unchanged profile saves retain ownership checks but skip a redundant write',()=>{
 const anchor=source.indexOf('const previousLocalName =');const segment=source.slice(anchor,source.indexOf("log('info','[FB202] profiles_public.set ok'",anchor));
 assert.match(segment,/assertCloudOwner\(accountId,ownerUid,data\)/);
 assert.match(segment,/if\(!data\|\|Object.entries\(next\).some/);
 assert.ok(segment.indexOf('assertCloudOwner')<segment.indexOf('Object.entries(next)'));
});
test('practice storage contains no replay, input, name, network or Firebase telemetry',()=>{
 const module=fs.readFileSync(new URL('./practice-history.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(module,/\bfetch\(|firebase|\.collection\(|recording:|replay:|nickname:/);
});

test('confirmed duplicate upload returns before overwriting its saved recording or accessing Firebase',()=>{
 const start=source.indexOf("const recData = normalizeReplayPayloadString",source.indexOf("if (urlObj.pathname === '/recordings'"));
 const end=source.indexOf("const rawIds =",start),body=source.slice(start,end);
 assert.ok(body.indexOf('recordingUploadAlreadyConfirmed(')<body.indexOf('writeRecordingStore('));
 assert.ok(body.indexOf('recordingUploadAlreadyConfirmed(')<body.indexOf('await db()'));
});

test('practice focus favors played revisits and manageable gaps ahead of RP gain',()=>{const context=vm.createContext({});vm.runInContext(extract('orderedPlannerRoutes'),context);const rows=[{trackId:'new',value:500,currentRank:0,practice:{factor:1}},{trackId:'revisit',value:10,currentRank:4,practice:{factor:1.1},ease:{effortScore:2}},{trackId:'easier',value:100,currentRank:6,practice:{factor:1},ease:{effortScore:1}}];assert.deepEqual(Array.from(context.orderedPlannerRoutes([],rows,8,'training'),r=>r.trackId),['revisit','easier','new']);assert.deepEqual(rows.map(r=>r.value),[500,10,100]);});
test('playing a track never speculatively downloads its full leaderboard',()=>{assert.doesNotMatch(extract('warmPlayedTrack'),/readPublicSnapshotBackup\('track',/);});
