# face-attendance-system

Face-recognition attendance for concrete-pump vendor workers. SvelteKit app + Node worker + Python (insightface/ONNX) AI microservice + Postgres/pgvector, all in Docker Compose. RDC Concrete (India) Ltd is the platform owner's own company and also one of the vendors on the platform — it operates pumps nationally, which is why it gets **one login per Area** instead of one national login (see Entity Hierarchy below).

Full diagrams (architecture, ER, session-pairing state machine, worker locking) live in [docs/Architecture.md](docs/Architecture.md) — read that before re-deriving system design from source. Full narrative spec lives in [plans/MasterPlan.md](plans/MasterPlan.md).

## Entity hierarchy

```
Admin (platform owner)
 └── Area (region, e.g. "Bangalore")
      └── Plant (physical site, e.g. "BG-Anjanapura")
           └── Pump (login + attendance entity, e.g. "ASLPWWI2")
                └── Person (auto-discovered, no login, no enrollment — permanently pinned to one Pump)

Vendor (login) — orthogonal to the tree above; owns/operates 1+ Pumps, possibly across Plants/Areas.
Large national vendors (e.g. RDC Concrete) get one Vendor row/login PER Area instead of one
national login — this only changes login/dashboard scope, never fraud-check scope (that's always
Area-wide and symmetric for every vendor, split or not).
```

Person records never merge across pumps — same human at two pumps = two Person rows. Same-pump identity drift (worse-lit evening photo splitting one person into two) is handled by the admin merge-candidate review flow, not auto-merging.

## Non-negotiables (see MasterPlan.md §2 for full rationale — do not violate these when touching attendance/matching code)

- Evening session requires ≥9 hours (540 min) elapsed since morning, and inherits morning's `session_date` — never derive session_type from calendar "today." The gap is read from `src/lib/server/settings.ts` (admin override at /admin/settings > env `EVENING_MIN_GAP_MINUTES` > 540); a shorter gap is for testing only.
- Single-button shift flow (UI words: Shift start / Shift end / Full shift / Start only; DB keeps morning/evening): no open shift → photo is a start (any time of day); open shift → photo is the end once the gap passed. An open start closes as "start only" by the pump's **End session** (API `/api/attendance/end` only; the pump screen button was removed 2026-10-27), by admin fix, or after the pairing window (default **24h**, same settings precedence; `worker/index.js` reads it the same way), checked lazily on submit/today and by the hourly sweep — never let "most recent open X" pairing run unbounded. `closed_by` records which. One shift per pump per date. Logic: `src/lib/server/shiftSessions.ts`. Admin fixes (End session, Split end into new start, Move to date) on `/admin/pumps/[id]`, audited. State machine: `docs/Architecture.md` §5.
- Cross-pump fraud check is Area-scoped and symmetric for every vendor, including RDC's Area-split accounts — never narrow the scope per-vendor, it makes fraud detection order-dependent. The only off switch is the admin **Test mode** switch at /admin/settings (`app_settings` key `test_mode`, no server env since 2026-10-26): while on, the fraud check is off, fraud alert and location approval emails are logged instead of sent (password reset emails still go), and every admin page shows a red banner. Reset to production defaults turns it off.
- Same-pump re-match (morning+evening) is expected, never a fraud flag — only a different-pump match is.
- Match threshold is `FACE_MATCH_THRESHOLD` (default **0.28**, from the golden small-group evaluation; see `src/lib/server/matching.ts` and the same parsing in `worker/index.js`) via pgvector cosine similarity, gallery-based (~5 embeddings per person: the anchor face it was created from plus the newest clear matches) — never hardcode the threshold. A weak or close-call match counts attendance but stays out of the gallery (`in_gallery`, `GALLERY_ADD_THRESHOLD` 0.40 / `GALLERY_ADD_MARGIN` 0.10 in `worker/faceQueries.js`), so a wrong match cannot teach the matcher. One face per person per photo: workers are handed out strongest match first (`assignFaces`); a face whose worker is taken takes its next-best one or becomes a new worker, never merged into another face. Operators make no matching decisions.
- All date/time logic is explicit `Asia/Kolkata`, computed in code — never rely on container/DB default TZ.
- Matching + fraud-check + person upsert for one session run inside one Postgres `SERIALIZABLE`-isolation transaction (optimistic concurrency — no blocking Area lock; conflicting concurrent writes abort with `40001`/`40P01` and are retried) — never remove this without understanding the race it prevents (`docs/Architecture.md` §9).
- Duplicate photo (same sha256 hash) is rejected, never double-counted.
- Every shift photo comes with a required operator photo (`operator_photo`, migration 030). The worker takes its largest face; if it matches a group face (>= threshold) that face is tagged `is_operator`, otherwise it is added as one more face. Never count the operator twice. No face in it fails the session at once (`OperatorPhotoError`, no retries).

## Secrets (env file)

- The env file lives outside the repo at `../.env` (loaded by `scripts/lib/load-env.mjs`). Never open, read, print, paste, log or quote it, and never show a value from it: no `cat`/`type`/Read on it, no unfiltered `docker compose config`, no `printenv`/`env` dumps.
- Refer to settings by variable name only. Need to know what a variable holds, whether it is set, or what it should be? Ask the user. Don't look it up.
- Code may load it (`load-env.mjs`, `npm run stack`, `migrate`, `seed`). When checking that it loaded, print only the file path and the number of variables.

## Where things live

| Concern | Path |
|---|---|
| SvelteKit backend routes | `src/routes/api/**`, `src/routes/admin/**`, `src/routes/vendor/**`, `src/routes/pump/**` |
| Auth (JWT httpOnly cookie, role guards) | `src/lib/server/auth.ts` |
| DB access | `src/lib/server/db.ts` |
| Logging (one JSON line shape for app, worker, ai-service; warn/error also in `system_logs`, shown at `/admin/logs`, kept `LOG_RETENTION_DAYS`=30) | `src/lib/server/log.ts`, `log()` in `worker/index.js` |
| IST time helpers | `src/lib/server/time.ts`, `src/lib/date.ts` |
| Forgot password (one-use email link, 30 min) and resets by admin / plant manager (pump and vendor logins go back to the default password `DEFAULT_PASSWORD` in `auth.ts`, plant managers get a random one; change forced at sign-in for every login except pumps, which are never asked since 2026-10-27), all logged in `password_reset_log`; SMTP shared in `mail.ts` | `src/lib/server/passwordReset.ts`, `src/lib/server/mail.ts` |
| Shift end reminders by Web Push (Chrome's recommended flow: after sign in a pump phone that has not answered sees an Enable notifications sheet before the guide, only its button asks, the subscription is saved once allowed, decisions in `src/lib/pushReminders.ts` (unit tested); worker sends the first the moment the evening gap has passed, then one every 15 min while the end is missing, 4 at most; VAPID keys made by the app in `push_keys`, no env; iPhone only from Home Screen; migration 040. No install or "reminders on" banner: the pump screen shows nothing once allowed) | `src/lib/components/PumpReminders.svelte`, `static/manifest.webmanifest`, `src/service-worker.ts`, `src/lib/server/push.ts`, `src/routes/api/pump/push`, `worker/endReminders.js` |
| Admin Areas / Plants (today per area, plant and pump on the same counts as the Overview totals; area and plant pages list every pump with its shift today, attendance over a range, and day calendars) | `src/lib/server/attendanceRollup.ts`, `src/lib/components/TodayCards.svelte`, `src/lib/components/PumpTodayList.svelte`, `src/routes/admin/areas/**`, `src/routes/admin/plants/**` |
| Pump status (migration 046 `pump_day_status`): Active / Idle / Inactive per pump and day, set for today or tomorrow only by admins, plant managers and monitors (their pumps via `manager_plants`), holds until the next change, no row = Inactive (every pump starts Inactive; its people set it Active or Idle); the same row holds the site name typed under the status (`site_name`, shown under the pump in the 9 am email; a new site today carries into tomorrow unless tomorrow had a different one); week / month / year day counts per status, one shared page. Separate from `pumps.status`, the login lockout | `src/lib/server/pumpStatus.ts`, `src/lib/components/PumpStatusBoard.svelte`, `src/routes/admin/pump-status`, `src/routes/plant-manager/pump-status` |
| Monitors (migration 044): a plant-manager login with `is_monitor` (Remove sets `disabled_at` unless it also manages plants: sign-in refused and an open session ends at the next request in `hooks.server.ts`; adding it again or giving it a plant clears it), given whole Areas (`monitor_areas`) at `/admin/monitors`. Every plant-manager access check reads the view `manager_plants` (own plants + monitored Areas); `plant_manager_assignments` is only written by the admin page and read for plant emails (`locationCheck.ts`). Plant-manager home is the day's checklist (problems first, Checked + note in `pump_day_checks`); a monitor with no plants of its own sees only Attendance, Pumps and People (Overview, Approvals and Kept photos redirect to Attendance in `plant-manager/+layout.server.ts`, fraud case pages stay open); every morning at 9 am IST one attendance tracker email per Area for the day before (never a day before `app_settings` `digest_first_day`, migration 045 sets Sun 1 Nov 2026 so the first email is Mon 2 Nov), only for Areas ticked at /admin/settings (`areas.digest_enabled`, migration 045; Mumbai only to start) (migration 045, `attendance_digest_log` 'area:<id>', once per Area and day): full shift, start only and end only per pump, every pump Active or Idle that day (`pump_day_status`, migration 046, see Pump status below), a pump with no one counted in red, Inactive pumps left out, grouped by Plant; To every admin and the Area's monitors, CC only the list at /admin/settings (`app_settings` `digest_cc`, added and removed one address at a time, migration 045 starts it with two addresses; no plant managers unless on it); logged instead of sent while mail is off or test mode is on | `src/routes/admin/monitors`, `src/lib/server/pumpChecks.ts`, `src/routes/plant-manager/+page.*`, `worker/attendanceDigest.js`, `worker/digestEmail.js` |
| CSV vendor/pump/plant import | `src/lib/server/csvImport.ts` |
| Attendance evidence/review (flagged guests, merge, fraud) | `src/lib/server/attendanceReview.ts` |
| Admin face fixes (move face, mark present, undo merge, remove a worker for good, close flagged errors at `/admin/review-flags`) | `src/lib/server/faceFixes.ts` |
| Fix attendance (one page for admin and plant manager, the manager limited to their plants: Same people?, ticks, rename, counted twice + undo, add a missed worker; migration 043). Rename also in the shift card's face popup (`POST /api/persons/[id]/name`) and on the People pages (`PeopleList.svelte`, vendor and plant manager) | `src/lib/server/fixAttendance.ts`, `src/lib/components/FixAttendance.svelte`, `src/lib/server/personNames.ts` |
| "Same people?" (start crew detected as new workers at the end): asked on both Fix attendance pages (no badge on the shift card since 2026-10-29), side-by-side pairing (admin and plant manager), real merge per pair; merge log records an admin or a plant manager (migration 042) | `src/lib/server/samePeople.ts`, `src/lib/components/SamePeople.svelte`, `mergeWorkers` in `faceFixes.ts` |
| Background worker (job claiming, fraud check, matching) | `worker/index.js` — see Architecture.md §9 before touching this |
| AI microservice (face detection + embeddings) | `ai-service/main.py` (FastAPI, insightface `buffalo_l`, ONNX CPU, no `--workers` set yet — single process today) |
| DB schema | `db/init.sql` (base) + `db/migrations/00N_*.sql` (incremental, applied via `npm run migrate`) |
| Seed data | `scripts/seed.ts` (`npm run seed`) |

## Commands

**Dev**
- `npm run stack -- up -d --build` — local Docker stack. Secrets come from an env file outside the repo (`FACE_ATTENDANCE_ENV`, else `../face-attendance.env`, else `../.env`, else `./.env`) via `scripts/lib/load-env.mjs`, which prints names only, never values. `npm run migrate` / `seed` load it the same way.
- Email is sent only where `MAIL_ENABLED=true` (production server `.env` only). Local stack, regression and host scripts force it off and log the mail instead (`src/lib/server/mail.ts`, `worker/mailer.js`).
- `npm run dev` — vite dev server
- `npm run check` — svelte-kit sync + svelte-check
- `npm run lint` / `npm run format` — prettier + eslint

**DB**
- `npm run migrate` — apply `db/migrations/*.sql`
- `npm run seed` — seed dev data

**Worker / AI**
- `npm run worker` — run `worker/index.js` standalone (normally runs in its own container)
- `docker compose up --scale worker=N` — horizontally scale the worker (safe today: `FOR UPDATE SKIP LOCKED` job claiming + per-Area advisory lock make this correct with zero code changes)
- Scaling `ai-service`: currently single uvicorn process, no `--workers` flag set — see Architecture.md §9 discussion for the two-step plan (in-container `--workers N` first, multi-container + load balancer only once that's saturated)

**E2E / attendance tests**
- `npm run test:e2e` — full Playwright suite
- `npm run test:e2e:attendance` — attendance-specific config (`playwright.attendance.config.ts`)
- `npm run test:e2e:audit` — UI audit config (`playwright.audit.config.ts`)
- `npm run test:attendance:load` — concurrency/load test (`scripts/run-attendance-concurrency.ts --profile=all`) — see `plans/FaceAttendanceE2EConcurrencyTestPlan.md`
- `npm run test:faces` — face-extraction suite against the real AI service (`scripts/run-face-extraction-suite.py`)

## Evaluation / approval system

Full spec: [plans/FaceAttendanceEvaluationApprovalSystem.md](plans/FaceAttendanceEvaluationApprovalSystem.md). This is the accuracy gate to run **before accepting any change** to the detection model, embedding model, match threshold, worker matching logic, or attendance retry/review flow.

- `npm run eval:download:core` — fetch Pins/LFW/WIDER datasets (biometric data, gitignored)
- `npm run eval:manifest:pins` / `eval:manifest:pins:local` / `eval:manifest:lfw:local` / `eval:manifest:wider:local` — build deterministic identity manifests
- `npm run eval:faces:smoke` — fast 4-photo sanity check against the checked-in group-photo corpus
- `npm run eval:faces:lfw` / `eval:faces:wider` — smaller sanity benchmarks
- `npm run eval:faces` — full 100-identity accuracy run
- `npm run eval:approve` — full **blocking** approval gate (requires explicit approval to pass)
- `npm run eval:golden:build` / `eval:golden:run` / `eval:golden:explain` — golden small-group corpus (50 cases, 100 morning/evening images, ground truth + quality-summary.csv + contact sheets) — build/run/explain cycle for regression-testing small-group matching specifically

## Testing gate

- `npm run test:unit` (`scripts/run-unit.mjs`): fast unit tests in `tests/unit` (face lookups in `worker/faceQueries.js`, fraud resolution, session cleanup) against a throwaway pgvector Postgres; no build, app or worker. Needs Docker. Runs separately from the regression gate.
- `npm run test:regression` (`scripts/run-regression.mjs`): svelte-check, throwaway Postgres, migrations, build, stub AI service (`tests/regression/stub-ai.mjs`, fixed face vectors), app + worker, then the API scenarios in `tests/regression/*.spec.ts`. Needs Docker. Run it before every push: the server does not run tests.
- Deploy is GitHub-only: on the server, inside the clone, `bash scripts/deploy.sh` fetches and fast-forwards to `origin/main`, backs up DB + photos, rebuilds, health-checks and rolls back on failure. Only the user deploys. Scenario IDs and coverage: [plans/RegressionTestPlan.md](plans/RegressionTestPlan.md). Every bug fix adds or flips a scenario.
- Pump Retry only works on `failed`/`review` sessions with no fraud evidence; deleting anything else is admin-only (`src/lib/server/sessionCleanup.ts`, audited in `admin_audit_log`). Clear test records deletes only sessions with `test_mode` (set at submit while test mode is on, migration 039); never add a bulk delete of genuine attendance.

## Known gotchas (full log: [plans/Learnings.md](plans/Learnings.md) — append new ones there, don't duplicate here)

- Session pairing update must touch **both** rows (`pairing_status` on morning AND evening) — an asymmetric update only surfaces on the *third* submission of the day, not the pair itself.
- A native Postgres service on the host can silently shadow Docker's mapped port (symptom: auth failures from host-side scripts while `docker compose ps` looks healthy) — check `netstat`/`Get-Process` on the port, not Docker logs.
- SvelteKit's CSRF check rejects non-JSON POSTs without a matching `Origin` header — any Node-based test script hitting multipart upload endpoints must set `Origin` explicitly; `adapter-node` also needs `ORIGIN` set as an env var.
- Fraud-check scope must be symmetric (Area-wide for every vendor) — an asymmetric scope (e.g. "narrower for ordinary vendors") makes catching fraud order-dependent on which pump submits first.
- Any "find the most recent open X for pairing" pattern needs an explicit expiry — otherwise one missed step strands everything downstream indefinitely.

## Codebase navigation

A graphify knowledge graph exists at `graphify-out/` (god nodes, community structure, cross-file relationships) — for architecture/relationship questions, prefer `graphify query "<question>"` over grepping raw source; it returns a scoped subgraph instead of the full report. Run `graphify update .` after code changes to keep it current (AST-only, no API cost). See `AGENTS.md` for the full graphify usage rules already configured for this repo.
