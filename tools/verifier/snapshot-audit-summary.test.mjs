import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {encodeSnapshot} from '../snapshot-package.mjs';
import {writeAuditProgressSummary} from './snapshot-audit-summary.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), TRACK = 'c'.repeat(64);

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-audit-summary-'));
  const repo = path.join(dir, 'repo'), privateDir = path.join(dir, 'private');
  await fs.mkdir(repo); await fs.mkdir(privateDir);
  const stateFile = path.join(privateDir, 'state.json'), pairsFile = path.join(privateDir, 'pairs.jsonl');
  const state = {schema: 'polytrack-snapshot-audit-v1', manifest: {generation: 'public-snapshots19', engineDigest: 'd'.repeat(64)},
    comparison: {done: true, tracksDone: 133, trackCount: 133, totalPairs: 132268, exactPairs: 9,
      actionableCrossAccountExactPairs: 2, lowInformationExactPairs: 3, comparisonsSkippedInputInvalid: 0},
    nativeBatches: 1, nativeResults: {x: {status: 'verified'}}};
  const pairs = [
    {trackId: TRACK, exactInput: true, informative: true, actionable: true, sameAccount: false,
      left: {accountId: A, timeMs: 5000, source: 'recordings/1.json', replayHash: 'd'.repeat(64)},
      right: {accountId: B, timeMs: 5000, source: 'recordings/2.json', replayHash: 'd'.repeat(64)}},
    {trackId: TRACK, exactInput: true, informative: true, actionable: true, sameAccount: false,
      left: {accountId: A, timeMs: 5000, source: 'event-replays/period/a.json', replayHash: 'd'.repeat(64)},
      right: {accountId: B, timeMs: 5000, source: 'recordings/2.json', replayHash: 'd'.repeat(64)}},
    {trackId: TRACK, exactInput: true, informative: true, actionable: false, sameAccount: true,
      left: {accountId: A, timeMs: 5000}, right: {accountId: A, timeMs: 5000}}
  ];
  state.findingsFile = pairsFile;
  await fs.writeFile(stateFile, JSON.stringify(state));
  await fs.writeFile(pairsFile, pairs.map(row => JSON.stringify(row)).join('\n') + '\n');
  return {dir, repo, privateDir, stateFile, pairsFile};
}

test('summary reads only checkpoint and bounded findings, and treats exact matches as advisory', async () => {
  const item = await fixture();
  try {
    const outputFile = path.join(item.privateDir, 'summary.md');
    const result = await writeAuditProgressSummary({stateFile: item.stateFile, pairsFile: item.pairsFile,
      outputFile, repositoryRoot: item.repo, targets: [{label: 'Target one', id: A}, {label: 'Target two', id: B}]});
    const text = await fs.readFile(outputFile, 'utf8');
    assert.equal(result.pairPassComplete, true);
    assert.match(text, /132268/);
    assert.match(text, /Native results stored: 1 of an expected total not persisted/);
    assert.match(text, /Informative cross-account exact matches \(unique replay pairs\): 1/);
    assert.match(text, /Actionable pair rows: 2 \(1 duplicate-source rows\)/);
    assert.match(text, /Same-account normal\/event duplicate pairs are counted/);
    assert.match(text, /not proof of coordinated cheating/);
    await assert.rejects(writeAuditProgressSummary({stateFile: item.stateFile, pairsFile: item.pairsFile,
      outputFile, repositoryRoot: item.repo, targets: [{label: 'Target one', id: A}]}));
  } finally { await fs.rm(item.dir, {recursive: true, force: true}); }
});

test('summary rejects repository output, mismatched findings, invalid targets, and oversized inputs', async () => {
  const item = await fixture();
  try {
    await assert.rejects(writeAuditProgressSummary({stateFile: item.stateFile, pairsFile: item.pairsFile,
      outputFile: path.join(item.repo, 'summary.md'), repositoryRoot: item.repo}), /outside the Git repository/);
    await assert.rejects(writeAuditProgressSummary({stateFile: item.stateFile, pairsFile: path.join(item.privateDir, 'other.jsonl'),
      outputFile: path.join(item.privateDir, 'other.md'), repositoryRoot: item.repo}), /ENOENT/);
    await assert.rejects(writeAuditProgressSummary({stateFile: item.stateFile, pairsFile: item.pairsFile,
      outputFile: path.join(item.privateDir, 'bad.md'), repositoryRoot: item.repo,
      targets: [{label: 'bad', id: 'not-account-id'}]}), /valid labels/);
    await fs.writeFile(item.pairsFile, Buffer.alloc(16 * 1024 * 1024 + 1));
    await assert.rejects(writeAuditProgressSummary({stateFile: item.stateFile, pairsFile: item.pairsFile,
      outputFile: path.join(item.privateDir, 'large.md'), repositoryRoot: item.repo}), /16 MiB/);
  } finally { await fs.rm(item.dir, {recursive: true, force: true}); }
});

test('summary joins every target normal and event run to the pinned local snapshot and native statuses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-account-run-summary-'));
  const repo = path.join(dir, 'repo'), generation = path.join(dir, 'repo', 'public-snapshots1');
  const privateDir = path.join(dir, 'private');
  await fs.mkdir(generation, {recursive: true}); await fs.mkdir(privateDir);
  const files = {}, values = new Map(), indexFile = path.join(generation, 'index.json');
  const replay = 'local-normal-replay', replayHash = crypto.createHash('sha256').update(replay).digest('hex');
  const eventReplay = 'local-event-replay', eventHash = crypto.createHash('sha256').update(eventReplay).digest('hex');
  values.set(`profile-results/${A}.json`, {accountId: A, publicProfile: {accountId: A, name: 'Miguel test'},
    coverage: {allTracksCaptured: false, boardsPresent: 1, boardsKnown: 2}});
  values.set(`recordings/9001.json`, {accountId: A, trackId: TRACK, uploadId: 9001, frames: 5000,
    replayHash, recording: replay});
  values.set(`event-replays/d_20261001/${A}.json`, {accountId: A, trackId: TRACK, periodId: 'd_20261001',
    runId: 'e'.repeat(64), timeMs: 5000, replayHash: eventHash, replay: eventReplay});
  values.set('events/d_20261001.json', {id: 'd_20261001', period: {id: 'd_20261001', trackId: TRACK},
    entries: [{accountId: A, timeMs: 5000}]});
  for (const [logical, value] of values) {
    const encoded = Buffer.from(await encodeSnapshot(value)), hash = crypto.createHash('sha256').update(encoded).digest('hex');
    await fs.writeFile(path.join(generation, `${hash}.bin`), encoded);
    files[logical] = {path: `${hash}.bin`, sha256: hash, decodedBytes: Buffer.byteLength(JSON.stringify(value))};
  }
  const indexBytes = Buffer.from(JSON.stringify({generation: 1, files}));
  const pointerBytes = Buffer.from(JSON.stringify({currentdir: 'public-snapshots1'}));
  await fs.writeFile(indexFile, indexBytes); await fs.writeFile(path.join(repo, 'snapshot-current.json'), pointerBytes);
  const stateFile = path.join(privateDir, 'state.json'), pairsFile = path.join(privateDir, 'pairs.jsonl');
  const normalResult = `normal-${crypto.createHash('sha256').update('recordings/9001.json').digest('hex').slice(0, 32)}`;
  const state = {schema: 'polytrack-snapshot-audit-v1', manifest: {generation: 'public-snapshots1',
    indexSha256: crypto.createHash('sha256').update(indexBytes).digest('hex'),
    pointerSha256: crypto.createHash('sha256').update(pointerBytes).digest('hex')},
    comparison: {done: true, totalPairs: 0}, nativeResults: {[normalResult]: {status: 'verified'}}};
  state.findingsFile = pairsFile;
  await fs.writeFile(stateFile, JSON.stringify(state)); await fs.writeFile(pairsFile, '');
  try {
    const output = path.join(privateDir, 'runs.md');
    const result = await writeAuditProgressSummary({stateFile, pairsFile, outputFile: output, repositoryRoot: repo,
      snapshotRoot: generation, targets: [{label: 'Miguel', id: A}]});
    const text = await fs.readFile(output, 'utf8');
    assert.equal(result.snapshotRuns, 2);
    assert.match(text, /Snapshot public name: Miguel test/);
    assert.match(text, /Locally captured normal\/event runs: 2 \(1 verified, 0 mismatch, 0 unavailable, 1 not yet processed\)/);
    assert.match(text, /Snapshot coverage: profile reports partial coverage \(1 of 2 boards\)/);
    assert.match(text, /normal verified: track/);
    assert.match(text, /event unprocessed: track/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
