const finite = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const positiveInt = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const cleanText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const numbers = ['activeMs', 'simulatedMs', 'sincePbMs', 'attempts', 'finishes', 'pbs', 'restarts', 'respawns', 'lastPlayedAt', 'lastPbAt', 'trackingStartedAt', 'legacyActiveMs', 'furthestCheckpoint', 'bestMs', 'improvedMs'];
const resultNumbers = ['timeMs', 'rank', 'fieldSize', 'weight', 'cachedAt', 'snapshotCapturedAt'];
const settingNames = new Set(['music', 'sound', 'showFps', 'showGhost', 'cameraShake', 'sensitivity', 'volume', 'fov', 'renderDistance', 'resolutionScale', 'graphics', 'shadows', 'antialiasing', 'uiTextScale', 'compactTrackPanel', 'plannerCurrentOnly', 'plannerOfficialOnly']);
const insightSources = ['planner', 'profile', 'leaderboard', 'event', 'selection', 'unknown'];

const selectNumbers = (row, fields) => Object.fromEntries(fields.map(key => [key, finite(row?.[key])]));
const sanitizeResult = row => ({
 trackId: hash(row?.trackId) ? row.trackId : '',
 ...Object.fromEntries(resultNumbers.map(key => [key, key === 'rank' || key === 'fieldSize' ? positiveInt(row?.[key]) : key === 'weight' ? (typeof row?.weight === 'number' && Number.isFinite(row.weight) ? row.weight : null) : finite(row?.[key])])),
 runVerified: typeof row?.runVerified === 'boolean' ? row.runVerified : null,
 integrityVerified: typeof row?.integrityVerified === 'boolean' ? row.integrityVerified : null,
 local: row?.local === true,
 placementKnown: positiveInt(row?.rank) !== null && positiveInt(row?.fieldSize) !== null && Number(row.fieldSize) >= Number(row.rank)
});

function sanitizeInsights(insights) {
 if (!insights || insights.version !== 1) return null;
 const revisions = Array.isArray(insights.revisions) ? insights.revisions.slice(-32).filter(row => Number.isSafeInteger(row?.revision) && row.revision >= 0).map(row => ({ revision: row.revision, firstAt: finite(row.firstAt), lastAt: finite(row.lastAt), visits: finite(row.visits), visibleMs: finite(row.visibleMs) })) : [];
 const tracks = {};
 for (const [id, row] of Object.entries(insights.tracks || {}).filter(([id]) => hash(id)).slice(0, 256)) tracks[id] = { plays: finite(row?.plays), lastAt: finite(row?.lastAt), sources: Object.fromEntries(insightSources.map(source => [source, finite(row?.sources?.[source])])) };
 const transitions = {};
 for (const [key, count] of Object.entries(insights.transitions || {}).filter(([key]) => /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key)).slice(0, 512)) transitions[key] = finite(count);
 const metrics = {};
 for (const [key, row] of Object.entries(insights.metrics || {}).filter(([key]) => /^[A-Z0-9_-]{1,32}$/.test(key)).slice(0, 32)) metrics[key] = { count: finite(row?.count), totalMs: finite(row?.totalMs), maxMs: finite(row?.maxMs), over5s: finite(row?.over5s), averageMs: finite(row?.averageMs), over5sPercent: finite(row?.over5sPercent) };
 const actions = Object.fromEntries(Object.entries(insights.actions || {}).filter(([key]) => /^[a-z-]{1,32}$/.test(key)).slice(0, 32).map(([key, value]) => [key, finite(value)]));
 return { version: 1, scope: 'This browser device; navigation and version observations may span local racer profiles', startedAt: finite(insights.startedAt), revisions, tracks, transitions, metrics, actions };
}

function summarizePractice(practice) {
 const rows = Array.isArray(practice) ? practice.slice(0, 256) : [];
 return {
  activeMs: rows.reduce((sum, row) => sum + finite(row.activeMs), 0),
  starts: rows.reduce((sum, row) => sum + finite(row.attempts), 0),
  finishes: rows.reduce((sum, row) => sum + finite(row.finishes), 0),
  resets: rows.reduce((sum, row) => sum + finite(row.restarts) + finite(row.respawns), 0),
  tracksNeverFinished: rows.filter(row => finite(row.attempts) > 0 && finite(row.finishes) === 0).length,
  timingNotes: rows.reduce((sum, row) => sum + (Array.isArray(row.recentFinishes) ? row.recentFinishes.filter(run => run?.timingNote === true).length : 0), 0)
 };
}

export function buildDeveloperReport({ practice = [], coverage = null, finishes = [], localResults = [], snapshot = {}, events = [], viewport = {}, publicId = '', includePublicId = false, clientRevision = 156, insights = null, extraTracks = [], settings = null } = {}) {
 const rows = Array.isArray(practice) ? practice.slice(0, 256) : [];
 const localRows = Array.isArray(localResults) ? localResults : [];
 const trackRows = Array.isArray(extraTracks) ? extraTracks : [];
 const sanitizedSettings = settings && typeof settings === 'object' ? Object.fromEntries(Object.entries(settings).filter(([key]) => settingNames.has(key)).filter(([, value]) => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))).slice(0, settingNames.size)) : null;
 return {
  schema: 'polytrack-developer-diagnostics-v1', revision: finite(clientRevision), diagnosticsRevision: 156, exportedAt: new Date().toISOString(),
  privacy: { automaticUpload: false, includesPublicId: includePublicId === true && hash(publicId), limitations: 'Client observations are incomplete and untrusted. Timing notes are not cheating verdicts. Request events are not billed Firebase operations.' },
  ...(includePublicId && hash(publicId) ? { publicRacerId: publicId } : {}),
  snapshot: { generation: finite(snapshot.generation), capturedAt: finite(snapshot.capturedAt) },
  viewport: selectNumbers(viewport, ['width', 'height', 'pixelRatio']),
  practiceCoverage: coverage ? { version: 2, scope: 'Known reported/device visible-time estimate, not full historical driving coverage', ...selectNumbers(coverage, ['startedAt', 'baselinePlaytimeMs', 'knownPlaytimeMs', 'observedVisibleMs', 'coverageFraction']) } : null,
  practice: rows.map(row => ({ trackId: hash(row.trackId) ? row.trackId : '', trackName: cleanText(row.trackName), ...selectNumbers(row, numbers), resetTimingBuckets: Array.from({ length: 4 }, (_, i) => finite(row.restartBuckets?.[i])), recentFinishes: (Array.isArray(row.recentFinishes) ? row.recentFinishes : []).slice(-8).map(run => ({ ...selectNumbers(run, ['at', 'timeMs', 'practiceMs']), timingNote: run.timingNote === true })) })),
  loadedResults: (Array.isArray(finishes) ? finishes : []).slice(0, 256).map(sanitizeResult),
  localResults: localRows.slice(0, 5000).map(sanitizeResult),
  insights: sanitizeInsights(insights),
  extraTracks: trackRows.slice(0, 5000).map(row => ({ trackId: cleanText(row?.trackId ?? row?.id), name: cleanText(row?.name), author: cleanText(row?.author) })),
  truncation: {
   localResults: { omitted: Math.max(0, localRows.length - 5000) },
   extraTracks: { omitted: Math.max(0, trackRows.length - 5000) }
  },
  settings: sanitizedSettings,
  practiceSummary: summarizePractice(rows),
  recentEvents: (Array.isArray(events) ? events : []).slice(-80).map(row => ({ category: /^[a-z-]{1,32}$/.test(row?.category) ? row.category : 'application', code: /^[A-Z0-9_-]{1,32}$/.test(row?.code) ? row.code : 'EVENT', durationMs: finite(row?.durationMs), status: finite(row?.status) }))
 };
}

export function openDiagnostics({ report, returnFocus = document.activeElement } = {}) {
 document.getElementById('polytrackDeveloperDialog')?.remove();
 const dialog = document.createElement('dialog'); dialog.id = 'polytrackDeveloperDialog'; dialog.className = 'sq-developer-dialog';
 dialog.innerHTML = '<header><h2>Export developer diagnostics</h2><button type="button" data-close aria-label="Close developer diagnostics">Close</button></header><main><p>Copy or download a JSON report to share with a developer. Nothing is uploaded automatically.</p><label><input type="checkbox" data-public-id> Include my public racer ID</label><details><summary>What is included?</summary><p>Local practice, PB summaries, loaded track metadata, navigation counts, loading timings, errors and first-observed versions. No automatic upload, login tokens, passwords, connection codes, raw replays or unrelated browser storage. Client data is not proof of fair play.</p></details><p role="status" aria-live="polite" data-status></p></main><footer><button type="button" data-download>Download JSON</button><button type="button" data-copy>Copy JSON</button></footer>';
 const status = dialog.querySelector('[data-status]');
 const makeJson = () => JSON.stringify(report(dialog.querySelector('[data-public-id]').checked), null, 2);
 dialog.querySelector('[data-public-id]').addEventListener('change',()=>{const button=dialog.querySelector('[data-copy]');button.classList.remove('is-success');button.textContent='Copy JSON';status.textContent='';});
 const close = () => dialog.close();
 dialog.querySelector('[data-close]').addEventListener('click', close);
 dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true }); });
 dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
 dialog.querySelector('[data-copy]').addEventListener('click', async event => {
  const button = event.currentTarget; button.classList.remove('is-success');
  try { await navigator.clipboard.writeText(makeJson()); button.classList.add('is-success'); button.textContent = 'Copied'; status.textContent = 'Copied. Review the JSON before sharing.'; }
  catch { button.textContent = 'Copy JSON'; status.textContent = 'Copy failed. Use Download JSON instead.'; }
 });
 dialog.querySelector('[data-download]').addEventListener('click', () => {
  try { const blob = new Blob([makeJson()], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'polytrack-developer-report-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); status.textContent = 'Downloaded. Review the JSON before sharing.'; }
  catch { status.textContent = 'Download failed. Try Copy JSON instead.'; }
 });
 document.body.append(dialog); dialog.showModal();
}

export function openClearPracticeConfirmation({ onConfirm, returnFocus = document.activeElement } = {}) {
 document.getElementById('polytrackClearPracticeDialog')?.remove();
 const dialog = document.createElement('dialog'); dialog.id = 'polytrackClearPracticeDialog'; dialog.className = 'sq-developer-dialog';
 dialog.innerHTML = '<form method="dialog"><header><h2>Clear practice history?</h2><button type="button" data-close aria-label="Close clear practice confirmation">Close</button></header><main><p>This permanently clears local practice history. Type CLEAR to enable confirmation.</p><label for="polytrackClearPracticeInput">Type CLEAR</label><input id="polytrackClearPracticeInput" data-confirmation autocomplete="off"><p role="status" aria-live="polite" data-status></p></main><footer><button type="button" data-cancel>Cancel</button><button type="submit" data-confirm disabled>Clear practice</button></footer></form>';
 const input = dialog.querySelector('[data-confirmation]'), confirm = dialog.querySelector('[data-confirm]'), status = dialog.querySelector('[data-status]');
 const dismiss = () => dialog.close();
 input.addEventListener('input', () => { confirm.disabled = input.value !== 'CLEAR'; status.textContent = confirm.disabled ? 'Confirmation remains disabled until CLEAR is entered exactly.' : ''; });
 dialog.querySelector('[data-close]').addEventListener('click', dismiss); dialog.querySelector('[data-cancel]').addEventListener('click', dismiss);
 dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); if (input.value !== 'CLEAR') { confirm.disabled = true; status.textContent = 'Type CLEAR exactly to continue.'; return; } try { onConfirm?.(); status.textContent = 'Practice history cleared.'; dialog.close(); } catch { status.textContent = 'Could not clear practice history. No changes were confirmed.'; } });
 dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
 dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true }); });
 document.body.append(dialog); dialog.showModal(); input.focus();
}
