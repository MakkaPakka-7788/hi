import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ensureFeaturedSection} from './client.mjs';
import {combineKodubCard} from './kodub-weekly.mjs';

const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):createRequire(new URL('../tools/verifier/package.json',import.meta.url))('playwright');

test('community version buttons survive normal, duplicate, and reopened menu ownership cycles',async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage();
  await page.setContent('<div id="menus"></div>');
  await page.addScriptTag({content:`window.ensureFeaturedSection=${ensureFeaturedSection.toString()};window.combineKodubCard=${combineKodubCard.toString()};`});
  const state=await page.evaluate(()=>{
   const makeMenu=(id)=>{
    const menu=document.createElement('div');menu.className='track-selection-ui';menu.dataset.menu=id;
    menu.innerHTML='<div class="tracks-container"><div class="wrapper"><div class="community-track-versions"><button class="button">StaticQuasar931</button><button class="button selected">0.6.3</button></div><div class="community-track-group"></div><div class="track track-of-the-week"><button>weekly</button></div></div></div>';
    document.querySelector('#menus').append(menu);return menu;
   };
   const snapshot=menu=>[...menu.querySelectorAll('.community-track-versions button')].map(button=>({text:button.textContent,hidden:button.hidden,ariaHidden:button.getAttribute('aria-hidden'),tabIndex:button.tabIndex,selected:button.classList.contains('selected')}));
   const first=makeMenu('normal');let clicks=0;first.querySelector('.community-track-versions button:nth-child(2)').addEventListener('click',()=>clicks++);
   const weekly={trackId:'a'.repeat(64),endTime:new Date(Date.now()+3600000).toISOString()};
   const before=snapshot(first),section=window.ensureFeaturedSection(document,first);window.combineKodubCard(document,section,weekly);
   const firstState={before,after:snapshot(first),sectionParent:section?.closest('.track-selection-ui')?.dataset.menu,weeklyOwner:first.querySelector('.sq-featured-events .track-of-the-week')?.closest('.track-selection-ui')?.dataset.menu,clicks};
   const second=makeMenu('overlapping'),secondSection=window.ensureFeaturedSection(document,second);window.combineKodubCard(document,secondSection,weekly);
   const secondState={sectionParent:second.querySelector('.sq-featured-events')?.closest('.track-selection-ui')?.dataset.menu,weeklyOwner:second.querySelector('.sq-featured-events .track-of-the-week')?.closest('.track-selection-ui')?.dataset.menu,buttons:snapshot(second)};
   first.remove();second.remove();
   const reopened=makeMenu('reopened'),reopenedSection=window.ensureFeaturedSection(document,reopened);window.combineKodubCard(document,reopenedSection,weekly);
   const reopenedState={sectionParent:reopened.querySelector('.sq-featured-events')?.closest('.track-selection-ui')?.dataset.menu,weeklyOwner:reopened.querySelector('.sq-featured-events .track-of-the-week')?.closest('.track-selection-ui')?.dataset.menu,buttons:snapshot(reopened)};
   return {firstState,secondState,reopenedState};
  });
  assert.deepEqual(state.firstState.before,state.firstState.after,'featured setup must not hide, retab, or switch native version buttons');
  assert.equal(state.firstState.clicks,0,'setup must not click a different version tab');
  assert.equal(state.firstState.sectionParent,'normal');
  assert.equal(state.firstState.weeklyOwner,'normal');
  assert.equal(state.secondState.sectionParent,'overlapping','each menu owns its own event section');
  assert.equal(state.secondState.weeklyOwner,'overlapping','weekly card must remain within its owning menu');
  assert.equal(state.reopenedState.sectionParent,'reopened','reopened menu receives fresh event content');
  assert.equal(state.reopenedState.weeklyOwner,'reopened');
  for(const item of [state.secondState,state.reopenedState])assert.deepEqual(item.buttons.map(button=>button.text),['StaticQuasar931','0.6.3']);
 }finally{await browser.close();}
});
