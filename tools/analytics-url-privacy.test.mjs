import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const gameSource = readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const analyticsBlock = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .find(source => source.includes('window.dataLayer = window.dataLayer || [];'));
assert.ok(analyticsBlock, 'inline analytics bootstrap exists');

function runAnalytics(pageHref, referrer) {
  const queue = [];
  const location = new URL(pageHref);
  const context = { window: { dataLayer: queue }, dataLayer: queue, location, document: { referrer }, URL, Date };
  vm.runInNewContext(analyticsBlock, context, { filename: 'index.html analytics bootstrap' });
  const config = queue.map(args => Array.from(args)).find(([command]) => command === 'config');
  assert.ok(config, 'GA config command exists');
  return { config: config[2], location };
}

test('pageview config explicitly sends only origin and pathname for both URL fields', () => {
  const { config, location } = runAnalytics(
    'https://game.example/play?userToken=fixture-secret&track=7#private-fragment',
    'https://source.example/entry?campaign=private#source-fragment'
  );
  assert.equal(config.page_location, 'https://game.example/play');
  assert.equal(config.page_referrer, 'https://source.example/entry');
  assert.deepEqual(Object.keys(config).sort(), ['cookie_domain', 'page_location', 'page_referrer']);
  assert.equal(location.search, '?userToken=fixture-secret&track=7');
  assert.equal(location.hash, '#private-fragment');
  assert.equal(JSON.stringify(config).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(config).includes('campaign=private'), false);
  assert.equal(JSON.stringify(config).includes('private-fragment'), false);
});

test('empty or non-HTTP referrers do not fall back to an unsanitized browser URL', () => {
  const empty = runAnalytics('https://game.example/play?userToken=fixture-secret', '');
  assert.equal(empty.config.page_location, 'https://game.example/play');
  assert.equal(empty.config.page_referrer, '');
  const unsafe = runAnalytics('https://game.example/play?userToken=fixture-secret', 'javascript:alert(1)');
  assert.equal(unsafe.config.page_referrer, '');
});

test('analytics configuration does not consume or rewrite the game URL token', () => {
  const { location } = runAnalytics('https://game.example/play?userToken=game-token-fixture', '');
  assert.equal(location.searchParams.get('userToken'), 'game-token-fixture');
  assert.match(gameSource, /searchParams\.get\(['"]userToken['"]\)/);
  assert.doesNotMatch(analyticsBlock, /history\.replaceState|searchParams\.delete/);
});
