const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, name));
const baseline = read('production-supplied.rules');
const candidate = read('candidate.rules');
const manifest = JSON.parse(read('manifest.json'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function matches(data) {
  const text = data.toString().replace(/\r\n/g, '\n'), result = new Map();
  for (const match of text.matchAll(/^[ \t]*match (\/0\.6\.2[^\n]+) \{\s*$/gm)) {
    const start = text.indexOf('{', match.index + match[0].lastIndexOf('{'));
    let end = start + 1, depth = 1;
    for (; depth && end < text.length; end++) {
      if (text[end] === '{') depth++;
      if (text[end] === '}') depth--;
    }
    assert.equal(depth, 0, match[1]);
    result.set(match[1], text.slice(start, end));
  }
  return result;
}
test('exact supplied baseline and tested candidate hashes', () => {
  assert.equal(hash(baseline), manifest.sourceSha256);
  assert.equal(hash(candidate), manifest.candidateSha256);
  assert.equal(manifest.deployed, false);
});
test('same collection inventory; only six scoped collection matches changed', () => {
  const old = matches(baseline), next = matches(candidate);
  assert.deepEqual([...old.keys()].sort(), [...next.keys()].sort());
  const changed = [...old].filter(([name, value]) => value !== next.get(name)).map(([name]) => name).sort();
  assert.deepEqual(changed, [
    '/0.6.2_leaderboards_track/{trackId}', '/0.6.2_leaderboards_overall/{docId}',
    '/0.6.2_daily_streaks/{accountId}', '/0.6.2_multiplayer_invites/{inviteCode}',
    '/0.6.2_multiplayer_sessions/{sessionId}', '/0.6.2_multiplayer_messages/{messageId}'
  ].sort());
  assert.ok(old.size > 20, 'Do not silently pass without parsing the rules');
});
