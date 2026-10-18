import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPracticeProfile } from './practice-profile.mjs';

const row = (overrides = {}) => ({
  trackId: 'track-a', trackName: 'Summer Run', activeMs: 125000, attempts: 7,
  finishes: 3, pbs: 1, bestMs: 47250, sincePbMs: 61000,
  lastPlayedAt: Date.UTC(2026, 9, 17), ...overrides
});

test('renders compact summary and per-track useful data with trusted preview markup', () => {
  const html = renderPracticeProfile({ rows: [row()], trackPreview: id => `<img src="/thumb/${id}.png" alt="">` });
  assert.match(html, /ACTIVE TIME/);
  assert.match(html, /2m/);
  assert.match(html, /TRACKS DRIVEN/);
  assert.match(html, /7 attempts/);
  assert.match(html, /3 finishes/);
  assert.match(html, /1 PB/);
  assert.match(html, /47\.25s/);
  assert.match(html, /1m 1s without a new PB/);
  assert.match(html, /Last played [^<]*2026/);
  assert.match(html, /<img src="\/thumb\/track-a\.png" alt="">/);
  assert.doesNotMatch(html, />PT</);
});

test('escapes names and uses fallback art if callback fails or returns no markup', () => {
  const html = renderPracticeProfile({ rows: [row({ trackName: '<img src=x onerror=1>' })], trackPreview: () => '<script>bad()</script>' });
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /<script>bad\(\)<\/script>/);
  const fallback = renderPracticeProfile({ rows: [row()], trackPreview: () => '' });
  assert.match(fallback, /pp-preview-unknown/);
});

test('does not render recent finishes section when there are none', () => {
  const html = renderPracticeProfile({ rows: [row()] });
  assert.doesNotMatch(html, /pp-finishes/);
  assert.doesNotMatch(html, /Recent finishes/);
});

test('shows recent finishes only when known and keeps optional timing note escaped', () => {
  const html = renderPracticeProfile({ rows: [row({ recentFinishes: [{ at: Date.UTC(2026, 9, 18), timeMs: 48123, practiceMs: 92000, timingNote: true }] })] });
  assert.match(html, /Recent finishes/);
  assert.match(html, /48\.12s/);
  assert.match(html, /1m 32s practice/);
  assert.match(html, /clocks differed/);
});

test('caps useful track rows at eight and excludes non-observations', () => {
  const rows = Array.from({ length: 12 }, (_, i) => row({ trackId: `t${i}`, trackName: `Track ${i}`, lastPlayedAt: i + 1 }));
  rows.push({ trackId: 'empty', trackName: 'Empty', activeMs: 0, attempts: 0, finishes: 0 });
  const html = renderPracticeProfile({ rows });
  assert.equal((html.match(/class="pp-track"/g) || []).length, 8);
  assert.doesNotMatch(html, /Empty/);
});

test('renders a single compact instruction for no meaningful observations', () => {
  const html = renderPracticeProfile({ rows: [row({ activeMs: 0, attempts: 0, finishes: 0, bestMs: 0 })] });
  assert.match(html, /Drive a track to start building your practice history/);
  assert.doesNotMatch(html, /pp-tracks/);
});

test('keeps clear-history action available in accessible native details', () => {
  const html = renderPracticeProfile();
  assert.match(html, /<details class="pp-manage">/);
  assert.match(html, /<button type="button" data-clear-practice-history>/);
  assert.match(html, /Manage local history/);
});
