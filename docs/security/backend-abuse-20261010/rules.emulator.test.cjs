const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');

// Refuse to run against a real project, even if ambient credentials exist.
const endpoint = process.env.FIRESTORE_EMULATOR_HOST || '';
assert.match(endpoint, /^(127\.0\.0\.1|localhost):[0-9]+$/, 'A loopback emulator is mandatory');
const [host, port] = endpoint.split(':');
const deps = process.env.AUDIT_DEPS_DIR
  ? createRequire(path.resolve(process.env.AUDIT_DEPS_DIR, 'package.json')) : require;
const {initializeTestEnvironment, assertSucceeds, assertFails} = deps('@firebase/rules-unit-testing');
const {doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, Timestamp} = deps('firebase/firestore');

const account = 'a'.repeat(64), track = 'b'.repeat(64);
const now = () => Date.now();
const day = (offset = 0) => new Date(now() + offset * 86400000).toISOString().slice(0, 10);
const invite = () => ({inviteCode: 'ABCDEF', hostUid: 'host', hostSocketId: 'host-socket',
  key: '', hostNickname: 'Host', createdAt: now(), expiresAt: now() + 1800000});
const session = () => ({session: 'session-1', inviteCode: 'ABCDEF', hostUid: 'host', hostSocketId: 'host-socket',
  joinUid: 'guest', joinSocketId: 'guest-socket', createdAt: now(), expiresAt: now() + 1800000});
const message = () => ({session: 'session-1', senderUid: 'guest', targetUid: 'host', targetSocketId: 'host-socket',
  payload: {type: 'joinInvite', session: 'session-1', offer: 'synthetic SDP', version: '0.6.3', mods: [],
    isModsVanillaCompatible: true, nickname: 'Guest', countryCode: null, carStyle: 'default', iceServers: []},
  createdAt: now(), expiresAt: now() + 120000});
const streak = () => ({accountId: account, ownerUid: 'guest', name: 'Guest', currentStreak: 0, bestStreak: 0,
  activityDay: day(), completedDay: '', lastTrackId: track, dayRuns: 1, dayPbs: 1,
  bestPbImprovementMs: 10, bestRunTimeMs: 1000, goalCompleted: false, updatedAt: now()});
const inbox = () => ({accountId: account, trackId: track, attemptId: 'attempt-1', timeMs: 1000, frames: 1000,
  replay: 'synthetic-replay', carStyle: '', periodId: 'period-1', ownerUid: 'guest', receivedAt: serverTimestamp()});

for (const variant of ['production-supplied', 'candidate']) {
  test(`${variant}: actual Firestore rule decisions`, async t => {
    const env = await initializeTestEnvironment({projectId: `demo-polytrack-abuse-${variant}`,
      firestore: {host, port: Number(port), rules: fs.readFileSync(path.join(__dirname, `${variant}.rules`), 'utf8')}});
    const guest = env.authenticatedContext('guest').firestore();
    const hostDb = env.authenticatedContext('host').firestore();
    const stranger = env.authenticatedContext('stranger').firestore();
    const anon = env.unauthenticatedContext().firestore();
    const seed = (p, data) => env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), p), data));
    const expectClosed = promise => variant === 'candidate' ? assertFails(promise) : assertSucceeds(promise);
    const invitePath = '0.6.2_multiplayer_invites/ABCDEF';
    const sessionPath = '0.6.2_multiplayer_sessions/session-1';
    const messagePath = '0.6.2_multiplayer_messages/message-1';
    const dailyPath = `0.6.2_daily_streaks/${account}`;
    const eventPath = `0.6.2_event_inbox/period-1_${account}`;
    async function scenario(name, run) {
      await t.test(name, async () => {await env.clearFirestore(); await run();});
    }
    try {
      await scenario('legacy overall overwrite', () => expectClosed(setDoc(doc(guest, '0.6.2_leaderboards_overall/main'),
        {entries: [{accountId: account, rank: 1}], updatedAt: now(), seededBy: 'guest', revision: 1, builtRevision: 1})));
      await scenario('legacy track arbitrary entry', () => expectClosed(setDoc(doc(guest, `0.6.2_leaderboards_track/${track}`),
        {trackId: track, entries: [{accountId: account, pbAt: 1}], updatedAt: now(), schemaVersion: 2})));
      await scenario('current school snapshots stay public and client read-only', async () => {
        for (const p of [`0.6.2_s1_leaderboards_track/${track}`, '0.6.2_s1_leaderboards_overall/main',
          '0.6.2_event_public/catalog', `0.6.2_s1_badges/${account}`, '0.6.2_s1_release_meta/current',
          `0.6.2_leaderboards_track/${track}`, '0.6.2_leaderboards_overall/main']) {
          await seed(p, {entries: []});
          await assertSucceeds(getDoc(doc(anon, p)));
          if (!p.includes('0.6.2_leaderboards_')) await assertFails(setDoc(doc(guest, p), {entries: []}));
        }
      });
      await scenario('valid multiplayer invite, join, messages and cleanup', async () => {
        await assertSucceeds(setDoc(doc(hostDb, invitePath), invite()));
        await assertSucceeds(getDoc(doc(guest, invitePath)));
        await assertSucceeds(setDoc(doc(guest, sessionPath), session()));
        await assertSucceeds(setDoc(doc(guest, messagePath), message()));
        await assertSucceeds(getDoc(doc(hostDb, messagePath)));
        await assertSucceeds(deleteDoc(doc(hostDb, messagePath)));
        for (const payload of [
          {type: 'acceptJoin', answer: 'synthetic SDP', mods: [], isModsVanillaCompatible: true, clientId: 4},
          {type: 'declineJoin', reason: 'SessionFull'},
          {type: 'iceCandidate', candidate: {candidate: 'candidate:data', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'test'}},
          {type: 'iceCandidate', candidate: null}
        ]) {
          await assertSucceeds(setDoc(doc(hostDb, messagePath), {...message(), senderUid: 'host', targetUid: 'guest',
            targetSocketId: 'guest-socket', payload: {...payload, version: '0.6.3', session: 'session-1'}}));
          await assertSucceeds(deleteDoc(doc(guest, messagePath)));
        }
        await assertSucceeds(deleteDoc(doc(guest, sessionPath)));
        await assertSucceeds(deleteDoc(doc(hostDb, invitePath)));
      });
      for (const [name, alteration] of [
        ['expired invite update', {expiresAt: 1}],
        ['unbounded invite key update', {key: 'x'.repeat(2048)}],
        ['invite socket retargeting', {hostSocketId: 'other-socket'}],
        ['wrong invite field type', {hostNickname: {nested: 'data'}}]
      ]) await scenario(name, async () => {
        await seed(invitePath, invite());
        await expectClosed(updateDoc(doc(hostDb, invitePath), alteration));
      });
      await scenario('bounded invite refresh remains valid', async () => {
        await seed(invitePath, invite());
        await assertSucceeds(updateDoc(doc(hostDb, invitePath), {expiresAt: now() + 1800000, hostNickname: 'New name'}));
      });
      await scenario('expired session cannot send fresh messages', async () => {
        await seed(sessionPath, {...session(), expiresAt: now() - 1000});
        await expectClosed(setDoc(doc(guest, messagePath), message()));
      });
      await scenario('destination socket must belong to session', async () => {
        await seed(sessionPath, session());
        await expectClosed(setDoc(doc(guest, messagePath), {...message(), targetSocketId: 'other-host-tab'}));
      });
      await scenario('payload cannot refer to another session', async () => {
        await seed(sessionPath, session());
        await expectClosed(setDoc(doc(guest, messagePath), {...message(), payload: {...message().payload, session: 'another-session'}}));
      });
      await scenario('session document ID limited to relay-compatible length', async () => {
        await seed(invitePath, invite());
        await expectClosed(setDoc(doc(guest, '0.6.2_multiplayer_sessions/' + 's'.repeat(129)), {...session(), session: 's'.repeat(129)}));
      });
      await scenario('unrelated caller cannot inject into session', async () => {
        await seed(sessionPath, session());
        await assertFails(setDoc(doc(stranger, messagePath), {...message(), senderUid: 'stranger'}));
      });
      await scenario('RESIDUAL: large nested payload and repeated IDs are still admitted', async () => {
        await seed(sessionPath, session());
        for (let i = 0; i < 3; i++) await assertSucceeds(setDoc(doc(guest, `${messagePath}-${i}`),
          {...message(), payload: {...message().payload, extra: {padding: 'x'.repeat(200000)}}}));
      });
      await scenario('daily initial incomplete milestone', () => assertSucceeds(setDoc(doc(guest, dailyPath), streak())));
      await scenario('instant 10000-day public streak', () => expectClosed(setDoc(doc(guest, dailyPath),
        {...streak(), currentStreak: 10000, bestStreak: 10000, goalCompleted: true, completedDay: day()})));
      await scenario('arbitrary ten-character activity day', () => expectClosed(setDoc(doc(guest, dailyPath),
        {...streak(), activityDay: 'abcdefghij'})));
      await scenario('stale write clock', () => expectClosed(setDoc(doc(guest, dailyPath),
        {...streak(), updatedAt: now() - 600000})));
      await scenario('first daily completion and unchanged completed streak', async () => {
        await seed(dailyPath, {...streak(), dayRuns: 2, dayPbs: 1});
        const completed = {...streak(), dayRuns: 3, currentStreak: 1, bestStreak: 1, goalCompleted: true, completedDay: day()};
        await assertSucceeds(setDoc(doc(guest, dailyPath), completed));
        await assertSucceeds(setDoc(doc(guest, dailyPath), {...completed, dayRuns: 4, updatedAt: now()}));
      });
      await scenario('repeat same-day streak increment', async () => {
        const completed = {...streak(), currentStreak: 4, bestStreak: 4, goalCompleted: true, completedDay: day()};
        await seed(dailyPath, completed);
        await expectClosed(setDoc(doc(guest, dailyPath), {...completed, currentStreak: 5, bestStreak: 5, dayRuns: 2}));
      });
      await scenario('consecutive day completion increments once', async () => {
        await seed(dailyPath, {...streak(), activityDay: day(-1), completedDay: day(-1), currentStreak: 4, bestStreak: 4, goalCompleted: true});
        await assertSucceeds(setDoc(doc(guest, dailyPath), {...streak(), completedDay: day(), currentStreak: 5, bestStreak: 5, goalCompleted: true}));
      });
      await scenario('missed-day completion resets current, retains best', async () => {
        await seed(dailyPath, {...streak(), activityDay: day(-2), completedDay: day(-2), currentStreak: 4, bestStreak: 4, goalCompleted: true});
        await assertSucceeds(setDoc(doc(guest, dailyPath), {...streak(), completedDay: day(), currentStreak: 1, bestStreak: 4, goalCompleted: true}));
      });
      await scenario('existing client milestone jump already fails both rulesets', async () => {
        await seed(dailyPath, streak());
        await assertFails(setDoc(doc(guest, dailyPath), {...streak(), dayRuns: 3, completedDay: day(), goalCompleted: true, currentStreak: 1, bestStreak: 1}));
      });
      async function seedEvent() {
        await seed(`0.6.2_profiles_public/${account}`, {accountId: account, ownerUid: 'guest'});
        await seed('0.6.2_event_periods/period-1', {id: 'period-1', enabled: true, trackId: track, startsAt: now() - 60000, endsAt: now() + 3600000});
      }
      await scenario('direct event create still works without Worker', async () => {
        await seedEvent(); await assertSucceeds(setDoc(doc(guest, eventPath), inbox()));
      });
      await scenario('event improvement after five seconds remains admissible', async () => {
        await seedEvent(); await seed(eventPath, {...inbox(), receivedAt: Timestamp.fromMillis(now() - 6000)});
        await assertSucceeds(setDoc(doc(guest, eventPath), {...inbox(), attemptId: 'attempt-2', timeMs: 999, frames: 999}));
      });
      await scenario('event cooldown, equal-time and spoofed-owner writes fail', async () => {
        await seedEvent(); await seed(eventPath, {...inbox(), receivedAt: Timestamp.now()});
        await assertFails(setDoc(doc(guest, eventPath), {...inbox(), attemptId: 'attempt-2', timeMs: 999, frames: 999}));
        await seed(eventPath, {...inbox(), receivedAt: Timestamp.fromMillis(now() - 6000)});
        await assertFails(setDoc(doc(guest, eventPath), {...inbox(), attemptId: 'attempt-2'}));
        await assertFails(setDoc(doc(stranger, eventPath), {...inbox(), ownerUid: 'stranger', attemptId: 'attempt-2', timeMs: 999, frames: 999}));
      });
      await scenario('direct profile plus canonical PB batch still works', async () => {
        const batch = writeBatch(guest);
        batch.set(doc(guest, `0.6.2_profiles_public/${account}`), {accountId: account, ownerUid: 'guest', name: 'Guest', nickname: 'Guest',
          carStyle: 'default', pbCount: 1, isVerifier: false, updatedAt: now()});
        batch.set(doc(guest, `0.6.2_race_results/${account}_${track}`), {accountId: account, ownerUid: 'guest', trackId: track,
          name: 'Guest', nickname: 'Guest', timeMs: 1000, replay: 'synthetic-replay', replayHash: 'synthetic-hash', carStyle: 'default',
          pbCount: 1, raceTimeFrames: 1000, frames: 1000, uploadId: 1, verified: false, verifiedState: 0, createdAt: now(),
          updatedAt: now(), ingestedAt: serverTimestamp(), source: 'emulator-only'});
        await assertSucceeds(batch.commit());
      });
    } finally {await env.cleanup();}
  });
}
