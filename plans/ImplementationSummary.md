# Implementation Summary — Prompt A Prototype Build

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

   | Person | morning_matched | evening_matched | Final |
   |---|---|---|---|
   | 5 of the 6 | true | true | **Present** |
   | 1 of the 6 | true | false | **Absent** |

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
  `api/attendance/submit` *before* an `attendance_sessions` row is ever created, so they are not
  retroactively queryable from history — only expired-unpaired-morning counts (which *do* persist
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
