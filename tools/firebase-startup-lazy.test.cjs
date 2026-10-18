const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function resumeRankedNotifications(){'),end=source.indexOf("  window.addEventListener('online'",start);assert(start>=0&&end>start);
function harness(pending=[],online=true){let reads=0,flushes=0,ready=false;const context={globalThis:{navigator:{onLine:online}},rankedNotifyQueue:()=>pending,db:async()=>{reads++;ready=true;},flushRankedNotificationQueue:async()=>{assert(ready);flushes++;return {sent:pending.length};}};vm.createContext(context);vm.runInContext(source.slice(start,end),context);return {run:context.resumeRankedNotifications,reads:()=>reads,flushes:()=>flushes};}
test('1000 empty notification resumes perform zero Firebase initializations',async()=>{const h=harness();for(let i=0;i<1000;i++)await h.run();assert.equal(h.reads(),0);assert.equal(h.flushes(),0);assert(!source.includes('setTimeout(()=>db().then(()=>flushRankedNotificationQueue())'));});
test('pending submissions initialize authentication before flushing, without deleting queue entries',async()=>{const rows=[{resultId:'pending'}],h=harness(rows);await h.run();assert.equal(h.reads(),1);assert.equal(h.flushes(),1);assert.equal(rows.length,1);});
test('offline queued work stays local',async()=>{const h=harness([{resultId:'pending'}],false);await h.run();assert.equal(h.reads(),0);assert.equal(h.flushes(),0);});
test('startup and restored connectivity both use the guarded resume path',()=>{assert(source.includes('setTimeout(()=>resumeRankedNotifications().catch(()=>{}),2500)'));assert(source.includes("window.addEventListener('online',()=>setTimeout(()=>{resumeRankedNotifications().catch(()=>{})"));});
test('installation and empty pending-work recovery do not initialize Firebase',async()=>{
 const begin=source.indexOf('  function install(){'),finish=source.indexOf('  function runStatus(',begin);
 assert(begin>=0&&finish>begin);let bootstraps=0;const values=new Map();
 const context={localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},
  ensureFirestoreBootstrap:()=>{bootstraps++;}};
 for(const name of ['migrateUnsafeLocalNames','ensureStyles','applyUiPreferences','ensurePanel','hookLegacyNetworking','hookMultiplayerNetworking',
  'injectRankingsButton','setUnofficialMessage','ensurePersistentInfoBranding','ensureStaticDiscordLink','syncNativeDiscordVisibility',
  'ensureSettingsEnhancements','syncMultiplayerRelayPanel','ensureWeeklyTrackHighlight','decoratePersonalBestPodiums','syncIntegrityStateLabels'])context[name]=()=>{};
 vm.createContext(context);vm.runInContext(source.slice(begin,finish),context);context.install();
 const h=harness();await h.run();assert.equal(bootstraps,0);assert.equal(h.reads(),0);
});

