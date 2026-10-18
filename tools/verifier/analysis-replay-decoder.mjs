import zlib from 'node:zlib';

export const ANALYSIS_LIMITS = Object.freeze({
  replayCharacters: 262144,
  compressedBytes: 196608,
  inflatedBytes: 150018,
  transitionsPerChannel: 20000,
  transitions: 50000,
  maxTick: 5999999,
  timeMs: 5999999
});

export class AnalysisReplayError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function reject(reason) { throw new AnalysisReplayError(reason); }

export function decodeAnalysisReplay(replay, timeMs) {
  if (typeof replay !== 'string' || !replay.length) reject('invalid_replay_type');
  if (replay.length > ANALYSIS_LIMITS.replayCharacters) reject('analysis_replay_size_limit');
  if (!Number.isSafeInteger(timeMs) || timeMs <= 0 || timeMs > ANALYSIS_LIMITS.timeMs) reject('analysis_time_limit');
  if (!/^[A-Za-z0-9_-]+$/.test(replay) || replay.length % 4 === 1) reject('invalid_base64url');
  const compressed = Buffer.from(replay, 'base64url');
  if (compressed.toString('base64url') !== replay) reject('noncanonical_base64url');
  if (compressed.length > ANALYSIS_LIMITS.compressedBytes) reject('analysis_compressed_size_limit');

  let inflated;
  try {
    inflated = zlib.inflateSync(compressed, {maxOutputLength: ANALYSIS_LIMITS.inflatedBytes, info: true});
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') reject('analysis_inflated_size_limit');
    reject('invalid_zlib');
  }
  if (inflated.engine.bytesWritten !== compressed.length) reject('trailing_compressed_bytes');

  const bytes = inflated.buffer, lists = {};
  const names = ['up', 'right', 'down', 'left', 'reset'];
  let scan = 0, total = 0;
  for (const _name of names) {
    if (scan + 3 > bytes.length) reject('truncated_transition_count');
    const count = bytes.readUIntLE(scan, 3);
    scan += 3;
    if (count > ANALYSIS_LIMITS.transitionsPerChannel) reject('analysis_channel_transition_limit');
    total += count;
    if (total > ANALYSIS_LIMITS.transitions) reject('analysis_transition_limit');
    scan += count * 3;
    if (scan > bytes.length) reject('truncated_transition_list');
  }
  if (scan < bytes.length) reject('trailing_transition_bytes');
  let cursor = 0;
  for (const name of names) {
    const count = bytes.readUIntLE(cursor, 3);
    cursor += 3;
    const frames = [];
    let frame = 0;
    for (let index = 0; index < count; index++) {
      const delta = bytes.readUIntLE(cursor, 3);
      cursor += 3;
      if (index > 0 && delta === 0) reject('non_increasing_transitions');
      frame += delta;
      if (frame > ANALYSIS_LIMITS.maxTick) reject('analysis_frame_limit');
      if (frame > timeMs) reject('transition_after_claim');
      frames.push(frame);
    }
    lists[name] = frames;
  }
  return {lists, transitions: total, inflatedBytes: bytes.length};
}
