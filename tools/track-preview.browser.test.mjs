import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}

test('saved loading preview stays separate, respects filters and cannot cross track selections',{skip:!chromium},async()=>{
  const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const helper=source.slice(source.indexOf('  let nativePreviewTicket=0,'),source.indexOf('  function shouldMock(urlObj)'));
  assert.ok(helper.includes('async function showTrackLoadingPreview'));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<div class="track-info-ui"><div class="leaderboard-ui"><div class="container"><div class="loading-spinner-container">Loading</div></div></div></div>');
    await page.addScriptTag({content:`
      let cached=null,filtered=false,eventEntered=false,pending=null;
      let currentTrackLoadState={trackId:'a'};
      const getTrackEntries={selection:{id:'a'}};
      const readTrackSnapshotCache=()=>cached;
      const personalFilterRuntime={active:()=>filtered},eventUi={isEntered:()=>eventEntered};
      const readPublicSnapshotBackup=()=>pending;
      const isElementVisible=()=>true,canonicalRaceTimeMs=row=>row.timeMs;
      const canonicalDisplayName=(id,name)=>name,safeDisplayName=name=>name,formatRaceTime=ms=>String(ms);
      ${helper}
      window.start=()=>showTrackLoadingPreview('a',true);
      window.setup=options=>{cached=options.cached||null;filtered=!!options.filtered;eventEntered=!!options.event;currentTrackLoadState.trackId='a';getTrackEntries.selection.id='a';pending=new Promise(resolve=>window.deliver=resolve);};
      window.leave=()=>{getTrackEntries.selection.id='b';currentTrackLoadState.trackId='b';};
    `});
    const rows=[{accountId:'first',name:'First',timeMs:100,runVerified:true},{accountId:'next',name:'Next',timeMs:200,runVerified:false}];
    await page.evaluate(()=>{setup({});window.work=start();});
    await page.evaluate(rows=>deliver({entries:rows}),rows);
    await page.evaluate(()=>window.work);
    assert.equal(await page.locator('.sq-loading-track-preview>div').count(),1);
    assert.match(await page.locator('.sq-loading-track-preview').innerText(),/First/);
    assert.equal(await page.locator('.sq-loading-track-preview').innerText().then(t=>t.includes('#')),false);
    assert.equal(await page.evaluate(()=>cached),null,'preview never becomes a full standings cache');
    await page.evaluate(()=>{const row=document.createElement('button');row.className='main';document.querySelector('.container').append(row);});
    await page.waitForFunction(()=>!document.querySelector('.sq-loading-track-preview'));
    await page.evaluate(()=>document.querySelector('button.main').remove());
    for(const option of [{filtered:true},{event:true},{cached:{entries:[{}]}}]){
      await page.evaluate(async option=>{setup(option);await start();},option);
      assert.equal(await page.locator('.sq-loading-track-preview').count(),0);
    }
    await page.evaluate(()=>{setup({});window.work=start();leave();});
    await page.evaluate(rows=>deliver({entries:rows}),rows);
    await page.evaluate(()=>window.work);
    assert.equal(await page.locator('.sq-loading-track-preview').count(),0,'late preview cannot appear on another track');
  }finally{await browser.close();}
});
