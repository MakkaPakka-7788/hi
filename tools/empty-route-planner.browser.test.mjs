import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;
try { ({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright')); } catch {}
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
test('empty route planner is readable without a narrow summary cell', {skip:!chromium}, async()=>{
  assert.ok(source.includes("profile-guide ${noRoute?'is-empty ':''}"));
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent('<main id="overallProfilePopup"><details class="profile-guide is-empty"><summary><span class="route-preview-empty"><strong>No helpful move found</strong><small>No useful upgrade found in the loaded results. Try another category.</small></span></summary></details></main>');
    await page.addStyleTag({content:css});
    for(const width of [320,390,768,1920,2800]){
      await page.setViewportSize({width,height:900});
      const result=await page.locator('summary').evaluate(node=>({display:getComputedStyle(node).display,width:node.getBoundingClientRect().width,overflow:node.scrollWidth>node.clientWidth}));
      assert.equal(result.display,'block');
      assert.ok(result.width>200);
      assert.equal(result.overflow,false);
    }
  } finally {await browser.close();}
});
