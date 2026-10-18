import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';
import {decodeSnapshot} from './snapshot-package.mjs';
const url=String(process.env.POLYTRACK_NATIVE_AUDIT_URL||'').trim();

test('native Kodub spotlight merges snapshot racers and local PB without entering event-only mode',{skip:!url},async()=>{
 const require=createRequire(new URL('./verifier/package.json',import.meta.url));
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
 const feed=JSON.parse(await fs.readFile(new URL('../events/kodub/current.json',import.meta.url),'utf8'));
 const trackId=feed.current.trackId;
 const pointer=JSON.parse(await fs.readFile(new URL('../snapshot-current.json',import.meta.url),'utf8'));
 const base=new URL('../'+pointer.currentdir+'/',import.meta.url);
 const index=JSON.parse(await fs.readFile(new URL('index.json',base),'utf8'));
 const entry=index.files['tracks/'+trackId+'.json'];
 assert.ok(entry,'the committed current weekly track must have a snapshot board');
 const board=JSON.parse(Buffer.from(await decodeSnapshot(await fs.readFile(new URL(entry.path,base)))));
 const token='1'.repeat(64),accountId=createHash('sha256').update(token).digest('hex');
 const fixture={trackId,token,accountId,timeMs:16027,recording:deflateSync(Buffer.alloc(15)).toString('base64url'),carStyle:'AAAAAAD_9QAAABsbG____w'};
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),origin=new URL(url).origin,errors=[];let productionRequests=0;
  page.on('pageerror',error=>errors.push(String(error)));
  const failedRequests=[],responses=[];
  page.on('requestfailed',request=>{if(failedRequests.length<40)failedRequests.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText});});
  page.on('response',response=>{if(response.status()>=400&&responses.length<40)responses.push({path:new URL(response.url()).pathname,status:response.status()});});

  await page.route('**/*',route=>{
   const request=route.request(),target=new URL(request.url());
   if(target.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
   if(target.origin===origin&&target.pathname==='/events/kodub/current.json')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...feed,current:{...feed.current,endTime:new Date(Date.now()+86400000).toISOString()}})});
   if(target.origin===origin&&['GET','HEAD'].includes(request.method()))return route.continue();
   if(/firestore.googleapis.com|workers.dev/.test(target.hostname))productionRequests++;
   return route.abort('blockedbyclient');
  });
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  await page.addInitScript(({trackId,token,accountId,timeMs,recording,carStyle})=>{
   localStorage.setItem('polytrack_v5_prod_user_0',JSON.stringify({token,nickname:'Local PB fixture',countryCode:null,carStyle,isVerifier:false}));
   localStorage.setItem('polytrack_v5_prod_totw_id',trackId);
   localStorage.setItem('polytrack_v5_prod_record_0_default_'+trackId,JSON.stringify({uploadId:null,tokenHash:accountId,frames:timeMs,recording}));
   localStorage.setItem('polytrack-0.6.2-local-race-results-v1',JSON.stringify([{accountId,userId:accountId,trackId,name:'Local PB fixture',timeMs,frames:timeMs,uploadId:99999999,createdAt:Date.now()}]));
  },fixture);
  await page.goto(url,{waitUntil:'domcontentloaded'});
  for(const name of ['Exit','Back','Play','Community tracks']){const button=page.getByRole('button',{name,exact:true}).last();await button.waitFor({state:'visible',timeout:60000}).catch(async error=>{console.error(JSON.stringify({stage:name,errors,failedRequests,responses,ui:(await page.locator('#ui').innerText().catch(()=>'' )).slice(0,1600),bodyClass:await page.locator('body').getAttribute('class'),screen:await page.locator('#error-screen').innerText().catch(()=>null),buttons:await page.locator('button:visible').allTextContents()}));throw error;});await button.click();}
  const weekly=page.locator('.sq-kodub-weekly > button');await weekly.waitFor({state:'visible',timeout:30000});
  assert.doesNotMatch(await page.locator('.community-track-versions').innerText(),/StaticQuasar931/);
  await page.waitForFunction(()=>{const image=document.querySelector('.sq-featured-events .sq-permanent-track img.thumbnail');return image?.complete&&image.naturalWidth>0&&!image.classList.contains('loading')&&Number(getComputedStyle(image).opacity)>0;},null,{timeout:15000});
  assert.equal(await page.locator('.sq-featured-events > .sq-permanent-track').count(),1);
  const search=page.getByPlaceholder(/Search by track or author/);await search.fill('La Infinita');
  assert.equal(await page.locator('.sq-featured-events > .sq-permanent-track').isVisible(),true,'native search cannot hide the permanent event');
  await search.fill('');
  assert.match(await weekly.locator('.personal-best').innerText(),/00:16\.027/);
  const expected=board.entries.filter(row=>(row.accountId||row.userId)!==accountId).length+1;
  const assertNormal=async()=>{
   await page.waitForFunction(count=>document.querySelectorAll('.track-info-ui .leaderboard-ui .container button.main').length===count,expected,{timeout:30000});
   assert.equal(await page.locator('.sq-event-board').count(),0);
   assert.equal(await page.locator('#polytrackTrackFreshness').count(),0,'Kodub PB views do not show the normal-track infocard');
   assert.match(await page.locator('.track-info-ui .side-panel .personal-best').innerText(),/00:16\.027/);
   assert.equal(await page.locator('.track-info-ui .leaderboard-ui button.main.self').count(),1);
   await page.waitForFunction(()=>document.querySelector('.track-info-ui .leaderboard-ui button.main.self')?.textContent.includes('LOCAL PB'),null,{timeout:10000});
   assert.match(await page.locator('.track-info-ui .leaderboard-ui button.main.self').innerText(),/LOCAL PB/);
  };
  await weekly.click();await assertNormal();
  const verified=page.locator('.track-info-ui .leaderboard-ui .only-verified');await verified.click();await verified.click();await assertNormal();
  await page.locator('.track-info-ui .leaderboard-ui button.back').click();await weekly.waitFor({state:'visible'});await weekly.click();await assertNormal();
  assert.equal(productionRequests,0,'snapshot-only browsing must not request Firestore or the Worker');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
