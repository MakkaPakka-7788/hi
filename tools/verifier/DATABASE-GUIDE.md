# PolyTrack Database Guide

## The Collections You Usually Need

| What you want | Collection | What to filter or inspect |
| --- | --- | --- |
| Suspicious runs to review | `0.6.2_s1_review_inbox` | `status == open`. Input similarity, rapid inputs, exact duplicates, and verification mismatches. Review evidence; no automatic account ban. |
| Track reports from players | `0.6.2_extra_track_reports` | Track ID, report reasons, and reporter records. A complaint is not a confirmed violation. |
| Submitted tracks to consider | `0.6.2_extra_track_submissions` | `status == pending`; permission, code, author, tags. |
| Normal verification backlog | `0.6.2_s1_verification` | `pending == true`; per-track `slots` and `notBefore`. |
| Extra verification backlog | `0.6.2_s1_extra_verification` | Same structure as normal queue. |
| Event verification progress | `0.6.2_event_runs`, `0.6.2_event_queues`, `0.6.2_event_receipts` | Period ID, status, proof/reason and receipt time. Not all unavailable runs are bad runs. |
| Published track rankings | `0.6.2_s1_leaderboards_track` | Track ID; entries, complete flag, update time. |
| Overall rankings and summary | `0.6.2_s1_leaderboards_overall` | Published entries and track summaries. |
| Event standings | `0.6.2_event_public`, `0.6.2_event_totals` | Current/past period and lifetime totals. |
| Past events | `0.6.2_event_archives`, `0.6.2_event_archive_tracks` | Period IDs and archived track information. |
| Racer information | `0.6.2_profiles_public` | Account ID, public name, car, cosmetics and saved stats. |
| Actual saved PB | `0.6.2_race_results` | Document ID is account ID plus track ID. |
| Rename moderation | `0.6.2_moderation_names`, `0.6.2_admin_audit` | Replacement name and moderation history. |
| Cosmetic publishing | `0.6.2_s1_cosmetic_jobs`, `0.6.2_s1_cosmetic_entitlements` | Pending job versus server-issued permissions. |
| All verification verdicts | `0.6.2_s1_verification_audit` | Exact run-version history. Do not browse this to find review cases. |

## Reviewing A Finding

Open the review inbox and add an equality filter for `status` with value `open`.
Each document includes the racer ID, track ID, run ID, detection time, category,
reason, and audit ID. Similarity findings also include reference evidence.
For normal and Extra runs, the document ID matches its verification audit ID.
For event findings, use `periodId` and `resultId` to locate the run in
`0.6.2_event_runs`; its finding ID is a stable event-specific identifier, not a
normal verification-audit document ID.

The inbox covers normal, Extra, and event verification. Temporary unavailable
verdicts are not treated as suspicious runs. A rapid-input or similarity flag
requires review; it does not establish that a person cheated. Exact-copy
rejections are recorded here too, without automatically banning the account.

After investigating, change only `status` to `resolved` or `dismissed`, and add a
`reviewNote` if useful. These are private administrative decisions, not automatic
bans. Do not edit PB times, replay proofs, queue bindings or leaderboard snapshots
to resolve a finding. A finding may describe an older PB superseded by a new run.

## Background Collections

`0.6.2_s1_worker_jobs` and `0.6.2_system` hold reconciliation cursors and server
state. `0.6.2_event_catalog`, `event_periods`, `event_cursors`, `event_owners`,
`event_pbs`, `event_inbox`, `event_replays`, `event_retries`, `event_quotas`,
`event_sessions` and `event_soft_targets` coordinate event intake and processing.
Do not delete these to clear a backlog.

`0.6.2_s1_badges`, `s1_release_meta`, `s1_group_tags`, and `daily_streaks` hold
public metadata and feature state. `0.6.2_extra_unranked_leaderboards` holds
unranked Extra results. `0.6.2_car_previews` contains separate rendered previews.

`0.6.2_multiplayer_invites`, `multiplayer_sessions`, and `multiplayer_messages`
are short-lived signaling records. `0.6.2_moderators`, `admin_code` and
`admin_sessions` contain access-control data and should not be shared.

`0.6.2_leaderboards_track` and `0.6.2_leaderboards_overall` are legacy collections,
not the authoritative S1 standings. Do not delete or loosen rules for them without
checking compatibility paths first.

## Rules And Cost

The supplied rules deny client access to unlisted collections, including the
review inbox, verification queues and audits. Firebase Console administrators
and service accounts use IAM, not these client rules. No rules change is needed
for the private review inbox. Do not give game clients read access to it.

Extra submissions and reports use authenticated Worker endpoints, not direct
client collection writes. Their absence from the client rules is intentional;
school-blocked Workers can still prevent those optional requests from reaching
the server. Do not fix this by allowing arbitrary client writes.

The inbox adds no operations for normal successful runs. A flagged finding costs
one additional read and one write only when newly created. Private report reads
are on demand and bounded; no background listeners or counters scan the audit.
Existing historical verdicts are not automatically copied or deleted.

This guide maps current code paths, not a guarantee that every historical
collection or every stored record has been inspected. Collection size is not a
cheater count. Account ID ownership and legacy client-writable caches require
separate security work; reorganizing collections does not resolve those risks.
