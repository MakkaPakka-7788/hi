import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {decodeSnapshot, MAX_FILE_BYTES} from '../snapshot-package.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const ACCOUNT_ID = /^[a-f0-9]{64}$/;
const REPLAY_SHA = /^[a-f0-9]{64}$/;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function resultKey(kind, logicalPath) { return `${kind}-${sha256(logicalPath).slice(0, 32)}`; }

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readInput(file, remainingBytes) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > remainingBytes) throw Error('Audit summary input exceeds the 16 MiB read budget');
  return fs.readFile(file);
}

function renderSummary(state, targetRows, targets, snapshotInfo = null) {
  const pair = state.comparison || {};
  const results = Object.values(state.nativeResults || {});
  const physics = {verified: 0, mismatch: 0, unavailable: 0};
  for (const result of results) if (Object.hasOwn(physics, result?.status)) physics[result.status]++;
  const lines = [
    '# Private Snapshot Audit Progress', '',
    'This is read-only advisory reporting. It is not a cheating verdict, does not change publication state, and must not be used as automatic enforcement.', '',
    `- Snapshot generation: ${state.manifest?.generation || 'unknown'}`,
    `- Pinned engine digest: ${state.manifest?.engineDigest || 'unknown'}`,
    `- Pair pass: ${pair.done ? 'complete' : 'in progress'}`,
    `- Tracks compared: ${pair.tracksDone ?? 0}${Number.isSafeInteger(pair.trackCount) ? ` / ${pair.trackCount}` : ''}`,
    `- Same-track pairs compared: ${pair.totalPairs ?? 0}`,
    `- Exact input pairs: ${pair.exactPairs ?? 0}`,
    `- Informative cross-account exact pairs (advisory only): ${pair.actionableCrossAccountExactPairs ?? 'not available in this checkpoint'}`,
    `- Low-information exact pairs (not flagged): ${pair.lowInformationExactPairs ?? 0}`,
    `- Pair records skipped for invalid inputs: ${pair.comparisonsSkippedInputInvalid ?? 'unknown'}`,
    `- Native results stored: ${results.length} of an expected total not persisted in this checkpoint`,
    `- Native results: ${physics.verified} verified, ${physics.mismatch} mismatch, ${physics.unavailable} unavailable`,
    `- Native batches completed: ${state.nativeBatches ?? 0}`,
    ...(snapshotInfo ? [`- Local snapshot payload bytes inspected for account run mapping: ${snapshotInfo.payloadBytesRead}`,
      '- Per-account run lists cover this snapshot generation only; they do not establish all-time account activity.'] : []),
    '',
    '## Requested Accounts', ''
  ];
  for (const target of targets) {
    const evidence = targetRows.get(target.id) || [];
    const exact = evidence.filter(row => row.exactInput);
    const actionable = exact.filter(row => row.actionable === true && row.informative === true && row.sameAccount === false);
    const account = snapshotInfo?.accounts.get(target.id);
    const runs = account?.runs || [];
    const runCounts = {verified: 0, mismatch: 0, unavailable: 0, unprocessed: 0};
    for (const run of runs) runCounts[run.status]++;
    const uniqueActionable = new Map();
    for (const row of actionable) {
      const own = row.left.accountId === target.id ? row.left : row.right;
      const other = row.left.accountId === target.id ? row.right : row.left;
      const key = [row.trackId, own.timeMs, own.replayHash || own.source, other.accountId,
        other.replayHash || other.source].join('|');
      if (!uniqueActionable.has(key)) uniqueActionable.set(key, {row, own, other});
    }
    lines.push(`### ${target.label}`, '', `Account ID: \`${target.id}\``,
      ...(account?.publicName ? [`Snapshot public name: ${account.publicName}`] : []),
      `- Pair-file matches: ${evidence.length}`,
      `- Exact-input matches: ${exact.length}`,
      `- Informative cross-account exact matches (unique replay pairs): ${uniqueActionable.size}`,
      `- Actionable pair rows: ${actionable.length}${actionable.length > uniqueActionable.size ? ` (${actionable.length - uniqueActionable.size} duplicate-source rows)` : ''}`,
      `- Locally captured normal/event runs: ${runs.length} (${runCounts.verified} verified, ${runCounts.mismatch} mismatch, ${runCounts.unavailable} unavailable, ${runCounts.unprocessed} not yet processed)`);
    if (snapshotInfo) {
      for (const run of runs) lines.push(`- ${run.kind} ${run.status}: track \`${run.trackId}\`, ${run.kind === 'normal' ? `${run.timeMs} recorded frames` : `${run.timeMs} ms`}, source \`${run.source}\`${run.replayHash ? `, replay \`${run.replayHash}\`` : ''}.`);
      if (account?.coverageNote) lines.push(`- Snapshot coverage: ${account.coverageNote}`);
    } else lines.push('- Per-run listing unavailable because no local snapshot root was supplied.');
    if (!pair.done) lines.push('- Coverage note: pair scan is incomplete; absence of a listed match is not evidence of absence.');
    if (!actionable.length) lines.push('- No actionable exact-match evidence for this account is present in the currently checkpointed findings.');
    for (const {row, own, other} of [...uniqueActionable.values()].slice(0, 100)) {
      lines.push(`- Advisory exact match: track \`${row.trackId}\`, counterpart \`${other.accountId}\`, time ${own.timeMs} ms, source \`${own.source || 'unknown'}\` versus \`${other.source || 'unknown'}\`, replay hashes \`${own.replayHash || 'unknown'}\` / \`${other.replayHash || 'unknown'}\`.`);
    }
    if (uniqueActionable.size > 100) lines.push(`- ${uniqueActionable.size - 100} additional unique replay pairs omitted from this readable summary.`);
    lines.push('');
  }
  lines.push('## Interpretation', '',
    '- An exact match is an input-pattern signal, not proof of coordinated cheating or account control.',
    '- Same-account normal/event duplicate pairs are counted in the global pair totals and are not actionable cross-account evidence.',
    '- Near-similar pairs are not included as findings in this summary.',
    '- Native status counts cover only saved result rows. Unprocessed snapshot records are not assumed verified.', '');
  return lines.join('\n');
}

async function loadAccountRuns(snapshotRoot, state, targets) {
  const root = path.resolve(snapshotRoot), generation = path.basename(root);
  if (generation !== state.manifest.generation) throw Error('Local snapshot generation does not match audit checkpoint');
  const pointerPath = path.join(path.dirname(root), 'snapshot-current.json');
  const pointerBytes = await fs.readFile(pointerPath);
  if (sha256(pointerBytes) !== state.manifest.pointerSha256) throw Error('Local snapshot pointer does not match audit checkpoint');
  const indexBytes = await fs.readFile(path.join(root, 'index.json'));
  if (sha256(indexBytes) !== state.manifest.indexSha256) throw Error('Local snapshot index does not match audit checkpoint');
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (index.generation !== Number(generation.replace('public-snapshots', '')) || !index.files || typeof index.files !== 'object') {
    throw Error('Invalid local snapshot index');
  }
  const accounts = new Map(targets.map(target => [target.id, {runs: [], publicName: null, coverageNote: null}]));
  let bytesRead = 0;
  async function read(logical) {
    const item = index.files[logical];
    if (!item || !REPLAY_SHA.test(item.sha256 || '') || item.path !== `${item.sha256}.bin` ||
        !Number.isSafeInteger(item.decodedBytes) || item.decodedBytes < 0 || item.decodedBytes > 2 * 1024 * 1024) return null;
    const file = path.resolve(root, item.path);
    if (path.dirname(file) !== root) throw Error('Snapshot payload path escapes generation');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || bytesRead + stat.size > MAX_SNAPSHOT_BYTES) {
      throw Error('Local snapshot scan exceeds its 64 MiB safety bound or contains invalid payload');
    }
    bytesRead += stat.size;
    const encoded = await fs.readFile(file);
    if (sha256(encoded) !== item.sha256) throw Error(`Snapshot payload hash mismatch: ${logical}`);
    const decoded = Buffer.from(await decodeSnapshot(encoded));
    if (decoded.length !== item.decodedBytes) throw Error(`Snapshot decoded size mismatch: ${logical}`);
    return JSON.parse(decoded.toString('utf8'));
  }

  for (const target of targets) {
    const profile = await read(`profile-results/${target.id}.json`);
    if (profile?.accountId === target.id && profile.publicProfile?.accountId === target.id) {
      accounts.get(target.id).publicName = String(profile.publicProfile.name || profile.publicProfile.nickname || '').slice(0, 100) || null;
      if (profile.coverage?.allTracksCaptured === false) accounts.get(target.id).coverageNote =
        `profile reports partial coverage (${profile.coverage.boardsPresent ?? '?'} of ${profile.coverage.boardsKnown ?? '?'} boards)`;
    }
  }

  for (const logical of Object.keys(index.files).filter(file => file.startsWith('recordings/'))) {
    const recording = await read(logical);
    if (!recording || !accounts.has(recording.accountId)) continue;
    const name = /^recordings\/(\d+)\.json$/.exec(logical);
    if (!name || !REPLAY_SHA.test(recording.trackId || '') || !Number.isSafeInteger(recording.frames) || recording.frames <= 0 ||
        !REPLAY_SHA.test(recording.replayHash || '') || typeof recording.recording !== 'string' || sha256(recording.recording) !== recording.replayHash ||
        recording.uploadId != null && String(recording.uploadId) !== name[1]) throw Error(`Invalid normal recording binding: ${logical}`);
    const id = resultKey('normal', logical), status = state.nativeResults[id]?.status || 'unprocessed';
    accounts.get(recording.accountId).runs.push({kind: 'normal', status, source: logical,
      trackId: recording.trackId, timeMs: recording.frames, replayHash: recording.replayHash});
  }
  const eventBoards = new Map();
  for (const logical of Object.keys(index.files).filter(file => file.startsWith('event-replays/'))) {
    const match = /^event-replays\/([^/]+)\/([a-f0-9]{64})\.json$/.exec(logical);
    if (!match || !accounts.has(match[2])) continue;
    const event = await read(logical);
    if (!event || event.accountId !== match[2] || event.periodId !== match[1] || !REPLAY_SHA.test(event.runId || '') || typeof event.replay !== 'string' ||
        !REPLAY_SHA.test(event.replayHash || '') || sha256(event.replay) !== event.replayHash || !REPLAY_SHA.test(event.trackId || '') ||
        !Number.isSafeInteger(event.timeMs) || event.timeMs <= 0) throw Error(`Invalid event replay binding: ${logical}`);
    if (!eventBoards.has(match[1])) eventBoards.set(match[1], await read(`events/${match[1]}.json`));
    const board = eventBoards.get(match[1]);
    if (board?.id !== match[1] || board?.period?.id !== match[1] || board.period.trackId !== event.trackId ||
        !Array.isArray(board.entries) || !board.entries.some(entry => entry.accountId === event.accountId && entry.timeMs === event.timeMs)) {
      throw Error(`Event replay does not bind to its local event board: ${logical}`);
    }
    const id = resultKey('event', logical), status = state.nativeResults[id]?.status || 'unprocessed';
    accounts.get(event.accountId).runs.push({kind: 'event', status, source: logical,
      trackId: event.trackId, timeMs: event.timeMs, replayHash: event.replayHash});
  }
  for (const account of accounts.values()) account.runs.sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source));
  return {accounts, generation, payloadBytesRead: bytesRead};
}

export async function writeAuditProgressSummary({stateFile, pairsFile, outputFile, targets = [], snapshotRoot = null, repositoryRoot = DEFAULT_ROOT} = {}) {
  for (const file of [stateFile, pairsFile, outputFile]) if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw Error('State, findings, and output paths must be absolute');
  }
  if (!Array.isArray(targets) || targets.some(target => typeof target?.label !== 'string' || !target.label.trim() || !ACCOUNT_ID.test(target.id || '')) ||
      new Set(targets.map(target => target.id)).size !== targets.length) throw Error('Targets must have unique account IDs and valid labels');
  const repo = await fs.realpath(repositoryRoot);
  const outputParent = await fs.realpath(path.dirname(outputFile));
  const resolvedOutput = path.join(outputParent, path.basename(outputFile));
  if (within(repo, resolvedOutput)) throw Error('Summary output must be outside the Git repository');
  const statePath = path.resolve(stateFile), pairsPath = path.resolve(pairsFile);
  let remainingBytes = MAX_INPUT_BYTES;
  const stateBytes = await readInput(statePath, remainingBytes); remainingBytes -= stateBytes.length;
  const pairBytes = await readInput(pairsPath, remainingBytes);
  const state = JSON.parse(stateBytes.toString('utf8'));
  if (state.schema !== 'polytrack-snapshot-audit-v1' || !state.manifest || !state.comparison ||
      !state.nativeResults || typeof state.nativeResults !== 'object') throw Error('Invalid audit checkpoint');
  const findingsFile = state.findingsFile && path.resolve(state.findingsFile);
  if (findingsFile !== pairsPath) throw Error('Findings path does not match the checkpoint');
  const snapshotInfo = snapshotRoot ? await loadAccountRuns(snapshotRoot, state, targets) : null;
  const rowsByAccount = new Map(targets.map(target => [target.id, []]));
  for (const line of pairBytes.toString('utf8').split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw Error('Findings file has an incomplete or invalid JSONL record'); }
    for (const id of new Set([row?.left?.accountId, row?.right?.accountId])) if (rowsByAccount.has(id)) rowsByAccount.get(id).push(row);
  }
  const summary = renderSummary(state, rowsByAccount, targets, snapshotInfo);
  const handle = await fs.open(resolvedOutput, 'wx', 0o600);
  try { await handle.writeFile(summary); await handle.sync(); }
  finally { await handle.close(); }
  return {outputFile: resolvedOutput, bytes: Buffer.byteLength(summary), targets: targets.length,
    nativeResults: Object.keys(state.nativeResults).length, pairPassComplete: state.comparison.done === true,
    snapshotRuns: snapshotInfo ? [...snapshotInfo.accounts.values()].reduce((sum, account) => sum + account.runs.length, 0) : null,
    snapshotBytesRead: snapshotInfo?.payloadBytesRead ?? 0};
}

function parseArgs(args) {
  const options = {targets: []};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value) throw Error('Missing option value');
    if (flag === '--state') options.stateFile = value;
    else if (flag === '--pairs') options.pairsFile = value;
    else if (flag === '--output') options.outputFile = value;
    else if (flag === '--snapshot-root') options.snapshotRoot = value;
    else if (flag === '--target') {
      const split = value.lastIndexOf('=');
      if (split < 1) throw Error('Target must be Label=accountId');
      options.targets.push({label: value.slice(0, split), id: value.slice(split + 1)});
    } else throw Error('Usage: node snapshot-audit-summary.mjs --state <file> --pairs <file> --output <private-md> [--target Label=accountId]');
  }
  if (!options.stateFile || !options.pairsFile || !options.outputFile) throw Error('Usage: node snapshot-audit-summary.mjs --state <file> --pairs <file> --output <private-md> [--snapshot-root <generation-dir>] [--target Label=accountId]');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeAuditProgressSummary(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(String(error?.message || error)); process.exitCode = 1;
  });
}
