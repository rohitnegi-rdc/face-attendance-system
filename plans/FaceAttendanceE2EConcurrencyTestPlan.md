# Face Attendance E2E and Concurrency Test Plan

## Summary

Build a reproducible 20-image group-photo corpus, exercise the real SvelteKit -> PostgreSQL
queue -> worker -> InsightFace pipeline, verify biometric duplicate matching and attendance
persistence, then repair and rerun any confirmed application defects.

Testing will use the current local stack but only newly created `E2E-*` areas, vendors, pumps,
sessions, and people. Existing operational records remain untouched.

## Test Infrastructure

### 1. Photo corpus

- Source permissively licensed public group photos and record the original URL, author, license,
  checksum, visible-face count, and identity cohort in
  `tests/fixtures/group-e2e/manifest.json`.
- Build four recurring identity cohorts with five cases each: baseline, alternate/partial group,
  low light, resize/compression, and crop/occlusion or duplicated-face composition.
- Include varied group sizes, face sizes, skin tones, poses, lighting, partial overlap, missing
  morning/evening members, and known recurring identities.
- Add separate negative fixtures for no-face, corrupt-file, unsupported-file, and oversized-upload
  testing; these do not count toward the 20 valid group photos.

### 2. Run isolation

- Generate a unique run ID and create dedicated same-Area and different-Area test pumps under an
  `E2E-<run-id>` namespace.
- Retain these tagged records for inspection, as selected.
- Use direct database helpers only for setup, timestamp advancement, and evidence collection. All
  attendance submissions and status checks still pass through the real HTTP application.
- Run against real PostgreSQL, worker, filesystem upload volume, and InsightFace service. Face
  extraction and matching will not be mocked.

### 3. Output structure

- Store everything under `test-output/attendance-e2e/<run-id>/`.
- Produce `run.json`, `corpus-manifest.json`, `detection-summary.csv`, `matching-matrix.csv`,
  `attendance-audit.json`, `queue-timings.json`, `E2EReport.md`, Playwright traces, and
  screenshots.
- For every photo, store the original, bounding-box overlay, numbered face crops, and a JSON record
  containing bbox coordinates, 512 finite embedding values, embedding norm, crop checksum, and
  matching results.
- Keep raw embeddings and bulky run artifacts local and git-ignored; commit the reproducible
  fixture manifest, license metadata, test code, and redacted report.

## Test Scenarios

### 1. Detection and embedding contract

- Process all 20 images directly through `/internal/face/extract`.
- Compare detected faces with manually recorded visible-face ground truth.
- Assert valid in-image bounding boxes, non-empty crops, one 512-dimensional finite embedding per
  face, approximately unit-normalized embeddings, and no duplicated detector output for a single
  face.
- Record missed faces, false detections, processing time, and confidence-independent visual
  overlays for manual inspection.

### 2. Biometric duplication and identity matching

- Verify recurring people across lighting, compression, resize, partial crop, and alternate group
  cases match at `FACE_MATCH_THRESHOLD=0.68`.
- Verify unrelated faces remain separate and report false-positive/false-negative pairs.
- Test the same face pasted twice within one group: one person and one daily-attendance row, without
  double counting.
- Test mixed known/new groups and assert exact matched-person and newly-created-person counts.
- Assert each person's embedding gallery never exceeds five entries.

### 3. Attendance business rules

- First morning submission creates people and sets only `morning_matched`.
- Evening after nine hours matches returning people, records new evening-only people, and leaves
  missing people morning-only.
- Assert final classification: both flags -> present, morning-only/evening-only -> absent with the
  correct yearly counter.
- Verify immediate evening rejection, completed-day rejection, exact upload retry idempotency,
  midnight rollover pairing, and 24-hour morning expiry.
- Verify the evening session inherits the morning `session_date` and both sessions link
  symmetrically.
- Test same-face submission at another pump in the same Area as fraud with no attendance credit.
- Test the same face in another Area as a separate pump-scoped identity.
- Verify zero-face and AI failures become explicit completed-empty or failed outcomes according to
  the finalized contract, never indefinitely pending.

### 4. Persistence audit

- For every accepted submission, assert exactly one stored image, session row, request ID, and
  queue job.
- Verify legal status progression: `pending -> processing -> completed` or `failed`.
- Cross-check API results, UI counts, persons, vectors, daily attendance, yearly rollups, fraud
  flags, pairing links, and upload files.
- Assert rejected requests create no session, job, attendance, person, or orphan upload.
- Recompute expected rollups independently from daily rows and compare them with persisted yearly
  counters.

### 5. Multiple-call and queue testing

- Burst 20 unique uploads across independent test Areas to measure web/API acceptance without lock
  contention.
- Burst 20 uploads across pumps in one Area to verify Area-level serialization and fraud
  correctness.
- Send 20 simultaneous submissions to one pump and require deterministic business rejections, no
  HTTP 500 responses, one valid morning at most, and no orphan jobs/files.
- Repeat with one worker and multiple worker containers to validate `FOR UPDATE SKIP LOCKED`
  claiming and exactly-once processing.
- Assert no lost, duplicated, permanently `queued`, or permanently `claimed` jobs.
- Require synchronous submission p95 below the MasterPlan's one-second target, zero unexpected
  5xx/timeouts, and a fully drained queue. Record AI throughput and lock-wait timings without
  imposing a hardware-independent worker completion SLA.

## UI and Reactive Coverage

- Assert each derived state immediately after its triggering action: session title, status badge,
  enabled controls, selected filename/size, upload state, processing step, matched/new/fraud
  counts, total people found, next-allowed time, and locked state.
- Capture screenshots after photo selection, while queued/processing, and after completion; also
  capture waiting and failure states.
- Test partial states explicitly: selected but not submitted, morning completed but evening
  unavailable, evening newly available after timestamp advancement, and mixed matched/new results
  before pressing Done.
- Cross-check every displayed result count with the status API and database; this will detect the
  current risk of a newly created person appearing in both `matched` and `new_persons`.
- Add a Svelte source regression check preventing template helpers from reading reactive state only
  through hidden function dependencies.
- Convert affected displays such as `sessionTitle()` to explicit `$derived` values or pass the
  reactive value literally at the template call site.

## Defect Repair and Delivery

- Write failing regression tests before changing confirmed behavior.
- Transactionally protect session decision, duplicate check, session insertion, pairing updates,
  job insertion, and upload cleanup.
- Move `BEGIN` before `pg_advisory_xact_lock` so the Area lock covers the entire worker
  transaction.
- Make queue claiming crash-recoverable and prevent duplicate jobs for one session.
- Correct status-result classification so matched and newly created collections are mutually
  exclusive.
- Make yearly rollups idempotent per person/date and verify retries cannot increment them twice.
- Run `npm run check`, production build, extraction suite, Playwright E2E suite, and all
  concurrency profiles.
- Append a new dated output section to `plans/ImplementationSummary.md`; preserve all existing
  content.
- Stage and commit in reviewable steps: corpus/harness, E2E scenarios, concurrency tests, confirmed
  fixes, then report/summary.
- Run `graphify update .` after code changes and review the final diff before committing.

## Assumptions

- "Duplication logic" primarily means duplicate face identity and attendance counting; exact-file
  retry idempotency remains a supporting test.
- The unanswered preferences use the recommended defaults: mixed controlled public-photo corpus,
  fix-and-rerun, and retained tagged E2E database records.
- Public photos must permit test redistribution; source and license attribution are mandatory.
- Biometric embeddings remain local test artifacts and are never written to application logs or
  committed.
- Current implementation behavior is not treated as proof of correctness where it conflicts with
  MasterPlan invariants.
