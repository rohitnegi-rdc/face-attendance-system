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
- An open morning session expires after the pairing window (default **16h**, same settings precedence; `worker/index.js` reads it the same way), checked both lazily on submit and via periodic sweep — never let "most recent open X" pairing run unbounded. 16h (not 24h) so a missed evening cannot swallow the next morning's photo. State machine: `docs/Architecture.md` §5.
- Cross-pump fraud check is Area-scoped and symmetric for every vendor, including RDC's Area-split accounts — never narrow the scope per-vendor, it makes fraud detection order-dependent.
- Same-pump re-match (morning+evening) is expected, never a fraud flag — only a different-pump match is.
- Match threshold is `FACE_MATCH_THRESHOLD` (default **0.28**, from the golden small-group evaluation; see `src/lib/server/matching.ts` and the same parsing in `worker/index.js`) via pgvector cosine similarity, gallery-based (~5 most recent embeddings per person) — never hardcode the threshold.
- All date/time logic is explicit `Asia/Kolkata`, computed in code — never rely on container/DB default TZ.
- Matching + fraud-check + person upsert for one session run inside one Postgres `SERIALIZABLE`-isolation transaction (optimistic concurrency — no blocking Area lock; conflicting concurrent writes abort with `40001`/`40P01` and are retried) — never remove this without understanding the race it prevents (`docs/Architecture.md` §9).
- Duplicate photo (same sha256 hash) is rejected, never double-counted.

## Where things live

| Concern | Path |
|---|---|
| SvelteKit backend routes | `src/routes/api/**`, `src/routes/admin/**`, `src/routes/vendor/**`, `src/routes/pump/**` |
| Auth (JWT httpOnly cookie, role guards) | `src/lib/server/auth.ts` |
| DB access | `src/lib/server/db.ts` |
| IST time helpers | `src/lib/server/time.ts`, `src/lib/date.ts` |
| CSV vendor/pump/plant import | `src/lib/server/csvImport.ts` |
| Attendance evidence/review (flagged guests, merge, fraud) | `src/lib/server/attendanceReview.ts` |
| Background worker (job claiming, fraud check, matching) | `worker/index.js` — see Architecture.md §9 before touching this |
| AI microservice (face detection + embeddings) | `ai-service/main.py` (FastAPI, insightface `buffalo_l`, ONNX CPU, no `--workers` set yet — single process today) |
| DB schema | `db/init.sql` (base) + `db/migrations/00N_*.sql` (incremental, applied via `npm run migrate`) |
| Seed data | `scripts/seed.ts` (`npm run seed`) |

## Commands

**Dev**
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

- `npm run test:regression` (`scripts/run-regression.mjs`): svelte-check, throwaway Postgres, migrations, build, stub AI service (`tests/regression/stub-ai.mjs`, fixed face vectors), app + worker, then the API scenarios in `tests/regression/*.spec.ts`. Needs Docker. `deploy.sh` runs it before shipping. Scenario IDs and coverage: [plans/RegressionTestPlan.md](plans/RegressionTestPlan.md). Every bug fix adds or flips a scenario.
- Pump Retry only works on `failed`/`review` sessions with no fraud evidence; deleting anything else is admin-only (`src/lib/server/sessionCleanup.ts`, audited in `admin_audit_log`).

## Known gotchas (full log: [plans/Learnings.md](plans/Learnings.md) — append new ones there, don't duplicate here)

- Session pairing update must touch **both** rows (`pairing_status` on morning AND evening) — an asymmetric update only surfaces on the *third* submission of the day, not the pair itself.
- A native Postgres service on the host can silently shadow Docker's mapped port (symptom: auth failures from host-side scripts while `docker compose ps` looks healthy) — check `netstat`/`Get-Process` on the port, not Docker logs.
- SvelteKit's CSRF check rejects non-JSON POSTs without a matching `Origin` header — any Node-based test script hitting multipart upload endpoints must set `Origin` explicitly; `adapter-node` also needs `ORIGIN` set as an env var.
- Fraud-check scope must be symmetric (Area-wide for every vendor) — an asymmetric scope (e.g. "narrower for ordinary vendors") makes catching fraud order-dependent on which pump submits first.
- Any "find the most recent open X for pairing" pattern needs an explicit expiry — otherwise one missed step strands everything downstream indefinitely.

## Codebase navigation

A graphify knowledge graph exists at `graphify-out/` (god nodes, community structure, cross-file relationships) — for architecture/relationship questions, prefer `graphify query "<question>"` over grepping raw source; it returns a scoped subgraph instead of the full report. Run `graphify update .` after code changes to keep it current (AST-only, no API cost). See `AGENTS.md` for the full graphify usage rules already configured for this repo.
