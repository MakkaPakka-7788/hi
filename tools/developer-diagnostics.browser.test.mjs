
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}
test('developer information fits small screens and copies only reviewed whitelist JSON',{skip:!chromium},async()=>{
 const source=await fs.readFile(new URL('./developer-diagnostics.mjs',import.meta.url),'utf8'),css=await fs.readFile(new URL('../home-ui.css',import.meta.url),'utf8');
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:route.request().url().endsWith('/module.mjs')?'text/javascript':'text/html',body:route.request().url().endsWith('/module.mjs')?source:'<!doctype html><button id="opener">Settings</button>'}));
  await page.goto('http://localhost/');await page.addStyleTag({content:css});
  await page.evaluate(async()=>{const {openDiagnostics,buildDeveloperReport}=await import('/module.mjs');Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text}}});document.querySelector('#opener').focus();openDiagnostics({report:includePublicId=>buildDeveloperReport({includePublicId,publicId:'a'.repeat(64),practice:Array.from({length:8},(_,i)=>({trackId:'b'.repeat(64),trackName:'<img src=x> Summer '+i,activeMs:60000,attempts:10,finishes:5,pbs:2,restarts:5}))})});});
  for(const [width,height]of [[320,568],[390,844],[844,390],[768,1024],[1280,800]]){await page.setViewportSize({width,height});const box=await page.locator('dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1&&box.y>=0&&box.y+box.height<=height+1);const button=await page.locator('[data-copy]').boundingBox();assert.ok(button.y+button.height<=height+1);assert.equal(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);}
  assert.equal(await page.locator('dialog img').count(),0);await page.locator('[data-copy]').click();let report=await page.evaluate(()=>JSON.parse(window.copied));assert.equal(report.publicRacerId,undefined);assert.equal(report.practice.length,8);
  await page.locator('[data-public-id]').check();await page.locator('[data-copy]').click();report=await page.evaluate(()=>JSON.parse(window.copied));assert.equal(report.publicRacerId,'a'.repeat(64));
  const pendingDownload=page.waitForEvent('download');await page.locator('[data-download]').click();const download=await pendingDownload;assert.match(download.suggestedFilename(),/\.json$/);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);assert.equal(JSON.parse(Buffer.concat(chunks).toString()).schema,'polytrack-developer-diagnostics-v1');
  await page.locator('[data-close]').click();await page.waitForSelector('dialog',{state:'detached'});assert.equal(await page.locator('dialog').count(),0);assert.equal(await page.evaluate(()=>document.activeElement.id),'opener');
 }finally{await browser.close();}
});
