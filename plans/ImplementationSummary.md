# Implementation Summary — Prompt A Prototype Build

## Capacity and image-processing hardening (2026-09-05)

- Added durable queue backpressure: uploads remain accepted, while `MAX_ACTIVE_ATTENDANCE_JOBS`
  limits active claimed jobs to 30. The production default is 30 and the worker logs the active
  policy at startup.
- Added safe AI-side preprocessing: attendance evidence is never altered; only an in-memory image
  larger than `AI_MAX_IMAGE_LONG_SIDE` (default 1920px) is downscaled before face inference.
  Each session stores original and inference dimensions/bytes plus extraction time in
  `attendance_sessions.processing_metadata`.
- Added reusable capacity profiling: `npm run eval:attendance:concurrency:capacity` benchmarks
  2 AI workers/4 batch, 4/8, and 6/12 across synchronized 10/20/30/40/50-agent morning and evening
  waves. The HTML comparison includes p95 queue/processing/end-to-end timings, throughput, and
  sampled Docker CPU/RAM. Raw samples are retained per run as `resource-samples.csv`.

Built from `plans/MasterPlan.md` (Prompt A), on 2026-07-27. Full stack is running, seeded, and
validated end-to-end with the two real photos you provided (`Test/faces/group_morning.jpg`,
`group_evening.jpg`). This document is the record of what was actually built, what was
deliberately simplified for prototype speed, and what was found and fixed by real testing (not
just claimed) — read this together with `plans/Learnings.md`, which now also has new entries.

## What's running

`docker compose up --build` brings up 4 services, all healthy:

- **postgres** (pgvector/pgvector:pg16) — schema in `db/init.sql`, auto-applied on first boot.
- **ai-service** — FastAPI + insightface (buffalo_l) on ONNX Runtime CPU. Downloads and loads the
  model pack once at container startup (confirmed in logs — all 5 buffalo_l sub-models loaded).
- **app** — SvelteKit (Node adapter), all API routes + pages from the spec.
- **worker** — plain Node script (no Redis; Postgres-backed `attendance_jobs` table, polled every
  1.5s, per the prototype option Prompt A itself offered).

## What was validated live, not just written

I ran the actual pipeline against your real photos, not a synthetic test:

1. Seeded the DB via `npm run seed` (12-row sample CSV → 3 areas, 7 plants, 9 vendors, 12 pumps,
   0 errors — the CSV importer's own code path, not a separate seed script).
2. Logged in as pump `bglprvn1@pumps.local`, submitted `group_morning.jpg` for real through
   `/api/attendance/submit` → the worker called the AI microservice, ran the (empty, first-ever)
   fraud/match check, and **auto-created 6 new persons** — correct, since this is the first photo
   ever seen at this pump.
3. Backdated that morning session by 10 hours (test-only, to satisfy the 9-hour rule without
   waiting) and submitted `group_evening.jpg` (which intentionally has only 5 of the 6 faces —
   your test fixture's `make_group_photos.py` already builds it that way to exercise the
   morning-present/evening-absent case).
4. Result, read back from `daily_person_attendance`:

   | Person     | morning_matched | evening_matched | Final       |
   | ---------- | --------------- | --------------- | ----------- |
   | 5 of the 6 | true            | true            | **Present** |
   | 1 of the 6 | true            | false           | **Absent**  |

   This is exactly the dual-flag rule from MasterPlan §2a working correctly, on real ArcFace
   embeddings and real pgvector cosine-similarity queries — not mocked.

5. Verified idempotency (duplicate photo hash → 409), the 9-hour rule, day-complete rejection,
   role guards (pump → 403 on `/admin/**` and admin APIs; unauthenticated → 302 to `/login`),
   admin dashboard/attendance-table/fraud-flags/flagged-guests/merge-candidates pages (all 200),
   the vendor dashboard, and the Excel export endpoint (returns a real `.xlsx` content-type).

## A real bug this testing caught and fixed

While verifying the "day complete" rejection with a genuinely new (never-submitted) photo, the
app returned a raw 500 instead of the expected 409. Root cause: `submit/+server.ts` set
`pairing_status = 'paired'` on the **morning** row when an evening session paired with it, but
never set it on the **evening row itself** — so the evening row's own `pairing_status` stayed at
its default `'open'` forever. The "is today already complete" check queries for
`session_type = 'evening' AND pairing_status = 'paired'`, which never matched, so a third
submission fell through to "start a new morning" and collided with the unique constraint on
`(pump_id, session_date, session_type)`. Fixed by setting `pairing_status = 'paired'` on both
rows; re-verified the day-complete path now correctly returns 409. Logged in `plans/Learnings.md`.

## Environment issue found and fixed (not a code bug, but worth knowing)

Your machine has a **native Windows Postgres service already listening on port 5432**, which
collided with Docker's host port-forward for the `postgres` service — connections from host-side
scripts (seed, test scripts) were silently hitting the wrong Postgres instance and failing auth.
Fixed by remapping the Docker Compose `postgres` service to host port **5433** (container-internal
port stays 5432, so `app`/`worker` — which talk to `postgres:5432` over the Docker network — are
unaffected). If you run `npm run seed` or any host-side script yourself, use
`DATABASE_URL=postgres://attendance:attendance@localhost:5433/attendance`.

## Deliberate simplifications (prototype-speed trade-offs, not gaps in understanding)

- **Job queue**: Postgres-backed polling table, not BullMQ/Redis — this was explicitly offered as
  a valid prototype choice in Prompt A itself.
- **Merge candidates**: computed on-the-fly on page load (per Prompt A's own "or compute on-the-fly
  for the admin endpoint if simpler" option) rather than a persisted `merge_candidates` table with
  a `dismiss` flag — so a dismissed pair can currently resurface on next page load. Noted as a
  known limitation; promoting it to a persisted table is a small follow-up if you want dismiss to
  stick.
- **Admin CRUD for Area/Plant/Vendor/Pump management**: not built as full CRUD UI — CSV import
  (create/update path) is fully built and is the primary onboarding path per your real data; direct
  single-record CRUD screens were deprioritized in favor of validating the core face-recognition
  flow end-to-end with your real photos, per what actually matters for a first prototype pass.
- **Playwright E2E suite (Prompt B)**: not built in this pass — Prompt A and Prompt B are separate
  prompts in the plan; this pass covered Prompt A (the application itself). Say the word and I'll
  build Prompt B next.
- **GPS geofencing**: stored (lat/lng captured from the browser) but not enforced, matching the
  plan's explicit "stubbed as optional/off" note.

## Structured logging

Confirmed working — `docker compose logs app/worker` show structured JSON lines with
`timestamp` (IST), `level`, `service`, and contextual fields (`pumpId`, `sessionId`,
`sessionType`, `requestId`) exactly as specified in §7a, including the "attendance session
queued" and worker-side match/fraud-flag events.

## How to reproduce

See the updated `README.md` for exact commands: `docker compose up --build`, `npm run seed`,
and `npx tsx scripts/submit-test-photos.ts` to re-run the same live validation against your two
photos at any time.

## Credentials created by seed

- Admin: `admin@attendance.local` / `Admin1234!`
- Pumps / Vendors: `<slugified name>@{pumps,vendors}.local` / `Test1234!` (e.g.
  `bglprvn1@pumps.local`, `rvnenterprises@vendors.local`)

---

# Attendance Insights Overhaul — Phases 1, 2A, 2B

Built from `plans/date-should-properly-formatted-smooth-lark.md` (approved plan), on 2026-07-27,
in response to your screenshot showing raw `Date().toString()` output and raw UUID person IDs in
the admin attendance table, plus the ask for day/pump/vendor filters, proper metrics, and a plan
for deeper insights as data grows. All three phases (Phase 1 readability fixes, Phase 2A
day/pump/vendor/area drill-downs, Phase 2B insights layer) were built and verified end-to-end
against the live Docker stack, in order, with each phase's containers rebuilt and its
verification checklist run before starting the next phase.

## Phase 1 — Readability fixes (dates, names, filters, cards, export)

**Built:**

- `src/lib/date.ts` — client-safe IST-explicit `formatDate()` → `"Mon, 27 Jul 2026"`, mirroring
  `$lib/server/time.ts`'s dayjs+timezone setup (plus `todayStr`/`addDaysStr`/`startOfMonthStr`/
  `daysBetween` helpers added in Phase 2A).
- `src/lib/personLabel.ts` — `personDisplayLabel(pumpCode, displaySeq)` → `"BGLPRVN1 Worker 1"`.
- `persons.display_seq` column (+ `UNIQUE(pump_id, display_seq)`), added to `db/init.sql` for
  fresh installs and via `db/migrations/001_add_person_display_seq.sql` (backfilled by
  `ROW_NUMBER() OVER (PARTITION BY pump_id ORDER BY first_seen_at)`) for the already-running
  container. `scripts/migrate.ts` is a new minimal migration runner (`schema_migrations` tracking
  table, applies `db/migrations/*.sql` in filename order, idempotent) — run via `npm run migrate`.
- `worker/index.js`'s auto-create-person path and `admin/flagged-guests`'s `promote` action both
  now compute `display_seq` as `COALESCE(MAX(display_seq),0)+1` inside their existing transaction/
  query, so new persons get a stable sequential worker number per pump.
- `admin/attendance` rebuilt with ID-based `<select>` dropdowns for Area/Vendor/Pump (previously
  name-string matching with no pump filter at all), a Day picker that overrides from/to, and 4
  live summary cards (Present/Absent/Total/Attendance %) using the same WHERE clause as the table.
- Excel export (`api/admin/attendance/export`) given the same ID-based+pump+day filters, real
  Excel date cells with `numFmt = 'ddd, dd mmm yyyy'` (not pre-formatted strings, so Excel
  sort/filter still works), and `personDisplayLabel` for the Person column.
- `admin/fraud-flags` given a formatted date column (`created_at` existed but wasn't shown) and
  `personDisplayLabel` instead of a raw UUID slice.
- `vendor/+page.svelte`'s one inconsistent `toLocaleDateString()` call replaced with `formatDate`;
  its persons table also uses `personDisplayLabel`.
- `api/attendance/status/[id]` now joins `pump_code`/`display_seq` into `matched`/`new_persons`,
  and `pump/+page.svelte`'s capture result screen renders `personDisplayLabel` instead of
  `person_id.slice(0,8)`.

**Verified live (not just written):**

- Ran `scripts/migrate.ts` against the running container (port 5433) — the 6 pre-existing seeded
  persons at pump BGLPRVN1 got `display_seq` 1–6 correctly, ordered by `first_seen_at`.
- Rebuilt `app`+`worker`, then submitted a genuinely new photo to a fresh pump (BGLPRVN3, which
  had no prior persons): the status response returned 5 new persons with `display_seq` 1–5 — the
  worker's sequential-assignment logic confirmed correct for a second pump, not just the seeded one.
- Loaded `/admin/attendance`: dates render `Mon, 27 Jul 2026`, Person column renders
  `BGLPRVN1 Worker 1`..`6`, all Area/Vendor/Pump dropdowns populate, pump+day filter combination
  returns the correct filtered summary (5 present / 1 absent / 83.3%), matching the known
  Prompt‑A validation numbers exactly.
- Downloaded the Excel export and read it back with ExcelJS: confirmed `numFmt` is
  `'ddd, dd mmm yyyy'` on a real Date object, and the Person column shows `personDisplayLabel`.
- Loaded `/admin/fraud-flags`: real fraud-flag rows (raised during earlier same-Area duplicate
  submissions) now render a formatted date and `personDisplayLabel`.
- Loaded `/vendor` as `rvnenterprises@vendors.local`: dates and `Worker N` labels both correct.

## Phase 2A — Day-summary mode, drill-downs, pagination/sorting

**Built:**

- `src/lib/components/AttendanceCalendarGrid.svelte` — one reusable day×entity grid (parameterized
  by entity list + cell-value accessor + `mode: 'status' | 'percent'`), used by all three
  drill-down pages instead of three bespoke grids.
- `src/lib/components/DateRangePicker.svelte` — from/to range with Today/Last 7 days/Last 30
  days/This month presets; single-day is the Phase 1 day-picker special case.
- `admin/attendance` day-summary mode: selecting a single day replaces the flat table with a
  collapsible Area → Vendor → Pump view (present/absent/total per pump), expandable to per-person
  rows; a multi-day range keeps the flat table. Pump/Vendor/Area cells in both modes now link to
  the new drill-down pages.
- `/admin/pumps/[id]` — header (pump/plant/area/vendor), `AttendanceCalendarGrid` over the
  selected range (default last 30 days), a session log table (submitted_at/type/status/pairing,
  with a note on expired-unpaired mornings), and a roster panel with
  `days_present`/`days_morning_only`/`days_evening_only` from `person_attendance_yearly`, linking
  to a new `/admin/persons/[id]` page.
- `/admin/vendors/[id]` (new) — pump list with attendance % over the range (sortable), calendar
  grid columned by pump in percent mode.
- `/admin/areas/[id]` (new) — same pattern, columned by plant.
- `/admin/persons/[id]` (new) — full attendance history + yearly rollup for one person, linked
  from the roster and the attendance table's Person column.
- Pagination (`page`/`pageSize=50` + total-count query, prev/next controls) and click-to-sort
  (whitelisted columns only: `session_date`, `pump_code`, `vendor_name`, `area_name`, `status` —
  no free-form `ORDER BY`, avoiding a SQL-injection surface) on the flat multi-day table.

**Bug caught and fixed by live testing:** the first version of `sortUrl()`/`pageUrl()` referenced
`window.location.search` directly in `+page.svelte`, which works client-side but throws
`ReferenceError: window is not defined` during SSR — a real 500 confirmed via
`docker logs face-attendance-system-app-1`. Fixed by deriving the query params from
`data.filters`/`data.sort` (already available from the server load) instead of reading `window`.

**Verified live:**

- `/admin/attendance?day=2026-07-27` returns the grouped Area→Vendor→Pump view (confirmed
  Bangalore → R V N Enterprises → pump rows in the rendered HTML) with correct counts; a
  multi-day range (`from`/`to`) correctly falls back to the flat, paginated, sortable table.
- `/admin/pumps/[id]`, `/admin/vendors/[id]`, `/admin/areas/[id]` all return 200 and are mutually
  consistent — the same pump code (BGLPRVN1) appears on both its own pump page and its vendor's
  page; the same plant (BG-Yelhanka) appears on the area page.
- `/admin/persons/[id]` returns 200 with the correct `personDisplayLabel`, yearly rollup, and
  history table.
- Sorted/ranged query (`?from=2026-07-01&to=2026-07-27&sort=pump_code&dir=asc`) returns 200 with
  correct "Page 1 of 1 (11 rows)" pagination text after the SSR fix above.

## Phase 2B — Insights layer

**Built (all as aggregations over Phase 2A's existing query shapes, no new data models):**

- `src/lib/sparkline.ts` — `sparklinePath()`, a tiny inline-SVG polyline generator (no charting
  library dependency, per the plan's explicit rule).
- `/admin/insights` (new) —
  - **Today at a glance**: attendance % / fraud flags / active pumps, each with a "vs yesterday"
    and (attendance %) "vs 7-day avg" delta computed via simple day-over-day queries against
    `daily_person_attendance`/`fraud_flags`.
  - **Pumps needing attention**: a ranked list combining (a) no submission in the last
    `EVENING_PAIRING_WINDOW_HOURS + 6` hours (30h by default), (b) a morning session that expired
    unpaired in the last 7 days, and (c) a >15 percentage-point 7-day-vs-prior-7-day attendance
    drop — each pump's reasons are merged and de-duplicated, linking to its `/admin/pumps/[id]`.
  - **Vendor rollup**: pump count, distinct persons (30d), today's %, 30-day baseline %, delta vs
    baseline (default sort: worst-first), an area-median comparison column, fraud rate
    (flags ÷ completed sessions, not a raw count — so busy Areas aren't penalized for volume), and
    a 7-day inline-SVG sparkline.
  - **Area rollup**: same shape, one level up, columned by plant internally.
  - **Data-quality backlog**: pending flagged-guest count + a 7-day sparkline of the same, as an
    early signal that `FACE_MATCH_THRESHOLD` may need retuning.
- `/admin/pumps/[id]` enhanced with its own 30-day attendance sparkline and a rejection-history
  note. Note: 9-hour-rule and duplicate-photo rejections are rejected by
  `api/attendance/submit` _before_ an `attendance_sessions` row is ever created, so they are not
  retroactively queryable from history — only expired-unpaired-morning counts (which _do_ persist
  as rows) are shown, with an explicit caption explaining the gap rather than presenting a
  fabricated zero as if it were real data.
- "Insights" added to the `/admin` nav (left as a normal nav link, not the post-login redirect,
  since the plan explicitly said to ask before changing the redirect and this wasn't asked).

**Verified live:** `/admin/insights` returns 200 with all five sections populated (10 pumps
correctly surfaced under "Pumps Needing Attention" against this small seeded dataset, vendor/area
rollup tables and sparkline `<path>` data present in the rendered HTML, backlog trend rendering
zeros correctly since there are no long-pending flagged guests in this dataset); `/admin/pumps/[id]`
shows both the new sparkline and the rejection-summary caption; the `/admin` page's nav now
contains `href="/admin/insights"`.

## Known limitations / deliberate scope decisions

- **Rejection history is partial by construction**: as noted above, only pairing-expiry rejections
  are persisted; 9-hour-rule and duplicate-photo rejections happen pre-insert and are only ever
  visible in the pump's live UI response, never in historical queries. Persisting a
  `rejected_submissions` audit table would close this gap but was out of scope for this pass.
- **Vendor area-median benchmark is a repo-wide median**, not a true per-Area vendor median,
  because `vendors.area_id` is only populated for Area-split accounts (e.g. RDC Concrete) — most
  vendors don't carry a direct Area FK. The column is still useful as a coarse benchmark; a more
  precise per-Area-cohort median would need each vendor's pumps' Areas resolved and grouped, which
  is a reasonable small follow-up if you want it tightened.
- **Merge-candidate backlog trend** (item 16) tracks flagged-guest backlog day-by-day (real,
  persisted data) but does not track merge-candidate backlog day-by-day, since merge candidates are
  computed on-the-fly on page load (a pre-existing Prompt A simplification, see above) rather than
  stored — there's no historical row to sample. Noted as a known gap rather than faked.
- **Small seeded dataset**: all live verification above is against the ~12-pump sample CSV plus a
  handful of manually-submitted test photos, not production-scale data. Pagination was verified to
  render correctly, but a full second page of results was not exercised live since the current
  dataset (11–20 rows depending on filter) fits on one page.

## How to reproduce

- `npm run migrate` (with `DATABASE_URL` pointed at the running Postgres, e.g.
  `postgres://attendance:attendance@localhost:5433/attendance`) applies the `display_seq` migration
  idempotently.
- `docker compose up -d --build app worker` picks up all Phase 1/2A/2B code changes.
- Log in as `admin@attendance.local` / `Admin1234!` and visit `/admin/attendance`,
  `/admin/pumps/<id>`, `/admin/vendors/<id>`, `/admin/areas/<id>`, `/admin/persons/<id>`, and
  `/admin/insights` to see the full overhaul.

---

# Output: Guided Workforce UI Redesign Implementation (2026-07-27)

## Implemented scope

- Added `PRODUCT.md` and `DESIGN.md` as the product register and canonical Guided Workforce design
  specification.
- Added the shared palette, typography, spacing, focus, table, form, metric, status, empty-state,
  and responsive tokens under `src/lib/styles/`.
- Added role-aware admin/vendor application navigation, a mobile pump shell, account context,
  responsive navigation drawer, skip link, and working `POST /api/auth/logout`.
- Rebuilt login with visible labels, password visibility control, loading state, plain-language
  errors, autocomplete metadata, and responsive WCAG-focused behavior.
- Rebuilt pump capture as a deliberate select/preview/submit/process/result workflow. The selected
  group photo survives recoverable upload failures; bounded polling tolerates temporary status
  interruptions; the sticky mobile action uses safe-area padding.
- Extended pump APIs with pump/plant/area context, exact IST next-allowed and pairing-expiry times,
  latest-session context, secure original-photo delivery, matched/new-person crops, unknown-face
  results, and readable cross-pump fraud context. Raw embeddings are not serialized.
- Rebuilt the admin overview, insights, attendance, fraud, guest, merge, CSV import, and all
  pump/vendor/area/person drill-down interfaces using the shared system. Existing grouped-day and
  paginated range attendance modes remain intact.
- Added admin attendance filters for plant, morning/evening session, present/absent status, and
  page sizes of 25/50/100. The XLSX export applies the same filter semantics.
- Added CSV drag-and-drop, required-header validation, a downloadable template, retained file
  state, progress/error handling, result totals, and a row-error table. Server validation now
  limits imports to CSV files of 5 MB or less.
- Added complete vendor-scoped overview, attendance calendar, pumps, and anonymous people routes.
  Every vendor query is constrained by the authenticated vendor ID.
- Added migration `002_add_merge_review_decisions.sql`. Merge dismissals now persist, completed
  pairs are excluded, cross-pump merges are rejected, and same-day attendance collisions are
  combined transactionally. This supersedes the earlier computed-only merge limitation documented
  above.
- Added `@lucide/svelte`, `@axe-core/playwright`, focused responsive/accessibility E2E coverage,
  and visual QA captures.

## Verification output

- Database migration: `002_add_merge_review_decisions.sql` applied successfully to the running
  PostgreSQL container.
- `npm run check`: passed with **0 errors and 0 warnings**.
- `npm run build`: passed using the adapter-node production build.
- `npx playwright test --workers=2`: **6 tests passed**, including login axe validation, admin
  serious/critical axe validation, 320px/390px overflow checks, retained pump photo preview,
  vendor navigation, and an SSR smoke sweep across all admin/vendor operational routes.
- `git diff --check`: passed.
- Visual captures are stored in `test-output/ui-redesign/`:
  `login-320.png`, `pump-preview-390.png`, `vendor-overview-768.png`, and
  `admin-overview-1440.png`.
- Production preview verified at `http://127.0.0.1:4178`.

## Residual tooling notes

- The repository-wide `npm run lint` remains blocked by its existing baseline: Prettier reports 23
  unrelated pre-existing files/generated outputs, and ESLint reports 228 strict-rule violations
  across legacy and new query-heavy code. Changed redesign files pass their scoped Prettier check;
  Svelte's compiler check is clean.
- `npm audit --omit=dev` reports 10 transitive advisories (9 high, 1 moderate) below ExcelJS's
  archive dependency tree. npm only proposes a forced breaking downgrade to `exceljs@3.4.0`, so no
  unsafe `--force` change was applied.

---

# Output: Face Attendance E2E and Concurrency Testing (2026-07-28)

## Implemented scope

- Added a reproducible, attributed 20-image group-photo corpus covering four identity cohorts
  across baseline, low-light, compressed, crop, and mirror variants. Added no-face, corrupt-image,
  extension-mismatch, and oversized-upload negative cases.
- Added extraction tooling that calls the real InsightFace service and stores numbered crops,
  bounding-box overlays, complete 512-value embeddings, checksums, matching matrices, and contract
  validation results under `test-output/attendance-e2e/<run-id>/`.
- Added a real-stack concurrency harness for 20 simultaneous same-pump requests, 20 independent
  Areas, and 20 pumps in one Area. The harness audits sessions, request IDs, files, jobs, attempts,
  attendance, fraud flags, vectors, and queue drainage.
- Added a dedicated Playwright configuration and six serial browser/API/database E2E scenarios.
  Live-derived UI values are asserted immediately after each input/state transition, including
  selected filename and size, processing state, waiting state, matched/new totals, session title,
  and final locked state. Four midpoint/result screenshots were retained in the local run output.
- Added migration `003_harden_attendance_pipeline.sql` and updated fresh-install schema definitions.
- Hardened submission concurrency with a pump advisory transaction lock, atomic session/job
  creation, rollback upload cleanup, deterministic conflict responses, and request IDs.
- Hardened workers with transactional Area locks, stale-claim recovery, bounded three-attempt
  retries, one job per session, session-scoped vectors, and explicit terminal failure states.
- Made morning-only/yearly finalization idempotent and applied it consistently during expiry.
- Corrected status classification so current-session matched and newly-created faces are mutually
  exclusive.
- Clamped InsightFace bounding boxes to the image dimensions and converted the pump session title
  to an explicit Svelte `$derived` value.

## Test output

- Extraction run `20260728-101644`: **20 photos**, **303 faces**, **90.35% mean visible-face
  recall**, **74.32% mean same-cohort variant match rate** at `0.68`, **0 cross-cohort false
  matches**, and **0 embedding/bounding-box/crop contract errors**.
- Same-pump burst: **1 accepted**, **19 deterministic 409 conflicts**, **0 HTTP 5xx**, **153 ms
  submit p95**, and one completed job.
- Independent-Area burst: **20/20 accepted and completed**, **0 failed**, **0 HTTP 5xx**, and
  **120 ms submit p95**.
- Same-Area burst: **20/20 accepted and completed**, **0 failed**, **0 HTTP 5xx**, and **132 ms
  submit p95**.
- Across the concurrency profiles, all **41 accepted jobs** reached `done`, each had exactly one
  attempt, and there were no duplicate jobs or stranded `queued`/`claimed` jobs.
- Same-Area fraud processing produced 187 flags while preserving Area serialization. Four workers
  showed an average Area-lock wait of about 8.3 seconds and a maximum of **42.817 seconds**.
- The dedicated attendance Playwright suite passed **6/6**, covering morning/evening matching,
  intermediate reactive UI states, midnight pairing, 25-hour expiry, exact-file duplication,
  zero-face completion, corrupt-image retry/failure, oversized upload rejection, yearly rollups,
  and Svelte dependency tracking.
- The existing general Playwright suite passed **6/6** after excluding the dedicated real-stack
  attendance suite from its preview-server configuration.
- `npm run check` passed with **0 errors and 0 warnings**; `npm run build`, scoped Prettier,
  Python/Node syntax checks, `git diff --check`, and `npm audit --offline --omit=dev` all passed.

## Evidence and retained data

- Full local evidence is stored in
  `test-output/attendance-e2e/20260728-101644/E2EReport.md`, with CSV/JSON audits, overlays, face
  crops, full embeddings, and four browser screenshots. Raw embeddings and bulky evidence remain
  git-ignored.
- The concurrency records are intentionally retained and tagged `E2E-28044945` for inspection;
  existing operational records were not modified.
- The migration was applied successfully to the current local PostgreSQL stack.

## Residual findings

- Compression variants are materially weak at the configured `0.68` threshold: cohort match rates
  were 14.29%, 0%, 20%, and 44.44%. Low-light, crop, and mirror variants performed much better.
  Threshold/model calibration should be evaluated on a representative consented workforce set
  before production rollout.
- API acceptance stayed well below the one-second target, but a 20-request same-Area burst waited
  up to 42.817 seconds for serialized worker processing. Additional workers improve independent
  Area throughput but cannot remove deliberate contention within one Area.

---

# Output: UI Data Consistency and Interaction Audit (2026-07-28)

## Reported defects reproduced

- Reproduced the admin attendance `Status = Present` and `Status = Absent` failure as HTTP 500.
  The status predicate added a SQL condition without adding a bind parameter, while pagination
  values were later mistaken for summary-query filter parameters.
- Confirmed the 28 July versus 27 July mismatch from the supplied screenshots. PostgreSQL stored
  `2026-07-28`, but the pump/vendor/Area drill-down maps converted its IST-midnight JavaScript
  `Date` with `toISOString()`, producing the previous UTC calendar day.

## Fixes implemented

- Captured attendance filter parameters before adding pagination values, so status-only and
  session/status combinations execute with the correct SQL binds.
- Added shared, explicit IST `isDateKey()`, `dateKey()`, formatting, range, and calendar-day
  handling. Replaced UTC date truncation in pump, vendor, Area, and insight aggregation maps.
- Corrected the vendor attendance calendar's yearless `String(Date).slice(0, 10)` keys. A
  historical 31 December 2025 browser regression proves the displayed year and lookup remain
  correct outside the current year and outside an IST browser timezone.
- Corrected XLSX attendance export to write canonical calendar dates; the browser test downloads
  and reads the workbook back with ExcelJS to verify 28 July remains 28 July.
- Hardened admin attendance, attendance export, vendor attendance, and vendor people filters
  against malformed UUIDs, impossible dates, invalid pages, and invalid page sizes instead of
  allowing PostgreSQL conversion errors to become HTTP 500 responses.
- Added a dedicated Playwright audit configuration, reusable against either a production preview
  or the live Docker app, and excluded the long audit from the normal fast Playwright suite.
- Added retained screenshots and an HTML report under `test-output/ui-audit/`. The directory is
  git-ignored because its evidence is environment-specific.

## Detailed browser verification

- The complete audit passed **12/12 suites in 5.5 minutes** using Chromium configured to
  `America/Los_Angeles`, while all displayed and persisted business dates were asserted as
  `Asia/Kolkata`.
- Exercised every current Area, vendor, plant, and pump option; the complete
  session/status/page-size Cartesian matrix; every attendance sort in both directions; single-day
  and ranged dates; pagination; clearing; exports; and malformed date/UUID/page fallbacks.
- Cross-checked every retained `E2E-*` attendance row for 27/28 July against its pump calendar
  date and morning/evening status.
- Independently recomputed PostgreSQL totals and verified the same values in grouped admin
  attendance, vendor drill-down, Area drill-down, and vendor-scoped attendance calendars.
- Clicked admin/vendor navigation, the mobile drawer, all date presets, custom date fields, vendor
  sorting, login/password/logout controls, CSV validation/import/removal, guest dismiss/promote,
  fraud review, merge dismiss/confirm, camera/gallery, cancel, retry, choose-another, and pump
  logout controls.
- The fixed reported flows passed **2/2** again directly against the refreshed Docker container on
  `http://127.0.0.1:3000`.
- The existing real attendance pipeline suite passed **6/6**, and the existing operational-route
  smoke test passed **1/1**.
- `npm run check` passed with **0 errors and 0 warnings**. Production builds completed throughout
  the Playwright runs, scoped Prettier passed, and `git diff --check` passed.

## Evidence and retained records

- Detailed local report:
  `test-output/ui-audit/UIAuditReport.md`.
- Fixed-view screenshots:
  `date-cross-view-fixed.png`, `present-status-filter-fixed.png`,
  `cross-view-aggregate-consistency.png`, `vendor-historical-date-fixed.png`, and
  `csv-import-complete.png`.
- The action tests only created or modified isolated `E2E-UIAUDIT-*` fixtures. These records remain
  in PostgreSQL for inspection; existing operational records were not changed.
- A normal Docker Compose rebuild was interrupted by npm registry connection resets. Because
  dependencies were unchanged, the already verified local production `build/` was layered onto
  the existing app runtime image and only the app container was recreated. The deployed regressions
  then passed on port 3000.

---

# Output: Attendance Evidence Photos and Morning-Only Accuracy (2026-07-28)

## Reported defects addressed

- Fixed the pump/person mismatch where the calendar showed morning attendance (`M`) but the
  summary counters still showed `0`. The affected summaries now read from live
  `daily_person_attendance` rows instead of stale yearly rollups.
- Prevented legacy/test fraud entries with missing `photo_url` from showing broken `View group
photo` links. The fraud review now shows an unavailable state instead of routing admins to a
  photo-not-found page.
- Added admin evidence controls on pump and individual person attendance views so admins can open
  the original group photo and each detected worker crop directly from the review screen.

## Fixes implemented

- Added durable attendance evidence storage with migration
  `004_add_attendance_evidence_review.sql`; existing `person_face_vectors` crops are backfilled
  into the new evidence table.
- Updated the worker to persist each processed face crop as attendance evidence before gallery
  pruning can remove older vectors.
- Added reusable evidence UI for `View group`, `View Worker N`, and `View Individual photo`, with
  admin flagging from the same dialog.
- Added scoped review flags for group-level and person-level evidence, with duplicate-open-flag
  protection.
- Updated pump detail pages to show morning-only count, awaiting/expired split, group photos, and
  worker crops.
- Updated person detail pages to show morning and evening evidence separately, including both group
  photos and individual crops.

## Verification

- Migration applied successfully against the local Docker PostgreSQL database.
- Backfill verified for the reported `E2E28044916ONE` fixture: 7 durable evidence crops and 7
  morning-only attendance rows were present.
- `npm run check` passed with 0 errors and 0 warnings.
- `npm run build` passed locally.
- Focused Playwright evidence flow passed: real morning upload, live morning-only assertions,
  group photo load, worker crop load, flag persistence, evening upload, morning/evening evidence
  visibility, and group-level flag persistence.
- Docker rebuild was blocked by external npm registry `ECONNRESET`, so the already-built verified
  app and updated worker file were copied into the existing containers and restarted. Live
  `http://127.0.0.1:3000/login` returns 200, all app/worker containers are running, and the live
  app container contains the new `Morning-only sessions` build output.

---

# Output: Pump Video-Call Screen Capture Mode (2026-08-05)

## Feature completed

- Added an optional pump-side **Capture video call** mode for WhatsApp or other video-call attendance.
- Preserved the existing **Take photo** and **Choose photo** flows. They still produce the same selected image preview and submit through the same attendance API.
- Used the browser's explicit screen/window picker through `navigator.mediaDevices.getDisplayMedia`; the app cannot silently capture WhatsApp.
- Added a live in-app preview for the selected video-call window and a **Use this frame** action.
- Converted the selected video frame into a JPEG `File`, then reused the existing `selectedFile`, `previewUrl`, sticky submit button, `/api/attendance/submit`, AI processing queue, worker matching, and admin review flow.
- Added cleanup so screen-sharing tracks stop when the user chooses a normal file, resets the capture, stops sharing, or leaves the page.

## Existing flow kept intact

- Camera capture remains available from the same pump attendance screen.
- Gallery/file upload remains available from the same pump attendance screen.
- The backend attendance submission contract was not changed for this feature; video-call capture submits as a normal JPEG image.
- RDC Suraksha was not touched.

## Verification

- `npx prettier --write src/routes/pump/+page.svelte` completed.
- `npm run check` passed with 0 errors and 0 warnings.
- `npm run build` passed.
- Manual browser verification is still required for the native screen-share picker because Chrome/Edge require a real user-selected window/screen.

---

# Output: Pump Attendance Result Retry Before Acceptance (2026-08-05)

## Defect addressed

- Fixed the pump-side workflow where an attendance session could complete with too few or zero detected people and leave the contractor with only a final Done action.
- The pump operator can now review the detected count and face crops before accepting the result.

## Feature completed

- Replaced the final-only completed state with an explicit review action area.
- Added **Retry with better photo** on the completed attendance result screen.
- Added **Accept result** for cases where the detected people/count are correct.
- Added a pump-only retry API at `/api/attendance/retry/[id]`.
- The retry API clears the selected session, queued job, face vectors, durable face evidence, guest faces, review flags, fraud flags, and the affected daily attendance match bits before allowing a fresh upload.
- Evening retry reopens the paired morning session so the same evening attendance can be submitted again after the bad evening result is cleared.
- Existing photo upload, camera capture, and video-call screen capture flows continue to use the same submit pipeline.

## Verification

- `npx prettier --write src/routes/pump/+page.svelte src/routes/api/attendance/retry/[id]/+server.ts` completed.
- `npm run check` passed with 0 errors and 0 warnings.
- `npm run build` passed.
- Docker app image was rebuilt and recreated with `docker compose up -d --build app`.
- Live app responds on `http://localhost:3001/login` with HTTP 200.

---

# Output: Face Attendance Evaluation Approval System (2026-08-07)

## Feature completed

- Added a reusable face-attendance evaluation and approval harness for measuring AI/service quality before accepting future changes.
- Added a deterministic Kaggle/Pins manifest builder for the first 100-identity benchmark.
- Added strict full approval gates for the 100-user identity benchmark in `eval/face-approval.full.json`.
- Added a fast smoke approval profile for the checked-in group-photo corpus in `eval/face-approval.smoke.json`.
- Added a reusable evaluator that calls the real AI service, scores metrics, writes reports, and returns approved/blocked gate decisions.
- Added approval outputs under `test-output/evaluations/<run-id>/`: `metrics.json`, `approval.json`, `approval-gates.csv`, `report.md`, `failed-cases.html`, component CSVs, and threshold sweep output for identity runs.
- Added npm scripts: `eval:manifest:pins`, `eval:faces:smoke`, `eval:faces`, and `eval:approve`.
- Added evaluation documentation and Mermaid architecture in `plans/FaceAttendanceEvaluationApprovalSystem.md`.
- Updated `.gitignore` so downloaded datasets, generated manifests, and evaluation artifacts with biometric metadata are not committed.

## Metrics covered

- Dataset coverage: identities, gallery images, probe images, failed images.
- Face detection: detection success rate and visible-face recall for group photos.
- Embedding contract: valid bbox, 512-dimension embeddings, finite values, contract error rate.
- Identity matching: top-1 accuracy, top-5 accuracy, verified top-1 accuracy, false accept rate, false reject rate, equal error rate, and threshold sweep.
- Condition slices: low/normal/bright light, blur/sharpness, and face-size buckets.
- Latency: mean, p95, and max AI processing time.

## Smoke verification

- Started the Docker AI service and confirmed `/health` returned `model_loaded: true`.
- `npm run eval:faces:smoke` passed with approval on run `20260807-132036`.
- Smoke metrics: 4 photos, visible-face recall 0.636364, embedding contract errors 0, failed images 0, mean processing 10495.0 ms, p95 processing 11722.98 ms.
- A full 20-photo smoke attempt completed once and showed visible-face recall 0.903535 with 0 contract errors, but it was too slow for a fast smoke command on CPU, so the smoke shortcut now samples 4 photos and the full benchmark remains dataset-based.

## Verification

- `python -m py_compile scripts/build-face-eval-manifest.py scripts/run-face-approval-eval.py` passed.
- JSON validation for package/config files passed.
- `npm run eval:faces:smoke` passed and wrote reports under `test-output/evaluations/20260807-132036`.
- `npm run check` passed with 0 errors and 0 warnings.
- `npm run build` passed.

---

# Output: Public Dataset Download and Evaluation Runs (2026-08-07)

## Feature completed

- Added `scripts/download-eval-datasets.py` to download/register public eval datasets through KaggleHub.
- Added `eval/datasets.local.json` as an ignored local registry for machine-specific dataset cache paths.
- Updated `scripts/build-face-eval-manifest.py` so identity manifests can be built from local dataset keys such as `pins` and `lfw`.
- Added `scripts/build-wider-eval-manifest.py` for WIDER FACE validation/train bbox manifests.
- Extended `scripts/run-face-approval-eval.py` with `wider-face-detection-eval` support.
- Added WIDER bbox scoring: IoU matching, bbox precision, bbox recall, bbox F1, exact count accuracy, count MAE, failed-image count, contract errors, and latency.
- Added approval profiles and commands for LFW sanity and WIDER bbox smoke testing.

## Datasets downloaded

- Pins Face Recognition downloaded and registered: 17,534 images.
- LFW downloaded and registered: 13,233 images.
- WIDER FACE downloaded and registered: 32,203 images with train/val bbox annotation files.
- WIDER required a short-path extraction fallback into `datasets/wider-face` because the KaggleHub cache path hit a Windows path-length extraction error.
- CelebA and VGGFace2 were not downloaded by the core command because they are large datasets; the downloader supports them with `python scripts/download-eval-datasets.py --all --include-large` when that storage/time cost is explicitly accepted.

## Evaluation results

- Group-photo smoke run `20260807-142030`: approved, 4 photos, visible-face recall 0.636364, contract errors 0, failed images 0, p95 processing 3497.27 ms.
- LFW sanity run `20260807-141724`: approved, 20 identities, 100 images, detection success 1.0, top-1 accuracy 1.0, verified top-1 accuracy 0.583333, false accept rate 0.0, equal error rate 0.0, p95 processing 1270.29 ms.
- WIDER bbox smoke run `20260807-142450`: approved, 25 images, 59 labeled faces, bbox recall 0.847458, bbox precision 0.704225, bbox F1 0.769231, exact count accuracy 0.64, count MAE 0.8, contract errors 0, failed images 0, p95 processing 3451.84 ms.
- Pins full 100-identity run `20260807-133711`: blocked by quality gates. It used 100 identities, 500 gallery images, and 1000 probe images, but detection success was 0.082, top-1 accuracy was 0.023, verified top-1 accuracy was 0.001, equal error rate was 0.109553, and failed images were 1377.

## Verification

- `npm run eval:download:core` completed and registered Pins, LFW, and WIDER.
- `npm run eval:manifest:pins:local` generated `eval/manifests/pins-100.json`.
- `npm run eval:manifest:lfw:local` generated `eval/manifests/lfw-20.json`.
- `npm run eval:manifest:wider:local` generated `eval/manifests/wider-val-25.json`.
- `npm run eval:faces:smoke` passed.
- `npm run eval:faces:lfw` passed.
- `npm run eval:faces:wider` passed.
- `python -m py_compile scripts/download-eval-datasets.py scripts/build-face-eval-manifest.py scripts/build-wider-eval-manifest.py scripts/run-face-approval-eval.py` passed.
- JSON validation for package/config/manifest files passed.
- `npm run check` passed with 0 errors and 0 warnings after rerunning outside the sandbox because the first sandboxed run hit Vite/Rolldown `spawn EPERM`.
- `npm run build` passed.

---

# Output: Evaluation Dataset Relocation to D Drive (2026-08-07)

## Fix completed

- Moved the downloaded Pins and LFW datasets out of KaggleHub's default C-drive cache and into the project-local ignored dataset folder.
- Kept WIDER FACE in the project-local ignored dataset folder and removed its old C-drive KaggleHub cache/archive.
- Updated `scripts/download-eval-datasets.py` so future core dataset downloads prefer/use project-local folders under `datasets/` instead of the default Windows user cache.
- Refreshed `eval/datasets.local.json` so all active dataset roots point to `D:/My Projects/Svelte Project/face-attendance-system/datasets/...`.
- Rebuilt the generated Pins, LFW, and WIDER manifests so they also point to D-drive paths.
- Updated `test-output/evaluations/EvaluationResultsSummary.md` with the new D-drive dataset locations.
- Rewrote existing generated evaluation artifacts under `test-output/evaluations/` so their recorded dataset paths now point to the D-drive dataset locations instead of stale C-drive cache paths.

## Current dataset locations

- Pins Face Recognition: `D:/My Projects/Svelte Project/face-attendance-system/datasets/pins`
- LFW: `D:/My Projects/Svelte Project/face-attendance-system/datasets/lfw`
- WIDER FACE: `D:/My Projects/Svelte Project/face-attendance-system/datasets/wider-face`

## Verification

- Verified Pins on D with 17,534 images.
- Verified LFW on D with 13,233 registered images.
- Verified WIDER on D with 32,203 registered images and train/val bbox annotation files.
- Confirmed the old C-drive KaggleHub dataset folders for Pins, LFW, and WIDER no longer exist.
- Confirmed active `eval/datasets.local.json`, `eval/manifests/pins-100.json`, `eval/manifests/lfw-20.json`, and `eval/manifests/wider-val-25.json` contain no C-drive user-cache references.
- Confirmed `test-output/evaluations/` also contains no stale C-drive dataset path references.
- Confirmed `/datasets/`, `eval/datasets.local.json`, generated manifests, and eval outputs are ignored by git.

---

# Output: Evaluation Report Index and Case Review Usability (2026-08-07)

## Fix completed

- Improved evaluation output naming so run folders are readable, for example `<timestamp>__<approved-or-blocked>__<approval-profile>__<dataset>` instead of only a timestamp.
- Added `test-output/evaluations/INDEX.md` as the first file to open after testing. It lists every evaluation run with status, evaluation name, dataset, key metrics, and links to the detailed evidence.
- Added `test-output/evaluations/INDEX.json` for tooling or future UI/report ingestion.
- Added per-run `README.md` files so each evaluation folder explains what ran, whether it was approved or blocked, which dataset was used, and which files to inspect.
- Added per-run `case-review.csv` and `case-review.html` files that show every evaluated photo/case with `PASS`, `PARTIAL`, or `FAIL`, plus the subject, image id/path, expected result, actual result, score, and failure reason.
- Backfilled the old date-only evaluation folders by renaming them to readable status/profile/dataset names and adding the new case-review and README files.
- Labeled incomplete/abandoned evaluation folders as `__incomplete__...` and added a README explaining that metrics and approval files were never produced.
- Added `npm run eval:index` to rebuild the global evaluation index without rerunning the AI service.
- Updated `eval/README.md` with the new report-reading workflow.
- Fixed a latent exception-row bug in group/WIDER evaluation error handling so failed evaluation rows now keep the correct fields for their evaluation type.

## Where to look

- Start here: `test-output/evaluations/INDEX.md`.
- For all photo-level outcomes in a run: open that run's `case-review.html`.
- For only failed/problem photos: open that run's `failed-cases.html`.
- For approval thresholds: open that run's `approval-gates.csv`.
- For the readable run summary: open that run's `README.md`.

## Verification

- `npm run eval:index` passed and generated `test-output/evaluations/INDEX.md`.
- Confirmed the evaluation folder list now shows names such as `20260807-142450__approved__wider-bbox-smoke__wider-face`, `20260807-133711__blocked__full-100-identity-approval__pins-face-recognition`, and `20260807-131442__incomplete__group-corpus-smoke-approval__group-corpus`.
- `python -m py_compile scripts/download-eval-datasets.py scripts/build-face-eval-manifest.py scripts/build-wider-eval-manifest.py scripts/run-face-approval-eval.py` passed.
- JSON validation for `package.json` and evaluation config files passed.
- Verified a generated `case-review.csv` includes per-photo status, reason, expected/actual counts, subject, image id, and D-drive dataset path.
- `npm run check` passed with 0 errors and 0 warnings after rerunning outside the sandbox because the first sandboxed run hit Vite/Rolldown `spawn EPERM`.

---

# Output: Compact Visual Evaluation Evidence Folders (2026-08-07)

## Fix completed

- Reworked evaluation outputs so each run folder now keeps only `README.md` and one `review/` folder.
- Added `review/index.html` as the main human-readable report for each run. It shows status, key metrics, all metric values, approval gates, case counts, and every evaluated photo/case.
- Added `review/photos/` with local thumbnails for the photos involved in the evaluation, so the report can show the actual images without requiring the user to hunt through dataset folders.
- Added visual bbox overlays where the run has bbox data:
  - WIDER FACE reports show green expected/labeled boxes and teal AI-detected boxes.
  - Identity extraction reports show teal detected face boxes when a bbox was recorded.
- Kept only the necessary data files in `review/`: `index.html`, `cases.csv`, `metrics.json`, `approval-gates.csv`, and `photos/`.
- Removed redundant generated files from existing evaluation run folders, including raw runner CSVs, duplicate HTML reports, duplicate JSON files, and old failed-case artifacts.
- Added `--keep-raw` for debugging when raw runner internals are needed, while keeping compact output as the default.
- Updated `eval/README.md` and `test-output/evaluations/INDEX.md` so the expected workflow is clear: open `INDEX.md`, then open a run's `review/index.html`.

## Current output layout

```text
test-output/evaluations/
  INDEX.md
  <timestamp>__<status>__<profile>__<dataset>/
    README.md
    review/
      index.html
      cases.csv
      metrics.json
      approval-gates.csv
      photos/
        *.jpg
```

## Verification

- `npm run eval:index` passed and compacted existing evaluation folders.
- Verified all evaluation run folders contain only `README.md` and `review/`.
- Verified all review folders contain only `index.html`, `cases.csv`, `metrics.json`, `approval-gates.csv`, and `photos/`.
- Verified the WIDER smoke run has 25 thumbnails in `review/photos/`.
- Verified the full Pins 100-identity run has 1500 thumbnails in `review/photos/`.
- Visually inspected a generated WIDER thumbnail and confirmed the photo renders with bbox overlays.
- `python -m py_compile scripts/download-eval-datasets.py scripts/build-face-eval-manifest.py scripts/build-wider-eval-manifest.py scripts/run-face-approval-eval.py` passed.
- JSON validation for `package.json` and evaluation config files passed.

---

# Output: Golden Small-Group Attendance Dataset V1 (2026-08-11)

## Dataset completed

- Built `datasets/golden-small-groups-v1` as the reusable golden dataset for morning/evening attendance model evaluation.
- Created 50 deterministic attendance use cases with 100 unlabelled evaluation input images:
  - 50 `morning.jpg`
  - 50 `evening.jpg`
- Created 100 labelled preview images for human verification:
  - 50 `morning_labeled_preview.jpg`
  - 50 `evening_labeled_preview.jpg`
- Created one `ground_truth.json` per case with worker IDs, expected present/absent workers, expected matches, face-region bboxes, source image references, scenario metadata, and IoU assignment threshold.
- Created `dataset.json`, `manifest.json`, `workers.json`, and `quality-summary.csv` for reuse by future model evaluators.
- Created 10 visual verification contact sheets under `datasets/golden-small-groups-v1/verification/`.
- Added `scripts/build-golden-small-groups.py` so the same dataset can be regenerated deterministically.
- Added `npm run eval:golden:build`.

## Scenario coverage

- `normal_6_to_5`: 8 cases.
- `normal_5_to_5`: 7 cases.
- `low_light_evening`: 8 cases.
- `blur_evening`: 7 cases.
- `small_faces_far_camera`: 7 cases.
- `partial_occlusion`: 5 cases.
- `extra_unknown_evening`: 4 cases.
- `fraud_duplicate_cross_pump`: 4 cases.

## Quality and labeling

- Each generated photo records brightness mean, brightness standard deviation, edge-variance sharpness, average face-area ratio, face-size label, and manual quality variant.
- Labels are assigned before testing using anonymous worker IDs such as `worker_001`.
- Labelled previews show the worker mapping visually, while unlabelled `morning.jpg` and `evening.jpg` remain clean evaluation inputs.
- Ground-truth face-region boxes are stored for IoU-based assignment, not exact bbox matching.
- Visually inspected all 10 generated contact sheets to verify the morning/evening worker mapping and scenario layout.

## Verification

- `npm run eval:golden:build` passed.
- Verified 50 case folders.
- Verified 50 morning eval images and 50 evening eval images.
- Verified 100 labelled preview images.
- Verified 50 `ground_truth.json` files.
- Verified 10 visual verification contact sheets.
- Verified `quality-summary.csv` contains 100 session rows.
- `python -m py_compile scripts/build-golden-small-groups.py` passed.
- JSON validation passed for `dataset.json`, `workers.json`, `manifest.json`, and all 50 `ground_truth.json` files.

---

# Output: Golden Small-Group Evaluation Run (2026-08-11)

## Evaluation runner completed

- Added `scripts/run-golden-small-group-eval.py` for reusable small-group attendance model evaluation.
- Added `npm run eval:golden:run`.
- The runner evaluates the live AI service against `datasets/golden-small-groups-v1`.
- Raw embeddings are used in memory for scoring and are not written to report files.
- Output is stored under `test-output/evaluations/<run-id>/` with:
  - `metrics.json`
  - `scenario-metrics.csv`
  - `case-metrics.csv`
  - `image-metrics.csv`
  - `match-pairs.csv`
  - `threshold-sweep.csv`
  - `fraud-groups.json`
  - `report.md`
  - `review/index.html`
  - 100 bbox overlay images under `review/overlays/`

## Latest full run

- Run folder: `test-output/evaluations/20260811-125327__golden-small-group__golden-small-groups-v1`.
- Evaluated 50 cases and 100 morning/evening images.
- Expected faces: 543.
- Detected faces: 543.
- Matched ground-truth faces by IoU: 539.
- Missed faces: 4.
- Extra detections: 4.
- Face detection recall: 99.3%.
- Face detection precision: 99.3%.
- Face count exact rate: 100.0%.
- Mean bbox IoU: 0.6941.
- Embedding/bbox/crop contract errors: 0.
- Failed images: 0.
- Attendance accuracy at current threshold 0.68: 60.6%.
- Expected morning-to-evening match recall at threshold 0.68: 10.0%.
- Pair false-match rate at threshold 0.68: 0.0%.
- Unknown-face handling accuracy: 100.0%.
- Fraud duplicate recall at threshold 0.68: 0.0% (0 of 2 known duplicate groups).
- Average AI processing time: 3900.038 ms per image.
- P95 AI processing time: 5361.71 ms.

## Threshold finding

- The current face match threshold `0.68` is too strict for this golden small-group dataset.
- `threshold-sweep.csv` recommends `0.30` for this run.
- At threshold `0.30`, pair-level precision was 100.0%, recall was 97.6%, F1 was 0.9877, and false-match rate was 0.0%.

## Verification

- `python -m py_compile scripts/run-golden-small-group-eval.py` passed.
- `npm run eval:golden:run` completed successfully.
- `npm run check` passed with 0 errors and 0 warnings after rerunning outside the sandbox because the first sandboxed attempt hit a Windows `spawn EPERM` while Vite loaded config.
- Verified `image-metrics.csv` contains 100 rows.
- Verified `case-metrics.csv` contains 50 rows.
- Verified `scenario-metrics.csv` contains 8 rows.
- Verified `threshold-sweep.csv` contains 28 threshold rows.
- Verified `review/overlays/` contains 100 overlay images.
- Verified `review/index.html` references existing overlay image files.

---

# Output: Threshold-Wise Golden Evaluation Metrics (2026-08-11)

## Threshold decision output completed

- Expanded `scripts/run-golden-small-group-eval.py` so the golden evaluation now produces threshold-wise decision metrics instead of only pair-level precision/recall.
- Added threshold coverage from `0.20` to `0.86` in `0.02` steps.
- Added three reusable decision files:
  - `threshold-sweep.csv`: one row per threshold with full overall metrics.
  - `threshold-scenario-metrics.csv`: one row per threshold per scenario.
  - `threshold-case-metrics.csv`: one row per threshold per case.
- The threshold tables now include attendance accuracy, expected match recall, top-1 accuracy, pair precision/recall/F1, pair false-match rate, pair false-non-match rate, false absent rate, false present rate, unknown handling, fraud duplicate recall, and cross-pump false duplicate rate.

## Latest full threshold run

- Run folder: `test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1`.
- Evaluated 50 cases and 100 morning/evening images.
- `threshold-sweep.csv` contains 34 threshold rows.
- `threshold-case-metrics.csv` contains 1700 rows.
- `threshold-scenario-metrics.csv` contains 272 rows.
- Recommended threshold: `0.24`.
- At threshold `0.24`:
  - Attendance accuracy: 98.6%.
  - Expected match recall: 98.0%.
  - Pair precision: 99.6%.
  - Pair recall: 99.2%.
  - Pair F1: 0.9939.
  - Pair false-match rate: 0.1%.
  - False absent rate: 1.5%.
  - False present rate: 0.0%.
  - Unknown handling accuracy: 100.0%.
  - Fraud duplicate recall: 100.0%.
  - Cross-pump false duplicate rate: 0.0%.

## Verification

- `python -m py_compile scripts/run-golden-small-group-eval.py` passed.
- `npm run eval:golden:run` completed successfully.
- `npm run check` passed with 0 errors and 0 warnings.
- Verified `image-metrics.csv` contains 100 rows.
- Verified `case-metrics.csv` contains 50 rows.
- Verified `match-pairs.csv` contains 1445 rows.
- Verified `threshold-sweep.csv` contains 34 rows.
- Verified `threshold-case-metrics.csv` contains 1700 rows.
- Verified `threshold-scenario-metrics.csv` contains 272 rows.
- Verified `review/overlays/` contains 100 overlay images.
- Verified `review/index.html` references existing overlay image files.

---

# Output: Deterministic Golden Evaluation Visual Report (2026-08-19)

## Deterministic report generator completed

- Added `scripts/explain-golden-small-group-eval.py`.
- Added `npm run eval:golden:explain`.
- The report generator does not call the AI service, does not resample the dataset, and does not use any LLM/model judge.
- It reads frozen artifacts from the saved eval run: `metrics.json`, `match-pairs.csv`, `image-metrics.csv`, `threshold-sweep.csv`, `threshold-case-metrics.csv`, `threshold-scenario-metrics.csv`, and the golden `ground_truth.json` files.
- It rebuilds threshold decisions from saved similarity scores and fixed golden labels, so the same run directory and threshold produce the same report files.

## Generated report output

- Report folder: `test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1/review/decision-review`.
- Main HTML report: `test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1/review/decision-review/index.html`.
- The main existing review page now links to the deterministic decision review.
- Generated 543 reusable face crop thumbnails for visual worker-level review.
- Generated deterministic machine/report artifacts:
  - `decision-trace.json`
  - `threshold-comparison.csv`
  - `threshold-0_68-worker-decisions.csv`
  - `threshold-0_68-attendance-errors.csv`
  - `threshold-0_68-pair-errors.csv`
  - `threshold-0_68-case-summary.csv`
  - `threshold-0_24-worker-decisions.csv`
  - `threshold-0_24-attendance-errors.csv`
  - `threshold-0_24-pair-errors.csv`
  - `threshold-0_24-case-summary.csv`

## 0.68 threshold explanation

- At threshold `0.68`, attendance accuracy is `60.6%`.
- This is `350 / 578` correct worker-session attendance decisions.
- There are `228` wrong worker-session decisions.
- All `228` wrong attendance decisions are false absences.
- Pair-level errors at `0.68`: `222`.
- Deterministic reason counts:
  - `threshold_too_strict`: 220.
  - `morning_detection_or_assignment_missing`: 5.
  - `embedding_similarity_below_threshold`: 2.
  - `evening_detection_or_assignment_missing`: 1.
- The comparison threshold included in the same report is `0.24`, where attendance errors reduce to `8`.

## Verification

- `python -m py_compile scripts/explain-golden-small-group-eval.py` passed.
- `package.json` parses successfully after adding `eval:golden:explain`.
- `npm run eval:golden:explain -- --threshold 0.68` completed successfully.
- Verified the generated HTML has 885 local image/file references and 0 missing references.
- Verified CSV row counts:
  - `threshold-0_68-worker-decisions.csv`: 578 rows.
  - `threshold-0_68-attendance-errors.csv`: 228 rows.
  - `threshold-0_68-pair-errors.csv`: 222 rows.
  - `threshold-0_24-attendance-errors.csv`: 8 rows.
  - `threshold-comparison.csv`: 34 rows.
- Reran `npm run eval:golden:explain -- --threshold 0.68` and verified SHA256 hashes stayed stable for `index.html`, `decision-trace.json`, `threshold-0_68-attendance-errors.csv`, `threshold-0_68-pair-errors.csv`, `threshold-0_24-attendance-errors.csv`, and `threshold-comparison.csv`.

---

# Output: Camera-Facing Attendance Dataset And Dynamic Threshold Dashboard (2026-08-21)

## Dynamic threshold dashboard completed

- Updated `scripts/explain-golden-small-group-eval.py` so the visual review dashboard now supports threshold selection inside the page.
- The dashboard now embeds all saved threshold rows from the evaluation run.
- Changing the threshold updates:
  - Overall metric cards.
  - Attendance explanation.
  - Threshold comparison table highlight.
  - Scenario breakdown.
  - Root-cause counts.
  - Fraud duplicate decision.
  - Worker-level visual error cards.
  - Pair-level error preview.
- Reduced dashboard slowness by rendering only the selected threshold's visible review cards instead of pre-rendering every image-heavy card up front.
- Added lazy-loaded images and a `Show more cases` control so the page does not immediately load every group image and crop.
- Added `dashboard-data.json` as a reusable machine-readable copy of the embedded dashboard data.

## Camera-facing attendance dataset completed

- Added `scripts/build-camera-attendance-groups.py`.
- Added package scripts:
  - `npm run eval:golden:build:camera`
  - `npm run eval:golden:run:camera`
  - `npm run eval:golden:explain:camera`
- Built the new dataset at `datasets/golden-camera-attendance-v1`.
- This dataset is the primary real-usecase benchmark. The older `golden-small-groups-v1` dataset remains useful as a harder stress benchmark.
- The new dataset has:
  - 50 morning/evening attendance cases.
  - 100 evaluation input images.
  - 100 labelled preview images.
  - 10 visual review contact sheets.
  - 64 selected worker identities.
  - 0 Pins fallback identities after switching to LFW.
- Source selection now prefers LFW DeepFunneled portraits, which are much closer to camera-facing attendance photos than the earlier Pins-only selection.
- Morning/evening identity generation now uses the same source face with deterministic recapture transforms, so the main variations are lighting, mild blur, warm color cast, compression, and small framing shifts.

## New camera-facing scenario mix

- `normal_5_to_4`: 10 cases.
- `normal_6_to_5`: 10 cases.
- `normal_5_to_5`: 8 cases.
- `low_light_evening_5_to_4`: 8 cases.
- `mild_blur_evening_6_to_5`: 6 cases.
- `warm_light_evening_5_to_4`: 4 cases.
- `cross_pump_duplicate_camera_facing`: 4 cases.

## Visual review notes

- Reviewed representative contact sheets for normal, low-light, mild-blur, and cross-pump duplicate scenarios.
- The LFW-backed version is much closer to the pump attendance use case than the earlier Pins-backed version.
- People are mostly portrait/frontal and the evening changes are controlled scenario changes instead of unrelated identity-looking-different photos.
- There can still be minor pose differences because LFW is a public portrait dataset, but it is now appropriate as the primary benchmark for the current attendance workflow.

## Verification

- `python -m py_compile scripts/build-camera-attendance-groups.py scripts/explain-golden-small-group-eval.py` passed.
- `package.json` parses successfully.
- `npm run eval:golden:build:camera` completed successfully.
- Verified `golden-camera-attendance-v1` contains 50 cases, 100 input images, 10 contact sheets, and 64 LFW identities.
- Verified the dynamic dashboard data has 34 thresholds, 50 case assets, 228 errors at threshold `0.68`, and 8 errors at threshold `0.24` for the existing stress-run report.
- AI service was not running at `http://127.0.0.1:8000/health`, so fresh model metrics for `golden-camera-attendance-v1` were not generated yet.

---

# Output: Evaluation Dashboard Performance Optimization (2026-08-21)

## Dashboard loading optimized

- Updated `scripts/explain-golden-small-group-eval.py` so the visual evaluation dashboard no longer embeds the full image-heavy threshold payload inside `index.html`.
- Split dashboard data into:
  - `dashboard-summary.js` for the small first-load summary, threshold list, scenario metrics, root-cause counts, and case metadata.
  - `threshold-data/threshold-*.js` chunks for detailed worker-session and pair-error records loaded only when that threshold is selected.
  - `dashboard-data.json` kept as a full machine-readable export for future tooling, but it is no longer loaded by the browser dashboard.
- Kept dashboard image loading lazy with `loading="lazy"` and `decoding="async"`.
- Kept visible review cards capped with the existing `Show more cases` flow so the page does not render every image-heavy error card at startup.

## Measured output

- Previous dashboard problem: `index.html` was roughly 5 MB because it carried the full embedded dashboard data.
- Optimized `index.html`: `25,356` bytes.
- First-load summary file: `dashboard-summary.js` is `203,339` bytes.
- Full reusable data export: `dashboard-data.json` is `6,436,798` bytes, but not loaded by the dashboard page.
- Threshold chunks created: `34`.
- Example selected-threshold chunks:
  - `threshold-0_24.js`: small low-error threshold chunk.
  - `threshold-0_68.js`: larger high-error threshold chunk.

## Browser verification

- Playwright browser check passed against:
  - `test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1/review/decision-review/index.html`
- Initial dashboard load to usable threshold UI: `200 ms`.
- Switching threshold from `0.68` to `0.24`: `29 ms`.
- Threshold options found: `34`.
- Initial threshold message: `Showing 12 of 50 error cases, from 228 worker-session errors.`
- Switched threshold message: `Showing 6 of 6 error cases, from 8 worker-session errors.`
- Browser console errors: `0`.

## Verification

- `python -m py_compile scripts/explain-golden-small-group-eval.py` passed.
- `npm run eval:golden:explain -- --threshold 0.68` completed successfully.
- Verified generated output includes `dashboard-summary.js` and `34` threshold chunk files under `threshold-data`.

---

# Output: On-Demand Evidence Dashboard Rendering (2026-08-21)

## Dashboard rendering optimized again

- Updated `scripts/explain-golden-small-group-eval.py` so the evaluation dashboard no longer pre-renders visual evidence cards.
- Worker-level review now loads as a lightweight case list first.
- Group photos, labelled previews, AI overlays, and worker crops are rendered only after clicking `Open evidence` for a specific case.
- Pair-level review now renders text rows first and loads crop images only after clicking `View images`.
- Removed auto-opened case evidence from the first page render.

## Thumbnail previews added

- Added deterministic dashboard thumbnails under `review/decision-review/thumbnails/`.
- Dashboard image previews now use compressed thumbnail files.
- Each thumbnail links to the original full-resolution input, labelled preview, overlay, or crop file for detailed inspection.
- Added an in-memory thumbnail cache in the generator so repeated threshold rows reuse the same generated thumbnail path instead of recompressing the same image repeatedly.

## Measured output on the local 5500 URL

- Verified against `http://127.0.0.1:5500/test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1/review/decision-review/index.html`.
- Initial dashboard load: `160 ms`.
- Threshold switch from `0.68` to `0.24`: `29 ms`.
- Opening one evidence case: `86 ms`.
- Images in DOM at initial load: `0`.
- Image requests at initial load: `0`.
- Images in DOM after threshold switch: `0`.
- Image requests after threshold switch: `0`.
- Images after opening one evidence case: `10` in the measured `0.24` case.
- Browser console errors: `0`.
- Failed requests: `0`.

## Thumbnail verification

- Clicked evidence uses thumbnail URLs such as `thumbnails/case-images/morning-85aa5b54f81c.jpg`.
- Each clicked evidence image has a full-resolution link, for example `../../../../../datasets/golden-small-groups-v1/cases/SG-001-normal-6-to-5/morning.jpg`.
- Verified all clicked case images in the sampled evidence panel used `thumbnails/`.

## Verification

- `python -m py_compile scripts/explain-golden-small-group-eval.py` passed.
- `npm run eval:golden:explain -- --threshold 0.68` completed successfully.
- Generated current report files:
  - `index.html`: `31,054` bytes.
  - `dashboard-summary.js`: `224,376` bytes.
  - `threshold-data/threshold-0_68.js`: `300,263` bytes.
  - `thumbnails/`: `803` files, `13,047,708` bytes total.

---

# Output: Root-Cause And Fraud Evidence On-Click Previews (2026-08-21)

## Evidence previews added

- Updated `scripts/explain-golden-small-group-eval.py` so `Root Cause Counts` now has a `View examples` button for each deterministic reason.
- Clicking a root-cause row opens a thumbnail-based pair preview below the table, showing representative morning/evening crop pairs for that reason at the selected threshold.
- Root-cause preview is capped to the first 12 examples so a high-volume reason such as `threshold_too_strict` does not load hundreds of images at once.
- Updated `Known Fraud Duplicate Checks` with a `View fraud pair` button for each fraud group.
- Clicking a fraud row opens the known cross-pump worker crop evidence for that fraud group, using the same thumbnail/full-image-link pattern as the other evidence panels.

## Data added

- Added a generated `fraud_evidence` map to the dashboard summary data.
- Fraud evidence is built from the known fraud group, worker ID, case IDs, and existing generated worker crops.
- The dashboard still renders both sections as text-only tables on first load. Images are created only after the user clicks a row.

## Browser verification

- Verified against `http://127.0.0.1:5500/test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1/review/decision-review/index.html`.
- Initial dashboard load: `140 ms`.
- Images in DOM at initial load: `0`.
- Image requests at initial load: `0`.
- Root-cause buttons found: `4`.
- Fraud evidence buttons found: `2`.
- Clicking a root-cause example panel loaded in `51 ms`.
- Root-cause preview images loaded: `24`, all from `thumbnails/`.
- Clicking a fraud evidence panel loaded in `47 ms`.
- Fraud preview images loaded: `2`, all from `thumbnails/`.
- Browser console errors: `0`.
- Failed requests: `0`.

## Verification

- `python -m py_compile scripts/explain-golden-small-group-eval.py` passed.
- `npm run eval:golden:explain -- --threshold 0.68` completed successfully.
- Generated current report files:
  - `index.html`: `38,149` bytes.
  - `dashboard-summary.js`: `226,392` bytes.
  - `threshold-data/threshold-0_68.js`: `300,263` bytes.
  - `thumbnails/`: `806` files, `13,059,581` bytes total.

---

# Output: Pump Take Photo Live Camera Fix (2026-08-21)

## Issue fixed

- `Take photo` was opening the file picker because it was wired to a hidden `<input type="file" capture="environment">`.
- On desktop browsers, `capture` is only a hint and often falls back to the normal file directory.

## Fix implemented

- Updated `src/routes/pump/+page.svelte` so `Take photo` now opens a live camera stream using `navigator.mediaDevices.getUserMedia()`.
- Added a laptop camera preview with `Use this photo` and `Stop camera` actions.
- Capturing a camera frame now creates the same JPEG `File` object used by the existing upload flow.
- Kept `Choose photo` as the file picker flow.
- Kept `Capture video call` as the screen/window capture flow.
- Added clear camera permission and camera-in-use error messages.

## Verification

- `npm run check` passed with `0 errors, 0 warnings`.

---

# Output: Docker App Rebuild For Camera Capture Fix (2026-08-21)

## Docker inspection

- Reviewed `Dockerfile`, `.dockerignore`, `docker-compose.yml`, and `ai-service/Dockerfile`.
- Confirmed the Svelte app is built into the Docker image using:
  - `COPY . .`
  - `RUN npm run build`
  - production start command `node build`
- Because the app image contains the compiled Svelte output, the `Take photo` UI change requires rebuilding the `app` image.
- Confirmed `docker-compose.yml` maps the app to host port `3001`:
  - container `3000`
  - host `http://localhost:3001`

## Build optimization

- The first rebuild attempt showed Docker sending more than `1 GB` of build context.
- Updated `.dockerignore` to exclude generated/local-heavy folders:
  - `datasets`
  - `test-output`
  - `eval`
  - `Bugs`
  - `commands`
  - `playwright-report`
  - `coverage`
  - Python cache folders
- Rebuilt again with the reduced context. New app build context was `8.08 MB`.

## Rebuild completed

- Rebuilt only the app service with:
  - `docker compose up -d --no-deps --build app`
- App image built successfully.
- App container was recreated and started successfully.
- Verified `http://localhost:3001/login` returns `HTTP 200 OK`.
- Verified the rebuilt container contains the new `Use this photo` camera UI text.
- App logs show:
  - `Listening on http://0.0.0.0:3000`

## Current container status

- `postgres`: running and healthy.
- `ai-service`: running and healthy.
- `app`: rebuilt and running on `0.0.0.0:3001->3000`.
- `worker`: running.

---

# Output: Attendance Workflow End-to-End Stabilization (2026-08-21)

## Scope completed

- Tested the pump attendance workflow end-to-end through real login, morning upload, evening upload, retry, failed capture, recovery, browser refresh, browser back/forward, repeated worker preview opens, and camera/screen-capture controls.
- Reproduced the `Could not prepare retry` issue before fixing it.
- Implemented individual worker preview from the attendance result list so clicking any fetched worker opens a focused face-crop preview with worker label, session type, result type, and daily match state.
- Kept existing photo upload intact while validating the newer laptop camera and WhatsApp/video-call screen capture flows.

## Fixes implemented

- `src/routes/pump/+page.svelte`
  - Worker rows are now clickable preview controls with accessible labels and `data-testid="worker-preview-trigger"`.
  - Added a worker preview dialog with crop image, close button, backdrop dismiss, and Escape-key close.
  - Fixed preview modal layering so the top bar no longer blocks the close button.
  - Added `Retry with better photo` for completed result review before accepting attendance.
  - Fixed failed-state `Retry` so it clears the failed session first instead of resubmitting stale data and triggering duplicate/stale-session problems.
  - Reset camera/screen capture state consistently on cancel, retry, upload replacement, and component destroy.
  - Added camera/screen capture readiness guards so `Use this photo` and `Use this frame` cannot run before the video frame is available.

- `src/routes/api/attendance/retry/[id]/+server.ts`
  - Fixed retry cleanup order for finalized evening attendance.
  - Deletes linked rollup finalization rows before deleting the attendance session.
  - Rolls back affected yearly attendance counters safely with `GREATEST(... - 1, 0)`.
  - Reopens the paired morning session when retrying an evening attendance.
  - Added a guard for retrying a morning session that is already paired to an evening session.

- `tests/attendance-workflow-deep.e2e.ts`
  - Added a deep Playwright E2E suite using real pump login and isolated `ATTWF...` test accounts.
  - Covers success, no-face result, finalized evening retry, failed corrupt-image retry, valid recovery, worker preview, camera capture, screen capture, cancel, reload, back/forward, and repeated preview interactions.
  - Cleans only `ATTWF...` E2E test records.

- `playwright.workflow.config.ts`
  - Added a dedicated workflow Playwright config for serial attendance workflow testing against `http://localhost:3001`.

- `package.json`
  - Added `npm run test:e2e:workflow`.

## Root cause found

- The retry endpoint attempted to delete an attendance session that was still referenced by `attendance_rollup_finalizations`.
- PostgreSQL blocked the delete with a foreign-key violation, and the UI showed the generic `Could not prepare retry` message.
- The fix unfinalizes the rollup first, rolls counters back, then deletes retry-owned evidence/session data.

## Verification

- `npm run check` passed with `0 errors, 0 warnings`.
- `npm run test:e2e:workflow` passed:
  - `2 passed (47.1s)`
- Docker app stack checked:
  - `postgres`: running and healthy.
  - `ai-service`: running and healthy.
  - `app`: running on `http://localhost:3001`.
  - `worker`: running.
- App logs confirmed retry cleanup:
  - finalized evening retry cleared with `unfinalizedRollups: 1`.
  - failed corrupt-image retry cleared with `unfinalizedRollups: 0`.
- Worker logs confirmed expected processing:
  - morning group photo detected `5` faces.
  - no-face evening detected `0` faces.
  - replacement evening detected `4` faces.
  - corrupt image intentionally failed, then valid recovery photo completed.

## Visual evidence

- Fresh Playwright screenshots:
  - `test-output/attendance-workflow/ATTWF1787312426822/screenshots`
- Playwright HTML report:
  - `test-output/attendance-workflow/report/index.html`

# Output: Conservative Face-Match Threshold Configuration (2026-09-02)

## Application configuration

- Set the application face-match threshold to `0.30` in `.env.example`, Docker app/worker environments, and runtime fallbacks.
- Kept historical evaluation configurations and generated reports unchanged.
- Adjusted the manual same-pump merge-review band to `0.20 <= similarity < 0.30`, preventing the queue from becoming empty after lowering the match threshold.

## Test credentials

- Added `creds.md` with the seeded admin, pump operator, and vendor test accounts.
- Marked every credential as development/test-only and unsuitable for production.

---

# Output: Attendance Usability Audit and Refinement (2026-09-03)

## Scope completed

- Created a reusable `attendance_ux_auditor` Codex subagent for repeated browser-led usability reviews.
- Logged in as administrator, vendor, and pump operator through the visible login form.
- Audited all primary role routes at desktop `1440x900` and mobile `390x844` using npm Playwright.
- Visually reviewed baseline and final screenshots, browser errors, failed requests, overflow, navigation, focus behavior, and intermediate date-filter states.
- Preserved operational data; the deep workflow used and cleaned only isolated `ATTWF` test records. No password reset was required.

## UX fixes implemented

- Replaced the ambiguous simultaneous `Single day`, `From`, and `To` inputs with an explicit Date range / Single day control that shows only applicable fields.
- Removed duplicate fraud, guest, and merge counters from the admin metric strip while retaining the actionable review queue.
- Added focus entry, focus trapping, Escape close, and focus restoration to the mobile navigation drawer and pump worker-preview dialog.
- Added lazy loading to pump result face crops and renamed `Accept result` to the clearer `Done reviewing`.
- Added accessible sort state to the admin vendor pump table.
- Secured new-tab fraud evidence links with `noopener noreferrer`.
- Removed two decorative side-border accents flagged by the design audit.

## Verification

- `npm run check`: passed with `0 errors, 0 warnings`.
- `npm run build`: passed.
- `npm run test:e2e:usability`: `9 passed`, `1` intentional desktop skip.
- Deep retry and worker-preview workflow: passed.
- Camera, screen-capture, cancel, and failed-session retry workflow: passed.
- Existing responsive and axe Playwright suite: `5 passed`.
- Impeccable detector: `0` findings, with degraded-parser warning recorded.
- Docker: app, worker, PostgreSQL, and AI service running; AI health reported `model_loaded: true`.

## Output

- Detailed report: `plans/AttendanceUXAuditAndRefinementReport.md`
- Baseline screenshots: `test-output/attendance-usability/baseline/`
- Final screenshots: `test-output/attendance-usability/final/`
- Playwright report: `test-output/attendance-usability/report/index.html`

---

# Output: 50-Agent Attendance Concurrency Evaluation (2026-09-04)

## What I built

- Added a reusable scenario-driven runner for 50 concurrent pump agents and 100 real attendance
  submissions: 50 morning requests followed by 50 evening requests.
- Reused the visually curated 50-case golden small-group dataset and its deterministic threshold
  metrics while exercising the real HTTP API, PostgreSQL queue, worker, AI service, and storage.
- Added synchronized request barriers, correlation IDs, queue sampling, service logs, percentile
  latency metrics, success/failure metrics, retries, conflicts, throughput, and drain-time evidence.
- Added a lightweight deterministic HTML report with a dynamic threshold selector, deferred request
  table rendering, and click-to-load morning/evening image previews.
- Added a reusable Chromium verifier for report rendering and lazy-loading behavior.

## Defects found and fixed

- Fixed the evaluation inventory import so it initializes with the correct local database URL.
- Made the runner discover and use the app container's trusted `ORIGIN` for SvelteKit form POSTs.
- Reserved same-Area pumps before ordinary case assignment so known cross-pump fraud cases remain
  valid and deterministic.
- Prevented failed reruns from reusing pumps with prior sessions.
- Resolved a Docker networking failure where the worker could not resolve `ai-service`.
- Changed this project's AI host port from 8000 to 8001 because another project already owns 8000;
  internal service communication remains `ai-service:8000`.

## Verified result

- Run: `20260904-144239__attendance-50-agents__golden-small-groups-v1`.
- 100 attempted, 100 accepted, 100 completed, 0 failed, 0 retries, and 0 conflicts.
- Peak queue: 50; peak claimed: 4; combined throughput: 0.202 sessions/second.
- API p95: 569.3 ms; queue-wait p95: 228.501 s; processing p95: 22.649 s;
  end-to-end p95: 238.736 s.
- At threshold 0.30, the deterministic golden evaluation reports 97.92% attendance accuracy,
  0% false-match rate, 2.23% false-absent rate, and 100% known-fraud recall.
- `npx tsc --noEmit`: passed.
- Headless Chromium report verification: passed, with a retained screenshot.

## Output

- Report: `test-output/load-evaluations/20260904-144239__attendance-50-agents__golden-small-groups-v1/attendance-50-agent-concurrency-report.html`
- Scenario: `eval/scenarios/attendance-50-concurrent.json`
- Runner: `scripts/run-attendance-concurrency-eval.ts`
- Verification: `scripts/verify-attendance-concurrency-report.ts`

## Concurrency Scaling Matrix

- Extended the load evaluator so the same real-pump workflow can run any agent count from 1 to 50.
- Ran and preserved side-by-side 10, 20, 30, 40, and 50-agent concurrency reports, where each level
  contains a synchronized morning wave and a synchronized evening wave.
- Every level completed with 100% request and processing success, zero failures, zero retries, and
  zero conflicts.
- Added scoped cleanup that removes only run-owned attendance sessions, generated people, queue
  records, and rollups while retaining the approved real inventory and report evidence.
- Added a browser-verified comparison report with separate readable latency and capacity tables.
- The measured p95 queue wait rises from 0.856 minutes at 10 agents to 3.808 minutes at 50 agents;
  API p95 remains between 0.005 and 0.009 minutes. CPU inference and queue capacity are the
  scaling constraint.
- Matrix report: `test-output/load-evaluations/20260904-101624__attendance-concurrency-matrix__10-20-30-40-50/attendance-concurrency-comparison-report.html`
