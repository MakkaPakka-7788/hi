const CHANNELS = ['right', 'down', 'left', 'reset'];
const ALL_CHANNELS = ['up', ...CHANNELS];
const MAX_TICK = 5999999;
const MAX_CHANNEL_EVENTS = 20000;
const MAX_TOTAL_EVENTS = 50000;
const MIN_MATCHED_CHANGES = 20;
const MIN_INFORMATIVE_MS = 1000;
const MIN_INPUT_SIMILARITY = 0.95;

function validateControls(controls, timeMs) {
  if (!controls || !controls.lists || !Number.isSafeInteger(timeMs) || timeMs <= 0 || timeMs > MAX_TICK) return false;
  let total = 0;
  for (const name of ALL_CHANNELS) {
    const values = controls.lists[name];
    if (!Array.isArray(values) || values.length > MAX_CHANNEL_EVENTS) return false;
    total += values.length;
    if (total > MAX_TOTAL_EVENTS) return false;
    let previous = -1;
    for (const tick of values) {
      if (!Number.isSafeInteger(tick) || tick < 0 || tick > timeMs || tick > MAX_TICK || tick <= previous) return false;
      previous = tick;
    }
  }
  return true;
}

function steeringEvents(controls) {
  return CHANNELS.flatMap((name, index) => controls.lists[name].map(tick => ({channel: index + 1, tick})))
    .sort((a, b) => a.tick - b.tick || a.channel - b.channel);
}

function prepare(controls) {
  const events = steeringEvents(controls), tokens = [];
  for (let index = 1; index < events.length; index++) {
    const previous = events[index - 1], current = events[index];
    tokens.push((previous.channel * 5 + current.channel) * (MAX_TICK + 1) + current.tick - previous.tick);
  }
  const groups = [];
  let state = 0, cursor = 0, activeMs = 0;
  for (let index = 0; index < events.length;) {
    const tick = events[index].tick;
    if (state) activeMs += tick - cursor;
    while (index < events.length && events[index].tick === tick) {
      state ^= 1 << events[index].channel;
      index++;
    }
    groups.push({tick, state, activeUntil: activeMs});
    cursor = tick;
  }
  function groupBefore(tick) {
    let low = 0, high = groups.length;
    while (low < high) { const middle = (low + high) >>> 1; if (groups[middle].tick <= tick) low = middle + 1; else high = middle; }
    return low - 1;
  }
  function stateAt(tick) { const index = groupBefore(tick); return index < 0 ? 0 : groups[index].state; }
  function activeAt(tick) {
    const index = groupBefore(tick);
    if (index < 0) return 0;
    const group = groups[index];
    return group.activeUntil + (group.state ? tick - group.tick : 0);
  }
  function activeDuration(start, end) { return Math.max(0, activeAt(end) - activeAt(start)); }
  function channelMask(start, end) {
    let mask = 0;
    for (let index = start; index < end; index++) mask |= 1 << events[index].channel;
    return mask;
  }
  return {events, tokens, stateAt, activeDuration, channelMask};
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

function bitCount(value) { let count = 0; for (; value; value &= value - 1) count++; return count; }

function allChannelAgreement(controlsA, controlsB, startA, endA, startB) {
  const boundaries = new Set([startA, endA]);
  for (const name of ALL_CHANNELS) {
    for (const tick of controlsA.lists[name]) if (tick > startA && tick < endA) boundaries.add(tick);
    for (const tick of controlsB.lists[name]) {
      const mapped = startA + tick - startB;
      if (mapped > startA && mapped < endA) boundaries.add(mapped);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  let matchingMs = 0;
  function stateAt(controls, tick) {
    let state = 0;
    for (let channel = 0; channel < ALL_CHANNELS.length; channel++) {
      const values = controls.lists[ALL_CHANNELS[channel]];
      let low = 0, high = values.length;
      while (low < high) { const middle = (low + high) >>> 1; if (values[middle] <= tick) low = middle + 1; else high = middle; }
      if (low % 2) state |= 1 << channel;
    }
    return state;
  }
  for (let index = 0; index + 1 < sorted.length; index++) {
    const tickA = sorted[index], tickB = startB + tickA - startA;
    if (stateAt(controlsA, tickA) === stateAt(controlsB, tickB)) matchingMs += sorted[index + 1] - tickA;
  }
  return matchingMs / Math.max(1, endA - startA);
}

function findSegment(a, b) {
  if (a.tokens.length < MIN_MATCHED_CHANGES - 1 || b.tokens.length < MIN_MATCHED_CHANGES - 1) return null;
  const short = a.tokens.length <= b.tokens.length ? a : b, long = short === a ? b : a;
  const states = buildSuffixAutomaton(short.tokens);
  let current = 0, matched = 0, best = null;
  for (let position = 0; position < long.tokens.length; position++) {
    const token = long.tokens[position];
    while (current && !states[current].transitions.has(token)) {
      current = states[current].link;
      matched = Math.min(matched, states[current].length);
    }
    if (states[current].transitions.has(token)) { current = states[current].transitions.get(token); matched++; }
    else { current = 0; matched = 0; }
    if (matched < MIN_MATCHED_CHANGES - 1) continue;
    const startShort = states[current].firstPos - matched + 1;
    const endShort = startShort + matched, startLong = position - matched + 1, endLong = position + 1;
    const first = short.events[startShort].tick, last = short.events[endShort].tick;
    const firstLong = long.events[startLong].tick, lastLong = long.events[endLong].tick;
    if (last - first < MIN_INFORMATIVE_MS || lastLong - firstLong < MIN_INFORMATIVE_MS) continue;
    if (bitCount(short.channelMask(startShort, endShort + 1)) < 2 || bitCount(long.channelMask(startLong, endLong + 1)) < 2) continue;
    const activeShort = short.activeDuration(first, last), activeLong = long.activeDuration(firstLong, lastLong);
    if (Math.min(activeShort, activeLong) < MIN_INFORMATIVE_MS || short.stateAt(first) !== long.stateAt(firstLong)) continue;
    const startTickA = short === a ? first : firstLong, endTickA = short === a ? last : lastLong;
    const startTickB = short === a ? firstLong : first, endTickB = short === a ? lastLong : last;
    const candidate = {matchedChanges: matched + 1, startTickA, endTickA, startTickB, endTickB,
      offsetTicks: startTickB - startTickA, informativeMs: Math.min(activeShort, activeLong),
      steeringActiveMsA: short === a ? activeShort : activeLong,
      steeringActiveMsB: short === a ? activeLong : activeShort,
      distinctSteeringChannels: bitCount(short.channelMask(startShort, endShort + 1))};
    if (!best || candidate.matchedChanges > best.matchedChanges ||
        candidate.matchedChanges === best.matchedChanges && candidate.endTickA - candidate.startTickA > best.endTickA - best.startTickA) best = candidate;
  }
  return best;
}

export function compareInputSegment(controlsA, controlsB, timeA, timeB) {
  if (!validateControls(controlsA, timeA) || !validateControls(controlsB, timeB)) return null;
  const preparedA = prepare(controlsA), preparedB = prepare(controlsB);
  const segment = findSegment(preparedA, preparedB);
  if (!segment) return null;
  const inputSimilarity = allChannelAgreement(controlsA, controlsB, segment.startTickA,
    segment.endTickA, segment.startTickB);
  const transitionSimilarity = 1;
  if (inputSimilarity < MIN_INPUT_SIMILARITY) return null;
  return {inputSimilarity, transitionSimilarity, informativeMs: segment.informativeMs,
    matchedChanges: segment.matchedChanges, distinctSteeringChannels: segment.distinctSteeringChannels,
    steeringActiveMsA: segment.steeringActiveMsA, steeringActiveMsB: segment.steeringActiveMsB,
    startTickA: segment.startTickA, endTickA: segment.endTickA,
    startTickB: segment.startTickB, endTickB: segment.endTickB,
    offsetTicks: segment.offsetTicks, reviewOnly: true};
}
