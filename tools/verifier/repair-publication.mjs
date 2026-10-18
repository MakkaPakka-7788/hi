import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {connect, encode, decode} from './firestore.mjs';
import {budgetDatabase} from './throughput.mjs';
import {mergeCanonicalResultsIntoTrack} from '../../workers/ranked/src/index.js';
import {verificationKey, hasAcceptedVerifiedProof, verificationCollectionForTrack} from '../../workers/ranked/src/verification.js';

// One existing proof, at most four exact reads and one guarded commit. No retries.
export async function repairVerifiedPublication(db, {trackId, resultId, apply = false, projectId = 'polytrack-052',
  workerEnv = JSON.parse(fs.readFileSync(new URL('../../workers/ranked/wrangler.jsonc', import.meta.url), 'utf8')).vars} = {}) {
  if (!/^[a-f0-9]{64}$/.test(trackId || '') || typeof resultId !== 'string' ||
      !resultId.endsWith('_' + trackId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(resultId.slice(0, -65)) ||
      typeof apply !== 'boolean' || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) throw Error('Invalid bounded publication repair');
  db = budgetDatabase(db, 5);
  const accountId = resultId.slice(0, -65);
  const base = 'projects/' + projectId + '/databases/(default)/documents/';
  const canonicalPath = '0.6.2_race_results/' + resultId;
  const queuePath = verificationCollectionForTrack(trackId) + '/' + trackId;
  const boardPath = '0.6.2_s1_leaderboards_track/' + trackId;
  const metaPath = '0.6.2_s1_release_meta/current';
  let reads = 0, commits = 0, proposedCommits = 0, queue;
  const read = async key => {
    if (++reads > 4) throw Error('Repair read bound exceeded');
    const slash = key.indexOf('/');
    const doc = await db.get(key.slice(0, slash), key.slice(slash + 1));
    return doc ? {...doc, fields: doc.fields || encode(doc.data || {}).mapValue.fields} : null;
  };
  const canonical = await read(canonicalPath);
  if (!canonical?.updateTime || canonical.data?.trackId !== trackId ||
      String(canonical.data.accountId || canonical.data.userId || '') !== accountId) throw Error('Current canonical binding required');
  const env = {...workerEnv, FIREBASE_PROJECT_ID: projectId, __TEST_FIRESTORE: async (requestPath, init = {}) => {
    if (requestPath === ':commit') {
      if (++proposedCommits > 1 || !queue?.updateTime) throw Error('Repair commit bound exceeded');
      const body = JSON.parse(init.body);
      if (!Array.isArray(body.writes) || body.writes.length < 1 || body.writes.length > 2 ||
          body.writes.some(write => ![base + boardPath, base + metaPath].includes(write.update?.name) ||
            !write.currentDocument)) throw Error('Unexpected repair write');
      const boardWrite = body.writes.find(write => write.update.name === base + boardPath);
      const board = boardWrite && decode({mapValue: {fields: boardWrite.update.fields}});
      const entry = board?.entries?.find(row => String(row.accountId || row.userId || '') === accountId);
      if (entry?.runVerified !== true || entry.integrityVerified !== true ||
          verificationKey(entry) !== verificationKey(canonical.data)) throw Error('Repair cannot publish without exact proof and replay integrity');
      body.writes.push(...[[canonicalPath, canonical], [queuePath, queue]].map(([key, doc]) =>
        ({verify: base + key, currentDocument: {updateTime: doc.updateTime}})));
      if (!apply) return {};
      commits++;
      return db.call(':commit', body);
    }
    const key = requestPath.replace(/^\//, '');
    if (![boardPath, queuePath, metaPath].includes(key) || init.method && init.method !== 'GET') throw Error('Repair forbids queries and fallback scans');
    const doc = await read(key);
    if (key === metaPath && doc) {
      if (typeof doc.data?.rankedWritesEnabled === 'boolean') env.RANKED_WRITES_ENABLED = String(doc.data.rankedWritesEnabled);
      if (typeof doc.data?.multiplayerEnabled === 'boolean') env.MULTIPLAYER_ENABLED = String(doc.data.multiplayerEnabled);
    }
    if (key === queuePath) {
      queue = doc;
      const proof = doc?.data?.slots?.[accountId];
      if (!doc?.updateTime || proof?.key !== verificationKey(canonical.data) ||
          !hasAcceptedVerifiedProof(canonical.data, proof)) throw Error('Matching current verified proof required');
    }
    return doc;
  }};
  const result = await mergeCanonicalResultsIntoTrack(env, trackId, [resultId], new Map([[resultId, canonical]]));
  if (result.fallback) throw Error('Current complete board required; full-track fallback refused');
  return {trackId, resultId, dryRun: !apply, applied: apply && commits === 1,
    wouldChange: result.changed === true, revision: result.revision, reads, commits, requests: db.requests(),
    overallDirtied: result.overallChanged === true && apply && commits === 1};
}

async function main() {
  const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
  const raw = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (!raw) throw Error('Set the existing private FIREBASE_VERIFIER_SERVICE_ACCOUNT environment variable');
  const projectId = JSON.parse(raw).project_id;
  const result = await repairVerifiedPublication(await connect(raw), {
    trackId: option('track-id'), resultId: option('result-id'), apply: process.argv.includes('--apply'), projectId
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
