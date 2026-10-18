import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function extract(name){const start=source.indexOf('  function '+name+'('),end=source.indexOf('\n  }',start);assert.ok(start>=0&&end>start,name);return source.slice(start,end+4);}
test('native rows retain account, self highlight, name, car and cosmetics after an in-place profile update',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<section class="leaderboard-ui"><div class="container"><button class="main"><div class="image-container"><img><img></div><div class="left"><p class="position">1</p><p>00:10.000</p></div><div class="name-container"><span class="name">Old</span><img class="country-flag"></div></button></div></section>');
  const names=['rowIdentityFreshness','snapshotRacerDirectoryIdentity','rankedIdentityRows','rankedIdentityForRacer','canonicalDisplayName','decorateNativeLeaderboardIdentity','decorateNativeLeaderboardCosmetics'];
  await page.evaluate(functions=>{
   const row={accountId:'r',userId:'r',name:'Old',timeMs:10000,identityUpdatedAt:100,carStyle:'old-car',countryCode:'US',profileCosmetics:{theme:'crimson'}};
   Object.assign(window,{currentTrackLoadState:{trackId:'track'},overallEntriesCache:[row],snapshotRacerDirectoryEntries:{},
    rankedIdentityIndex:null,rankedIdentityIndexSource:null,nativeDecorationLookupCache:null,trackCacheGeneration:0,overallCacheGeneration:0,localRaceGeneration:0,cosmeticEpoch:0,
    isElementVisible:()=>true,ensureNativeAllRunsDefault(){},activeRankedAccountId:()=> 'r',readTrackSnapshotCache:()=>({entries:[row]}),
    localTrackDisplayEntries:(_id,rows)=>rows,canonicalRaceTimeMs:row=>row.timeMs,formatRaceTime:()=> '00:10.000',readOverallSnapshotCache:()=>null,
    readCosmeticDirectory:()=>({entries:{}}),cleanUserId:x=>x||'',safeDisplayName:x=>x,getLastKnownName:()=>'',setLastKnownName(){},runStatus:()=> 'verified',
    syncNativeSelfHighlight:(button,row,id)=>button.classList.toggle('self',row?.accountId===id),
    racerCosmeticClasses:row=>'cosmetic-'+(row.profileCosmetics?.theme||'classic'),__pt062NormalizeStyle:x=>x,
    hydrateOverallCarModels:button=>{button.dataset.carHydrations=String(Number(button.dataset.carHydrations||0)+1);},
    countryFlagMarkup:country=>country?'<img class="country-flag" alt="'+country+'">':''});
   (0,eval)(functions+'\nwindow.repaintIdentity=decorateNativeLeaderboardCosmetics;');
   window.repaintIdentity();
  },names.map(extract).join('\n'));
  const row=page.locator('button.main');
  assert.match(await row.getAttribute('class'),/self/);
  await page.evaluate(()=>{
   snapshotRacerDirectoryEntries.r={name:'New',nickname:'New',carStyle:'new-car',countryCode:'',profileCosmetics:{theme:'classic'},updatedAt:300};
   overallCacheGeneration++;cosmeticEpoch++;repaintIdentity();repaintIdentity();
  });
  assert.equal(await row.locator('.name').innerText(),'New');
  assert.match(await row.getAttribute('class'),/self/);
  assert.match(await row.getAttribute('class'),/cosmetic-classic/);
  assert.doesNotMatch(await row.getAttribute('class'),/cosmetic-crimson/);
  assert.equal(await row.locator('.country-flag').count(),0,'explicit country removal clears old flags');
  assert.equal(await row.locator('.image-container').getAttribute('data-renderarg'),'new-car');
  assert.equal(await row.locator('.image-container.overall-car-model').count(),0,'native car keeps native sizing classes');
  assert.equal(await row.getAttribute('data-sq-racer-account-id'),'r');
 }finally{await browser.close();}
});
