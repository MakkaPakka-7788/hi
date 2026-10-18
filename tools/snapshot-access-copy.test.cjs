const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(process.env.POLYTRACK_AUDIT_REPO||path.join(__dirname,'..'),'polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  function snapshotAccessNotice(){');
const end=source.indexOf('  let snapshotCountdownWasLocked=',start);
function notice(state){const context=vm.createContext({snapshotRefreshState:()=>state});vm.runInContext(source.slice(start,end),context);return context.snapshotAccessNotice();}
test('snapshot help only lists unfinished live-refresh requirements',()=>{
  assert.match(notice({remainingMs:1000,needsFinish:true}),/timer and your first saved finish/);
  assert.match(notice({remainingMs:1000,needsFinish:false}),/Finish saved/);
  assert.doesNotMatch(notice({remainingMs:1000,needsFinish:false}),/first saved finish/);
  assert.match(notice({remainingMs:0,needsFinish:true}),/after your first saved finish/);
  assert.doesNotMatch(notice({remainingMs:0,needsFinish:true}),/timer/);
});
test('compact Ranked notice retains coverage warning and full help tooltip',()=>{
  assert.ok(source.includes('Missing racers are not ranked in this snapshot.'));
  assert.match(source,/notice\.title=protectedReads\?snapshotAccessNotice\(\):coverage/);
  assert.match(source,/Race and save runs now\. Live refresh unlocks below\./);
});
