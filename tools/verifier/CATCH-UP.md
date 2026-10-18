# Catch Up Verification

In GitHub, open **Actions > Verify PolyTrack runs > Run workflow**, enable
**Catch up backlog**, and start one run. Leave it running rather than repeatedly
starting more workflows.

| Mode | Maximum rounds | Maximum native attempts | Processing HTTP request cap |
| --- | --- | --- | --- |
| Normal / scheduled | 4 | 64 | 400 |
| Manual Catch-Up | 12 | 192 | 1,200 |

These are ceilings, not promises of verified runs. Each round still reserves event
work, prioritizes estimated RP impact, includes an aging quota, and lets normal
work borrow unused event slots. Extra work uses remaining capacity. No physics,
trusted-track, replay, or per-attempt resource limits are relaxed.

Catch-Up reuses one dependency/browser setup. It admits rounds within a 12-minute
processing window with a finishing reserve; the processing step has a 15-minute
hard timeout and the whole job a 25-minute timeout. It stops early when no progress
is possible, Firebase throttles, infrastructure fails, or its budget runs low.
Future-dated retries are not forced due.

Catch-Up uses more Firebase quota per workflow than Normal. HTTP requests are not
billed document reads: consult the summary's estimated document reads as well.
Preflight has its own small bounded read sample, outside the processing cap.
Use Catch-Up for a backlog, not as a replacement for scheduled verification.

All runs share one concurrency group: one runs at a time. Repeated launches do not
increase processing speed and can replace an older pending run. Serialization
prevents duplicate simulation and competing publications.

If waiting reasons include `missing_trusted_track`, `scan_work_limit`, or
`time_limit`, longer batches do not repair those individual runs. They need
separate diagnosis; slow or unavailable runs are never automatically approved.

Within one drain, event batches resume after the last served period. This prevents twelve fast Catch-Up rounds from repeatedly serving only the first period while the clock-based discovery rotation is unchanged. The cursor is in memory only; event reservations, request caps, and retry eligibility do not change.

A verified proof and a published green badge are distinct stages. Use the private diagnostic publication state to distinguish an accepted proof awaiting board reconciliation from a deferred verification retry. Repeated Catch-Up workflows cannot fix delayed publication. Normal native capacity is also conditional on the remaining shared request budget, not a guarantee of twelve checks when event intake is expensive.
