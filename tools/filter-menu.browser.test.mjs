import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNativeRankedAuditFixture } from './native-ranked-audit-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}

test('filter menu works offline in a real browser: focus, preview, share and loadouts', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.'
}, async () => {
  const menuPath = resolve(here, 'filter-menu.mjs');
  const cssPath = resolve(here, 'filter-menu.css');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/filter-menu.css"></head><body>
    <button id="opener">Open filters</button><main id="root"></main>
    <script type="module">
      import { mountFilterMenu } from '/filter-menu.mjs';
      const users=[{accountId:'racer-1',name:'Racer One',rank:1,rp:12.345},{accountId:'racer-2',name:'Racer Two',rank:2},{accountId:'a'.repeat(64),name:'Long ID Pilot'}];
      let current={enabled:true}; let rendered=0; let failLoadoutWrites=false;
      const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>{
        if(failLoadoutWrites&&key==='polytrack-advanced-filter-loadouts-v1')throw new Error('quota exceeded');
        localStorage.setItem(key,value);
      }};
      const menu=mountFilterMenu({root:document.querySelector('#root'),storage,
        getRows:()=>users,getFilter:()=>current,getTracks:()=>[],
        onApply:next=>{current=next;return {unavailable:[]};},
        renderRacer:row=>row.accountId==='racer-1'?'<div class="overall-car-model image-container"><img class="show" alt=""></div>':'',
        onRenderRacers:()=>{rendered++;},
        exportCode:value=>'SHARE:'+JSON.stringify(value),
        importCode:value=>{if(value!=='valid-code')throw new Error('Malformed share code');return {whitelist:['racer-1']};}
      });
      window.fixture={menu,get rendered(){return rendered;},setFailLoadoutWrites:value=>{failLoadoutWrites=value;},
        getBackup:()=>localStorage.getItem('polytrack-advanced-filter-backup-v1'),getCurrent:()=>current};
      document.querySelector('#opener').addEventListener('click',()=>menu.open());
      window.ready=true;
    </script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
      if (req.url === '/filter-menu.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(menuPath)); return; }
      if (req.url === '/filter-menu.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(await readFile(cssPath)); return; }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await installNativeRankedAuditFixture(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready === true);
    const opener = page.locator('#opener');
    await opener.focus();
    const renderedBeforeOpen = await page.evaluate(() => window.fixture.rendered);
    await opener.click();
    const overlay = page.locator('.pt-group-filter-menu');
    await assert.doesNotReject(() => overlay.waitFor({ state: 'visible' }));
    await assert.doesNotReject(() => page.getByRole('button', { name: 'Close advanced filters' }).waitFor());
    const renderedAfterOpen = await page.evaluate(() => window.fixture.rendered);
    assert.equal(renderedAfterOpen - renderedBeforeOpen, 4,
      'opening refreshes each racer chip once before and once after the overlay becomes visible');
    for (const [width, height, label, fileName] of [
      [390, 844, 'phone viewport'],
      [195, 422, '200% zoom effective viewport']
    ]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(200);
      const layout = await overlay.evaluate(element => {
        const shell = element.querySelector('.fm-shell').getBoundingClientRect();
        const content = element.querySelector('.fm-content');
        const controls = [...element.querySelectorAll('.fm-header button, .fm-footer button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        });
        return {
          shell: { left: shell.left, top: shell.top, right: shell.right, bottom: shell.bottom },
          contentWidth: content.clientWidth,
          contentScrollWidth: content.scrollWidth,
          contentHeight: content.clientHeight,
          controls
        };
      });
      assert.ok(layout.shell.left >= -1 && layout.shell.top >= -1 && layout.shell.right <= width + 1 && layout.shell.bottom <= height + 1,
        `filter dialog stays in the viewport at ${label}: ${JSON.stringify(layout.shell)}`);
      assert.ok(layout.contentScrollWidth <= layout.contentWidth + 1,
        `filter content has no horizontal overflow at ${label}`);
      assert.ok(layout.controls.every(rect => rect.left >= -1 && rect.right <= width + 1),
        `filter actions fit without clipping at ${label}: ${JSON.stringify(layout.controls)}`);
      if (width === 195) assert.ok(layout.contentHeight >= 100,
        `filter content remains usable at ${label}: ${layout.contentHeight}px high`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await overlay.locator('.fm-button-pause').focus();
    await page.keyboard.press('Shift+Tab');
    const lastFocused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert.match(lastFocused, /Apply filters/);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Pause filters');

    const include = page.getByRole('searchbox', { name: 'Include racers' });
    await include.fill('Racer');
    await page.locator('.fm-user-picker [role="status"]').getByText('2 racers found.').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await overlay.isVisible(), true, 'Escape dismisses racer suggestions without closing the filter dialog');
    assert.equal(await include.getAttribute('aria-expanded'), 'false');
    await include.press('ArrowDown');
    assert.equal(await include.getAttribute('aria-expanded'), 'true', 'ArrowDown reopens dismissed racer suggestions');
    await include.press('Escape');
    await include.fill('');
    await include.fill('Racer');
    const listboxId = await include.getAttribute('aria-controls');
    const racerList = page.locator(`#${listboxId}`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const activeOptionId = await include.getAttribute('aria-activedescendant');
    const activeOption = page.locator(`#${activeOptionId}`);
    assert.match(await activeOption.innerText(), /Racer Two/);
    assert.equal(await activeOption.getAttribute('aria-selected'), 'true');
    assert.notEqual(await activeOption.evaluate(el => getComputedStyle(el).boxShadow), 'none');
    await page.keyboard.press('Enter');
    await page.locator('.fm-user-picker [role="status"]').getByText('Racer Two selected.').waitFor();
    await include.fill('Racer One');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.fm-chips .fm-racer-native-preview img.show').count(), 1);
    const fallback = page.locator('.fm-chips .fm-initials');
    assert.equal(await fallback.textContent(), 'RT');
    assert.equal(await fallback.getAttribute('aria-hidden'), 'true');
    assert.equal(await include.getAttribute('aria-controls'), await racerList.getAttribute('id'));
    assert.equal(await include.getAttribute('aria-expanded'), 'false');
    assert.equal(await include.getAttribute('aria-activedescendant'), null);
    assert.ok(await page.evaluate(() => window.fixture.rendered > 0));

    await page.setViewportSize({ width: 390, height: 844 });
    const removeTarget = await page.locator('.fm-chips .fm-chip-remove').first().evaluate(button => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert.ok(removeTarget.width >= 42 && removeTarget.height >= 42,
      `Racer remove target meets the 42px touch size: ${JSON.stringify(removeTarget)}`);
    await include.fill('id: aaaaa');
    await page.locator('.fm-suggestions [role="option"]').filter({ hasText: 'Long ID Pilot' }).waitFor();
    const suggestionWidth = await racerList.evaluate(list => ({
      client: list.clientWidth, scroll: list.scrollWidth
    }));
    assert.ok(suggestionWidth.scroll <= suggestionWidth.client + 1,
      `Long account IDs wrap without horizontal overflow on a phone: ${JSON.stringify(suggestionWidth)}`);
    await include.fill('');
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByRole('button', { name: 'Share and loadouts' }).click();
    await page.getByRole('button', { name: 'Create share code' }).click();
    assert.match(await page.getByRole('textbox', { name: 'Shared filter code' }).inputValue(), /^SHARE:/);
    const share = page.getByRole('textbox', { name: 'Shared filter code' });
    await share.fill('invalid');
    await page.getByRole('button', { name: 'Import code' }).click();
    await page.getByRole('status').getByText('Malformed share code').waitFor();
    await share.fill('valid-code');
    await page.getByRole('button', { name: 'Import code' }).click();
    await page.getByRole('status').getByText('Code imported into the editor').waitFor();

    await page.getByRole('button', { name: 'Share and loadouts' }).click();
    await page.getByRole('textbox', { name: 'Loadout name' }).fill('Browser test');
    await page.getByRole('button', { name: 'Save current' }).click();
    const loadoutData = page.getByRole('textbox', { name: 'Loadout import and export data' });
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    const exported = JSON.parse(await loadoutData.inputValue());
    assert.equal(exported.presets[0].name, 'Browser test');
    await loadoutData.fill(JSON.stringify({ presets: [{ name: 'Browser test', filter: [] }] }));
    await page.getByRole('button', { name: 'Import loadouts' }).click();
    await page.getByRole('status').getByText('Each named loadout must contain a filter object').waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets, exported.presets,
      'an array-shaped filter cannot replace an existing saved loadout');
    await loadoutData.fill('{}');
    await page.getByRole('button', { name: 'Import loadouts' }).click();
    await page.getByRole('status').getByText('Loadout data must contain a presets list').waitFor();

    const backupBeforeFailures = await page.evaluate(() => window.fixture.getBackup());
    await page.evaluate(() => window.fixture.setFailLoadoutWrites(true));
    await page.getByRole('textbox', { name: 'Loadout name' }).fill('Unsaved');
    await page.getByRole('button', { name: 'Save current' }).click();
    await page.locator('.fm-status').getByText('Loadout could not be saved').waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets.map(item => item.name), ['Browser test']);

    const select = page.getByRole('combobox', { name: 'Saved loadouts' });
    await select.selectOption({ value: 'Browser test' });
    await page.getByRole('button', { name: '☆ Favorite' }).click();
    await page.locator('.fm-status').getByText('Favorite could not be saved').waitFor();
    assert.equal(await page.getByRole('button', { name: '☆ Favorite' }).count(), 1);
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.equal(JSON.parse(await loadoutData.inputValue()).presets[0].favorite, false);
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await page.locator('.fm-status').getByText('Loadout could not be deleted').waitFor();
    assert.equal(await select.inputValue(), 'Browser test');
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets.map(item => item.name), ['Browser test']);

    await loadoutData.fill(JSON.stringify({ presets: [{ name: 'Failed import', filter: { blacklist: ['racer-1'] } }] }));
    await page.getByRole('button', { name: 'Import loadouts' }).click();
    await page.locator('.fm-status').getByText('Loadouts could not be saved in this browser').waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets.map(item => item.name), ['Browser test']);
    assert.equal(await page.evaluate(() => window.fixture.getBackup()), backupBeforeFailures);

    await select.selectOption({ value: 'Browser test' });
    const filterBeforeFailedLoad = await page.locator('.fm-user-picker').first().locator('.fm-chips').innerText();
    await page.getByRole('button', { name: 'Load selected' }).click();
    await page.locator('.fm-status').getByText('Loadout usage could not be saved').waitFor();
    assert.equal(await page.locator('.fm-user-picker').first().locator('.fm-chips').innerText(), filterBeforeFailedLoad);
    assert.equal(await page.evaluate(() => window.fixture.getBackup()), backupBeforeFailures);

    await page.evaluate(() => window.fixture.setFailLoadoutWrites(false));
    await page.getByRole('button', { name: '☆ Favorite' }).click();
    await page.getByRole('button', { name: '★ Favorited' }).waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    const savedBeforeQuickAction = JSON.parse(await loadoutData.inputValue()).presets[0];
    await page.evaluate(() => window.fixture.setFailLoadoutWrites(true));

    assert.equal(await page.evaluate(() => window.fixture.menu.updateRacer('racer-1', 'exclude')), true);
    await page.locator('.fm-status').getByText('Racer excluded in the active filter, but saved loadout "Browser test" could not be updated').waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.getCurrent().blacklist), ['racer-1']);
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets[0], savedBeforeQuickAction);

    assert.equal(await page.evaluate(() => window.fixture.menu.updateRacer('racer-2', 'include')), true);
    await page.locator('.fm-status').getByText('Racer forced into results in the active filter, but saved loadout "Browser test" could not be updated').waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.getCurrent().forcedIncludes), ['racer-2']);
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets[0], savedBeforeQuickAction);
    await page.evaluate(() => window.fixture.setFailLoadoutWrites(false));

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'opener');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
