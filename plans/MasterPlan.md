# Face-Recognition Attendance Management System — Master Plan

A refined, production-shaped version of your flowchart, turned into (1) a system spec and (2) two copy-paste prompts you can hand to a coding agent (Claude Code, Cursor, etc.) to scaffold the first working prototype.

---

## 1. Refined Entity Hierarchy

**Updated after seeing your real sample data.** The CSV showed something the original plan didn't account for: a Vendor isn't the strict parent of one location — a single vendor (e.g. `R V N Enterprises`) can run pumps across *different* plants, and a single plant (e.g. `BG-Anjanapura`) can host pumps from *different* vendors. There are also two grouping levels — Area and Plant — that sit above the pump itself.

```
Admin (platform owner)
 └── Area (region, e.g. "Bangalore", "Assam")
      └── Plant (physical location, e.g. "BG-Anjanapura")
           └── Pump (the login + attendance entity — your "Pump Contractor", e.g. "ASLPWWI2")
                ├── linked to one Vendor (e.g. "R V N Enterprises")
                └── Person (auto-discovered from photos — no login, no enrollment, see §2a)

Vendor (login) — owns/operates one or more Pumps, potentially across different Plants/Areas
```

- **Admin**: sees everything — all areas, plants, pumps, vendors, attendance, exports, fraud flags. Can bulk-import the vendor/pump/plant structure via CSV (see §8).
- **Vendor**: logs in, sees only the pumps they operate (which may span multiple plants/areas) and aggregate attendance for those pumps.
  - **Vendor Accounts, not always one login per vendor company.** Real onboarding data showed a handful of vendors (most notably `RDC Concrete (India) Ltd`, which operates pumps in nearly every Area in the country) that are not naturally scoped the way a typical vendor is (a small contractor running 1-5 pumps in one city). Rather than giving a company like this one login that sees a national dashboard, such vendors get **one login per Area** — e.g. "RDC Concrete (India) Ltd — Bangalore", "RDC Concrete (India) Ltd — Hyderabad" are separate `vendors` rows/logins, each scoped to only that Area's pumps for that company. Ordinary vendors (the large majority, already naturally scoped to one or a few plants in one Area) keep a single login as before. See §8a for how the importer decides which vendors get split.
- **Pump** (renamed from "Site" in earlier drafts — same entity, now correctly modeled as living inside a Plant): the only role that actually captures photos. Tied to a fixed `plant_id`, and inherits GPS/geofence from that plant.
- **Plant**: a physical location that can host multiple pumps, possibly from different vendors. Exists for GPS/geofencing and admin reporting/filtering (e.g. "show me everything at BG-Anjanapura").
- **Area**: a region grouping plants, used for reporting/filtering (state-level rollups, matching your CSV's `Area Name` column).
- **Person** (replaces "Member" — see §2a): **not enrolled manually**. Auto-discovered the first time a face appears in any daily group photo at a pump. Has no login, no name, no upfront data entry — identity is purely a face-vector gallery that grows over time.

**Naming note**: using "Pump" instead of "Site" from here on, to match your CSV's `PUMP Name` column — same entity as "Pump Contractor" in your original description. Similarly, "Person" replaces "Member" from here on, since there is no enrollment step — see §2a for how identities are actually created.

---

## 2. Core Business Rules

| Rule | Detail |
|---|---|
| **Two sessions/day** | First submission at a pump (for an open, unpaired day — see "Session pairing" below) = `morning`. A second submission is only allowed once ≥ 9 hours have elapsed since the morning submission, and becomes `evening`, explicitly **linked to that specific morning session** rather than to whatever the calendar date happens to be when it's uploaded. Anything submitted before the 9 hours have elapsed is rejected with a clear "9-hour rule" error. |
| **Session pairing (fixes midnight rollover)** | An evening submission is paired to its morning session by an explicit `attendance_sessions.paired_session_id` link, not by matching `session_date` to "today." The evening row **inherits the morning row's `session_date`**, even if the evening photo is physically uploaded after midnight (e.g. morning at 11pm, evening naturally lands ~8am the next calendar day). The "which session type is this submission" check looks for this pump's most recent morning session that has no paired evening session yet **and is still within its pairing window** (see next rule) — not "does a row exist for today's date" — so a late-arriving evening photo always correctly completes the day it belongs to instead of silently starting a new, disconnected day. |
| **Morning session expiry window (prevents a pump getting permanently stuck)** | An open morning session (no evening paired yet) is only eligible for pairing for `EVENING_PAIRING_WINDOW_HOURS` (config value, default **24 hours**) after its `submitted_at`. If no evening submission arrives within that window: the morning session is auto-closed (`paired_session_id` stays NULL, but it's no longer treated as "open" for pairing purposes — mark it resolved, e.g. a `pairing_status ENUM('open','paired','expired')` column, or equivalent), that date is finalized as morning-only/incomplete for every person matched in it (feeds `days_morning_only` in the yearly rollup, §4), and the **next photo submitted at that pump starts a brand-new morning session** rather than being swallowed as a stale evening pairing. Without this cap, a single missed evening submission (camera issue, connectivity, worker forgets) would otherwise cause every subsequent submission at that pump — for days, weeks, indefinitely — to be mispaired as the "evening" completion of that one ancient morning, silently breaking the pump's attendance until an admin manually intervened. This expiry check should run both lazily (checked at submission time before deciding session_type) and via a periodic background sweep (e.g. hourly) that closes out any morning session that's aged past the window, so a stuck-open session doesn't sit undetected between submissions. |
| **Cross-pump fraud check — symmetric, Area-scoped for everyone** | Before writing to attendance, every face vector extracted from today's photo is compared against face vectors already logged today at **other pumps in the same Area** — any vendor, not just this vendor's own pumps, and not a platform-wide scan either. This applies uniformly to every vendor account, including ordinary (non-split) vendors — not just the Area-split accounts (e.g. RDC's). Making it symmetric closes a gap in an earlier draft where an ordinary vendor's narrower scope could miss a fraud pattern that an Area-split account's broader scope would have caught, depending on which pump happened to submit later in the day — an asymmetric rule silently misses fraud depending on submission order, which defeats the point of the check. A match within the Area → fraud flag, no attendance write, admin notified. (See §3 for why Area-scoping — instead of platform-wide — still matters for query cost at real scale.) |
| **Same-pump re-match** | A person already matched at *this* pump today (e.g., appears in both morning and evening photos) is expected and not a fraud flag — only matches at a *different* pump are flagged. |
| **Unknown face handling** | A face detected in the photo that matches no one on any roster goes to a `flagged_guest` table for manual admin review — it does not block the rest of the group from being logged. |
| **Threshold-based matching** | ArcFace cosine similarity ≥ 0.68 (tunable) = match. Below that = unknown. This threshold must be a config value, not hardcoded — you'll need to tune it against real photos. |
| **Timezone: explicit IST everywhere, never server default** | Every notion of "today," `session_date`, and "9 hours elapsed" is computed in `Asia/Kolkata`, explicitly — not whatever the container/OS/DB default happens to be. Relying on a container's `TZ` env var alone is fragile (a redeploy to a differently-configured host silently reverts to UTC); the app must compute date boundaries in IST in code (e.g. `dayjs.tz(now, 'Asia/Kolkata')`) and Postgres date comparisons must use `AT TIME ZONE 'Asia/Kolkata'` explicitly, not rely on the session/database default timezone. |
| **Concurrency: locked, transactional matching** | Face-matching, the fraud check, and person upsert for one session all run inside a single DB transaction, guarded by a Postgres advisory lock keyed on the fraud-check scope (the Area). If a second submission for the same Area arrives while another is mid-processing, it waits (briefly — on the order of hundreds of milliseconds to a few seconds, bounded by how long one photo's matching takes) for the first to commit and release the lock, rather than racing it. This prevents two concurrent submissions in the same Area from both passing a "no match yet" check simultaneously and either double-creating the same real person as two different `persons` rows, or both missing a genuine fraud match against each other because neither had committed when the other's check ran. |
| **Idempotency** | Uploading the same photo twice (network retry) must not double-count attendance — dedupe by photo hash + pump + session. |

---

## 2a. Identity Model — Auto-Discovery, No Enrollment

There is **no manual enrollment step**. The contractor sends a group photo every day and the system builds the roster itself, purely from faces it sees.

**How a person is first created**
The first time a face is detected in *any* daily photo at a pump, its embedding is compared against every existing person already known at that pump. No match found → a new `persons` row is auto-created on the spot, seeded with that one embedding. No name, no login, no upfront data entry — the person simply exists from that point forward as a face vector.

**Multi-embedding gallery, not a single fixed vector**
Rather than storing one embedding per person forever, each person keeps a small **gallery** of their most recent embeddings (e.g. last 5). New photos are matched against the *best* similarity across the whole gallery, and a good match gets added to the gallery (dropping the oldest). This makes matching far more tolerant of day-to-day lighting/angle/PPE variation than pinning identity to a single reference photo — critical here since there's no controlled enrollment photo to fall back on.

**Morning + evening dual-flag attendance**
Each person gets one row per day, with two independent flags rather than a single present/absent value:

```
daily_person_attendance(person_id, pump_id, session_date,
                         morning_matched BOOLEAN DEFAULT false,
                         evening_matched BOOLEAN DEFAULT false,
                         final_status ENUM('present','absent') GENERATED,
                         updated_at)
```

- Morning photo processed → matched people get `morning_matched = true`.
- Evening photo processed → matched people get `evening_matched = true`.
- `final_status = 'present'` only if **both** are true. Morning-only (or evening-only) → `'absent'`, per your rule: "morning 1, evening 0 → absent."

**Identity drift is expected — and needs a human-in-the-loop fix**
Without an enrollment photo to anchor to, a person whose evening photo is worse-lit/angled than their morning one can fall just under the match threshold and get auto-created as a second, phantom person — splitting one human's attendance history across two IDs. This can't be fixed by lowering the match threshold (that risks merging two *different* people into one identity instead, which is a worse failure mode — silently giving one worker credit for another's attendance). Instead:

- A background job periodically flags person-pairs at the *same pump* whose embeddings are similar but just below the match threshold (a "maybe same person" zone, e.g. 0.55–0.68) — candidates for review, not auto-merged.
- Admin gets a **merge tool**: side-by-side face crops of both candidates plus each one's attendance history, and confirms or dismisses.
- On confirm: the newer person's attendance rows are reassigned to the older one, its gallery embeddings are folded in, and it's archived (not hard-deleted, so the merge is auditable) rather than left dangling.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────┐
│  SvelteKit Frontend (mobile-first PWA)       │
│  - Vendor / Pump / Admin login                │
│  - capture=environment camera input          │
│  - Geolocation API                           │
│  - Offline-tolerant upload queue              │
└───────────────────┬───────────────────────────┘
                    │ HTTPS (JSON + multipart image)
┌───────────────────▼───────────────────────────┐
│  SvelteKit Backend (API routes / hooks)       │
│  - Auth (session/JWT) + role guards           │
│  - 9-hour session-state machine                │
│  - Enqueues background job, returns fast       │
└───────────────────┬───────────────────────────┘
                    │ job queue
┌───────────────────▼───────────────────────────┐
│  Background Worker                            │
│  - Calls AI microservice, writes results       │
└───────────────────┬───────────────────────────┘
                    │ internal REST (Docker network)
┌───────────────────▼───────────────────────────┐
│  Python FastAPI — Face AI Microservice        │
│  - insightface on ONNX Runtime (CPU)          │
│  - Detector + ArcFace embedding per face       │
│  - Returns array of {bbox, embedding, crop}    │
└───────────────────┬───────────────────────────┘
                    │
┌───────────────────▼───────────────────────────┐
│  PostgreSQL + pgvector (Docker)               │
│  - vector similarity search (cross-pump scan)  │
│  - roster matching                             │
│  - daily_attendance + aggregate rollups        │
└───────────────────────────────────────────────┘
```

**Why pgvector**: the "cross-pump scan" is a nearest-neighbor search over every face vector logged today, across potentially dozens of pumps. A manual loop in Node/Python doesn't scale. `pgvector`'s `<=>` cosine-distance operator with an HNSW index does this in one indexed query. The scan is now scoped to all pumps in the submitting pump's Area (§2) — the same scope for every vendor account, split or not — so in practice each query filters to a small subset of today's sessions (`pump_id IN (SELECT id FROM pumps WHERE plant_id IN (SELECT id FROM plants WHERE area_id = ...))`) rather than the full platform. Cheaper than the original "compare against every pump nationwide" design, and pgvector's index makes the filtered version trivially fast even as the pump count grows into the hundreds seen in the real onboarding data (§8).

**Why async**: face matching on CPU takes several seconds per photo (see earlier discussion on `insightface`/ONNX resource cost). The submit endpoint enqueues a job and returns immediately; a background worker does the actual matching while the frontend polls for the result. This keeps the field-facing capture page responsive regardless of backend processing time.

---

## 4. Data Model (Postgres)

```sql
-- Identity & hierarchy
areas(id, name, created_at)                                    -- e.g. "Bangalore", "Assam"
plants(id, area_id FK, name, latitude, longitude,
       geofence_radius_m, created_at)                           -- e.g. "BG-Anjanapura"
vendors(id, name, email, password_hash, created_at,
        area_id FK NULL, group_name)
        -- e.g. "R V N Enterprises" (area_id NULL, ordinary single-login vendor)
        -- or "RDC Concrete (India) Ltd — Bangalore" (area_id = Bangalore, group_name =
        -- "RDC Concrete (India) Ltd") for an Area-split vendor account, see §1/§8a.
        -- area_id set = this account's fraud-check scope is "same Area", not "same vendor_id"
pumps(id, plant_id FK, vendor_id FK, pump_code, login_email,
      password_hash, created_at)                                -- e.g. "ASLPWWI2" (has login)
pumps(id, plant_id FK, vendor_id FK, pump_code, login_email,
      password_hash, created_at)                                -- e.g. "ASLPWWI2" (has login)

-- Auto-discovered identities (no enrollment — see §2a)
persons(id, pump_id FK, first_seen_at, last_seen_at, status ENUM('active','merged','archived')
        DEFAULT 'active', merged_into_person_id FK NULL)
person_face_vectors(id, person_id FK, embedding vector(512), source_photo_crop_url, created_at)
                     -- gallery: keep ~5 most recent per person, oldest dropped on insert

-- Attendance
attendance_sessions(id, pump_id FK, session_date, session_type ENUM('morning','evening'),
                     status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
                     pairing_status ENUM('open','paired','expired') DEFAULT 'open',
                     photo_url, photo_hash, gps_lat, gps_lng, submitted_at, processed_at,
                     paired_session_id FK NULL REFERENCES attendance_sessions(id))
                     -- paired_session_id: an evening session points back at the morning session
                     -- it completes. session_date on the evening row is COPIED from the paired
                     -- morning row, not derived from the evening upload's own calendar date —
                     -- this is what makes a late-night-to-early-morning submission still resolve
                     -- to the correct day instead of silently starting a disconnected new day.
                     -- pairing_status: a morning session is 'open' until either an evening session
                     -- pairs with it (-> 'paired') or EVENING_PAIRING_WINDOW_HOURS (default 24h)
                     -- elapses with no evening ('open' -> 'expired'). Only 'open' AND still within
                     -- the window counts as eligible for pairing — this cap is what prevents a
                     -- pump getting permanently stuck pairing every future submission against one
                     -- ancient unpaired morning session (see §2's expiry-window rule).
daily_person_attendance(id, person_id FK, pump_id FK, session_date,
                         morning_matched BOOLEAN DEFAULT false,
                         evening_matched BOOLEAN DEFAULT false,
                         morning_confidence, evening_confidence, updated_at)
                         -- final_status computed as present only if both flags true
flagged_guests(id, session_id FK, embedding vector(512), face_crop_url, reviewed BOOLEAN DEFAULT false)
fraud_flags(id, session_id FK, person_id FK, matched_at_pump_id FK,
            matched_session_id FK, similarity_score, created_at)
person_merge_log(id, kept_person_id FK, merged_person_id FK, admin_id FK,
                  similarity_score, merged_at)

-- Aggregates (rolled up nightly or on-write)
person_attendance_yearly(person_id FK, year, days_present, days_morning_only, days_evening_only,
                          last_updated)
                          -- days_present: both flags true for that date.
                          -- days_morning_only: morning_matched true, evening_matched false.
                          -- days_evening_only: evening_matched true, morning_matched false
                          -- (a person absent from the morning photo but present in the evening
                          -- one) — each date increments exactly one of these three counters,
                          -- never more than one, computed once the day's session pairing (see
                          -- attendance_sessions.paired_session_id) is resolved.

-- Admin/auth
admins(id, email, password_hash, created_at)

-- Bulk import audit trail
csv_imports(id, admin_id FK, filename, rows_total, rows_created, rows_skipped,
            errors_json, imported_at)
```

Design notes:
- `pumps.pump_code` stores the exact code from your CSV (e.g. `ASLPWWI2`) — unique, shown on the pump's login screen.
- `pumps` has **both** `plant_id` and `vendor_id` as separate FKs (vendor is not nested under plant) — this matches your real data, where a vendor's pumps span plants and a plant hosts pumps from multiple vendors.
- GPS/geofence lives on `plants`, not individual pumps, since co-located pumps share a physical location.
- `persons` has no name/title — pure face-identity, scoped to one pump **by design, permanently** — see §2a: identities are never merged across pumps, only across two candidate persons at the *same* pump. If the same real worker is later reassigned to a different pump, they are intentionally treated as a new, separate `persons` row there — this is an accepted trade-off (yearly rollups fragment for movers) rather than a gap to fix; do not build a cross-pump merge path. `merged_into_person_id` exists only for same-pump merges and lets a merged person's old ID still resolve to the surviving one without deleting history.
- `daily_person_attendance` is the dual-flag table implementing the morning+evening rule described in §2a.
- `vendors.area_id` is NULL for the ordinary case (one vendor = one login covering all their pumps). It is set only for the handful of vendor accounts the importer splits per-Area (§8a) — this drives **login/dashboard scoping only** (which pumps this vendor account can see/manage). It does **not** drive fraud-check scope any more — the cross-pump fraud check (§2) is Area-scoped for every vendor account uniformly, split or not. `vendors.group_name` is purely a display label so the admin dashboard can still roll multiple per-Area accounts of the same company back up into one line if needed.

Indexes:
```sql
CREATE INDEX ON person_face_vectors USING hnsw (embedding vector_cosine_ops);
CREATE UNIQUE INDEX ON attendance_sessions (pump_id, session_date, session_type);
CREATE UNIQUE INDEX ON attendance_sessions (photo_hash); -- idempotency
CREATE UNIQUE INDEX ON pumps (pump_code);
```

---

## 5. API Surface (SvelteKit backend)

| Method | Route | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | all | Unified login, returns role + JWT/session |
| POST | `/api/attendance/submit` | pump | Upload photo + GPS → queues background job, returns immediately |
| GET | `/api/attendance/status/:session_id` | pump | Poll job status (pending/processing/completed/failed) |
| GET | `/api/attendance/today` | pump | Current session status (morning/evening/locked) |
| GET | `/api/admin/dashboard/metrics` | admin | Aggregate cards (today's attendance %, active pumps, fraud flags today, etc.) |
| GET | `/api/admin/attendance?area=&plant=&vendor=&pump=&from=&to=` | admin | Filtered attendance table |
| GET | `/api/admin/attendance/export` | admin | Streams XLSX |
| GET | `/api/admin/fraud-flags` | admin | List + resolve fraud flags |
| GET | `/api/admin/flagged-guests` | admin | Review unknown faces |
| GET | `/api/admin/merge-candidates` | admin | List likely-duplicate person pairs for review |
| POST | `/api/admin/merge-candidates/:id/confirm` | admin | Merge two person records |
| POST | `/api/admin/merge-candidates/:id/dismiss` | admin | Dismiss a suggested merge |
| POST | `/api/admin/import/csv` | admin | Bulk import Area/Plant/Pump/Vendor rows from CSV |
| GET | `/api/admin/import/:id` | admin | Import result summary (created/skipped/errors) |
| POST | `/api/vendor/pumps` | vendor/admin | CRUD for pumps |
| GET | `/api/pump/persons` | pump/admin | View auto-discovered persons at this pump + their attendance history |

Internal-only (Docker network, not public):
| POST | `/internal/face/extract` | FastAPI service — returns embeddings array |

---

## 6. Dashboard Metrics (Admin)

Cards: Today's Attendance %, Active Pumps Today, Total Distinct Persons, Fraud Flags Today, Pending Guest Reviews, Pending Merge Reviews, Avg. Elapsed Hours (morning→evening).

Table: filterable by area, plant, vendor, pump, date range, session type, with an **Export to XLSX** button (SheetJS/exceljs on backend, streamed file).

---

## 7. Tech Stack Decisions

- **Frontend**: SvelteKit (SSR off for the capture page — needs to be a fast PWA-like shell), Tailwind for styling.
- **Backend**: SvelteKit server routes (Node adapter) — one deploy unit for frontend+API.
- **AI microservice**: Python + FastAPI + `insightface` on **ONNX Runtime** (CPU execution provider) — a separate container, since face models are heavy and you'll want to scale/replace this independently. ONNX Runtime instead of `deepface`+TensorFlow because it's 2-3x faster on CPU with a much smaller image — no GPU in the prototype environment.
- **Processing model**: attendance submission is **async**. The API accepts the photo, writes a `pending` session row, returns immediately, and a background worker does the face-matching. The frontend polls for the result.
- **DB**: PostgreSQL 16 + `pgvector` extension, all in Docker Compose.
- **Logging**: structured JSON logs from every service (SvelteKit backend, worker, FastAPI AI microservice) — see §7a.
- **Auth**: JWT in httpOnly cookies, role stored in token, SvelteKit `hooks.server.ts` guards routes by role.
- **File storage**: local volume for prototype (swap for S3-compatible bucket later) — store cropped face thumbnails + the group photo.

---

## 7a. Structured Logging & Observability

Every service (SvelteKit backend, background worker, FastAPI AI microservice) logs **structured JSON to stdout**, not plain-text/`console.log` strings — Docker captures stdout either way, but JSON is what makes the logs actually queryable later (grep/jq for the prototype, a log aggregator like Loki/CloudWatch once this goes past prototype stage, no code changes needed to adopt one). Suggested libraries: `pino` for the Node/SvelteKit side, Python's standard `logging` with a JSON formatter (or `structlog`) for FastAPI — both are lightweight, no extra infrastructure required for the prototype.

**Every log line carries these common fields**, so an incident can be traced by filtering on any one of them: `timestamp` (ISO 8601, IST — same timezone rule as §2), `level`, `service` (`sveltekit` / `worker` / `ai-service`), `request_id` (see below), `session_id`, `pump_id`, `area_id`, and `vendor_id` when known.

**Request correlation.** The synchronous `/api/attendance/submit` handler generates a `request_id` (UUID) at the moment a photo is accepted, and that same ID is threaded through everything downstream: the enqueued background job, every worker log line for that session, and the header sent to the FastAPI `/internal/face/extract` call. This means one submission's entire lifecycle — accepted → queued → worker picked it up → AI service call (and its timing) → fraud check → DB writes → completed/failed — is traceable as one `request_id` across all three services' logs, instead of three disconnected log streams you have to correlate by timestamp guesswork.

**Specific events that must be logged (structured, with enough fields to act on, not just "something happened")**:
- Session-type decision and any rejection reason (9-hour rule remaining, day-already-complete, duplicate photo hash) — these are exactly the errors field workers will call in about, so they need to be greppable by `pump_id`.
- **Morning-session expiry** (the `pairing_status: open -> expired` transition from §2's 24h window fix) — this is silent at the DB level by design, so a log line is the only way to notice it's actually happening in production and to confirm the fix is working as intended after rollout.
- **Advisory lock acquisition**: when a worker requests the per-Area lock, log how long it waited before acquiring it. This is the direct instrumentation for the open load-testing question from earlier in this plan (whether Area-wide serialization bottlenecks busy Areas like Kerala/Hyderabad during the morning rush) — without this log field, that question can't be answered from real traffic.
- Face-extraction call timing from the AI microservice (already noted in its own section below — this is the structured version of that, not a separate requirement).
- Person auto-created vs. matched, with the similarity score, for every face processed.
- Fraud flag raised, with `person_id`, the other pump/area involved, and similarity score.
- Merge candidate confirm/dismiss actions, with `admin_id` and both `person_id`s.
- CSV import summary (already returned to the admin UI per §8 — also log it, so there's an audit trail independent of whether anyone looked at the UI response).

**What never gets logged**: raw face embeddings, photo bytes, or anything that could reconstruct a face from the log stream — log `person_id` and similarity scores, never the vector itself. Log levels: `INFO` for normal business events (session created, match found, person created), `WARN` for rejections and expirations, `ERROR` for pipeline failures that set a session to `failed`.

---

## 8. Onboarding Data (your CSV)

Your sample maps directly onto the schema:

| CSV column | Maps to |
|---|---|
| `Area Name` | `areas.name` |
| `Plant Name` | `plants.name` (linked to the area) |
| `PUMP Name` | `pumps.pump_code` |
| `Vendor Name` | `vendors.name` (linked to the pump) |

Given you already have real operational data in this exact shape, Prompt A includes an **admin CSV bulk-import feature** built to this exact column format, rather than making you create dozens of areas/plants/pumps/vendors by hand through a UI. It upserts on `pump_code` so re-importing an updated CSV is safe (won't create duplicates), and it auto-creates any Area/Plant/Vendor rows referenced in the sheet that don't already exist.

The full 204-row sheet was checked directly (not just the 12-row illustrative sample below) for two things the importer needs to handle correctly:
- **No duplicate `pump_code` values** — all 204 `PUMP Name` entries are unique, so the `UNIQUE INDEX ON pumps(pump_code)` holds cleanly against real data.
- **No live vendor near-duplicates today** — normalizing every `Vendor Name` (lowercase, punctuation stripped) still yields 82 distinct vendors for 82 distinct raw strings; nothing in the current sheet is already fragmented. The normalization step below is a forward-looking safeguard against a *future* re-import spelling an existing vendor slightly differently (extra space, different case, dropped punctuation), not a fix for existing dirty data.

### 8a. Import Normalization Rules

Three concrete issues surfaced by the real data, each with a fix baked into the importer (see Prompt A's ADMIN CSV BULK IMPORT section):

1. **Name normalization for Area/Plant/Vendor matching.** Before running find-or-create lookups, trim leading/trailing whitespace, collapse internal double-spaces, and standardize hyphen spacing (no space on either side of a `-` inside a name, e.g. `PUN- Jambe` → `PUN-Jambe`, `Goa-DLF Bayview` stays as-is). This is stored as the canonical name — apply the same normalization on every future CSV row before the lookup, so a re-typed variant of an existing Plant/Area/Vendor matches the existing row instead of creating a duplicate.
2. **Pump-code slugification for generated logins.** `pump_code` can contain characters unsafe for an email address — the real sheet has `PUMP Name = "BOOM 3"` (a literal space). Generated `login_email` must be built from a slugified version of the code (lowercase, non-alphanumeric characters stripped/replaced with nothing), e.g. `BOOM 3` → `boom3@pumps.local`, not `boom 3@pumps.local`. `pump_code` itself is stored unmodified (exactly as in the CSV, since that's what's shown on the pump's physical login screen) — only the derived login_email is slugified.
3. **No vendor-identity inference from pump-code naming patterns.** Pump codes sometimes look like they encode a vendor (e.g. `BGLPRVN2` resembling the `R V N Enterprises` series `BGLPRVN1/3/4`), but the real sheet shows `BGLPRVN2`'s actual vendor is `KS Enterprises` — a different company. The importer (and any future admin tooling) must take vendor identity **only** from the CSV's `Vendor Name` column, never infer or "correct" it from the pump code's text.

### 8b. Area-Split Vendor Accounts (RDC Concrete and similar)

Per your decision: `RDC Concrete (India) Ltd` — which in the real sheet operates pumps across nearly every Area in the country — is imported as **one separate vendor account per Area** rather than a single national login. Concretely, for this vendor only:
- The importer creates one `vendors` row per distinct Area this vendor's rows touch (e.g. "RDC Concrete (India) Ltd — Bangalore", "RDC Concrete (India) Ltd — Hyderabad", …), each with `area_id` set to that Area and `group_name = "RDC Concrete (India) Ltd"`.
- Each such row gets its own `login_email`/password, scoped to only the pumps in that Area attributed to this vendor in the CSV.
- **This split is purely a login/dashboard-scoping decision, not a fraud-check decision.** Fraud-check scope (§2) is Area-wide for *every* vendor account uniformly, split or not — an ordinary single-login vendor's cross-pump check also looks at all other pumps in its own Area, not just its own pumps. (An earlier draft scoped ordinary vendors to "own pumps only," which created an asymmetric gap — see §2's note on why that was corrected.)
- All other vendors keep a single login covering all of their own pumps regardless of how many Areas those pumps sit in — this includes a few other vendors in the real sheet that also span more than one Area (e.g. `Om Sai Enterprises (Hr/Dl)` across Rajasthan and Delhi, `Trident Engineering` across Punjab and Jammu, `RBM Infra Services Private Limited` across Uttarakhand and Delhi). Their login/dashboard still shows all their pumps nationally as one account; only `RDC Concrete (India) Ltd` gets the per-Area login split, per your explicit instruction. Flagging this now: if you later want the same per-Area login treatment for these three, that's a small extension of the same importer logic, not a redesign.
- The list of vendors to Area-split (for login purposes) is a small hardcoded/admin-configurable set for the prototype (starting with just this one name) — not an automatic "split any vendor spanning >1 Area" rule, since that would also silently split the three vendors above without you having decided you want that yet.

---

## 9. PROMPT A — Build the Full Prototype

Copy everything in the box below into a fresh Claude Code / coding-agent session.

```
Build a production-shaped prototype of a multi-tenant Attendance Management System
using face recognition. Follow this spec exactly.

STACK
- Frontend + Backend: SvelteKit (TypeScript, Node adapter), TailwindCSS
- AI microservice: Python 3.11 + FastAPI + insightface running on ONNX Runtime (CPU
  execution provider) — use the buffalo_l model pack, which bundles a RetinaFace-equivalent
  detector and a 512-dim ArcFace embedding model. Do NOT use deepface/tensorflow — ONNX Runtime
  is required for CPU performance and smaller image size.
- Background job processing: a lightweight queue (BullMQ + Redis, or a simple Postgres-backed
  job table with a polling worker if you want to avoid adding Redis for the prototype — your
  choice, pick whichever is faster to implement correctly) so attendance photo processing runs
  asynchronously and doesn't block the HTTP request.
- Database: PostgreSQL 16 with the pgvector extension
- Orchestration: docker-compose.yml running all services (sveltekit, ai-service, postgres, and
  redis if used)
- Timezone: set TZ=Asia/Kolkata on every container (sveltekit, ai-service, worker, postgres) AND
  compute all date/"today" boundaries explicitly in IST in application code (do not rely on the
  container default alone) — see NON-FUNCTIONAL below.
- Logging: structured JSON logs to stdout from every service (sveltekit, worker, ai-service) —
  use pino for the Node/SvelteKit side, Python's logging module with a JSON formatter (or
  structlog) for FastAPI. See STRUCTURED LOGGING below for required fields and events.

ENTITY HIERARCHY
Admin -> Area -> Plant -> Pump (login, tied to one Plant AND one Vendor) -> Person (auto-
discovered from daily photos — NO enrollment step, no login, no name). Vendor also has its own
login and can own pumps across multiple plants/areas. A Person is scoped to exactly one Pump
PERMANENTLY, by design — never build a feature that merges Person records across two different
Pumps, even if you're confident it's the same real human; only same-Pump merge candidates are
ever surfaced for admin review (see the BACKGROUND MERGE-CANDIDATE JOB section below).

DATABASE SCHEMA
Implement exactly this schema (Postgres, with pgvector):
- areas(id, name, created_at)
- plants(id, area_id FK, name, latitude, longitude, geofence_radius_m, created_at)
- vendors(id, name, email, password_hash, created_at, area_id FK NULL, group_name)
  -- area_id is NULL for ordinary vendors (one login, scoped to all their own pumps).
  -- area_id is set only for Area-split vendor accounts (see ADMIN CSV BULK IMPORT below) —
  -- for those, fraud-check scope is "same Area" instead of "same vendor_id". group_name is a
  -- display-only label so multiple per-Area accounts of one company can be rolled up in the UI.
- pumps(id, plant_id FK, vendor_id FK, pump_code, login_email, password_hash, created_at)
- persons(id, pump_id FK, first_seen_at, last_seen_at,
  status ENUM('active','merged','archived') DEFAULT 'active', merged_into_person_id FK NULL)
- person_face_vectors(id, person_id FK, embedding vector(512), source_photo_crop_url, created_at)
  -- gallery table: keep the ~5 most recent embeddings per person, drop oldest on insert
- attendance_sessions(id, pump_id FK, session_date, session_type ENUM('morning','evening'),
  status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
  pairing_status ENUM('open','paired','expired') DEFAULT 'open',
  photo_url, photo_hash, gps_lat, gps_lng, submitted_at, processed_at,
  paired_session_id FK NULL REFERENCES attendance_sessions(id))
  -- an evening session's paired_session_id points at the morning session it completes, and its
  -- session_date is COPIED from that morning session (not derived from the evening upload's own
  -- calendar date) — this is required so a late-night morning + early-next-morning evening pair
  -- still resolves to one correct day instead of splitting across two session_dates.
  -- pairing_status: 'open' until an evening pairs with it ('paired') or
  -- EVENING_PAIRING_WINDOW_HOURS (config, default 24) elapses with none ('expired'). Only 'open'
  -- morning sessions still inside the window are eligible for pairing — see CORE FLOW step 4b.
- daily_person_attendance(id, person_id FK, pump_id FK, session_date,
  morning_matched boolean default false, evening_matched boolean default false,
  morning_confidence, evening_confidence, updated_at)
  -- one row per person per day; final_status = present ONLY if both flags are true
- flagged_guests(id, session_id FK, embedding vector(512), face_crop_url, reviewed boolean default false)
- fraud_flags(id, session_id FK, person_id FK, matched_at_pump_id FK, matched_session_id FK,
  similarity_score, created_at)
- person_merge_log(id, kept_person_id FK, merged_person_id FK, admin_id FK, similarity_score,
  merged_at)
  -- merges are SAME-PUMP ONLY, by design — never build a cross-pump merge path (see ENTITY
  -- HIERARCHY note below and MasterPlan §2a/§4).
- person_attendance_yearly(person_id FK, year, days_present, days_morning_only, days_evening_only,
  last_updated)
  -- each (person, date) increments exactly one of the three counters once that date's session
  -- pairing is resolved: both flags true -> days_present; morning only -> days_morning_only;
  -- evening only (rare but possible per-person) -> days_evening_only.
- admins(id, email, password_hash, created_at)
- csv_imports(id, admin_id FK, filename, rows_total, rows_created, rows_skipped, errors_json,
  imported_at)

Add: HNSW index on person_face_vectors.embedding (vector_cosine_ops), unique index on
attendance_sessions(pump_id, session_date, session_type), unique index on
attendance_sessions(photo_hash) for idempotency, unique index on pumps(pump_code).

AUTH
- Single unified /login page, one form, backend detects role by matching email against
  vendors, pumps, or admins tables.
- JWT in httpOnly cookie. hooks.server.ts enforces role-based route guards:
  /admin/** = admin only, /vendor/** = vendor only, /pump/** = pump only.
- Seed script creating: 1 admin, plus data derived from this exact sample CSV (create it as
  tests/fixtures/sample-vendor-pump-data.csv and seed from it via the CSV import logic itself,
  so the import path is exercised from day one):

  Sr.No,Area Name,Plant Name,PUMP Name,Vendor Name
  1,Assam,ASM-Guwahati 1,ASLPWWI2,M/S Welworth Infra
  2,Assam,ASM-Guwahati 1,ASLPWWI3,Welworth Ready Mix Concrete
  3,Uttar Pradesh,UP-Ayodhya,AYLPADA1,Adarsh Infra
  4,Bangalore,BG-Veerasandra,BGLPDD2,Venkatasai Earth Movers_New
  5,Bangalore,BG-Anjanapura,BGLPHSE1,H S Enterprises.
  6,Bangalore,BG-Anjanapura,BGLPHSE2,H S Enterprises.
  7,Bangalore,BG-Hedge Nagar,BGLPME1,MARUTHI ENTERPRISES - BLR TM
  8,Bangalore,BG-Mysore Road,BGLPRAJ1,Raj Enterprises.
  9,Bangalore,BG-Yelhanka,BGLPRVN1,R V N Enterprises
  10,Bangalore,BG-Hedge Nagar,BGLPRVN2,KS Enterprises
  11,Bangalore,BG-Yelhanka,BGLPRVN3,R V N Enterprises
  12,Bangalore,BG-Yelhanka,BGLPRVN4,R V N Enterprises

  For each pump created this way, generate a login_email from a SLUGIFIED pump_code (lowercase,
  strip/replace every non-alphanumeric character — do NOT just lowercase the raw code, since
  real pump codes can contain spaces, e.g. "BOOM 3" must become "boom3@pumps.local", not
  "boom 3@pumps.local") plus a fixed test password (e.g. "Test1234!"), and assign a placeholder
  password to each auto-created vendor too (email pattern "<slugified vendor name>@vendors.local",
  same slugification rule). pump_code itself is stored EXACTLY as given in the CSV (unmodified) —
  only the derived login_email is slugified. Do NOT pre-seed persons — persons must only ever
  be created by the face-detection pipeline itself when processing a group photo, per the
  auto-discovery flow below. For test/demo purposes, seed a handful of sample group photos
  under tests/fixtures/photos/ that the seed script or Prompt B's tests can submit through the
  real submission flow to organically populate a few persons per pump.

ADMIN CSV BULK IMPORT
- Admin UI page: upload a CSV matching the exact columns above (Sr.No, Area Name, Plant Name,
  PUMP Name, Vendor Name — Sr.No is ignored).
- Backend endpoint POST /api/admin/import/csv:
  - Parse the CSV (use a proper CSV parser, not naive split-by-comma, to handle quoted fields).
  - NORMALIZE every Area Name / Plant Name / Vendor Name before any lookup: trim leading/trailing
    whitespace, collapse repeated internal spaces to one, and standardize hyphen spacing (strip
    spaces immediately adjacent to a "-" inside the name, e.g. "PUN- Jambe" -> "PUN-Jambe"). Use
    this normalized form as the canonical stored name AND as the find-or-create lookup key, so a
    future CSV re-typing an existing Area/Plant/Vendor with slightly different spacing/punctuation
    matches the existing row instead of creating a duplicate.
  - VENDOR IDENTITY comes only from the Vendor Name column — never infer or "correct" a vendor
    from patterns in the pump code (real data shows pump codes that look vendor-coded, e.g.
    "BGLPRVN2", can belong to an entirely different vendor than the naming pattern suggests).
  - AREA-SPLIT VENDORS: maintain a small configurable list of vendor names that get split into
    one vendor account PER AREA instead of a single account (for the prototype: just
    "RDC Concrete (India) Ltd"). For a row whose (normalized) Vendor Name is on this list:
    find-or-create a vendors row keyed by (vendor_name, area_id) instead of vendor_name alone,
    named "<vendor_name> — <area_name>" with area_id set to that Area and group_name set to the
    plain vendor_name; generate its login_email/password the same way as any other vendor. For
    any vendor NOT on this list, keep the existing single-account-per-vendor-name behavior (even
    if that vendor's rows span multiple Areas in the sheet, e.g. "Om Sai Enterprises (Hr/Dl)" or
    "Trident Engineering" — do not auto-split vendors that aren't explicitly on the list).
  - For each row: find-or-create the Area by (normalized) name, find-or-create the Plant by
    (normalized name, area_id), find-or-create the Vendor per the two rules above, then UPSERT
    the Pump on pump_code — if pump_code already exists, update its plant_id/vendor_id (in case a
    pump moved plants/vendors); if not, create it with a generated login_email/password as
    described above (slugify pump_code for the email, store pump_code itself unmodified).
  - Track rows_created vs rows_skipped (e.g. malformed row) and any error per row, store as a
    csv_imports record with errors_json, return a summary to the frontend.
  - Show the import result in the UI: X areas, Y plants, Z vendors, W pumps created/updated,
    plus a list of any row-level errors.
- This importer must be idempotent — re-uploading the same CSV twice must not create duplicate
  areas/plants/vendors/pumps.

CORE FLOW — PUMP ROLE
1. Login page for pump accounts.
2. Capture page: <input type="file" accept="image/*" capture="environment"> forced to back
   camera, no gallery picker fallback. On file select, immediately request
   navigator.geolocation.getCurrentPosition and attach lat/lng.
3. On submit, POST multipart (image + pump_id + gps) to /api/attendance/submit.

4. SYNCHRONOUS part of the request (must return fast, under ~1 second):
   a. All "today"/date logic below is computed in Asia/Kolkata explicitly (e.g.
      dayjs().tz('Asia/Kolkata')), never the server process's or container's default timezone.
   b. First, lazily expire stale sessions: for this pump, if there's an attendance_sessions row
      with session_type='morning' AND pairing_status='open' AND
      now - submitted_at > EVENING_PAIRING_WINDOW_HOURS (config, default 24) — flip its
      pairing_status to 'expired' before doing anything else. (Also run this same expiry check as
      a periodic background sweep, e.g. hourly, across ALL pumps — not just at submission time —
      so a pump that simply never submits again still gets its stale morning session closed out
      instead of sitting open indefinitely.) An 'expired' morning session finalizes that date as
      morning-only for every person it matched (feeds daily_person_attendance /
      days_morning_only, unchanged from its already-recorded morning_matched=true) and is no
      longer eligible for pairing.
   c. Determine session type by looking for this pump's most recent morning session with
      pairing_status='open' (having just applied the expiry check in step b, "open" now
      correctly excludes anything past the pairing window) — not by matching session_date to
      "today's" calendar date:
      - no open morning session exists -> session_type = 'morning', session_date = today (IST),
        pairing_status = 'open'
      - an open morning session exists -> compute elapsed hours vs that morning session's
        submitted_at (not vs "today")
        - < 9 hours -> reject with 409 "9-hour rule: X hours remaining" (no job created)
        - >= 9 hours -> session_type = 'evening'; this new session's session_date is COPIED from
          the open morning session's session_date (even if the current IST calendar date has
          since rolled over), and once created it is linked back via
          paired_session_id = <the morning session's id> (and, symmetrically, the morning
          session's own paired_session_id is set to this new evening session's id, and its
          pairing_status flips 'open' -> 'paired')
      - no open (or now-expired) morning session AND today already has a completed morning+evening
        pair -> reject, day complete (no job created)
      IMPORTANT: this expiry window is exactly what prevents a pump from getting permanently
      stuck — without it, a pump that ever misses submitting an evening photo would otherwise have
      every future submission (days, weeks later) mispaired as the "evening" completion of that
      one ancient morning session, since "most recent unpaired morning" with no time bound would
      keep matching it forever.
   d. Hash the photo (sha256). If photo_hash already exists in attendance_sessions -> reject
      as duplicate submission (idempotency), no job created.
   e. Insert an attendance_sessions row with status='pending', store the photo, enqueue a
      background job with the session id.
   f. Return immediately to the frontend with { session_id, status: 'pending' }.

5. ASYNC part, done by a background worker (separate process/consumer from the web server):
   a. Determine this pump's Area (via plant.area_id). Acquire a Postgres advisory transaction
      lock keyed on that Area (e.g. pg_advisory_xact_lock(hashtext(area_id::text))) BEFORE doing
      any matching for this session, and run the entire match-and-write sequence below (steps b
      through e) inside one DB transaction holding that lock. If another session for the same
      Area is already being processed, this worker blocks until that transaction commits and
      releases the lock (typically sub-second, bounded by one photo's matching time) rather than
      racing it — this prevents two concurrent submissions in the same Area from both passing a
      "no match yet" check simultaneously, whether that double-creates one real person as two
      separate persons rows, or lets a genuine cross-pump fraud match slip through because
      neither transaction had committed when the other's check ran.
   b. Mark session status='processing'.
   c. Call the FastAPI /internal/face/extract endpoint with the image. It returns an array of
      { bbox, embedding[512], crop_base64 } for every face detected via insightface
      (RetinaFace-equivalent detector + ArcFace embedding, ONNX Runtime).
   d. For each detected face embedding, run this sequence (NO enrollment step — identity is
      entirely auto-discovered, see below):
      - CROSS-PUMP CHECK (Area-scoped, symmetric for every vendor account): the comparison set is
        every OTHER pump in the same Area as this pump (plants.area_id match), regardless of
        vendor — this applies identically whether the submitting pump's vendor account is an
        ordinary single-login vendor or an Area-split account (e.g. RDC's); there is no branching
        on vendor type here, which is what makes the check symmetric and closes the gap an
        earlier, vendor-scoped-for-ordinary-vendors draft had. Cosine similarity against all
        person_face_vectors joined to daily_person_attendance -> attendance_sessions WHERE
        session_date = today AND pump_id != this pump AND pump_id IN (pumps in this Area). If
        best similarity >= FACE_MATCH_THRESHOLD within that scope -> write to fraud_flags
        (person_id = the matched person), do NOT mark attendance for this face, continue to next
        face (don't block the rest of the group). A match at a pump outside this Area is not
        compared at all (by design — cross-Area same-day travel is treated as implausible).
      - LOCAL MATCH: cosine similarity against person_face_vectors WHERE pump_id = this pump,
        using the BEST match across each person's embedding gallery (not a single fixed
        vector per person). Remember: identity is scoped to this ONE pump permanently — a person
        who was previously seen at a different pump is never matched here even if it's the same
        real human; this is intentional (see ENTITY HIERARCHY / MasterPlan §2a) and no cross-pump
        merge tooling should be built.
        - Best match >= FACE_MATCH_THRESHOLD -> this is an existing person. Upsert
          daily_person_attendance for (person_id, this session's session_date — the paired/copied
          date from step 4, NOT necessarily today's IST calendar date for an evening session):
          set morning_matched=true if session_type='morning', or evening_matched=true if
          session_type='evening'. Append this embedding to the person's gallery
          (person_face_vectors), dropping the oldest if the gallery exceeds ~5 entries. Update
          persons.last_seen_at.
        - No match found (below threshold at this pump AND no cross-pump match) -> AUTO-CREATE
          a new persons row (pump_id, first_seen_at=now, status='active'), insert this
          embedding as its first gallery entry, and create the daily_person_attendance row for
          this session's session_date with the appropriate morning/evening flag set to true.
   e. On success: mark session status='completed', processed_at = now(). On any pipeline
      error: status='failed', store an error reason, and make sure the frontend polling can
      surface a retry option (don't leave it silently pending forever). Commit the transaction
      (releasing the Area advisory lock from step a) only after this.
   f. On successful completion of an EVENING session specifically (i.e. once its
      daily_person_attendance row can have both flags evaluated for that date — a morning-only
      session never triggers this step, since morning_only/evening_matched=false stays open until
      either an evening session pairs with it or the day is otherwise closed out), for every
      person touched by this session's session_date, upsert person_attendance_yearly: increment
      exactly one of days_present (both flags true), days_morning_only (morning true, evening
      false), or days_evening_only (evening true, morning false — a person who appears in the
      evening photo despite not having been in the morning photo) — never more than one counter
      per (person, date).

6. FRONTEND: after submit, show a "Processing..." state and poll GET
   /api/attendance/status/:session_id every ~2 seconds (or use SSE/WebSocket if you prefer)
   until status is 'completed' or 'failed'. On completion, show the result screen: which known
   persons were matched (green, with a thumbnail so the pump operator can sanity-check), any
   brand-new persons auto-created this session (blue, "new person detected"), any fraud flags
   raised (red, with which other pump/plant), and any faces that matched nothing at all —
   should be rare since unmatched faces auto-create a person, but keep flagged_guests as a
   fallback path for low-confidence/ambiguous detections the pipeline chooses not to
   auto-create from (e.g. partially obscured faces). On 'failed', show a retry button.

BACKGROUND MERGE-CANDIDATE JOB
- A separate scheduled job (e.g. nightly, or triggerable manually by admin) scans, per pump,
  for pairs of 'active' persons whose gallery embeddings have a best-pair cosine similarity in
  a "maybe same person" band below FACE_MATCH_THRESHOLD but above a lower bound (e.g. 0.55–
  0.68, both configurable) — these are candidates, never auto-merged.
- Store candidates in a merge_candidates table (or compute on-the-fly for the admin endpoint if
  simpler) for the admin UI to review.

CORE FLOW — VENDOR ROLE
- Dashboard scoped to only the pumps this vendor operates (may span multiple plants/areas):
  attendance calendar, per-pump attendance %, list of auto-discovered persons per pump with
  their attendance history. Vendors do NOT create pumps or persons manually in this
  prototype — pumps come from admin CSV import/UI, persons are fully auto-discovered from
  daily photos.

CORE FLOW — ADMIN ROLE
- Dashboard with metric cards: Today's Attendance %, Active Pumps Today, Total Distinct
  Persons, Fraud Flags Today, Pending Guest Reviews, Pending Merge Reviews, Avg Elapsed Hours
  (morning->evening).
- Filterable attendance table: area, plant, vendor, pump, date range, session type, showing
  each person's morning_matched/evening_matched/final present-or-absent status per day.
- "Export to Excel" button -> backend streams an .xlsx (use SheetJS/exceljs) of the filtered
  table.
- Fraud Flags page: list of fraud_flags with both pumps'/plants' photos/timestamps, ability to
  mark reviewed/dismissed.
- Flagged Guests page: list of unrecognized faces with crop thumbnails, ability to promote to
  a new person on a chosen pump or dismiss.
- Merge Candidates page: side-by-side face crops of two candidate persons plus each one's
  attendance history (days present, date range). Confirm -> reassign all
  daily_person_attendance rows from the newer/merged person to the kept person, fold the
  merged person's gallery embeddings into the kept person's gallery, set the merged person's
  status='merged' and merged_into_person_id, write a person_merge_log row. Dismiss -> mark the
  candidate reviewed so it doesn't resurface.
- Area/Plant/Vendor/Pump management: CRUD, plus the CSV bulk-import page described above.

AI MICROSERVICE (FastAPI)
- POST /internal/face/extract: accepts an image, runs insightface (buffalo_l model pack) on
  the ONNX Runtime CPU execution provider, returns JSON array of faces with bbox, 512-dim
  embedding, and a base64 crop of each face.
- Load the model pack once at container startup (not per-request) and keep it warm in memory
  to avoid repeated cold-start cost.
- Must handle 0 faces (empty array, not an error) and enforce a max of ~30 faces per image for
  performance.
- Dockerfile installing insightface + onnxruntime (CPU build, NOT tensorflow) — this keeps the
  image significantly smaller and inference meaningfully faster on CPU-only hosts. Exposed on
  an internal Docker network only (not published to host).
- Log processing time per request so real-world latency can be measured against actual pump
  photos and FACE_MATCH_THRESHOLD/worker concurrency tuned accordingly.

STRUCTURED LOGGING
- Every service (sveltekit backend, worker, ai-service) logs structured JSON to stdout, not
  plain-text strings. Node/SvelteKit: pino. Python/FastAPI: standard logging + a JSON formatter
  (or structlog). No separate log-aggregation infrastructure required for the prototype — JSON on
  stdout is what makes adopting one later (Loki/CloudWatch/etc.) a zero-code-change swap.
- Every log line includes: timestamp (ISO 8601, IST), level, service, request_id, session_id,
  pump_id, area_id, vendor_id (when known).
- REQUEST CORRELATION: /api/attendance/submit generates a request_id (UUID) when a photo is
  accepted. Thread this same request_id through the enqueued job, every worker log line for that
  session, and the header sent to POST /internal/face/extract — so one submission's full
  lifecycle (accepted -> queued -> worker picked up -> AI service call+timing -> fraud check -> DB
  writes -> completed/failed) is traceable as a single request_id across all three services' logs.
- MUST-LOG EVENTS (structured, with enough fields to act on):
  - Session-type decision and any rejection reason (9-hour rule remaining, day-complete,
    duplicate photo hash) — greppable by pump_id, since these are what field workers call about.
  - Morning-session expiry (pairing_status open -> expired, per the 24h window rule) — this is
    silent at the DB level by design, so a log line is the only way to confirm it's actually
    firing in production.
  - Advisory-lock wait time: when a worker requests the per-Area lock, log how long it waited
    before acquiring it — this is the instrumentation needed to answer whether Area-wide
    serialization bottlenecks busy Areas (e.g. Kerala/Hyderabad) during the morning rush.
  - Face-extraction call timing (the "Log processing time per request" item above, structured).
  - Person auto-created vs. matched, with similarity score, per face processed.
  - Fraud flag raised, with person_id, the other pump/area involved, similarity score.
  - Merge candidate confirm/dismiss, with admin_id and both person_ids.
  - CSV import summary — also log it (already returned to the UI per ADMIN CSV BULK IMPORT
    above), so there's an audit trail independent of the UI response.
- NEVER log raw face embeddings or photo bytes — log person_id and similarity scores only, never
  vectors themselves. Log levels: INFO for normal business events, WARN for rejections/expirations,
  ERROR for pipeline failures that set a session to 'failed'.

NON-FUNCTIONAL
- Mobile-first, fast page loads on the capture flow specifically (this is the page used daily
  in the field, on average phones/networks) — lazy-load everything else.
- All secrets/config via .env (DATABASE_URL, JWT_SECRET, FACE_MATCH_THRESHOLD, AI_SERVICE_URL).
- FACE_MATCH_THRESHOLD must be a config value, not hardcoded, default 0.68.
- EVENING_PAIRING_WINDOW_HOURS must be a config value, not hardcoded, default 24. Controls how
  long an open morning session stays eligible for evening pairing before auto-expiring (see CORE
  FLOW — PUMP ROLE step 4b).
- TIMEZONE: set TZ=Asia/Kolkata in every container's environment (sveltekit, worker, ai-service,
  postgres) AND explicitly use Asia/Kolkata in all application-level date logic (session_date
  computation, the 9-hour elapsed check, "today" for dashboard queries) — do not rely on the
  container/OS default timezone alone, since a redeploy to a differently-configured host would
  silently revert to UTC and corrupt every session_date boundary.
- Basic error boundaries + toast notifications on the frontend for all rejection cases (9-hour
  rule, duplicate photo, network failure, CSV import errors).
- README with docker-compose up instructions, how to seed the DB, and how to run the CSV
  import manually.

Build this as a working, runnable prototype — actual database, actual face pipeline, actual
docker-compose, not mocked. Ask me before making architectural decisions not covered by this
spec, but otherwise proceed end-to-end.
```

---

## 10. PROMPT B — Playwright E2E Test Suite

Run this as a follow-up prompt once the app from Prompt A exists and runs locally.

```
Set up an automated Playwright test suite (TypeScript) for the Attendance Management System
already built in this project. Cover all three roles end-to-end against the real running app
(docker-compose stack), using the seeded test accounts and sample CSV from the backend seed
script.

SETUP
- npm install -D @playwright/test, npx playwright install
- playwright.config.ts: baseURL pointing at the local dev server, 3 projects (chromium is
  enough for prototype stage), retries: 1, trace: 'on-first-retry', screenshot on failure.
- A global setup that resets/reseeds the test database before the suite runs (using the same
  CSV-driven seed script from Prompt A), and a teardown that tears it down after, so the suite
  is repeatable.
- Store seeded test credentials (admin, one vendor, one pump — e.g. pump_code BGLPRVN1) in a
  tests/fixtures/test-users.ts file, matching whatever the seed script from Prompt A actually
  created.
- Copy tests/fixtures/sample-vendor-pump-data.csv from the seed data so the import test in
  admin-dashboard.spec.ts can re-use it.

TEST FILES

1. tests/auth.spec.ts
   - Admin, Vendor, and Pump accounts can each log in with valid credentials and land on their
     correct role-specific dashboard.
   - Invalid credentials show an error and do not redirect.
   - An unauthenticated user hitting /admin/**, /vendor/**, or /pump/** is redirected to /login.
   - A logged-in Pump user hitting /admin/** is denied (role guard works both ways).

2. tests/pump-attendance-flow.spec.ts (as the Pump role)
   - Log in as a seeded pump account (e.g. BGLPRVN1).
   - Mock the camera capture: use Playwright's setInputFiles on the file input with a fixture
     group photo (place 2-3 sample face photos in tests/fixtures/photos/), and mock
     navigator.geolocation via page.context().grantPermissions + a mocked position.
   - Submit morning attendance -> assert the UI shows a "Processing..." state, then wait for
     the frontend's status polling to resolve to 'completed' (use Playwright's expect().toPass
     or waitForResponse against /api/attendance/status/:session_id) -> assert the result screen
     shows the detected faces as "new person" (first-ever submission at this pump, so everyone
     should be auto-created, not matched).
   - Submit the SAME group's evening photo (same faces, ~9+ hours later — advance the system
     clock or seed submitted_at directly for the test) -> assert those same persons are now
     matched (not created as new), and assert via an admin API check that
     daily_person_attendance has morning_matched=true AND evening_matched=true for each, with
     final status 'present'.
   - Test a person who ONLY appears in the morning photo, not evening -> assert their
     daily_person_attendance row ends up morning_matched=true, evening_matched=false, and
     final status 'absent' (per the rule: morning present + evening absent = absent overall).
   - Immediately try submitting again after evening -> assert the "day complete" rejection.
   - Test duplicate photo submission -> assert idempotency rejection.
   - (If feasible with fixture photos) submit a photo containing a face already logged today at
     a DIFFERENT seeded pump (e.g. BGLPRVN3, same vendor but different pump) -> assert the
     result screen shows a fraud flag for that person, and assert via the admin fraud-flags
     API that a fraud_flags row was created.

3. tests/vendor-dashboard.spec.ts (as the Vendor role)
   - Log in as a seeded vendor that owns multiple pumps across plants (e.g. R V N Enterprises,
     which owns BGLPRVN1/3/4 across two plants per the sample CSV).
   - Assert dashboard shows all of that vendor's pumps across both plants, and does NOT show a
     pump belonging to a different vendor (e.g. assert "BGLPHSE1" does not appear).
   - After a pump-attendance-flow test has run and auto-created persons at one of this vendor's
     pumps, assert the vendor dashboard shows those auto-discovered persons and their
     attendance history — confirm there is no "add/enroll person" UI control anywhere (identity
     is fully auto-discovered, never manually created).

4. tests/admin-dashboard.spec.ts (as the Admin role)
   - Log in as admin.
   - Assert all metric cards render with numeric values (not "undefined"/"NaN"), including
     Total Distinct Persons and Pending Merge Reviews.
   - Filter the attendance table by area ("Bangalore"), by vendor, and by date range, assert
     row counts change accordingly.
   - Click Export to Excel, assert a .xlsx file is actually downloaded (use Playwright's
     download event) and has at least a header row + expected columns when parsed with a
     library like xlsx/exceljs in the test itself.
   - CSV IMPORT TEST: upload tests/fixtures/sample-vendor-pump-data.csv via the admin import
     page, assert the summary shows the correct counts (e.g. areas created, plants created,
     vendors created, pumps created), then re-upload the SAME file and assert it reports 0 new
     rows created (idempotency of the importer).
   - Open Fraud Flags page, mark a flag as reviewed, assert its status updates.
   - Open Flagged Guests page, promote a guest to a new person on a pump, assert it now appears
     in that pump's person list.
   - MERGE CANDIDATES TEST: seed two persons at the same pump with deliberately similar-but-
     not-identical embeddings (in the "maybe same person" band) via a test-only seeding helper,
     assert they appear on the Merge Candidates page, confirm the merge, then assert via the
     admin API that the merged person's daily_person_attendance rows were reassigned to the
     kept person and a person_merge_log row exists. Separately, test the Dismiss action and
     assert the pair does not resurface.

5. tests/cross-role-security.spec.ts
   - A Pump account cannot call /api/admin/** endpoints directly (test via request context,
     not just UI) — assert 401/403.
   - A Vendor account cannot fetch attendance data for a pump outside their own vendor_id via
     direct API call — assert 403 even if they know the pump's ID.

CONVENTIONS
- Use Page Object Model: tests/pages/LoginPage.ts, PumpDashboardPage.ts, VendorDashboardPage.ts,
  AdminDashboardPage.ts, wrapping selectors and actions.
- Prefer data-testid attributes for selectors; add them to the frontend components as needed
  if missing (list which components you had to modify).
- Add npm scripts: "test:e2e": "playwright test", "test:e2e:ui": "playwright test --ui",
  "test:e2e:report": "playwright show-report".
- Add a GitHub Actions workflow (.github/workflows/e2e.yml) that spins up docker-compose,
  waits for health checks, runs the suite, and uploads the Playwright HTML report as an
  artifact on failure.

Run the full suite at the end and report which tests pass/fail, with fixes for any failures
caused by the app itself (not the tests) rather than papering over them.
```

---

## Notes before you run this

- **Face-match accuracy will need real tuning.** `0.68` is a reasonable ArcFace cosine-similarity starting point, but you'll want to test it against your actual pump photos (lighting, distance, camera quality) and adjust — this is the single biggest risk to "it works in the demo but not in the field."
- **`insightface` on ONNX Runtime + async processing**: submit returns instantly, matching happens in a background worker, frontend polls for the result. Keeps the container smaller, CPU inference 2-3x faster than deepface/TensorFlow, and keeps the field-facing capture page responsive.
- **GPS geofencing is stubbed as optional/off** since you didn't specify per-plant radius rules — tell me the intended radius (e.g., 200m) if you want it enforced rather than just logged.
- **The CSV importer is now a first-class feature**, not just seed data — since you already have real onboarding data in this format, Prompt A wires it as the actual admin workflow for adding areas/plants/vendors/pumps in bulk, and the seed script itself runs through that same code path so it's exercised from day one.
- **If CPU load becomes a problem** once you have real traffic (many pumps clocking in in the same few minutes), the next lever is a small GPU instance for the AI service — not a rewrite, since the FastAPI/insightface interface stays the same either way.
- **Fraud-check scope is bounded AND symmetric** (§2): every vendor account, split or not, checks the whole Area — not just its own pumps. An earlier draft scoped ordinary vendors to "own pumps only," which created an order-dependent gap where some real fraud went undetected depending on which of two pumps submitted later in the day; that's now fixed by making the scope uniform. Only `RDC Concrete (India) Ltd` gets the per-Area *login* split (§8b) — that's a dashboard-scoping decision, unrelated to fraud-check scope.
- **The real 204-row CSV has no duplicate pump codes and no already-fragmented vendor names** — verified directly, not assumed. The name-normalization step in the importer (§8a) is a safeguard against future re-imports, not a cleanup of the current sheet.
- **Midnight rollover is handled via explicit session pairing, with a 24h expiry cap** (§2, §4): an evening session links back to its specific morning session via `paired_session_id` and inherits that session's `session_date`, instead of trusting whatever calendar date happens to be current when the evening photo is uploaded. Combined with computing every date boundary in explicit IST (never the container/OS default timezone) rather than assuming it, this closes what would otherwise be a silent, hard-to-notice source of misattributed attendance on late-network-retry days. Critically, an open morning session is only eligible for pairing for `EVENING_PAIRING_WINDOW_HOURS` (default 24h) — past that it auto-expires, finalizes as morning-only, and the pump's next submission starts a fresh morning. Without this cap, one missed evening submission would otherwise permanently mispair every future submission at that pump against the same stale morning session.
- **Concurrent submissions in the same Area are serialized, not raced** (§2, Prompt A step 5a): matching + fraud-check + person upsert run inside one DB transaction guarded by a Postgres advisory lock keyed on the Area, so two pumps in the same Area submitting near-simultaneously can't both pass a stale "no match yet" check. Open question, not yet resolved: whether Area-wide serialization bottlenecks the busiest Areas (Kerala and Hyderabad each have 20+ pumps in the real CSV) during the morning submission rush — you're planning to load-test this once a prototype exists rather than pre-optimize the lock granularity now.
- **Person identity never merges across pumps, by design** (§4, ENTITY HIERARCHY note in Prompt A): a worker reassigned to a different pump is intentionally treated as a new person there; this trades off some fragmentation in `person_attendance_yearly` for a much simpler and more reliable identity model. `person_attendance_yearly` now also tracks `days_morning_only` / `days_evening_only` alongside `days_present`, so partial-attendance patterns stay visible to admins instead of collapsing into a single present/absent number.