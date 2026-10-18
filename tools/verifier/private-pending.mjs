import {queueDocumentId,verificationShardId} from '../../workers/ranked/src/verification-shards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {connect, decode} from './firestore.mjs';
import {budgetDatabase} from './throughput.mjs';
import {selectJobs, prioritizeQueueDocuments, publishResults} from './runner.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';
import {createSimilarityReviewer} from './similarity.mjs';
import {validateEnginePin} from './run.mjs';
import {EXTRA_VERIFICATION_COLLECTION, VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST,
  VERIFIER_VERSION, legacyTimingFrames, verificationCollectionForTrack, verificationKey} from '../../workers/ranked/src/verification.js';

const require = createRequire(import.meta.url);
const {LIMITS, sha256} = require('./replay.cjs');
const verifyBatchDefault = require('./verify.cjs').verifyBatch;
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PRIVATE_CAPTURE_LIMITS = Object.freeze({jobs: 16, queueDocumentsPerLane: 8,
  requests: 100, fileBytes: 32 * 1024 * 1024});
const CAPTURE_SCHEMA = 'polytrack-private-pending-v1';
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TRACK_ID = /^[a-f0-9]{64}$/;

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

async function privatePath(file, root, {mustExist = false} = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Capture path must be absolute');
  const repo = await fs.realpath(root);
  const parent = await fs.realpath(path.dirname(file));
  const resolved = path.join(parent, path.basename(file));
  if (isWithin(repo, resolved)) throw Error('Private captures must be stored outside the Git repository');
  if (mustExist) {
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PRIVATE_CAPTURE_LIMITS.fileBytes) {
      throw Error('Invalid or oversized private capture file');
    }
    const actual = await fs.realpath(resolved);
    if (isWithin(repo, actual)) throw Error('Private captures must be stored outside the Git repository');
    return actual;
  }
  return resolved;
}

function captureJob(job) {
  const accountId = String(job?.accountId || job?.userId || '');
  const trackId = String(job?.trackId || '');
  const resultId = String(job?.resultId || '');
  const sourceTimeMs = job?.correctionCandidate?.originalTimeMs ?? job?.timeMs;
  const timeMs = job?.timeMs;
  const replay = job?.replay;
  const replayHash = String(job?.replayHash || '').toLowerCase();
  const frames = job?.frames ?? null;
  const raceTimeFrames = job?.raceTimeFrames ?? null;
  const uploadId = job?.uploadId ?? null;
  const id = job?.id ?? null;
  const queueCollection = job?.queueCollection || verificationCollectionForTrack(trackId);
  const queueId = job?.queueId ?? trackId;
  if (!ACCOUNT_ID.test(accountId) || !TRACK_ID.test(trackId) || resultId !== `${accountId}_${trackId}` ||
      !Number.isSafeInteger(timeMs) || timeMs <= 0 || !Number.isSafeInteger(sourceTimeMs) || sourceTimeMs <= 0 ||
      typeof replay !== 'string' || !replay.length || replay.length > LIMITS.replayCharacters ||
      !/^[a-f0-9]{64}$/.test(replayHash)) {
    throw Error('Invalid pending replay binding');
  }
  if (sha256(replay) !== replayHash) throw Error('Pending replay hash mismatch');
  if (queueCollection !== verificationCollectionForTrack(trackId) ||
      ![VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION].includes(queueCollection)) {
    throw Error('Pending replay queue binding mismatch');
  }
  if(queueId!==trackId&&queueId!==verificationShardId(trackId,accountId))throw Error('Invalid private queue document binding');
  const sourceRow = {accountId, trackId, timeMs: sourceTimeMs, frames, raceTimeFrames, uploadId, id, replayHash};
  const queueKey = String(job?.queueKey || '');
  if (verificationKey(sourceRow) !== queueKey) throw Error('Pending replay queue-key binding mismatch');
  const correctionFrames = legacyTimingFrames(sourceRow);
  let correctionCandidate = null;
  if (correctionFrames !== null) {
    if (timeMs !== correctionFrames) throw Error('Invalid legacy timing correction');
    correctionCandidate = {frames: correctionFrames, originalTimeMs: sourceTimeMs};
  } else if (sourceTimeMs !== timeMs) throw Error('Invalid source time binding');
  return {accountId, resultId, trackId, timeMs, sourceTimeMs, replayHash, replay,
    frames, raceTimeFrames, uploadId, id, queueKey, queueId, queueCollection, correctionCandidate};
}

async function writePrivateCapture(file, root, capture) {
  const output = await privatePath(file, root);
  const body = JSON.stringify(capture);
  if (Buffer.byteLength(body) > PRIVATE_CAPTURE_LIMITS.fileBytes) throw Error('Private capture exceeds size limit');
  let handle, created = false;
  try {
    handle = await fs.open(output, 'wx', 0o600);
    created = true;
    await handle.writeFile(body, 'utf8');
    await handle.close();
    handle = null;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await fs.rm(output, {force: true}).catch(() => {});
    throw error;
  }
  return output;
}

function requestMetrics(db) {
  return {requests: db.requests(), queryCount: db.queryCount(), returnedDocuments: db.returnedDocuments(),
    estimatedDocumentReads: db.estimatedDocumentReads(), emptyQueryMinimumReads: db.emptyQueryMinimumReads()};
}

export async function readPrivateCapture(file, {root = rootDefault} = {}) {
  const input = await privatePath(file, root, {mustExist: true});
  const capture = JSON.parse(await fs.readFile(input, 'utf8'));
  if (!capture || capture.schema !== CAPTURE_SCHEMA || capture.engineDigest !== VERIFIER_ENGINE_DIGEST ||
      capture.verifierVersion !== VERIFIER_VERSION || !Array.isArray(capture.jobs) ||
      capture.jobs.length > PRIVATE_CAPTURE_LIMITS.jobs) throw Error('Capture schema or pinned engine mismatch');
  const jobs = capture.jobs.map(captureJob);
  if (new Set(jobs.map(job => job.resultId)).size !== jobs.length) throw Error('Duplicate captured result ID');
  return {...capture, jobs};
}

async function dueQueueDocuments(db, collection, now) {
  const rows = await db.call(':runQuery', {structuredQuery: {
    from: [{collectionId: collection}],
    select: {fields: [{fieldPath: 'trackId'}, {fieldPath: 'slots'}, {fieldPath: 'notBefore'}]},
    where: {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL',
      value: {integerValue: String(now)}}},
    orderBy: [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}],
    limit: PRIVATE_CAPTURE_LIMITS.queueDocumentsPerLane
  }});
  if (!Array.isArray(rows)) throw Error('Unexpected verification queue response');
  return rows.filter(row => row.document).map(row => ({data: decode({mapValue: {fields: row.document.fields || {}}}),
    updateTime: row.document.updateTime, queueCollection: collection}));
}

export async function capturePending({file, credentials = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,
  root = rootDefault, now = Date.now(), jobLimit = PRIVATE_CAPTURE_LIMITS.jobs,
  validateEngine = validateEnginePin, connectDatabase = connect} = {}) {
  if (!Number.isInteger(jobLimit) || jobLimit < 1 || jobLimit > PRIVATE_CAPTURE_LIMITS.jobs) {
    throw Error(`jobLimit must be an integer from 1 to ${PRIVATE_CAPTURE_LIMITS.jobs}`);
  }
  await privatePath(file, root);
  if (typeof credentials !== 'string' || !credentials) throw Error('FIREBASE_VERIFIER_SERVICE_ACCOUNT is required');
  await validateEngine();
  const db = budgetDatabase(await connectDatabase(credentials), PRIVATE_CAPTURE_LIMITS.requests);
  const discovered = [
    ...await dueQueueDocuments(db, VERIFICATION_COLLECTION, now),
    ...await dueQueueDocuments(db, EXTRA_VERIFICATION_COLLECTION, now)
  ];
  const priorityCache = new Map();
  const prioritized = await prioritizeQueueDocuments(db, discovered, now, priorityCache);
  // Capture is read-only: selectJobs may propose queue housekeeping commits, which this adapter drops.
  const readOnlySelectionDb = {...db, call: (endpoint, body) => endpoint === ':commit' ? Promise.resolve({}) : db.call(endpoint, body)};
  const selected = await selectJobs(readOnlySelectionDb, prioritized, now, {
    jobLimit, lookupLimit: jobLimit,
    perTrackLimit: PRIVATE_CAPTURE_LIMITS.queueDocumentsPerLane
  });
  const originalSlots = new Map();
  for (const doc of discovered) for (const [accountId, slot] of Object.entries(doc.data.slots || {})) {
    originalSlots.set(`${doc.queueCollection}/${queueDocumentId(doc)}/${accountId}`, slot);
  }
  const jobs = [];
  for (const job of selected.jobs) {
    const slot = originalSlots.get(`${job.queueCollection}/${job.queueId || job.trackId}/${job.accountId}`);
    if (!slot || slot.key !== job.queueKey) continue;
    jobs.push(captureJob(job));
  }
  const capture = {schema: CAPTURE_SCHEMA, capturedAt: new Date(now).toISOString(),
    engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION, jobs};
  const output = await writePrivateCapture(file, root, capture);
  return {file: output, jobs: jobs.length, ...requestMetrics(db)};
}

async function verifyCaptureContents(capture, {root, verifyNative}) {
  const trustedTracks = loadWeeklyTrustedTrack(root, capture.jobs);
  const results = await verifyNative(root, capture.jobs, trustedTracks);
  if (!Array.isArray(results) || results.length !== capture.jobs.length) throw Error('Native verifier returned an incomplete result set');
  const seen = new Set();
  for (const result of results) {
    const job = capture.jobs.find(row => row.resultId === result?.resultId);
    if (!job || seen.has(result.resultId) || !['verified', 'mismatch', 'unavailable'].includes(result.status)) {
      throw Error('Native verifier result binding mismatch');
    }
    seen.add(result.resultId);
    const fieldsMatch = result.trackId === job.trackId && result.timeMs === job.timeMs && result.replayHash === job.replayHash;
    const sparseUnavailable = result.status === 'unavailable' &&
      (result.trackId === undefined || result.trackId === job.trackId) &&
      (result.timeMs === undefined || result.timeMs === job.timeMs) &&
      (result.replayHash === undefined || result.replayHash === job.replayHash);
    if (!fieldsMatch && !sparseUnavailable) {
      throw Error('Native verifier result binding mismatch');
    }
  }
  await createSimilarityReviewer(root)(capture.jobs, results);
  return results;
}

export async function verifyPrivateCapture({file, root = rootDefault, validateEngine = validateEnginePin,
  verifyNative = verifyBatchDefault} = {}) {
  await validateEngine();
  const capture = await readPrivateCapture(file, {root});
  const results = await verifyCaptureContents(capture, {root, verifyNative});
  return {jobs: capture.jobs, results, requests: 0};
}

export async function publishPrivateCapture({file, credentials = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,
  root = rootDefault, validateEngine = validateEnginePin, verifyNative = verifyBatchDefault,
  connectDatabase = connect, publish = publishResults} = {}) {
  if (typeof credentials !== 'string' || !credentials) throw Error('FIREBASE_VERIFIER_SERVICE_ACCOUNT is required');
  await validateEngine();
  const capture = await readPrivateCapture(file, {root});
  // Captured JSON is never treated as verdict evidence; always replay it again before opening Firebase.
  const results = await verifyCaptureContents(capture, {root, verifyNative});
  const db = budgetDatabase(await connectDatabase(credentials), PRIVATE_CAPTURE_LIMITS.requests);
  const summary = await publish(db, capture.jobs, results);
  return {...summary, ...requestMetrics(db)};
}

function parseArgs(args) {
  const command = args[0];
  if (!['capture', 'verify', 'publish'].includes(command)) {
    throw Error('Usage: npm run private-pending -- <capture|verify|publish> --file <absolute-path-outside-repo> [--limit 1..16]');
  }
  const options = {command, limit: PRIVATE_CAPTURE_LIMITS.jobs};
  let limitProvided = false;
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (option === '--file' && !options.file && args[index + 1]) options.file = args[++index];
    else if (option === '--limit' && !limitProvided && args[index + 1]) {
      const raw = args[++index];
      if (!/^\d+$/.test(raw)) throw Error('Capture limit must be an integer from 1 to 16');
      options.limit = Number(raw);
      limitProvided = true;
    } else throw Error('Usage: npm run private-pending -- <capture|verify|publish> --file <absolute-path-outside-repo> [--limit 1..16]');
  }
  if (!options.file || command !== 'capture' && options.limit !== PRIVATE_CAPTURE_LIMITS.jobs) {
    throw Error('A file is required; --limit is available only for capture');
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > PRIVATE_CAPTURE_LIMITS.jobs) {
    throw Error(`Capture limit must be an integer from 1 to ${PRIVATE_CAPTURE_LIMITS.jobs}`);
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.command === 'capture') {
    const result = await capturePending({file: options.file, jobLimit: options.limit});
    console.log(JSON.stringify({captured: result.jobs, cost: result, file: result.file}));
  } else if (options.command === 'verify') {
    const result = await verifyPrivateCapture({file: options.file, validateEngine: (await import('./run.mjs')).validateEnginePin});
    console.log(JSON.stringify({verified: result.results.filter(row => row.status === 'verified').length,
      results: result.results.map(({resultId, status, reason}) => ({resultId, status, reason}))}));
  } else {
    const result = await publishPrivateCapture({file: options.file, validateEngine: (await import('./run.mjs')).validateEnginePin});
    console.log(JSON.stringify({publication: result, requests: result.requests}));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  });
}
