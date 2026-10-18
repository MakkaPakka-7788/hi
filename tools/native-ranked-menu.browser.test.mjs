import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { installNativeRankedAuditFixture, auditNativeRankedClick } from './native-ranked-audit-fixture.mjs';

const url = String(process.env.POLYTRACK_NATIVE_AUDIT_URL || '').trim();

test('native home Ranked button opens the real panel with offline Firebase', { skip: !url }, async () => {
  const require = createRequire(new URL('./verifier/package.json', import.meta.url));
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const localOrigin = new URL(url).origin;
    await page.route('**/*', route => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (requestUrl.pathname === '/v6/user') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      if (requestUrl.origin === localOrigin && ['GET', 'HEAD'].includes(request.method())) return route.continue();
      return route.abort('blockedbyclient');
    });
    await installNativeRankedAuditFixture(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const result = await auditNativeRankedClick(page);
    console.log(JSON.stringify({ nativeRankedAudit: result }));
    assert.equal(result.clicks, 1, 'the native Ranked button must receive the click');
    assert.equal(result.buttonVisible, true, 'Ranked must remain visible after reconciliation');
    assert.equal(result.panelConnected, true, 'the real Ranked panel must remain connected');
    assert.equal(result.panelDisplay, 'flex', 'the real Ranked panel must be visible');
    assert.doesNotMatch(result.listText, /Ranked could not finish opening/);
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rejections, []);
    await page.locator('#overallLeaderboardList .overall-entry').first().waitFor({state: 'visible', timeout: 45000});
    const initialRows=await page.locator('#overallLeaderboardList .overall-entry').count();
    for(let visit=0;visit<3;visit++){
      await page.locator('#closeOverallLeaderboard').click();
      await page.locator('#injectedRankingsBtn').click();
      await page.locator('#overallLeaderboardList .overall-entry').first().waitFor({state:'visible',timeout:15000});
      assert.equal(await page.locator('#overallLeaderboardPanel').count(),1,'reopening reuses the Ranked panel');
      assert.equal(await page.locator('#overallLeaderboardList .overall-entry').count(),initialRows,'reopening does not accumulate rows');
    }
    const errorsAfterReopen=await page.evaluate(()=>window.__ptNativeRankedAudit);
    assert.deepEqual(errorsAfterReopen.errors,[]);
    assert.deepEqual(errorsAfterReopen.rejections,[]);
    for (const [width, height] of [[320, 568], [390, 844], [640, 800], [700, 800], [844, 390], [384, 216]]) {
      await page.setViewportSize({width, height});
      const layout = await page.evaluate(() => {
        const panel = document.getElementById('overallLeaderboardPanel');
        const status = panel.querySelector('#overallFreshness');
        const shell = panel.querySelector('.overall-shell');
        const pager = panel.querySelector('.overall-pager');
        const filter = panel.querySelector('[data-personal-filter-button]');
        const header = panel.querySelector('.overall-top').getBoundingClientRect();
        const bounds = filter.getBoundingClientRect();
        const jump=panel.querySelector('#overallPageJump').getBoundingClientRect(),next=panel.querySelector('#overallNextPage').getBoundingClientRect(),pageStatus=panel.querySelector('#overallPageStatus');
        return {jumpWidth:jump.width,jumpRight:jump.right,nextLeft:next.left,pageStatusWidth:pageStatus.clientWidth,pageStatusContentWidth:pageStatus.scrollWidth,pagerWidth:pager.clientWidth,pagerContentWidth:pager.scrollWidth,shellHeight: shell.clientHeight, shellContentHeight: shell.scrollHeight, shellOverflow: getComputedStyle(shell).overflowY,
          statusHeight: status.clientHeight, statusContentHeight: status.scrollHeight,
          filterLeft: bounds.left, filterRight: bounds.right, filterContentWidth: filter.scrollWidth, filterWidth: filter.clientWidth, headerHeight: header.height};
      });
      assert.ok(layout.jumpWidth>=34, `page number stays readable at ${width}x${height}`);
      assert.ok(layout.jumpRight<=layout.nextLeft, `page number never overlaps Next at ${width}x${height}`);
      assert.ok(layout.pageStatusContentWidth<=layout.pageStatusWidth+1, `page total stays readable at ${width}x${height}`);
      assert.ok(layout.pagerContentWidth<=layout.pagerWidth+1, `page controls fit at ${width}x${height}`);
      assert.ok(layout.statusContentHeight <= layout.statusHeight + 1, `refresh instructions must not clip at ${width}x${height}`);
      assert.ok(layout.filterLeft >= 0 && layout.filterRight <= width, `filters fit at ${width}x${height}`);
      assert.ok(layout.filterContentWidth <= layout.filterWidth + 1, `filter state stays readable at ${width}x${height}`);
      assert.ok(layout.headerHeight <= 145, `header leaves room for racers at ${width}x${height}`);
      assert.ok(layout.shellContentHeight <= layout.shellHeight + 2 || /auto|scroll/.test(layout.shellOverflow), `overflowing footer stays reachable at ${width}x${height}`);
      if (process.env.POLYTRACK_NATIVE_AUDIT_SCREENSHOT_DIR) {
        await page.screenshot({path: join(process.env.POLYTRACK_NATIVE_AUDIT_SCREENSHOT_DIR, `ranked-final-${width}.png`)});
      }
    }
  } finally {
    await browser.close();
  }
});
