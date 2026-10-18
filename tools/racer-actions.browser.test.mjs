import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function openPersonalRacerActions('),end=source.indexOf('  function personalFilterNotice(',start);
const closeStart=source.indexOf('  function closeOverallPanel('),closeEnd=source.indexOf('  let lastRankedManualRefreshAt',closeStart);
assert.ok(start>=0&&end>start&&closeEnd>closeStart);
const cssStart=source.indexOf('.personal-racer-context{'),cssEnd=source.indexOf('.leaderboard-ui .button-wrapper>',cssStart);
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}
test('racer actions clean up listeners, contain keyboard focus and fit resized viewports',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:768},hasTouch:true});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<button id="racer">Racer</button><button id="outside">Outside</button><div id="overallLeaderboardPanel" style="display:flex"></div>');
  await page.addStyleTag({content:source.slice(cssStart,cssEnd)});
  await page.evaluate(()=>{
   window.actions=[];window.openRankedPanel=async()=>{};window.overallEntriesCache=[];
   window.openRankedProfile=()=>{};window.editPersonalRacer=(id,action)=>actions.push(action);
   window.openPersonalFilterMenu=()=>actions.push('edit');window.backgroundEscape=0;
   window.addEventListener('keydown',e=>{if(e.key==='Escape')backgroundEscape++;});
   window.listeners={pointer:new Set(),resize:new Set()};
   for(const [target,type,key] of [[document,'pointerdown','pointer'],[window,'resize','resize']]){
    const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);
    target.addEventListener=(name,fn,options)=>{if(name===type)listeners[key].add(fn);return add(name,fn,options);};
    target.removeEventListener=(name,fn,options)=>{if(name===type)listeners[key].delete(fn);return remove(name,fn,options);};
   }
  });
  await page.addScriptTag({content:'let rankedFreshnessTimer=0;'+source.slice(start,end)+source.slice(closeStart,closeEnd)});
  const open=()=>page.evaluate(()=>openPersonalRacerActions('racer',{target:document.querySelector('#racer'),clientX:innerWidth-10,clientY:innerHeight-10}));
  const counts=()=>page.evaluate(()=>({pointer:listeners.pointer.size,resize:listeners.resize.size}));
  await open();
  assert.ok(await page.locator('#personalRacerActions button').evaluateAll(buttons=>buttons.every(button=>button.getBoundingClientRect().height>=44)),'touch actions have usable targets');
  await page.locator('#personalRacerActions').dispatchEvent('pointerdown');
  assert.deepEqual(await counts(),{pointer:1,resize:1},'inside pointer does not consume outside dismissal');
  await page.locator('#outside').click();
  assert.equal(await page.locator('#personalRacerActions').count(),0);
  assert.deepEqual(await counts(),{pointer:0,resize:0});
  await open();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>backgroundEscape),0,'Escape must not close the leaderboard behind the popup');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'racer');
  assert.deepEqual(await counts(),{pointer:0,resize:0});
  await open();await page.keyboard.press('End');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Close');
  await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Racer profile');
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Close');
  await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Include in filters');
  await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>actions),['include']);
  assert.deepEqual(await counts(),{pointer:0,resize:0});
  for(const [width,height] of [[320,568],[844,390],[384,216]]){
   await page.setViewportSize({width,height});await open();
   const box=await page.locator('#personalRacerActions').boundingBox();
   assert.ok(box.x>=8&&box.y>=8&&box.x+box.width<=width-7&&box.y+box.height<=height-7,'popup fits '+width+'x'+height);
  }
  assert.deepEqual(await counts(),{pointer:1,resize:1},'reopening replaces rather than accumulates listeners');
  await page.evaluate(()=>closeOverallPanel(document.querySelector('#overallLeaderboardPanel')));
  assert.deepEqual(await counts(),{pointer:0,resize:0});
  assert.equal(await page.locator('#personalRacerActions').count(),0);
 }finally{await browser.close();}
});
