import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./verifier/package.json', import.meta.url));
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const homeCss = read('../home-ui.css');
const patch = read('../polytrack_062_patch.js');
const bundle = read('../main.bundle.js');
const literal = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
const fragments = [...patch.matchAll(new RegExp(String.raw`(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*(${literal})`, 'g'))];
const injectedCss = fragments.map(match => vm.runInNewContext(match[1], {}, { timeout: 100 })).join('\n');
const nativeFragments = [...bundle.matchAll(/\.push\(\[\w+\.id,("(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g)];
const fontData = fs.readFileSync(new URL('../forced_square.woff2', import.meta.url)).toString('base64');
const nativeCss = nativeFragments.map(match => {
  // The only interpolations in native CSS are bundled asset URLs, not layout rules.
  const source = match[1].replace(/\$\{[^}]+\}/g, 'data:application/octet-stream;base64,');
  return vm.runInNewContext(source, {}, { timeout: 100 }).replace(/@font-face\s*\{[^}]*\}/g, '');
}).join('\n');
const helper = patch.match(/  function positionTrackFreshnessBanner\(banner,leaderboard\)\{[\s\S]*?\r?\n  \}(?=\r?\n  function updateTrackFreshnessBanner)/)?.[0];
// Capture the entire statement, including the nested template used for the weight.
const bannerExpression = patch.match(/const bannerHtml=([\s\S]*?);\r?\n/)?.[1];
const nativeScale = bundle.match(/df=function\(\)\{return (Math\.max\(\.01,Math\.min\(1,Math\.min\(window\.innerWidth,1\.4375\*window\.innerHeight\)\/1150\)\))\}/)?.[1];

const viewports = [
  { width: 320, height: 568, label: 'small-phone-portrait' },
  { width: 384, height: 216, label: '500-percent-zoom-equivalent' },
  { width: 560, height: 312, label: 'small-landscape' },
  { width: 600, height: 400, label: 'small-window' },
  { width: 2800, height: 1920, label: 'large-monitor' },
  { width: 1920, height: 1080, label: 'desktop' },
  { width: 1371, height: 771, label: '140-percent-zoom-equivalent' },
  { width: 1280, height: 720, label: '150-percent-zoom-equivalent' },
  { width: 390, height: 844, label: 'phone-portrait' },
  { width: 844, height: 390, label: 'phone-landscape' },
  { width: 820, height: 1180, label: 'ipad-portrait' },
];
const states = [
  { name: 'snapshot', fieldSize: 84, weight: 1.25, sourceHtml: '<b class="track-data-snapshot-age">Snapshot 2h old</b>', pbStatusHtml: '', updateLine: 'Standings changed 2d ago', policy: 'Live refresh unlocks in 14:00' },
  { name: 'submitted-pb', fieldSize: 12345, weight: 9.99, sourceHtml: '<b class="track-data-snapshot-age">Snapshot 12d old</b> + submitted PB', pbStatusHtml: ' <b class="track-data-pb-status">WAITING</b>', updateLine: 'Standings changed 12 days ago', policy: 'Live refresh unlocks in 14:59' },
  { name: 'error-empty', fieldSize: 0, weight: 0, sourceHtml: 'Saved on this device - live refresh unavailable', pbStatusHtml: '', updateLine: 'No published standings change recorded', policy: '' },
];
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const bannerHtml = state => vm.runInNewContext(bannerExpression, { ...state, escapeHtml }, { timeout: 100 });
const asset = name => `data:image/svg+xml;base64,${fs.readFileSync(new URL(`../images/${name}.svg`, import.meta.url)).toString('base64')}`;
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${homeCss}\n${nativeCss}\n${injectedCss}
@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${fontData}) format('woff2')}
</style></head><body><div id="ui"><div class="menu-ui"><div class="track-info-ui">
<div class="leaderboard-ui"><h2>Leaderboard</h2><h3>Version 0.6</h3><div class="total-players fade-in">84 Players</div>
<div class="container">${Array.from({length: 20}, (_, index) => `<button class="button main"><div class="image-container"></div><div class="left"><p class="position">${index + 1}<span> / 84</span></p><p>00:28.123</p></div><div class="right"><div class="name-container"><p class="name">Racer ${index + 1}</p></div><p class="verified-state verified">Verified</p></div></button>`).join('')}</div>
<div class="pages">${Array.from({length: 5}, (_, index) => `<button class="button page${index ? '' : ' selected'}">${index + 1}</button>`).join('')}</div>
<div class="button-wrapper"><button class="button back"><img class="button-icon" src="${asset('back')}"> Back</button><button class="button personal-filter-toggle" data-personal-filter-button>Filters-Inactive</button><button class="button icon-button first" aria-label="Find me"><img class="button-icon" src="${asset('pin')}"></button><button class="button only-verified">Only verified<img src="${asset('state_verified')}"></button></div></div>
<div class="side-panel"><h2>01 - Summer</h2><div class="thumbnail"></div><p class="track-author">Kodub</p><p class="personal-best-title">Personal best</p><div class="personal-best"><p>00:28.123</p></div><p class="opponents-title">Opponents</p><div class="opponents-container no-opponents">No opponents selected</div><button class="button watch">Watch</button><button class="button play">Play</button></div>
</div></div></div><div id="polytrackTrackFreshness" class="polytrack-track-freshness" data-source="snapshot"></div></body></html>`;

function bounded(promise, label, milliseconds = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms; stop this browser run rather than retrying`)), milliseconds); })]).finally(() => clearTimeout(timer));
}

function assertInside(rect, parent, label) {
  assert.ok(rect.width > 0 && rect.height > 0, `${label}: rendered ${JSON.stringify(rect)}`);
  assert.ok(rect.left >= parent.left - 1 && rect.right <= parent.right + 1 && rect.top >= parent.top - 1 && rect.bottom <= parent.bottom + 1, `${label}: outside boundary ${JSON.stringify({rect, parent})}`);
}

test('responsive card harness uses production CSS, font, markup and placement', () => {
  assert.ok(fragments.length >= 40, 'include double-quoted, single-quoted and template CSS injections');
  assert.match(injectedCss, /pointer-events:none/);
  assert.match(nativeCss, /\.leaderboard-ui > \.button-wrapper > \.back/);
  assert.match(nativeCss, /#ui \{/);
  assert.ok(helper && nativeScale, 'extract production placement helper and native resize formula');
  assert.match(bannerHtml(states[1]), /<strong><b class="track-data-weight">9\.99x Weight<\/b><b class="track-data-players">12345 Players/);
  assert.match(bannerHtml(states[1]), /track-data-pb-status/);
  assert.match(homeCss, /font-size:\s*1\.2em\s*!important/);
  assert.match(homeCss, /font-size:\s*1\.05em\s*!important/);
});

test('production card avoids native footer and scrollbar with no clipped content', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to run the offline browser check.', timeout: 65000,
}, async () => {
  const browser = await chromium.launch({ headless: true, timeout: 15000,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    ...(process.env.POLYTRACK_TEST_SOFTWARE_RENDERING === '1' ? { args: ['--disable-gpu'] } : {}),
  });
  const evidence = [];
  let failure;
  try {
    const page = await bounded(browser.newPage(), 'new page');
    console.log('Offline card page created.');
    page.setDefaultTimeout(10000);
    await page.route('**/*', route => route.abort('blockedbyclient'));
    await bounded(page.setContent(fixture, { waitUntil: 'domcontentloaded' }), 'offline fixture');
    console.log('Production CSS and native markup loaded.');
    await bounded(page.evaluate(async ({ helper, nativeScale }) => {
      window.positionTrackFreshnessBanner = new Function(`${helper}; return positionTrackFreshnessBanner;`)();
      window.nativeTrackUiScale = new Function(`return ${nativeScale};`);
      await document.fonts.load('20px ForcedSquare');
      await document.fonts.ready;
      if (![...document.fonts].some(font => font.family === 'ForcedSquare' && font.status === 'loaded')) throw Error('ForcedSquare font did not load');
    }, { helper, nativeScale }), 'production font and helpers');
    console.log('ForcedSquare and production helpers ready.');
    for (const scale of [1, 0.85, 1.25]) {
      for (const viewport of viewports) {
        await bounded(page.setViewportSize({ width: viewport.width, height: viewport.height }), 'viewport resize');
        for (const state of states) {
          const result = await bounded(page.evaluate(({ scale, html, state }) => {
            document.documentElement.style.setProperty('--sq-ui-scale', String(scale));
            const root = document.getElementById('ui');
            const nativeScale = window.nativeTrackUiScale();
            root.style.width = `calc(100% / ${nativeScale})`;
            root.style.height = `calc(100% / ${nativeScale})`;
            root.style.transform = nativeScale < 1 ? `scale(${nativeScale})` : '';
            document.documentElement.style.setProperty('--ui-scale-factor', String(nativeScale));
            const board = document.querySelector('.leaderboard-ui');
            const card = document.getElementById('polytrackTrackFreshness');
            card.dataset.source = state === 'error-empty' ? 'error' : 'snapshot';
            card.dataset.submittedPb = String(state === 'submitted-pb');
            card.innerHTML = html;
            // Repeated calls must not leave a stale compact layout or oscillate placement.
            window.positionTrackFreshnessBanner(card, board);
            const bottom = card.style.bottom;
            window.positionTrackFreshnessBanner(card, board);
            const rect = element => { const r = element.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
            const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
            const cardRect = rect(card), footer = board.querySelector(':scope > .button-wrapper'), pages = board.querySelector(':scope > .pages'), scroll = board.querySelector(':scope > .container');
            const style = getComputedStyle(card);
            const title = getComputedStyle(card.querySelector('strong'));
            const details = getComputedStyle(card.querySelector(':scope > span'));
            const scrollbar = rect(scroll); scrollbar.left = scrollbar.right - (scroll.offsetWidth - scroll.clientWidth) * nativeScale;
            return {
              card: cardRect, footer: rect(footer), pages: rect(pages), controls: [...footer.children].map(rect),
              viewport: {left:0,top:0,right:innerWidth,bottom:innerHeight}, nativeScale, uiScale: getComputedStyle(card).getPropertyValue('--sq-ui-scale').trim(),
              overlapsFooter: intersects(cardRect, rect(footer)), overlapsPages: intersects(cardRect, rect(pages)), overlapsScrollbar: intersects(cardRect, scrollbar),
              outsideScroll: card.parentElement === document.body && !scroll.contains(card), stableBottom: bottom === card.style.bottom,
              position: style.position, fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize), titleRatio: parseFloat(title.fontSize) / parseFloat(style.fontSize), detailRatio: parseFloat(details.fontSize) / parseFloat(style.fontSize),
              titleDirection: title.flexDirection, layout: card.dataset.layout || '', background: style.backgroundColor,
              overflow: [card, footer, ...footer.children, document.documentElement].map(node => ({className:node.className, clientWidth:node.clientWidth, scrollWidth:node.scrollWidth, clientHeight:node.clientHeight, scrollHeight:node.scrollHeight})),
              lines: [...card.children].map(rect),
            };
          }, { scale, html: bannerHtml(state), state: state.name }), 'card measurement');
          const label = `${viewport.label} ${viewport.width}x${viewport.height} UI ${scale} ${state.name}`;
          evidence.push({ label, ...result });
          if (process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR && scale === 1 && state.name === 'submitted-pb' && [384, 390, 1280].includes(viewport.width)) {
            await bounded(page.screenshot({ path: join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, `track-info-card-${viewport.width}.png`), timeout: 4000, animations: 'disabled' }), 'screenshot');
          }
          assertInside(result.card, result.viewport, `${label} card`);
          assertInside(result.footer, result.viewport, `${label} footer`);
          assertInside(result.pages, result.viewport, `${label} pagination`);
          assert.equal(result.position, 'fixed', label);
          assert.equal(result.outsideScroll, true, `${label}: body-owned sidecar`);
          assert.equal(result.overlapsFooter, false, `${label}: native footer collision`);
          assert.equal(result.overlapsPages, false, `${label}: pagination collision`);
          assert.equal(result.overlapsScrollbar, false, `${label}: scrollbar collision`);
          assert.equal(result.stableBottom, true, `${label}: repeated placement is stable`);
          assert.equal(result.uiScale, String(scale), `${label}: browser zoom is not UI scale`);
          assert.match(result.fontFamily, /ForcedSquare/, label);
          assert.ok(result.fontSize >= (viewport.height <= 320 ? 6 : 15), `${label}: font follows native scale only at extreme zoom`);
          assert.ok(Math.abs(result.titleRatio - 1.2) < 0.01 && Math.abs(result.detailRatio - 1.05) < 0.01, `${label}: proportional text`);
          if (viewport.width === 390 || result.layout === 'vertical') assert.equal(result.titleDirection, 'column', `${label}: compact title stacks`);
          assert.notEqual(result.background, 'rgba(0, 0, 0, 0)', label);
          for (const line of result.lines) assertInside(line, result.card, `${label} status line`);
          for (const overflow of result.overflow) assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, `${label}: horizontal overflow ${JSON.stringify(overflow)}`);
          assert.ok(result.overflow[0].scrollHeight <= result.overflow[0].clientHeight + 1, `${label}: card clips status text`);
          for (const control of result.controls) assertInside(control, result.footer, `${label} footer control`);
          for (let i = 0; i < result.controls.length; i++) for (let j = i + 1; j < result.controls.length; j++) {
            const a = result.controls[i], b = result.controls[j];
            assert.ok(a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1 || b.bottom <= a.top + 1, `${label}: native controls overlap`);
          }
        }
      }
    }
    for(const source of ['snapshot','mixed','cache','live','local','error']){
      const contrast=await page.locator('#polytrackTrackFreshness').evaluate((el,source)=>{
        el.dataset.source=source;
        const luminance=value=>{
          const channels=value.match(/[\d.]+/g).slice(0,3).map(Number).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
          return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
        };
        const bg=luminance(getComputedStyle(el).backgroundColor);
        return [...el.children].map(child=>{const fg=luminance(getComputedStyle(child).color);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);});
      },source);
      assert.ok(contrast.every(value=>value>=4.5),`${source} text has accessible contrast: ${contrast}`);
    }
    console.log(`Verified ${evidence.length} production-layout cases, offline and serial.`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR) fs.writeFileSync(join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR, 'track-info-card-measurements.json'), JSON.stringify(evidence, null, 2));
    try { await bounded(browser.close(), 'browser cleanup', 5000); }
    catch (error) { if (!failure) throw error; console.error(error.message); }
  }
});
