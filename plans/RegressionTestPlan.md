# Regression Test Plan

A living catalogue of every behaviour the app must keep. Each scenario has a stable ID. When a bug
is fixed, its scenario is added here (or its status flips to Covered) **in the same change**, and
it is never deleted. This makes "did this change break an earlier fix?" a test result instead of a
memory exercise.

Companion: [ProductionReadinessAudit-2026-10-08.md](ProductionReadinessAudit-2026-10-08.md). Its
blockers appear below as scenarios with status **RED**. Those are tests written to fail today and
pass once the fix lands.

---

## 1. Test tiers

| Tier | What | Runs | Time budget | Command (target) |
|---|---|---|---|---|
| 0 Static | `svelte-check`, ESLint, Prettier, `bash -n` on scripts | Every change, in `deploy.sh` | < 1 min | `npm run check && npm run lint` |
| 1 API + worker (regression gate) | HTTP calls against the built app, real Postgres, real worker, **stub AI service** with deterministic embeddings | Every change, in `deploy.sh` | about 2 min | `npm run test:regression` |
| 2 Browser E2E | Playwright per role, desktop and phone width | Before every deploy (manual), and after UI changes | < 15 min | existing `test:e2e:*` configs |
| 3 Model accuracy | Golden small-group corpus, Pins/LFW approval gate | Only when detection model, embedding model, threshold or matching logic changes | 10–60 min | `eval:golden:run`, `eval:approve` |
| 4 Load and concurrency | Burst submissions, same-Area contention, worker scaling | Before go-live, and after worker or DB changes | 10–30 min | `test:attendance:load`, `eval:attendance:concurrency:*` |

**Why Tier 1 is the key missing piece.** Today every attendance test needs the real ML model.
Results then depend on the photos and the model rather than on our code, so the tests are slow and
sometimes ambiguous. A stub AI service turns face matching into a controlled input:

- The stub implements `POST /internal/face/extract` and `GET /health` with the same response shape as `ai-service/main.py`.
- The test registers what a photo "contains" before uploading it: `photo sha256 -> [identity "W1", identity "W2"]`.
- Each identity maps to a fixed 512-dim unit vector. A variant `W1~0.9` returns a vector with cosine 0.9 to `W1`, so tests can sit exactly above or below `FACE_MATCH_THRESHOLD`.
- Photos are tiny generated PNGs with a random pixel, so every photo has a unique hash.

The Tier 1 runner then covers pairing, matching, fraud, review and rollups exactly and
repeatably. The real model is tested only in Tier 3, where accuracy is the actual question.

**Clock control.** The server uses `now()`. Tests move time by back-dating rows
(`UPDATE attendance_sessions SET submitted_at = submitted_at - interval '10 hours'`) rather than
waiting. IST date-boundary cases set `submitted_at` to explicit instants such as `23:50 IST`.

**Isolation.** Each run creates its own Area, Plant, Vendor and Pumps with a run-id prefix and
deletes them at the end. Tests never touch seed or real data, so the suite can also run against a
staging copy of production.

---

## 2. Scenario catalogue

Status values:
- **Covered**: an automated test exists.
- **Partial**: some of it is tested.
- **Missing**: no test yet.
- **RED**: a known bug; the test should fail until it is fixed.

Priority: P0 = must pass to deploy, P1 = must pass before go-live, P2 = important.

### AUTH: login and sessions

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| AUTH-01 | Valid login for each role (admin, vendor, plant manager, pump) | 200, cookie set, redirected to the role's home | 1, 2 | P0 | Covered (auth-rbac.spec) |
| AUTH-02 | Wrong password, unknown email, empty fields | 401, 401, 400. The same message for wrong password and unknown email (no account enumeration) | 1 | P0 | Covered (auth-rbac.spec) |
| AUTH-03 | Email case-insensitive (`ADMIN@x` logs in as `admin@x`) | 200 | 1 | P1 | Covered (auth-rbac.spec) |
| AUTH-04 | Disabled pump login | 403 "Account disabled" | 1 | P0 | Covered (auth-rbac.spec) |
| AUTH-05 | Disabled pump with a token that is still valid submits a photo | 403, no session row created | 1 | P0 | Covered (auth-rbac.spec) |
| AUTH-06 | First login with `must_change_password` | Every page redirects to `/change-password`. Every API returns 403 except password and logout | 1 | P0 | Covered (auth-rbac.spec) |
| AUTH-07 | Change password: under 12 characters, mismatch, valid | 400, 400, 200 + new 7-day cookie, flag cleared | 1 | P0 | Covered (auth-rbac.spec) |
| AUTH-08 | Temporary token expires after 15 min | Redirected to login | 1 | P2 | Missing |
| AUTH-09 | Tampered or expired JWT | Treated as logged out | 1 | P0 | Covered (auth-rbac.spec) |
| AUTH-10 | Logout | Cookie removed, protected page redirects to login | 1, 2 | P0 | Covered (`interactive-ui-audit`) |
| AUTH-11 | HTTPS (`x-forwarded-proto: https`) sets a `Secure` cookie named `session`; HTTP sets `session_http` | As stated | 1 | P1 | Missing |
| AUTH-12 | Google OAuth: unknown email, disabled pump, valid account | Rejected, rejected, logged in | 1 (stub Google) | P2 | Missing |
| AUTH-13 | Brute force: 20 wrong passwords for one email in 1 min | Throttled (429) | 1 | P1 | **RED** (no rate limit) |
| AUTH-14 | Admin resets a vendor or pump password | Old password fails; new one forces a password change | 1 | P1 | Missing |

### RBAC: who can see what

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| RBAC-01 | Matrix: every role × every page prefix (`/admin`, `/vendor`, `/plant-manager`, `/pump`) | Own prefix 200; others 403; anonymous 302 to login | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-02 | Matrix: every role × every `/api/*` route | Allowed only as in `hooks.server.ts`; others 401 or 403 | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-03 | Pump A reads pump B's photo or status | 403 | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-04 | Pump A approves or retries pump B's session | 403, nothing changed | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-05 | Plant manager reads the photo of a pump at a plant not assigned to them | 403 | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-06 | Plant manager POSTs to the attendance API (submit, approve, retry) | 403 | 1 | P0 | Missing |
| RBAC-07 | Vendor pages show only that vendor's pumps, people and attendance (two vendors in one Area) | No rows from the other vendor, on every vendor page and filter | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-08 | Plant manager pages show only assigned plants | Same as RBAC-07 | 1 | P0 | Missing |
| RBAC-09 | Admin form actions (`?/resolveFraudSession`, `?/createVendor`, ...) POSTed by a vendor | 403, no DB change | 1 | P0 | Covered (auth-rbac.spec) |
| RBAC-10 | Export with filters as a non-admin | 401 or 403 | 1 | P0 | Missing |

### SUB: photo submission

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| SUB-01 | First photo of the day | 202, session `morning`, `pairing_status=open`, job queued | 1 | P0 | Covered (attendance.spec) |
| SUB-02 | Same bytes uploaded twice (same pump or another pump) | 409 "Duplicate photo", one row only | 1 | P0 | Covered (attendance.spec) |
| SUB-03 | File over 18 MB, empty file, wrong type (PDF) | 413, 413, 415. No row and no file left on disk | 1 | P0 | Covered (attendance.spec) |
| SUB-04 | No `photo` field | 400 | 1 | P1 | Missing |
| SUB-05 | Two submissions from one pump at the same instant | One accepted, the other 409. Never two mornings | 1, 4 | P0 | Covered (concurrency suite) |
| SUB-06 | GPS lat and lng stored; missing GPS still accepted | As stated | 1 | P2 | Missing |
| SUB-07 | Submit while the morning is still `pending` or `processing` | Clear 409 telling the operator to wait (today: misleading "Concurrent submission already recorded") | 1 | P1 | Covered (attendance.spec, fixed 2026-10-08) |
| SUB-08 | DB failure mid-submit | 500, no orphan photo file | 1 | P2 | Missing |

### PAIR: morning and evening pairing, dates, time zone

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| PAIR-01 | Evening before the minimum gap | 409 with time remaining; `/today` shows `can_submit=false` and the correct `next_allowed_at` | 1 | P0 | Covered (attendance.spec, fixed 2026-10-08) |
| PAIR-02 | Evening at or after 9h | `evening`, both rows `paired`, linked both ways | 1 | P0 | Covered (attendance.spec) |
| PAIR-03 | Third photo after the day is complete | 409 "Day complete" | 1 | P0 | Covered (attendance.spec) |
| PAIR-04 | Morning 23:30 IST, evening 08:45 IST next day | Evening has the morning's `session_date` | 1 | P0 | Covered ("midnight pairing") |
| PAIR-05 | Morning older than the pairing window | Morning `expired`, `days_morning_only` +1 exactly once, next photo is a fresh morning | 1 | P0 | Covered (attendance.spec) |
| PAIR-06 | Expiry triggered by `/today`, by submit and by the worker sweep, all at once | Rollup counted once | 1 | P0 | Partial |
| PAIR-07 | Missed evening: morning 08:00, next photo 07:30 the next day | Recorded as the **new day's morning**, not yesterday's evening | 1 | P0 | Covered (attendance.spec, fixed 2026-10-08 (16 h window)) |
| PAIR-08 | Missed morning: only one photo at 18:00 | Agreed rule from P1 (today it becomes a "morning") | 1 | P1 | **RED** (pending decision) |
| PAIR-09 | `session_date` is computed in IST even when the container TZ is UTC | Run the app with `TZ=UTC` and submit at 00:30 IST | 1 | P0 | Covered (regression run uses TZ=UTC) |
| PAIR-10 | Morning in `review`: `/today` state is `review`; submit is blocked with a clear message | As stated | 1 | P1 | Partial |
| PAIR-11 | Morning `failed` (no faces): operator retries, then submits again | New morning accepted | 1 | P0 | Covered |

### WRK: worker and job queue

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| WRK-01 | Job processed: `queued` → `claimed` → `done`; session ends `completed` or `review` | As stated | 1 | P0 | Covered (every regression scenario) |
| WRK-02 | AI service returns 500 or times out | Retried up to the attempt limit, then session `failed` with a readable reason | 1 (stub returns 500) | P0 | Covered (fraud-review-admin.spec REV-03) |
| WRK-03 | Worker killed mid-job | Stale claim re-claimed after the timeout; processed once | 1 | P0 | Missing |
| WRK-04 | Two workers, 20 jobs | Each job processed exactly once | 4 | P0 | Covered (concurrency suite) |
| WRK-05 | Two pumps in one Area at the same instant with the same face | Exactly one wins; the other gets a fraud flag (`SERIALIZABLE` retry) | 1, 4 | P0 | Partial |
| WRK-06 | Zero faces in photo | Session completes with no attendance; operator sees "no faces found" | 1 | P0 | Covered (existing e2e) |
| WRK-07 | Heartbeat stops | `/api/health` reports `worker: unavailable` within the timeout | 1 | P1 | Missing |

### MATCH: identity (stub embeddings make these exact)

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| MATCH-01 | New face at a pump | New `pending_review` person "Worker N"; session `review` | 1 | P0 | Covered (fraud-review-admin.spec) |
| MATCH-02 | Same face next day at the same pump, similarity just above the threshold | Matched to the same person; no new person | 1 | P0 | Missing |
| MATCH-03 | Similarity just below the threshold | New person (then the merge-candidate flow) | 1 | P0 | Covered (fraud-review-admin.spec) |
| MATCH-04 | Morning and evening, same pump, same face | Same person, both flags true, **no fraud flag** | 1 | P0 | Covered (fraud-review-admin.spec) |
| MATCH-05 | Five workers in one photo | Five evidence rows, five attendance rows | 1 | P0 | Covered (fraud-review-admin.spec) |
| MATCH-06 | Threshold comes from env | Changing `FACE_MATCH_THRESHOLD` changes the MATCH-02/03 outcome | 1 | P1 | **RED** (compose hardcodes 0.30) |
| MATCH-07 | Gallery: a match against any of the ~5 recent vectors counts | As stated | 1 | P2 | Missing |
| MATCH-08 | `display_seq` stays unique and gap-free under concurrency | As stated | 4 | P1 | Missing |

### FRD: cross-pump fraud (falsified-photo check is off for v1)

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| FRD-01 | Worker present at pump A, then the same face at pump B, same Area, same day | Fraud flag on B; worker **not** marked present at B | 1 | P0 | Covered (fraud-review-admin.spec) |
| FRD-02 | Same as FRD-01 but different Areas | No flag; treated as a new person at B | 1 | P0 | Covered (fraud-review-admin.spec) |
| FRD-03 | Order symmetry: B first then A gives the same outcome as A then B | Flag raised in both orders | 1 | P0 | Covered (fraud-review-admin.spec) |
| FRD-04 | RDC Area-split vendor: two RDC logins in one Area | Flagged exactly like any other vendor | 1 | P0 | Missing |
| FRD-05 | Brand-new worker (`pending_review`) at A, same face at B | Flagged | 1 | P0 | Covered (fraud-review-admin.spec, fixed 2026-10-08) |
| FRD-06 | Pump A's session still in `review` when B submits the same face | Flagged | 1 | P0 | Covered (fraud-review-admin.spec, fixed 2026-10-08) |
| FRD-07 | Pump retries a completed session that carries a fraud flag | Refused; flag stays | 1 | P0 | Covered (fraud-review-admin.spec, fixed 2026-10-08) |
| FRD-08 | Admin marks a flag "not fraud" | Worker becomes present for that day, rollups adjusted | 1 | P1 | **RED** (no such action) |
| FRD-09 | `PHOTO_SPOOF_CHECK_ENABLED=false` | A screen-capture photo is processed normally; pump not disabled | 1 | P0 | Covered (`attendance-anti-spoof`, needs re-run) |
| FRD-10 | `fraud_detected` session marked normal by admin | Reprocessed once; pump re-enabled; never re-flagged | 1 | P1 | Partial |

### REV: pump review, approve, retry

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| REV-01 | Approve a `review` session | `completed`; new people become `active`; evening approval finalizes rollups once | 1 | P0 | Covered (fraud-review-admin.spec) |
| REV-02 | Approve twice or approve a non-review session | 409, rollups unchanged | 1 | P0 | Covered (fraud-review-admin.spec) |
| REV-03 | Retry a `failed` session | Rows, files and the job removed; a fresh submit works | 1 | P0 | Covered (fraud-review-admin.spec) |
| REV-04 | Retry the morning while its evening is paired | 409 "Retry the evening first" | 1 | P1 | Missing |
| REV-05 | Retry an evening that already finalized rollups | Rollups decremented exactly once; morning back to `open` | 1 | P0 | Covered |
| REV-06 | Retry a `completed` session from 30 days ago | Refused (pump-side) | 1 | P0 | Covered (fraud-review-admin.spec, fixed 2026-10-08) |

### ADM: admin operations

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| ADM-01 | Manual correction: mark a missed worker present | Attendance and rollups updated; correction audited with admin id | 1, 2 | P0 | Covered (`admin-attendance-correction`) |
| ADM-02 | Mark duplicate, then undo | Counts return to the original values | 1 | P0 | Partial |
| ADM-03 | Merge two persons of the same pump | Vectors and attendance moved; no double counting on a shared day; logged | 1 | P0 | Partial |
| ADM-04 | Merge candidates never offer persons from two different pumps | As stated | 1 | P0 | Missing |
| ADM-05 | Dismissed merge pair does not reappear | As stated | 1 | P1 | Covered |
| ADM-06 | Flagged guest: promote to person, dismiss | As stated | 1, 2 | P1 | Covered |
| ADM-07 | Reactivate a disabled pump | Login works again | 1 | P1 | Missing |
| ADM-08 | Create vendor and pump; duplicate email | Created, then a clear error with no partial rows | 1 | P0 | Missing |
| ADM-09 | Assign a plant manager to a plant; reassign | History row written; old manager loses access immediately | 1 | P1 | Missing |
| ADM-10 | Every admin action is audited (who, when) | As stated | 1 | P2 | Partial |

### SET: admin attendance settings (added 2026-10-08)

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| SET-01 | Admin widens the pairing window to 24 h | A photo 17 h after an unpaired morning pairs as its evening | 1 | P0 | Covered (attendance.spec) |
| SET-02 | Admin shortens the evening gap to 5 min for testing | Evening refused before 5 min, accepted after; change is in the audit log | 1 | P0 | Covered (attendance.spec) |
| SET-03 | Invalid values (window not longer than gap, 0, out of range) | Refused, nothing stored | 1 | P0 | Covered (attendance.spec) |
| SET-04 | Reset to defaults | Stored values removed; 540 min and 16 h apply | 1 | P1 | Covered (attendance.spec) |

### ADM (continued): admin delete and reset (added 2026-10-08)

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| ADM-11 | Admin deletes a fraud-flagged session | Session, flags and new workers gone; audit row records the flag count; pump can submit again | 1 | P0 | Covered (fraud-review-admin.spec) |
| ADM-12 | Admin deletes a morning that has a paired evening | Both deleted; attendance rows and yearly roll-up reversed | 1 | P0 | Covered (fraud-review-admin.spec) |
| ADM-13 | Admin clears all attendance of a pump | Refused without the exact pump code; then every session, worker and related fraud flag is gone, audited, and the pump can start fresh | 1 | P0 | Covered (fraud-review-admin.spec) |

### IMP: CSV import

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| IMP-01 | Valid pump/vendor CSV (the real `Pump Vendor.csv`) | Areas, plants, vendors and pumps created; credentials shown once | 1, 2 | P0 | Covered |
| IMP-02 | Re-import the same file | Idempotent: no duplicates, no password reset | 1 | P0 | Missing |
| IMP-03 | Bad rows: missing column, duplicate pump code, bad email, BOM, Windows line endings, extra spaces | Row-level errors; good rows not half-applied (all or nothing, or a clear per-row report) | 1 | P0 | Partial |
| IMP-04 | Plant manager CSV (`Plant Managers.csv`), unknown plant code | Clear error for the row | 1 | P1 | Missing |
| IMP-05 | 2,000-row file | Finishes within the request timeout | 4 | P2 | Missing |

### RPT: reporting, export, roll-ups

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| RPT-01 | Admin, vendor, Area and pump views give the same totals for the same day | Equal | 1, 2 | P0 | Covered |
| RPT-02 | Export (xlsx) rows equal the on-screen filtered list | Equal | 1, 2 | P0 | Covered |
| RPT-03 | Yearly rollup equals a recount from `daily_person_attendance` after a full scripted week (missed sessions, retries, merges, corrections) | Equal | 1 | P0 | Missing |
| RPT-04 | Date filters across month and year boundaries in IST | Correct days only | 1 | P1 | Partial |
| RPT-05 | Vendor and plant manager export | Scoped file | 1 | P1 | **RED** (feature missing, P3) |

### PATH: sub-path hosting (BASE_PATH)

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| PATH-01 | Build with `BASE_PATH=/pump-attendance`: every page, link, form action, fetch, photo URL and CSV template stays under the prefix | No request leaves the prefix (crawl all links as each role) | 2 | P0 | Partial (manual curl run on 2026-10-08) |
| PATH-02 | Role guards still apply with the prefix | Same as RBAC-01 | 1 | P0 | Partial (manual) |
| PATH-03 | Cookies scoped to the prefix | `Path=/pump-attendance` | 1 | P1 | Partial (manual) |
| PATH-04 | Root build (empty `BASE_PATH`) unchanged | As before | 1 | P0 | Partial (manual) |
| PATH-05 | Invalid `BASE_PATH` (`pump`, `/pump/`) | Build fails with a clear message | 0 | P2 | Missing |

### OPS: deploy, health, data safety

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| OPS-01 | Fresh database: `init.sql` + all migrations | Schema identical to an upgraded database (diff `pg_dump --schema-only`) | 1 | P0 | Missing |
| OPS-02 | Run migrations twice | No error, no change | 1 | P0 | Missing |
| OPS-03 | `/api/health` with each dependency down (DB, AI, worker) | 503 and names the failed part | 1 | P0 | Missing |
| OPS-04 | Deploy a release that fails its health check | Automatic rollback; previous version serving | Manual drill | P0 | Missing |
| OPS-05 | Backup then restore into a scratch database | Row counts and photo files match | Manual drill | P0 | Missing (`restore-drill.sh` exists) |
| OPS-06 | `deploy.sh` when local `main` differs from `origin/main` | Refuses | 0 | P0 | Missing |
| OPS-07 | App starts without `JWT_SECRET` or with a short one | Fails fast with a clear message | 1 | P1 | Missing |
| OPS-08 | Logs contain no passwords, tokens or photo bytes | grep of logs after a Tier 1 run | 1 | P1 | Missing |

### UI: browser behaviour per role

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| UI-01 | Pump page states: morning, waiting, evening, locked, review, failed, disabled | Correct text and button state for each | 2 | P0 | Covered |
| UI-02 | Pump page at 360 px on a low-end Android profile: camera capture, gallery pick, cancel, upload progress | Usable, no zoom on inputs | 2 | P0 | Partial |
| UI-03 | Network drops during upload | Clear retry message; selected photo kept | 2 | P1 | Missing |
| UI-04 | Every admin, vendor and plant manager page renders with no console errors and no 500 | As stated | 2 | P0 | Covered (`ui-redesign`, `interactive-ui-audit`) |
| UI-05 | Empty states (new vendor with no pumps; day with no attendance) | Helpful message, no crash | 2 | P1 | Partial |
| UI-06 | Accessibility (axe) on login, pump and admin home | No serious violations | 2 | P1 | Covered |
| UI-07 | Session expires while a page is open, then the user clicks an action | Sent to login, no silent failure | 2 | P2 | Missing |

### ACC: model accuracy (Tier 3, existing gate)

| ID | Scenario | Expected | Tier | Pri | Status |
|---|---|---|---|---|---|
| ACC-01 | Golden small-group corpus at the configured threshold | Meets the approval targets in `FaceAttendanceEvaluationApprovalSystem.md` | 3 | P0 when matching changes | Covered |
| ACC-02 | Compressed (WhatsApp-quality) photos | Match rate reported; known weak point (`Bugs/MajorBugs.md`) | 3 | P1 | Partial |
| ACC-03 | Real site photos (dim light, helmets, side faces), collected in the pilot | Baseline recorded, then tracked | 3 | P1 | Missing |

---

## 3. Build order

Done on 2026-10-08: step 1 (stub AI service, harness, runner `scripts/run-regression.mjs`), the P0 AUTH/RBAC/SUB/PAIR/FRD/REV scenarios, and step 3 (`deploy.sh` runs `npm run test:regression`). A mutation check confirmed the suite goes red when the old fraud scope and the old pump retry rule are put back (FRD-03/05/06, FRD-07 and REV-06 fail).

1. **Stub AI service** (`tests/stub-ai/server.mjs`, about 80 lines) and the Tier 1 harness: run-id fixtures, login helper, `waitForSession()`, clock back-dating, cleanup.
2. **P0 scenarios marked Missing or RED in AUTH, RBAC, SUB, PAIR, FRD and REV.** These guard money and fraud. The RED ones confirm the audit blockers; fix those blockers next.
3. Wire `npm run test:regression` into `DEPLOY_CHECKS` in `scripts/deploy.sh` (needs a disposable Postgres locally: `docker compose -p fa-test up -d postgres`).
4. OPS-01 to OPS-03, then RPT-03 (the full-week ledger check, which catches most rollup bugs at once).
5. Fill in P1 and P2.

## 4. Rules that keep this useful

- A bug fix without a scenario ID is not done. Put the ID in the commit message (`fix(pairing): PAIR-07 ...`).
- RED tests are marked `test.fail()` with the scenario ID, so the suite stays green while still recording the bug. When the fix lands, `test.fail()` starts failing (because the test now passes), which forces you to flip it.
- Never weaken an expectation to make a test pass. Change it only together with a product decision recorded in this file.
- Tier 3 runs whenever the threshold, model or matching SQL changes. Record its result in the commit message.
