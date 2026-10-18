import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadSnapshotAuditInputs} from './snapshot-audit.mjs';
import {readPrivateCapture} from './private-pending.mjs';
import {ANALYSIS_LIMITS, decodeAnalysisReplay} from './analysis-replay-decoder.mjs';
import {compareInputSegment} from './segment-similarity.mjs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {checkJob: checkNativeJob} = require('./replay.cjs');
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACCOUNT_ID = /^[a-f0-9]{64}$/;
const MIN_MATCHED_TRANSITIONS = 20;
const MIN_STEERING_TICKS = 1000;
const MIN_SCORE = 0.95;
const MAX_PAIRS = 500000;
const MAX_SEGMENT_WORK = 160000000;
const MAX_INDEX_WINDOWS = 4000000;
const MAX_CANDIDATE_PAIRS = 2000000;
const MAX_CANDIDATE_OPERATIONS = 10000000;
const CHANNELS = ['right', 'down', 'left', 'reset'];
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const PRIVATE_INPUT_BYTES = 32 * 1024 * 1024;

export {compareInputSegment};

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function eventRows(controls) {
  return CHANNELS.flatMap((name, index) => controls.lists[name].map(tick => ({channel: index + 1, tick})))
    .sort((a, b) => a.tick - b.tick || a.channel - b.channel);
}

function prepareControls(controls) {
  const events = eventRows(controls), edgeTokens = [];
  for (let i = 1; i < events.length; i++) {
    const previous = events[i - 1], current = events[i];
    edgeTokens.push(((previous.channel * 5 + current.channel) * (ANALYSIS_LIMITS.maxTick + 1)) + current.tick - previous.tick);
  }
  const channelPrefix = Array.from({length: 5}, () => new Uint32Array(events.length + 1));
  for (let i = 0; i < events.length; i++) {
    for (let channel = 1; channel <= 4; channel++) channelPrefix[channel][i + 1] = channelPrefix[channel][i];
    channelPrefix[events[i].channel][i + 1]++;
  }
  const groups = [];
  let state = 0, cursor = 0, activeTotal = 0;
  for (let i = 0; i < events.length;) {
    const tick = events[i].tick, first = i;
    if (state) activeTotal += tick - cursor;
    while (i < events.length && events[i].tick === tick) {
      state ^= 1 << events[i].channel;
      i++;
    }
    groups.push({tick, state, activeUntil: activeTotal, first, end: i});
    cursor = tick;
  }
  function groupBefore(tick) {
    let lo = 0, hi = groups.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (groups[mid].tick <= tick) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
  function stateAt(tick) { const i = groupBefore(tick); return i < 0 ? 0 : groups[i].state; }
  function activeAt(tick) {
    const i = groupBefore(tick);
    if (i < 0) return 0;
    const group = groups[i];
    return group.activeUntil + (group.state ? tick - group.tick : 0);
  }
  function activeDuration(start, end) { return Math.max(0, activeAt(end) - activeAt(start)); }
  function channelMask(startIndex, endIndex) {
    let mask = 0;
    for (let channel = 1; channel <= 4; channel++) if (channelPrefix[channel][endIndex] > channelPrefix[channel][startIndex]) mask |= 1 << channel;
    return mask;
  }
  return {events, edgeTokens, stateAt, activeDuration, channelMask};
}

function buildSuffixAutomaton(tokens) {
  const states = [{length: 0, link: -1, transitions: new Map(), firstPos: -1}];
  let last = 0;
  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position], current = states.length;
    states.push({length: states[last].length + 1, link: 0, transitions: new Map(), firstPos: position});
    let parent = last;
    while (parent >= 0 && !states[parent].transitions.has(token)) {
      states[parent].transitions.set(token, current);
      parent = states[parent].link;
    }
    if (parent < 0) states[current].link = 0;
    else {
      const child = states[parent].transitions.get(token);
      if (states[parent].length + 1 === states[child].length) states[current].link = child;
      else {
        const clone = states.length;
        states.push({length: states[parent].length + 1, link: states[child].link,
          transitions: new Map(states[child].transitions), firstPos: states[child].firstPos});
        while (parent >= 0 && states[parent].transitions.get(token) === child) {
          states[parent].transitions.set(token, clone);
          parent = states[parent].link;
        }
        states[child].link = clone;
        states[current].link = clone;
      }
    }
    last = current;
  }
  return states;
}

export function findCopiedSteeringSegment(left, right) {
  const a = left.edgeTokens.length <= right.edgeTokens.length ? left : right;
  const b = a === left ? right : left;
  if (a.edgeTokens.length < MIN_MATCHED_TRANSITIONS - 1 || b.edgeTokens.length < MIN_MATCHED_TRANSITIONS - 1) return null;
  const states = buildSuffixAutomaton(a.edgeTokens);
  let current = 0, matchedEdges = 0, best = null;
  for (let position = 0; position < b.edgeTokens.length; position++) {
    const token = b.edgeTokens[position];
    while (current && !states[current].transitions.has(token)) {
      current = states[current].link;
      matchedEdges = Math.min(matchedEdges, states[current].length);
    }
    if (states[current].transitions.has(token)) {
      current = states[current].transitions.get(token);
      matchedEdges++;
    } else {
      current = 0;
      matchedEdges = 0;
    }
    if (matchedEdges < MIN_MATCHED_TRANSITIONS - 1) continue;
    const aTokenStart = states[current].firstPos - matchedEdges + 1;
    const aStart = aTokenStart, aEnd = aTokenStart + matchedEdges;
    const bStart = position - matchedEdges + 1, bEnd = position + 1;
    const aStartTick = a.events[aStart].tick, aEndTick = a.events[aEnd].tick;
    const bStartTick = b.events[bStart].tick, bEndTick = b.events[bEnd].tick;
    if (aEndTick - aStartTick < MIN_STEERING_TICKS || bEndTick - bStartTick < MIN_STEERING_TICKS) continue;
    if (countBits(a.channelMask(aStart, aEnd + 1)) < 2 || countBits(b.channelMask(bStart, bEnd + 1)) < 2) continue;
    const activeA = a.activeDuration(aStartTick, aEndTick), activeB = b.activeDuration(bStartTick, bEndTick);
    if (activeA < MIN_STEERING_TICKS || activeB < MIN_STEERING_TICKS) continue;
    const stateScore = a.stateAt(aStartTick) === b.stateAt(bStartTick) ? 1 : 0;
    const transitionCount = matchedEdges + 1;
    const score = stateScore === 1 ? 1 : 0;
    if (score < MIN_SCORE) continue;
    const leftStart = a === left ? aStartTick : bStartTick;
    const rightStart = a === left ? bStartTick : aStartTick;
    const leftEnd = a === left ? aEndTick : bEndTick;
    const rightEnd = a === left ? bEndTick : aEndTick;
    const candidate = {matchedTransitions: transitionCount, transitionScore: 1, stateScore: score,
      steeringActiveMsLeft: a === left ? activeA : activeB,
      steeringActiveMsRight: a === left ? activeB : activeA,
      startTickLeft: leftStart, endTickLeft: leftEnd, startTickRight: rightStart, endTickRight: rightEnd,
      offsetTicks: rightStart - leftStart, durationTicks: leftEnd - leftStart,
      distinctSteeringChannels: countBits(a.channelMask(aStart, aEnd + 1)), score};
    if (!best || candidate.matchedTransitions > best.matchedTransitions ||
        candidate.matchedTransitions === best.matchedTransitions && candidate.durationTicks > best.durationTicks) best = candidate;
  }
  return best;
}

function countBits(value) { let count = 0; for (; value; value &= value - 1) count++; return count; }

function informative(events, prepared, duration) {
  if (events.length < MIN_MATCHED_TRANSITIONS || countBits(prepared.channelMask(0, events.length)) < 2 || !events.length) return false;
  return prepared.activeDuration(0, duration) >= MIN_STEERING_TICKS;
}

function fullChannelAgreement(leftControls, rightControls, startLeft, endLeft, startRight, endRight) {
  const names = ['up', 'right', 'down', 'left', 'reset'];
  const stateAt = (controls, tick) => {
    let state = 0;
    for (let channel = 0; channel < names.length; channel++) {
      const values = controls.lists[names[channel]];
      let low = 0, high = values.length;
      while (low < high) { const mid = (low + high) >>> 1; if (values[mid] <= tick) low = mid + 1; else high = mid; }
      const count = low;
      if (count % 2) state |= 1 << channel;
    }
    return state;
  };
  const boundaries = new Set([startLeft, endLeft]);
  for (const name of names) {
    for (const tick of leftControls.lists[name]) if (tick > startLeft && tick < endLeft) boundaries.add(tick);
    for (const tick of rightControls.lists[name]) {
      const mapped = startLeft + tick - startRight;
      if (mapped > startLeft && mapped < endLeft) boundaries.add(mapped);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  let matching = 0, total = endLeft - startLeft;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const tick = sorted[i], leftState = stateAt(leftControls, tick);
    const shiftedTick = startRight + (tick - startLeft);
    if (leftState === stateAt(rightControls, shiftedTick)) matching += sorted[i + 1] - tick;
  }
  return total > 0 ? matching / total : 0;
}

function addAlias(run, job) {
  run.sources.push({kind: job.kind, source: job.source});
}

function deduplicateJobs(jobs) {
  const runs = new Map();
  for (const job of jobs) {
    if (!ACCOUNT_ID.test(job.accountId || '') || !ACCOUNT_ID.test(job.trackId || '') || !/^[a-f0-9]{64}$/.test(job.replayHash || '') ||
        !Number.isSafeInteger(job.timeMs) || job.timeMs <= 0 || typeof job.replay !== 'string') continue;
    const key = [job.trackId, job.accountId, job.replayHash, job.timeMs].join('/');
    const existing = runs.get(key);
    if (existing) { addAlias(existing, job); continue; }
    runs.set(key, {...job, sources: [{kind: job.kind, source: job.source}], controls: null,
      controlHash: null, prepared: null, decodeError: null});
  }
  return [...runs.values()].sort((a, b) => a.trackId.localeCompare(b.trackId) || a.accountId.localeCompare(b.accountId) ||
    a.timeMs - b.timeMs || a.replayHash.localeCompare(b.replayHash));
}

function forEachSignature(tokens, visit) {
  const width = MIN_MATCHED_TRANSITIONS - 1;
  if (tokens.length < width) return 0;
  const bases = [16777619, 2246822519], powers = bases.map(base => {
    let power = 1;
    for (let i = 1; i < width; i++) power = Math.imul(power, base) >>> 0;
    return power;
  });
  const hashes = bases.map(base => {
    let value = 0;
    for (let i = 0; i < width; i++) value = (Math.imul(value, base) + tokens[i]) >>> 0;
    return value;
  });
  const seen = new Set();
  for (let start = 0; start <= tokens.length - width; start++) {
    const key = `${hashes[0].toString(16)}:${hashes[1].toString(16)}`;
    if (!seen.has(key)) {
      seen.add(key);
      if (!visit(key)) return tokens.length - width - start + 1;
    }
    if (start + width < tokens.length) {
      for (let h = 0; h < bases.length; h++) {
        hashes[h] = (Math.imul((hashes[h] - Math.imul(tokens[start], powers[h])) >>> 0, bases[h]) + tokens[start + width]) >>> 0;
      }
    }
  }
  return 0;
}

export async function analyzeSegmentPairs(jobs, {maxPairs = MAX_PAIRS, maxSegmentWork = MAX_SEGMENT_WORK,
  maxIndexWindows = MAX_INDEX_WINDOWS, maxCandidatePairs = MAX_CANDIDATE_PAIRS,
  maxCandidateOperations = MAX_CANDIDATE_OPERATIONS, onProgress = () => {}} = {}) {
  if (![maxPairs, maxSegmentWork, maxIndexWindows, maxCandidatePairs, maxCandidateOperations].every(value => Number.isSafeInteger(value) && value >= 1)) {
    throw Error('Pair and segment-work limits must be positive safe integers');
  }
  const runs = deduplicateJobs(jobs), groups = new Map(), counts = {
    sourceJobs: jobs.length, uniqueRuns: runs.length, duplicateSourcesCollapsed: jobs.length - runs.length,
    decodeUnavailable: 0, crossAccountPairs: 0, crossAccountPairsCompared: 0, pairsSkippedDecodeUnavailable: 0,
    fullExactInformative: 0, fullExactLowInformation: 0,
    segmentPairs: 0, segmentWorkUsed: 0, segmentPairsSkippedWork: 0, sameAccountPairsExcluded: 0,
    segmentIndexWindows: 0, segmentIndexWindowsSkipped: 0, segmentCandidatePairs: 0,
    segmentCandidatesValidated: 0, segmentCandidatesSkipped: 0, segmentPairsWithOtherControlsDifference: 0,
    candidatePairOperations: 0, decodeFailureKinds: {}
  };
  for (const run of runs) {
    try {
      run.controls = decodeAnalysisReplay(run.replay, run.timeMs);
      run.controlHash = sha256(JSON.stringify(run.controls.lists));
      run.prepared = prepareControls(run.controls);
      try {
        checkNativeJob({resultId: `${run.accountId}_${run.trackId}`, trackId: run.trackId, timeMs: run.timeMs,
          replayHash: run.replayHash, replay: run.replay});
        run.nativeEligible = true;
      } catch (error) {
        run.nativeEligible = false;
        run.nativeUnavailableReason = String(error?.reason || error?.message || 'native_validation_unavailable');
      }
    } catch (error) {
      run.decodeError = String(error?.reason || error?.message || 'decode_error');
      counts.decodeUnavailable++;
      counts.decodeFailureKinds[run.decodeError] = (counts.decodeFailureKinds[run.decodeError] || 0) + 1;
    }
    if (!groups.has(run.trackId)) groups.set(run.trackId, []);
    groups.get(run.trackId).push(run);
  }
  counts.nativeEligibleRuns = runs.filter(run => !run.decodeError && run.nativeEligible).length;
  counts.analysisOnlyRuns = runs.filter(run => !run.decodeError && !run.nativeEligible).length;
  counts.nativeIneligibilityReasons = {};
  for (const run of runs) if (!run.decodeError && !run.nativeEligible) {
    const reason = run.nativeUnavailableReason;
    counts.nativeIneligibilityReasons[reason] = (counts.nativeIneligibilityReasons[reason] || 0) + 1;
  }
  const candidatePairs = new Map(), segmentFindings = new Map(), findings = [];
  let indexComplete = true, candidatesComplete = true;
  for (const [trackId, trackRuns] of groups) {
    const postings = new Map();
    for (let index = 0; index < trackRuns.length; index++) {
      const run = trackRuns[index];
      if (run.decodeError) continue;
      const skipped = forEachSignature(run.prepared.edgeTokens, key => {
        if (counts.segmentIndexWindows >= maxIndexWindows) {
          indexComplete = false;
          return false;
        }
        counts.segmentIndexWindows++;
        if (!postings.has(key)) postings.set(key, new Set());
        postings.get(key).add(index);
        return true;
      });
      if (skipped) { counts.segmentIndexWindowsSkipped += skipped; indexComplete = false; }
      if ((index & 31) === 31) { onProgress({phase: 'segment_index', runs: index + 1, total: trackRuns.length}); await new Promise(resolve => setImmediate(resolve)); }
    }
    outer: for (const indices of postings.values()) {
      const rows = [...indices];
      for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
        if (counts.candidatePairOperations >= maxCandidateOperations) { candidatesComplete = false; break outer; }
        counts.candidatePairOperations++;
        const leftIndex = rows[a], rightIndex = rows[b];
        if (trackRuns[leftIndex].accountId === trackRuns[rightIndex].accountId) continue;
        const key = `${trackId}/${leftIndex}/${rightIndex}`;
        if (candidatePairs.has(key)) continue;
        if (candidatePairs.size >= maxCandidatePairs) { candidatesComplete = false; break outer; }
        candidatePairs.set(key, [trackRuns[leftIndex], trackRuns[rightIndex]]);
        if (counts.candidatePairOperations % 100000 === 0) { onProgress({phase: 'candidate_pairs', operations: counts.candidatePairOperations}); await new Promise(resolve => setImmediate(resolve)); }
      }
    }
  }
  counts.segmentCandidatePairs = candidatePairs.size;
  let candidateIndex = 0;
  for (const [key, [left, right]] of candidatePairs) {
    candidateIndex++;
    const work = left.prepared.edgeTokens.length + right.prepared.edgeTokens.length;
    if (counts.segmentWorkUsed + work > maxSegmentWork) { counts.segmentPairsSkippedWork++; continue; }
    counts.segmentWorkUsed += work;
    counts.segmentCandidatesValidated++;
    const segment = findCopiedSteeringSegment(left.prepared, right.prepared);
    if (!segment) continue;
    counts.segmentPairs++;
    const fullExact = left.timeMs === right.timeMs && left.controlHash === right.controlHash;
    const leftInformative = informative(eventRows(left.controls), left.prepared, left.timeMs);
    const rightInformative = informative(eventRows(right.controls), right.prepared, right.timeMs);
    const fullExactInformative = fullExact && leftInformative && rightInformative;
    const allChannelAgreement = fullChannelAgreement(left.controls, right.controls, segment.startTickLeft,
      segment.endTickLeft, segment.startTickRight, segment.endTickRight);
    if (allChannelAgreement < MIN_SCORE) counts.segmentPairsWithOtherControlsDifference++;
    segmentFindings.set(`${left.trackId}/${left.replayHash}/${right.replayHash}`, {trackId: left.trackId,
      left: runSummary(left), right: runSummary(right), segment: {...segment, allChannelStateAgreement: allChannelAgreement}});
    if (candidateIndex % 128 === 0) { onProgress({phase: 'segment_candidates', completed: candidateIndex, total: candidatePairs.size}); await new Promise(resolve => setImmediate(resolve)); }
  }
  counts.segmentCandidatesSkipped = counts.segmentCandidatePairs - counts.segmentCandidatesValidated;
  for (const [trackId, trackRuns] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < trackRuns.length; i++) for (let j = i + 1; j < trackRuns.length; j++) {
      const left = trackRuns[i], right = trackRuns[j];
      if (left.accountId === right.accountId) { counts.sameAccountPairsExcluded++; continue; }
      counts.crossAccountPairs++;
      if (counts.crossAccountPairs > maxPairs) throw Error(`Cross-account pair cap exceeded (${maxPairs}); no partial report written`);
      if (left.decodeError || right.decodeError) { counts.pairsSkippedDecodeUnavailable++; continue; }
      counts.crossAccountPairsCompared++;
      const fullExact = left.timeMs === right.timeMs && left.controlHash === right.controlHash;
      const leftInformative = informative(eventRows(left.controls), left.prepared, left.timeMs);
      const rightInformative = informative(eventRows(right.controls), right.prepared, right.timeMs);
      const fullExactInformative = fullExact && leftInformative && rightInformative;
      if (fullExact) {
        if (fullExactInformative) counts.fullExactInformative++;
        else counts.fullExactLowInformation++;
      }
      if (fullExactInformative) {
        const key = `${trackId}/${left.replayHash}/${right.replayHash}`, segmentRow = segmentFindings.get(key);
        findings.push({trackId, left: runSummary(left), right: runSummary(right), fullExactSameTicks: true,
          lowInformationFullExact: false, segment: segmentRow?.segment || null,
          evidenceKind: segmentRow ? 'full_and_segment' : 'informative_full_exact'});
      }
      if (counts.crossAccountPairs % 4096 === 0) { onProgress({phase: 'full_pairs', completed: counts.crossAccountPairs}); await new Promise(resolve => setImmediate(resolve)); }
    }
  }
  const exactKeys = new Set(findings.map(row => `${row.trackId}/${row.left.replayHash}/${row.right.replayHash}`));
  for (const [key, row] of segmentFindings) if (!exactKeys.has(key)) findings.push({...row,
    fullExactSameTicks: false, lowInformationFullExact: false,
    evidenceKind: row.segment.allChannelStateAgreement < MIN_SCORE ? 'steering_segment_other_controls_differ' : 'copied_steering_segment'});
  const unavailableRuns = runs.filter(run => run.decodeError).map(run => ({trackId: run.trackId,
    accountId: run.accountId, timeMs: run.timeMs, replayHash: run.replayHash, decodeError: run.decodeError,
    sources: run.sources}));
  return {findings, counts, unavailableRuns, coverage: {completeCrossAccountPairPass: true,
    completeInputPairComparison: counts.pairsSkippedDecodeUnavailable === 0,
    completeSegmentSearch: indexComplete && candidatesComplete && counts.segmentPairsSkippedWork === 0 && counts.decodeUnavailable === 0,
    completeDecodedSegmentSearch: indexComplete && candidatesComplete && counts.segmentPairsSkippedWork === 0,
    completeSegmentCandidateIndex: indexComplete,
    completeSegmentCandidateEnumeration: candidatesComplete,
    minimumMatchedTransitions: MIN_MATCHED_TRANSITIONS, minimumSteeringActiveMs: MIN_STEERING_TICKS,
    minimumScore: MIN_SCORE, maxPairs, maxSegmentWork, maxIndexWindows, maxCandidatePairs, maxCandidateOperations}};
}

async function readPrivateJson(file, root) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Private input path must be absolute');
  const repo = await fs.realpath(root), parent = await fs.realpath(path.dirname(file));
  const resolved = path.join(parent, path.basename(file));
  if (within(repo, resolved)) throw Error('Private inputs must be stored outside the Git repository');
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PRIVATE_INPUT_BYTES) throw Error('Invalid or oversized private audit input');
  if (within(repo, await fs.realpath(resolved))) throw Error('Private inputs must be stored outside the Git repository');
  return JSON.parse(await fs.readFile(resolved, 'utf8'));
}

export async function loadPrivateSegmentJobs({root = DEFAULT_ROOT, pendingFile, extraFile} = {}) {
  const jobs = [];
  if (pendingFile) {
    const capture = await readPrivateCapture(pendingFile, {root});
    for (const job of capture.jobs) jobs.push({...job, kind: 'private-pending', source: `pending-capture:${job.resultId}`});
  }
  if (extraFile) {
    const capture = await readPrivateJson(extraFile, root);
    if (capture?.schema !== 'polytrack-private-current-audit-v1' || !Array.isArray(capture.jobs) || capture.jobs.length > 500) {
      throw Error('Private current-audit capture schema mismatch');
    }
    for (const row of capture.jobs) {
      if (!ACCOUNT_ID.test(row?.accountId || '') || !ACCOUNT_ID.test(row?.trackId || '') ||
          !Number.isSafeInteger(row.timeMs) || row.timeMs <= 0 || typeof row.replay !== 'string' ||
          row.replay.length === 0 || !/^[a-f0-9]{64}$/.test(row.replayHash || '') || sha256(row.replay) !== row.replayHash ||
          typeof row.recordId !== 'string' || !row.recordId || row.resultId !== `${row.accountId}_${row.trackId}` ||
          row.kind !== 'private-current') {
        throw Error('Private current-audit replay binding or hash mismatch');
      }
      jobs.push({...row, kind: 'private-current', source: `current-audit:${row.recordId}`});
    }
  }
  return jobs;
}

function runSummary(run) {
  return {accountId: run.accountId, timeMs: run.timeMs, replayHash: run.replayHash,
    sources: run.sources, nativeEligible: run.nativeEligible, nativeUnavailableReason: run.nativeUnavailableReason || null,
    transitions: run.controls.transitions,
    steeringTransitions: run.prepared.events.length};
}

function markdown(summary) {
  const lines = ['# Private Segment Similarity Audit', '',
    'Advisory similarity evidence only. This report is not proof of cheating and must not trigger automatic denial, account action, or publication changes.', '',
    `- Snapshot generation: ${summary.snapshot.generation}`,
    `- Snapshot index SHA-256: ${summary.snapshot.indexSha256}`,
    `- Pinned verifier engine digest: ${summary.snapshot.engineDigest}`,
    `- Source jobs: ${summary.counts.sourceJobs}`,
    `- Unique track/account/hash/time runs after normal/event deduplication: ${summary.counts.uniqueRuns}`,
    `- Duplicate normal/event sources collapsed: ${summary.counts.duplicateSourcesCollapsed}`,
    `- Private pending-capture jobs included: ${summary.privateInputs.pendingJobs}`,
    `- Private current-audit jobs included: ${summary.privateInputs.currentJobs}`,
    `- Cross-account same-track pairs checked: ${summary.counts.crossAccountPairs}`,
    `- Cross-account pairs with valid inputs compared: ${summary.counts.crossAccountPairsCompared}`,
    `- Cross-account pairs skipped for decode failures: ${summary.counts.pairsSkippedDecodeUnavailable}`,
    `- Same-account pairs excluded: ${summary.counts.sameAccountPairsExcluded}`,
    `- Informative full exact same-tick pairs: ${summary.counts.fullExactInformative}`,
    `- Low-information full exact pairs (not flagged): ${summary.counts.fullExactLowInformation}`,
    `- Exact contiguous steering-segment pairs: ${summary.counts.segmentPairs}`,
    `- Candidate pairs with differing all-channel states: ${summary.counts.segmentPairsWithOtherControlsDifference}`,
    `- Replay decode unavailable: ${summary.counts.decodeUnavailable}`,
    `- Native-eligible runs: ${summary.counts.nativeEligibleRuns}`,
    `- Analysis-only runs (not valid for native approval): ${summary.counts.analysisOnlyRuns}`,
    `- Native ineligibility reasons: ${Object.entries(summary.counts.nativeIneligibilityReasons).map(([reason, count]) => `${reason} (${count})`).join(', ') || 'none'}`,
    `- Analysis decoder caps: ${ANALYSIS_LIMITS.replayCharacters} replay characters, ${ANALYSIS_LIMITS.compressedBytes} compressed bytes, ${ANALYSIS_LIMITS.inflatedBytes} inflated bytes, ${ANALYSIS_LIMITS.transitions} total / ${ANALYSIS_LIMITS.transitionsPerChannel} per-channel transitions, tick/time <= ${ANALYSIS_LIMITS.maxTick}`,
    `- Decode failure reasons: ${Object.entries(summary.counts.decodeFailureKinds).map(([reason, count]) => `${reason} (${count})`).join(', ') || 'none'}`,
    `- Segment checks skipped by work cap: ${summary.counts.segmentPairsSkippedWork}`,
    `- Pair-pass coverage complete: ${summary.coverage.completeCrossAccountPairPass}`,
    `- Valid-input pair coverage complete: ${summary.coverage.completeInputPairComparison}`,
    `- Segment-search coverage complete: ${summary.coverage.completeSegmentSearch}`, '',
    '- This is a local snapshot plus explicitly listed private captures, not an exhaustive read of all Firestore history or every recording ever uploaded.',
    `- Source snapshot binding issues: ${summary.sourceIssues}`,
    `- Source snapshot coverage complete: ${summary.coverage.sourceSnapshotComplete}`,
    ...(summary.sourceIssueKinds.length ? [`- Source issue kinds: ${summary.sourceIssueKinds.map(item => `${item.kind} (${item.count})`).join(', ')}`] : []),
    '',
    '## Unavailable Replays', ''];
  if (!summary.unavailableRuns.length) lines.push('None.', '');
  for (const row of summary.unavailableRuns) lines.push(`- ${row.decodeError}: track \`${row.trackId}\`, account \`${row.accountId}\`, ${row.timeMs} ms, replay \`${row.replayHash}\`, sources ${row.sources.map(source => `\`${source.kind}:${source.source}\``).join(', ')}`);
  lines.push('', '## Flagged Pairs', '');
  if (!summary.findings.length) lines.push('No pairs met the conservative evidence thresholds.', '');
  for (const [index, row] of summary.findings.entries()) {
    lines.push(`### ${index + 1}. ${row.evidenceKind}`, '', `Track: \`${row.trackId}\``,
      `- Left account: \`${row.left.accountId}\` (${row.left.timeMs} ms, ${row.left.steeringTransitions} steering transitions)`,
      `- Left native status: ${row.left.nativeEligible ? 'eligible under current native limits' : `analysis-only (${row.left.nativeUnavailableReason})`}`,
      `- Left sources: ${row.left.sources.map(source => `\`${source.kind}:${source.source}\``).join(', ')}`,
      `- Right account: \`${row.right.accountId}\` (${row.right.timeMs} ms, ${row.right.steeringTransitions} steering transitions)`,
      `- Right native status: ${row.right.nativeEligible ? 'eligible under current native limits' : `analysis-only (${row.right.nativeUnavailableReason})`}`,
      `- Right sources: ${row.right.sources.map(source => `\`${source.kind}:${source.source}\``).join(', ')}`,
      `- Replay hashes: \`${row.left.replayHash}\` / \`${row.right.replayHash}\``);
    if (row.segment) lines.push(`- Exact steering segment: ${row.segment.matchedTransitions} transitions, score ${(row.segment.score * 100).toFixed(1)}%, all-five-channel state agreement ${(row.segment.allChannelStateAgreement * 100).toFixed(1)}%, steering-active ${row.segment.steeringActiveMsLeft} / ${row.segment.steeringActiveMsRight} ticks, windows ${row.segment.startTickLeft}-${row.segment.endTickLeft} and ${row.segment.startTickRight}-${row.segment.endTickRight}, offset ${row.segment.offsetTicks} ticks. ${row.segment.allChannelStateAgreement < MIN_SCORE ? 'Lower-confidence steering-only similarity because other controls differ.' : 'Five-channel state overlap supports the steering match.'}`);
    lines.push('');
  }
  lines.push('## Thresholds', '',
    `- Segment evidence requires at least ${MIN_MATCHED_TRANSITIONS} exact steering transitions, at least ${MIN_STEERING_TICKS} steering-active ticks on both runs, at least two steering channels, and a score of at least ${MIN_SCORE}.`,
    '- Forward-only holding/coasting is excluded because only right/down/left/reset transitions are considered.',
    '- Partial-window search requires an exact contiguous steering-transition signature; approximate 95% partial-window matching is not performed. Up/throttle is excluded from candidate generation but its full state overlap is measured and reported for each validated match.',
    '- The analysis decoder has larger, separate bounded limits. Analysis-only decodes may support similarity review but are never native verification or approval evidence. Native validation uses the unchanged pinned verifier limits.',
    '- Identical normal/event evidence from one account and replay hash is collapsed before cross-account comparisons.',
    '- A matching copied segment is not proof of coordination; common routes, shared practice, or recording artifacts remain possible.', '');
  return lines.join('\n');
}

async function writeExclusive(file, data) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); }
  finally { await handle.close(); }
}

export async function runSegmentAudit({report, root = DEFAULT_ROOT, maxPairs = MAX_PAIRS,
  maxSegmentWork = MAX_SEGMENT_WORK, pendingFile, extraFile, onProgress = () => {}} = {}) {
  if (typeof report !== 'string' || !path.isAbsolute(report)) throw Error('Report path must be absolute');
  const repo = await fs.realpath(root), parent = await fs.realpath(path.dirname(report));
  const base = path.join(parent, path.basename(report));
  if (within(repo, base)) throw Error('Private report must be outside the Git repository');
  const audit = await loadSnapshotAuditInputs({root});
  onProgress({phase: 'snapshot_loaded', jobs: audit.jobs.length, generation: audit.manifest.generation});
  const privateJobs = await loadPrivateSegmentJobs({root, pendingFile, extraFile});
  const result = await analyzeSegmentPairs([...audit.jobs, ...privateJobs], {maxPairs, maxSegmentWork, onProgress});
  const summary = {...result, snapshot: {generation: audit.manifest.generation,
    indexSha256: audit.manifest.indexSha256, pointerSha256: audit.manifest.pointerSha256,
    engineDigest: audit.manifest.engineDigest, engineFingerprint: audit.manifest.engineFingerprint},
    analysisLimits: ANALYSIS_LIMITS,
    privateInputs: {pendingJobs: privateJobs.filter(job => job.kind === 'private-pending').length,
      currentJobs: privateJobs.filter(job => job.kind === 'private-current').length},
    sourceCoverage: audit.coverage, sourceIssues: audit.issues.length,
    sourceIssueKinds: [...audit.issues.reduce((counts, issue) => counts.set(issue.kind,
      (counts.get(issue.kind) || 0) + 1), new Map()).entries()].map(([kind, count]) => ({kind, count})).sort((a, b) => a.kind.localeCompare(b.kind))};
  summary.coverage.sourceSnapshotComplete = audit.coverage.complete;
  const json = `${JSON.stringify(summary, null, 2)}\n`, md = markdown(summary);
  if (Buffer.byteLength(json) + Buffer.byteLength(md) > MAX_REPORT_BYTES) throw Error('Private report exceeds 64 MiB safety bound');
  await writeExclusive(base + '.json', json);
  try { await writeExclusive(base + '.md', md); }
  catch (error) { throw Error(`JSON report exists at ${base}.json; Markdown report failed: ${error.message}`); }
  return {report: base, counts: summary.counts, coverage: summary.coverage, findings: summary.findings.length};
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value) throw Error('Missing option value');
    if (flag === '--report') options.report = value;
    else if (flag === '--max-pairs' && /^\d+$/.test(value)) options.maxPairs = Number(value);
    else if (flag === '--max-work' && /^\d+$/.test(value)) options.maxSegmentWork = Number(value);
    else if (flag === '--pending-file' && !options.pendingFile) options.pendingFile = value;
    else if (flag === '--extra-file' && !options.extraFile) options.extraFile = value;
    else throw Error('Usage: node segment-audit.mjs --report <absolute-private-path> [--pending-file <private-capture>] [--extra-file <private-current-capture>] [--max-pairs N] [--max-work N]');
  }
  if (!options.report) throw Error('Usage: node segment-audit.mjs --report <absolute-private-path> [--pending-file <private-capture>] [--extra-file <private-current-capture>] [--max-pairs N] [--max-work N]');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSegmentAudit({...parseArgs(process.argv.slice(2)), onProgress: progress => console.error(JSON.stringify(progress))})
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(String(error?.message || error)); process.exitCode = 1; });
}
