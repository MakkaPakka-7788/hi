const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const cacheStart=source.indexOf('  function readJsonStorage('),cacheEnd=source.indexOf('  function writeJsonStorage(',cacheStart);
const storeStart=source.indexOf('  function readRecordingStore('),storeEnd=source.indexOf('  function cachedNativeRecording(',storeStart);
assert.ok(cacheStart>=0&&cacheEnd>cacheStart&&storeStart>=0&&storeEnd>storeStart);
function harness(){
 let parses=0,raw=JSON.stringify({1:{recording:'replay-one',frames:40,verifiedState:1,carStyle:'red'}});
 const context={jsonStorageCache:new Map(),volatileLeaderboardCache:new Map(),hotSnapshotStorageKeys:new Set(),RECORDING_STORE_KEY:'recordings',localStorage:{getItem:()=>raw},JSON:{parse:text=>{parses++;return JSON.parse(text);}},normalizeReplayPayloadString:x=>x,safePositiveInt:(v,f)=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):f,cleanCarId:x=>x,__pt062NormalizeStyle:x=>x,getDefaultCarStyle:()=> 'default'};
 vm.createContext(context);vm.runInContext(source.slice(cacheStart,cacheEnd)+source.slice(storeStart,storeEnd),context);
 return {read:context.readRecordingStore,parses:()=>parses,setRaw:value=>{raw=value;}};
}
test('repeated replay selections reuse parsed local storage and return independent display rows',()=>{
 const h=harness();const row=h.read([1])[0];row.verifiedState=0;
 for(let i=0;i<100;i++){const result=h.read([1,2]);assert.equal(result[0].verifiedState,1);assert.equal(result[1],null);}
 assert.equal(h.parses(),1);
});
test('replay cache observes writes, external changes, removal and repaired malformed data',()=>{
 const h=harness();assert.equal(h.read([1])[0].recording,'replay-one');
 h.setRaw(JSON.stringify({1:{recording:'new-replay',frames:60,verifiedState:0}}));assert.equal(h.read([1])[0].recording,'new-replay');assert.equal(h.parses(),2);
 h.setRaw(null);assert.equal(h.read([1])[0],null);
 h.setRaw('{');assert.equal(h.read([1])[0],null);
 h.setRaw(JSON.stringify({2:{recording:'repaired',frames:80,verifiedState:1}}));assert.equal(h.read([2])[0].recording,'repaired');assert.equal(h.read([1])[0],null);
});
