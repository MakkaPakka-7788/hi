const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
function fixture(status=429,retryAfter='60',snapshotOnly=false){
  let now=1000,calls=0,backups=0,failures=0;
  const context={Date:{now:()=>now},snapshotOnlyForNewAccount:()=>snapshotOnly,publicSnapshotRetryAt:0,rankedBrokerUrl:()=> 'https://ranked.example',rankedEdgeAvailable:()=>true,
    fetch:async()=>{calls++;return {status,ok:status===200,headers:{get:key=>key==='Retry-After'?retryAfter:'application/json'},json:async()=>({entries:[]})};},
    withTimeout:promise=>promise,readPublicSnapshotBackup:async()=>{backups++;return null;},clearRankedEdgeFailure:()=>{},markRankedEdgeUnavailable:()=>failures++};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  async function fetchRankedSnapshot('),source.indexOf('  function rankedNotifyQueue()',source.indexOf('  async function fetchRankedSnapshot('))),context);
  return {context,calls:()=>calls,backups:()=>backups,failures:()=>failures,advance:ms=>now+=ms};
}
test('429 pauses snapshot requests without treating school connectivity as broken',async()=>{
  const f=fixture();await f.context.fetchRankedSnapshot('overall','',{refresh:true});await f.context.fetchRankedSnapshot('track','a',{refresh:true});
  assert.equal(f.calls(),1);assert.equal(f.backups(),2);assert.equal(f.failures(),0);
  f.advance(60001);await f.context.fetchRankedSnapshot('overall','',{refresh:true});assert.equal(f.calls(),2);
});
test('cooldown bounds malformed or excessively long retry headers',async()=>{
  for(const [header,delay] of [['bad',60000],['0',60000],['999999',900000]]){
    const f=fixture(429,header);await f.context.fetchRankedSnapshot('overall','',{refresh:true});assert.equal(f.context.publicSnapshotRetryAt,1000+delay);
  }
});
test('unavailable Worker still permits existing connectivity recovery',async()=>{
  const f=fixture(503);await f.context.fetchRankedSnapshot('overall','',{refresh:true});assert.equal(f.failures(),1);assert.equal(f.context.publicSnapshotRetryAt,0);
});

test('protected new accounts never call Worker even when refresh is requested',async()=>{
  const f=fixture(200,'60',true);
  await f.context.fetchRankedSnapshot('overall','',{refresh:true});
  assert.equal(f.calls(),0);assert.equal(f.backups(),1);
});
test('track and overall fallback plus optional planner honor the snapshot cooldown',()=>{
  assert.equal((source.match(/if\(Date\.now\(\)<publicSnapshotRetryAt\)throw Error\('Public snapshot requests paused/g)||[]).length,2);
  assert.match(source,/const sidecar=backup\?null:data\._publicBackup\|\|Date\.now\(\)<publicSnapshotRetryAt\?null:/);
});

test('live refresh consults the snapshot baseline before its network response',async()=>{
 const f=fixture(200);const order=[];const baseline={entries:[{accountId:'saved'}],algorithmVersion:'v1',revision:10,_publicBackup:true};
 f.context.readPublicSnapshotBackup=async()=>{order.push('snapshot');return baseline;};
 f.context.fetch=async()=>{order.push('live');return {status:200,ok:true,headers:{get:()=> 'application/json'},json:async()=>({entries:[],algorithmVersion:'v1',revision:9})};};
 assert.equal(await f.context.fetchRankedSnapshot('track','a',{refresh:true}),baseline);assert.deepEqual(order,['snapshot','live']);
});
test('newer complete live boards replace rows instead of resurrecting snapshot racers',async()=>{
 const f=fixture(200);const live={entries:[],algorithmVersion:'v1',revision:11,complete:true};
 f.context.readPublicSnapshotBackup=async()=>({entries:[{accountId:'removed'}],algorithmVersion:'v1',revision:10,_publicBackup:true});
 f.context.fetch=async()=>({status:200,ok:true,headers:{get:()=> 'application/json'},json:async()=>live});
 assert.equal(await f.context.fetchRankedSnapshot('track','a',{refresh:true}),live);
});

test('malformed and explicitly incomplete empty responses cannot erase saved racers',async()=>{
 for(const payload of [{entries:'bad'},{entries:[],complete:false}]){const f=fixture(200),saved={entries:[{accountId:'saved'}],_publicBackup:true};f.context.readPublicSnapshotBackup=async()=>saved;f.context.fetch=async()=>({status:200,ok:true,headers:{get:()=> 'application/json'},json:async()=>payload});assert.equal(await f.context.fetchRankedSnapshot('track','a',{refresh:true}),saved);}
});
