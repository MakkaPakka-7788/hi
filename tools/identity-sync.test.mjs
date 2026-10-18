import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function extract(name){const start=source.indexOf('  function '+name+'('),end=source.indexOf('\n  }',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+4);}
const plain=value=>JSON.parse(JSON.stringify(value));
function harness({overall=[],directory={},cosmetics={},shared={}}={}){
 const context=vm.createContext({overallEntriesCache:overall,snapshotRacerDirectoryEntries:directory,snapshotCosmeticEntries:cosmetics,
   readOverallSnapshotCache:()=>null,readCosmeticDirectory:()=>({entries:shared}),rankedIdentityIndex:null,rankedIdentityIndexSource:null,
   cleanUserId:x=>x||'',safeDisplayName:x=>x,getLastKnownName:()=>'',setLastKnownName(){},activeRankedAccountId:()=>'',
   readJsonStorage:()=>null,PROFILE_COSMETICS_KEY:'local',sanitizeProfileCosmetics:x=>x,enforceCosmeticUnlocks:x=>x});
 vm.runInContext(['snapshotRacerDirectoryIdentity','rowIdentityFreshness','overlaySnapshotRacerDirectory','rankedIdentityRows','rankedIdentityForRacer','canonicalDisplayName','resolveCosmeticsForEntry'].map(extract).join('\n')+'\nfunction savedCosmeticDesign(id){return snapshotCosmeticEntries[id]?.value||null}',context);
 return context;
}
test('a new PB date never resurrects an old name or car',()=>{
 const h=harness({overall:[{userId:'r',name:'New',carStyle:'new-car',identityUpdatedAt:200}]});
 const row={userId:'r',name:'Old',carStyle:'old-car',identityUpdatedAt:100,pbAt:900,createdAt:1000};
 assert.equal(h.rowIdentityFreshness(row),100);
 assert.equal(h.rankedIdentityForRacer(row).name,'New');assert.equal(h.rankedIdentityForRacer(row).carStyle,'new-car');
});
test('partial directory metadata preserves the freshest available fields and explicit country clears',()=>{
 const h=harness({overall:[{userId:'r',name:'New',carStyle:'new-car',countryCode:'US',identityUpdatedAt:200}],directory:{r:{updatedAt:300,countryCode:''}}});
 const row={userId:'r',name:'Old',carStyle:'old-car',identityUpdatedAt:100};
 const value=h.rankedIdentityForRacer(row);
 assert.equal(value.name,'New');assert.equal(value.carStyle,'new-car');assert.equal(value.countryCode,'');
 assert.equal(h.overlaySnapshotRacerDirectory([{userId:'r',countryCode:'US'}])[0].countryCode,'');
});
test('nameless newer aggregate cannot suppress a valid directory name',()=>{
 const h=harness({overall:[{userId:'r',identityUpdatedAt:400}],directory:{r:{name:'Directory',updatedAt:300}}});
 assert.equal(h.canonicalDisplayName('r','Old',100),'Directory');
});
test('name ties consistently prefer Overall over track labels',()=>{
 const h=harness({overall:[{userId:'r',name:'Overall',identityUpdatedAt:200}]});
 assert.equal(h.canonicalDisplayName('r','Track',200),'Overall');
 assert.equal(h.rankedIdentityForRacer({userId:'r',name:'Track',identityUpdatedAt:200}).name,'Overall');
});
for(const reset of [{theme:'classic'},{}])test('newer cosmetic reset beats old shared and snapshot designs: '+JSON.stringify(reset),()=>{
 const h=harness({shared:{r:{at:100,value:{theme:'crimson'}}},cosmetics:{r:{at:200,value:{theme:'gold'}}}});
 assert.deepEqual(plain(h.resolveCosmeticsForEntry({userId:'r',identityUpdatedAt:300,profileCosmetics:reset})),reset);
});
test('newer snapshot design beats older shared cosmetics without a cloud read',()=>{
 const h=harness({shared:{r:{at:100,value:{theme:'crimson'}}},cosmetics:{r:{at:300,value:{theme:'classic'}}}});
 assert.equal(h.resolveCosmeticsForEntry({userId:'r',identityUpdatedAt:200,profileCosmetics:{theme:'gold'}}).theme,'classic');
});
test('local rename metadata wins consistently over a stale packaged profile',()=>{
 const h=harness({directory:{r:{name:'Old',updatedAt:100}},shared:{r:{identity:{name:'Current',carStyle:'new-car',identityUpdatedAt:300}}}});
 assert.equal(h.canonicalDisplayName('r','Old',100),'Current');
 assert.equal(h.rankedIdentityForRacer({userId:'r'}).carStyle,'new-car');
});
