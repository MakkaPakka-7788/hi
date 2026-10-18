const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

const count = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
const millis = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function duration(value) {
  const ms = millis(value);
  if (!ms) return 'not recorded';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

function activeTime(value) {
  const seconds = Math.floor(millis(value) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainderSeconds = seconds % 60;
  return hours ? `${hours}h ${minutes % 60}m ${remainderSeconds}s`
    : minutes ? `${minutes}m ${remainderSeconds}s` : `${seconds}s`;
}

function dateLabel(value) {
  const date = new Date(millis(value));
  return Number.isFinite(date.getTime()) && date.getTime() > 0
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';
}

function resolveName(row, trackName) {
  const value = row.trackName ?? row.name ?? (typeof trackName === 'function'
    ? trackName(row.trackId)
    : trackName && typeof trackName === 'object'
      ? trackName[row.trackId]
      : trackName);
  return String(value || `Track ${String(row.trackId || '').slice(0, 8) || 'unknown'}`);
}

function previewFor(row, trackPreview) {
  if (typeof trackPreview === 'function' && row.trackId != null) {
    try {
      const markup = trackPreview(row.trackId);
      if (typeof markup === 'string' && markup.trim()) return markup;
    } catch {
      // Missing previews are normal for custom or unavailable tracks.
    }
  }
  return '<span class="pp-preview-unknown" aria-label="Track preview unavailable">?</span>';
}

function trackCard(row, trackName, trackPreview) {
  const name = resolveName(row, trackName);
  const attempts = count(row.attempts);
  const finishes = count(row.finishes);
  const best = duration(row.bestMs);
  const sincePb = millis(row.sincePbMs);
  const lastPlayed = dateLabel(row.lastPlayedAt);
  const details = [
    `${attempts} ${attempts === 1 ? 'attempt' : 'attempts'}`,
    finishes ? `${finishes} ${finishes === 1 ? 'finish' : 'finishes'}` : 'No finish yet',
    count(row.pbs) ? `${count(row.pbs)} ${count(row.pbs) === 1 ? 'PB' : 'PBs'}` : '',
    millis(row.bestMs) ? `Best ${best}` : '',
    sincePb ? `${activeTime(sincePb)} without a new PB` : '',
    count(row.restarts) ? `${count(row.restarts)} resets` : '',
    count(row.respawns) ? `${count(row.respawns)} checkpoint respawns` : '',
    lastPlayed ? `Last played ${lastPlayed}` : ''
  ].filter(Boolean);

  return `<li class="pp-track">
    <div class="pp-art" aria-hidden="true">${previewFor(row, trackPreview)}</div>
    <div class="pp-track-main"><h3>${esc(name)}</h3><p class="pp-track-data">${details.map(esc).join('<span aria-hidden="true"> · </span>')}</p>
      <p class="pp-active">${activeTime(row.activeMs)} active</p></div>
  </li>`;
}

function finishItems(rows, trackName) {
  return rows.flatMap(row => (Array.isArray(row.recentFinishes) ? row.recentFinishes : [])
    .filter(run => run && millis(run.timeMs))
    .map(run => ({ run, name: resolveName(row, trackName) })))
    .sort((a, b) => millis(b.run.at) - millis(a.run.at))
    .slice(0, 6)
    .map(({ run, name }) => `<li class="pp-finish"><span><strong>${esc(name)}</strong><small>${esc(dateLabel(run.at) || 'Date unavailable')}${millis(run.practiceMs) ? ` · ${esc(activeTime(run.practiceMs))} practice` : ''}</small></span><b>${duration(run.timeMs)}</b>${run.timingNote === true ? '<small class="pp-note">Practice and finish clocks differed on this run.</small>' : ''}</li>`)
    .join('');
}

export function renderPracticeProfile({ rows = [], coverage = null, trackName, trackPreview } = {}) {
  const safeRows = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
  const observed = safeRows.filter(row => millis(row.activeMs) || count(row.attempts) || count(row.finishes));
  const totalActive = observed.reduce((sum, row) => sum + millis(row.activeMs), 0);
  const drivenTracks = observed.length;
  const tracks = [...observed]
    .sort((a, b) => millis(b.lastPlayedAt) - millis(a.lastPlayedAt) || millis(b.activeMs) - millis(a.activeMs))
    .slice(0, 8);
  const finishes = finishItems(observed, trackName);
  const coverageText = Number.isFinite(coverage?.coverageFraction)
    ? `${Math.round(Math.max(0, Math.min(1, coverage.coverageFraction)) * 100)}% visible-time coverage`
    : '';
  const trackMarkup = tracks.map(row => trackCard(row, trackName, trackPreview)).join('');

  return `<details class="polytrack-practice-profile">
  <summary class="pp-heading"><span class="pp-heading-copy"><strong>Practice history</strong><small>Local driving record</small></span><span class="pp-caret" aria-hidden="true"></span></summary>
  <div class="pp-content">
    ${tracks.length?`<div class="pp-summary" aria-label="Practice summary"><span><small>ACTIVE TIME</small><strong>${activeTime(totalActive)}</strong></span><span><small>TRACKS DRIVEN</small><strong>${drivenTracks}</strong></span>${coverageText ? `<small class="pp-coverage">${esc(coverageText)}</small>` : ''}</div>`:''}
    ${tracks.length ? `<section class="pp-tracks" aria-labelledby="pp-tracks-title"><h2 id="pp-tracks-title">Recent practice</h2><ul>${trackMarkup}</ul></section>` : '<p class="pp-empty">Drive a track to start building your practice history.</p>'}
    ${finishes ? `<details class="pp-finishes"><summary>Recent finishes <span>${Math.min(6, observed.reduce((sum, row) => sum + (Array.isArray(row.recentFinishes) ? row.recentFinishes.filter(run => run && millis(run.timeMs)).length : 0), 0))}</span></summary><ul>${finishes}</ul></details>` : ''}
    <details class="pp-manage"><summary>Manage local history</summary><p>Removes this racer's practice observations from this device. Personal bests and saved tracks are not changed.</p><button type="button" data-clear-practice-history>Clear practice history</button></details>
  </div>
</details>`;
}
