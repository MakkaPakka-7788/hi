import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {installNativeRankedAuditFixture,auditNativeRankedClick} from './native-ranked-audit-fixture.mjs';

const url=String(process.env.POLYTRACK_NATIVE_AUDIT_URL||'').trim();

test('native Ranked Help fits phone, portrait, landscape, and desktop viewports', {skip:!url}, async()=>{
 const require=createRequire(new URL('./verifier/package.json',import.meta.url));
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:768}}),localOrigin=new URL(url).origin;
  await page.route('**/*',route=>{
   const request=route.request(),requestUrl=new URL(request.url());
   if(requestUrl.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
   if(requestUrl.origin===localOrigin&&['GET','HEAD'].includes(request.method()))return route.continue();
   return route.abort('blockedbyclient');
  });
  await installNativeRankedAuditFixture(page);
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const ranked=await auditNativeRankedClick(page);
  assert.equal(ranked.panelConnected,true,'the real Ranked panel must be open');
  assert.deepEqual(ranked.errors,[]);assert.deepEqual(ranked.rejections,[]);assert.deepEqual(ranked.pageErrors,[]);
  await page.locator('#overallLeaderboardList .overall-entry').first().waitFor({state:'visible',timeout:45000});
  await page.locator('#overallHelpBtn').click();
  const popup=page.locator('#overallHelpPopup'),card=popup.locator('.overall-help-card');
  await popup.waitFor({state:'visible'});
  const screenshotDir=process.env.POLYTRACK_NATIVE_HELP_SCREENSHOT_DIR;
  for(const [width,height] of [[1366,768],[390,844],[844,390],[320,568]]){
   await page.setViewportSize({width,height});
   await card.evaluate(node=>{node.scrollTop=0;});
   const layout=await page.evaluate(()=>{
    const popup=document.querySelector('#overallHelpPopup'),card=popup.querySelector('.overall-help-card');
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const overflow=[...card.querySelectorAll('*')].filter(node=>node.clientWidth&&node.scrollWidth>node.clientWidth+1).map(node=>({selector:node.className||node.tagName,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth}));
    return {popupDisplay:getComputedStyle(popup).display,popup:rect(popup),card:rect(card),cardClientWidth:card.clientWidth,cardScrollWidth:card.scrollWidth,cardClientHeight:card.clientHeight,cardScrollHeight:card.scrollHeight,overflow,documentWidth:document.documentElement.scrollWidth};
   });
   assert.notEqual(layout.popupDisplay,'none',`Help remains open at ${width}x${height}`);
   assert.ok(layout.popup.left>=-1&&layout.popup.right<=width+1,`Help overlay stays in viewport at ${width}x${height}`);
   assert.ok(layout.popup.top>=-1&&layout.popup.bottom<=height+1,`Help overlay stays in viewport vertically at ${width}x${height}`);
   assert.ok(layout.card.left>=-1&&layout.card.right<=width+1,`Help card stays in viewport horizontally at ${width}x${height}`);
   assert.ok(layout.card.top>=-1&&layout.card.bottom<=height+1,`Help card stays in viewport vertically at ${width}x${height}`);
   assert.ok(layout.cardScrollWidth<=layout.cardClientWidth+1,`Help card has no horizontal overflow at ${width}x${height}`);
   assert.ok(layout.documentWidth<=width+1,`Help does not widen the page at ${width}x${height}`);
   assert.deepEqual(layout.overflow,[],`Help text and cards have no horizontal overflow at ${width}x${height}`);
   if(screenshotDir&&(width===390||width===1366))await page.screenshot({path:join(screenshotDir,`ranked-help-${width}.png`)});
   for(const selector of ['[data-help-action]','#overallHelpClose']){
    const action=card.locator(selector).last();
    await action.scrollIntoViewIfNeeded();
    const bounds=await action.boundingBox();
    assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1,`${selector} is horizontally reachable at ${width}x${height}`);
    assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<=height+1,`${selector} is vertically reachable by scrolling at ${width}x${height}`);
   }
  }
  await page.keyboard.press('Escape');
  await popup.waitFor({state:'hidden'});
  assert.equal(await page.locator('#overallLeaderboardPanel').evaluate(node=>getComputedStyle(node).display!=='none'),true,'Escape closes Help without closing Ranked');
 }finally{await browser.close();}
});
