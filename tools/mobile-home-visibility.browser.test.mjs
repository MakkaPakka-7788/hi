import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const fragments = [...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)];
assert.ok(fragments.length > 1, 'native UI CSS injection remains discoverable');
const rankedCss = fragments.map(fragment => JSON.parse(fragment[1])).join('\n');

test('portrait native home, settings, track-info, and track-selection screens respect hidden state', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.'
}, async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent('<style>' +
      'html,body{margin:0;width:100%;height:100%}' +
      'body>div{position:fixed;inset:0;transform:scale(.8)}' +
      '.menu-ui{position:fixed;inset:0}' +
      '.main-buttons-container{position:absolute;inset:20px}' +
      '/* main.bundle.js initializes and hides this screen with the .hidden class. */' +
      '.track-selection-ui{position:absolute;inset:0;display:flex;flex-direction:column}' +
      '.settings-menu-ui,.track-info-ui{position:absolute;inset:0;display:flex;flex-direction:column}' +
      '.track-selection-ui.hidden,.settings-menu-ui.hidden,.track-info-ui.hidden{display:none}' +
      '</style><div><div class="menu-ui"><div class="main-buttons-container">HOME</div>' +
      '<div class="settings-menu-ui hidden">SETTINGS</div><div class="track-info-ui hidden">TRACK INFO</div>' +
      '<div class="track-selection-ui hidden">TRACK SELECTION</div></div></div>');
    await page.addStyleTag({ content: rankedCss });

    const measure = selector => page.evaluate(selector => {
      const selection = document.querySelector(selector);
      const rect = selection.getBoundingClientRect();
      return { hiddenClass: selection.classList.contains('hidden'), display: getComputedStyle(selection).display,
        rectCount: selection.getClientRects().length, width: rect.width, height: rect.height,
        hostTransform: getComputedStyle(document.body.firstElementChild).transform,
        homeDisplay: getComputedStyle(document.querySelector('.main-buttons-container')).display };
    }, selector);
    for (const selector of ['.settings-menu-ui', '.track-info-ui', '.track-selection-ui']) {
      const hidden = await measure(selector);
      assert.equal(hidden.hiddenClass, true, `${selector} uses the native hidden class`);
      assert.equal(hidden.display, 'none', `${selector} remains hidden in portrait`);
      assert.equal(hidden.rectCount, 0, `${selector} cannot overlap HOME`);
      assert.equal(hidden.hostTransform, 'matrix(0.8, 0, 0, 0.8, 0, 0)', `${selector} does not reset native HOME scaling`);
      assert.equal(hidden.homeDisplay, 'block');

      await page.locator(selector).evaluate(node => node.classList.remove('hidden'));
      const visible = await measure(selector);
      assert.equal(visible.display, 'flex', `${selector} receives the active portrait layout`);
      assert.ok(visible.rectCount > 0);
      assert.equal(visible.hostTransform, 'none', `${selector} gets the viewport host layout while active`);
      if (selector === '.track-selection-ui') {
        assert.equal(visible.width, 390);
        assert.equal(visible.height, 844);
      }
      await page.locator(selector).evaluate(node => node.classList.add('hidden'));
    }
    await page.setViewportSize({ width: 844, height: 390 });
    for (const selector of ['.settings-menu-ui', '.track-info-ui', '.track-selection-ui']) {
      const hidden = await measure(selector);
      assert.equal(hidden.display, 'none', `${selector} remains hidden after portrait-to-landscape rotation`);
      assert.equal(hidden.rectCount, 0);
      assert.equal(hidden.hostTransform, 'matrix(0.8, 0, 0, 0.8, 0, 0)');
    }
    await page.locator('.track-selection-ui').evaluate(node => node.classList.remove('hidden'));
    assert.equal((await measure('.track-selection-ui')).display, 'flex', 'track selection remains visible when activated in landscape');
  } finally {
    await browser.close();
  }
});
