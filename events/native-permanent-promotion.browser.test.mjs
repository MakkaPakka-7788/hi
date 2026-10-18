import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import {ensureFeaturedSection} from './client.mjs';
import {installNativeRankedAuditFixture} from '../tools/native-ranked-audit-fixture.mjs';

const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):require('playwright');
const nativeBundle=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');

test('Events promotes the original card and hides only its emptied author tab without editing the pinned engine',async()=>{
  assert.match(nativeBundle,/id:"fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778",group:"StaticQuasar931",trackMetadata:\{name:"Rolling Hills Racer"/);
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await installNativeRankedAuditFixture(page);
    await page.setContent('<div id="ui"></div>');
    await page.addScriptTag({content:`window.ensureFeaturedSection=${ensureFeaturedSection.toString()};`});
    const state=await page.evaluate(()=>{
      const selection=document.createElement('div');selection.className='track-selection-ui';
      selection.innerHTML='<div class="tracks-container"><div class="wrapper"><div class="community-track-versions"><button class="button selected">StaticQuasar931</button><button class="button">0.6.3</button></div><div class="community-track-group"><div class="track"><button class="button"><div class="track-title"><p>Rolling Hills Racer</p></div><img class="thumbnail loading" src="tracks/community/thumbnails/rolling_hills_racer.png"><div class="record">00:20.000</div></button></div></div><div class="community-track-group hidden"><div class="track"><button class="button">Another 0.6.3 community track</button></div></div></div></div>';
      document.querySelector('#ui').append(selection);
      const tabs=[...selection.querySelectorAll('.community-track-versions > button')],groups=[...selection.querySelectorAll('.community-track-group')],original=groups[0].querySelector(':scope > .track'),image=original.querySelector('img');
      const tabsBefore=tabs.map(tab=>tab.textContent);
      for(const tab of tabs)tab.addEventListener('click',()=>{tabs.forEach(node=>node.classList.toggle('selected',node===tab));});
      let nativeLaunches=0,imageLoads=0;
      original.querySelector(':scope > button').addEventListener('click',()=>nativeLaunches++);
      image.addEventListener('load',()=>{imageLoads++;image.classList.remove('loading');});
      const section=window.ensureFeaturedSection(document,selection),featured=section.querySelector(':scope > .sq-permanent-track');
      image.dispatchEvent(new Event('load'));
      featured.querySelector(':scope > button').click();
      return {sameNode:featured===original,tabsBefore,tabsAfter:tabs.map(tab=>tab.textContent),tabCount:tabs.length,staticQuasarTabs:tabs.filter(tab=>tab.textContent==='StaticQuasar931'&&!tab.hidden).length,selectedTab:tabs.find(tab=>tab.classList.contains('selected'))?.textContent,groupTrackCount:groups[0].querySelectorAll(':scope > .track').length,otherTrackStillPresent:groups[1].textContent.includes('Another 0.6.3 community track'),nativeLaunches,imageLoads,imageLoading:image.classList.contains('loading'),thumbnail:image.getAttribute('src'),title:featured.querySelector('.track-title p')?.textContent};
    });
    assert.equal(state.sameNode,true,'the featured card must be the original native node');
    assert.deepEqual(state.tabsBefore,state.tabsAfter,'promotion must not alter the native version tab list');
    assert.equal(state.tabCount,2);
    assert.equal(state.staticQuasarTabs,0);
    assert.equal(state.groupTrackCount,0,'only RHR was in its author group');
    assert.equal(state.selectedTab,'0.6.3','native selection must leave the emptied hidden author group');
    assert.equal(state.otherTrackStillPresent,true,'unrelated native tracks stay in their group');
    assert.equal(state.nativeLaunches,1,'the native track launch listener remains attached');
    assert.equal(state.imageLoads,1);
    assert.equal(state.imageLoading,false,'the native lazy-image load listener remains attached');
    assert.equal(state.thumbnail,'tracks/community/thumbnails/rolling_hills_racer.png');
    assert.equal(state.title,'Rolling Hills Racer');
    const restored=await page.evaluate(()=>{
      const selection=document.querySelector('.track-selection-ui');
      const source=selection.querySelector('.community-track-group');
      const other=document.createElement('div');other.className='track';other.textContent='Another author track';source.append(other);
      window.ensureFeaturedSection(document,selection);
      window.ensureFeaturedSection(document,selection);
      const tab=selection.querySelector('.community-track-versions > button');
      return {tabHidden:tab.hidden,sourceHidden:source.hidden,display:tab.style.display,ariaHidden:tab.getAttribute('aria-hidden'),tabindex:tab.getAttribute('tabindex'),featuredCount:selection.querySelectorAll('.sq-permanent-track').length,otherPresent:source.contains(other)};
    });
    assert.deepEqual(restored,{tabHidden:false,sourceHidden:false,display:'',ariaHidden:null,tabindex:null,featuredCount:1,otherPresent:true},'a real additional author track restores its tab without duplicating the featured card');
  }finally{await browser.close();}
});
