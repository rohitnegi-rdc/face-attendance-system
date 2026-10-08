# Architecture

## 1. System Architecture

```mermaid
flowchart TB
    subgraph Client["SvelteKit Frontend (mobile-first PWA)"]
        C1["Vendor / Pump / Admin login"]
        C2["capture=environment camera input"]
        C3["Geolocation API"]
        C4["Offline-tolerant upload queue"]
    end

    subgraph Backend["SvelteKit Backend (API routes / hooks)"]
        B1["Auth (JWT httpOnly cookie) + role guards"]
        B2["9-hour session-state machine + expiry check"]
        B3["Enqueues background job, returns fast"]
    end

    subgraph Queue["Job Queue (BullMQ+Redis or Postgres-backed polling)"]
    end

    subgraph Worker["Background Worker"]
        W1["Acquire Postgres advisory lock (per Area)"]
        W2["Call AI microservice"]
        W3["Cross-pump fraud check (Area-scoped)"]
        W4["Local match / auto-create person"]
        W5["Write attendance + release lock"]
    end

    subgraph AI["Python FastAPI - Face AI Microservice"]
        A1["insightface on ONNX Runtime (CPU)"]
        A2["Detector + ArcFace embedding per face"]
        A3["Returns array of bbox, embedding, crop"]
    end

    subgraph DB["PostgreSQL + pgvector (Docker)"]
        D1["Vector similarity search (Area-scoped scan)"]
        D2["Roster matching"]
        D3["daily_attendance + yearly rollups"]
    end

    Client -- "HTTPS JSON + multipart image" --> Backend
    Backend --> Queue
    Queue --> Worker
    Worker -- "internal REST (Docker network)" --> AI
    Worker --> DB
    Backend --> DB
    AI --> Worker
```

## 2. Entity Hierarchy

```mermaid
flowchart TD
    Admin["Admin (platform owner)"]
    Area["Area (region, e.g. Bangalore, Assam)"]
    Plant["Plant (physical location, e.g. BG-Anjanapura)"]
    Pump["Pump (login + attendance entity, e.g. ASLPWWI2)"]
    Person["Person (auto-discovered, no login, no enrollment)"]
    Vendor["Vendor (login, owns/operates 1+ Pumps across Plants/Areas)"]
    VendorSplit["Area-split Vendor Account (e.g. RDC Concrete - Bangalore)"]

    Admin --> Area
    Area --> Plant
    Plant --> Pump
    Pump --> Person
    Pump -. "linked to one" .-> Vendor
    Vendor -. "special-cased vendors get one login PER Area" .-> VendorSplit
    VendorSplit -. "scoped to pumps in that Area only" .-> Pump
```

## 3. Entity-Relationship Diagram (Data Model)

```mermaid
erDiagram
    AREAS ||--o{ PLANTS : contains
    PLANTS ||--o{ PUMPS : hosts
    VENDORS ||--o{ PUMPS : operates
    AREAS ||--o| VENDORS : "scopes (area-split accounts only)"
    PUMPS ||--o{ PERSONS : "auto-discovers"
    PERSONS ||--o{ PERSON_FACE_VECTORS : "gallery (~5 most recent)"
    PUMPS ||--o{ ATTENDANCE_SESSIONS : receives
    ATTENDANCE_SESSIONS ||--o| ATTENDANCE_SESSIONS : "paired_session_id (morning<->evening)"
    PERSONS ||--o{ DAILY_PERSON_ATTENDANCE : has
    PUMPS ||--o{ DAILY_PERSON_ATTENDANCE : at
    ATTENDANCE_SESSIONS ||--o{ FLAGGED_GUESTS : "unrecognized faces"
    ATTENDANCE_SESSIONS ||--o{ FRAUD_FLAGS : raises
    PERSONS ||--o{ FRAUD_FLAGS : "matched person"
    PERSONS ||--o{ PERSON_MERGE_LOG : "kept / merged"
    PERSONS ||--o{ PERSON_ATTENDANCE_YEARLY : rolls_up
    ADMINS ||--o{ CSV_IMPORTS : performs

    AREAS {
        uuid id
        string name
        timestamp created_at
    }
    PLANTS {
        uuid id
        uuid area_id FK
        string name
        float latitude
        float longitude
        int geofence_radius_m
        timestamp created_at
    }
    VENDORS {
        uuid id
        string name
        string email
        string password_hash
        uuid area_id FK "NULL unless Area-split account"
        string group_name "display rollup label"
        timestamp created_at
    }
    PUMPS {
        uuid id
        uuid plant_id FK
        uuid vendor_id FK
        string pump_code UK
        string login_email
        string password_hash
        timestamp created_at
    }
    PERSONS {
        uuid id
        uuid pump_id FK "permanent, never merged cross-pump"
        timestamp first_seen_at
        timestamp last_seen_at
        string status "active|merged|archived"
        uuid merged_into_person_id FK
    }
    PERSON_FACE_VECTORS {
        uuid id
        uuid person_id FK
        vector embedding "512-dim"
        string source_photo_crop_url
        timestamp created_at
    }
    ATTENDANCE_SESSIONS {
        uuid id
        uuid pump_id FK
        date session_date
        string session_type "morning|evening"
        string status "pending|processing|completed|failed"
        string pairing_status "open|paired|expired"
        string photo_url
        string photo_hash UK
        float gps_lat
        float gps_lng
        timestamp submitted_at
        timestamp processed_at
        uuid paired_session_id FK
    }
    DAILY_PERSON_ATTENDANCE {
        uuid id
        uuid person_id FK
        uuid pump_id FK
        date session_date
        boolean morning_matched
        boolean evening_matched
        float morning_confidence
        float evening_confidence
        timestamp updated_at
    }
    FLAGGED_GUESTS {
        uuid id
        uuid session_id FK
        vector embedding
        string face_crop_url
        boolean reviewed
    }
    FRAUD_FLAGS {
        uuid id
        uuid session_id FK
        uuid person_id FK
        uuid matched_at_pump_id FK
        uuid matched_session_id FK
        float similarity_score
        timestamp created_at
    }
    PERSON_MERGE_LOG {
        uuid id
        uuid kept_person_id FK
        uuid merged_person_id FK
        uuid admin_id FK
        float similarity_score
        timestamp merged_at
    }
    PERSON_ATTENDANCE_YEARLY {
        uuid person_id FK
        int year
        int days_present
        int days_morning_only
        int days_evening_only
        timestamp last_updated
    }
    ADMINS {
        uuid id
        string email
        string password_hash
        timestamp created_at
    }
    CSV_IMPORTS {
        uuid id
        uuid admin_id FK
        string filename
        int rows_total
        int rows_created
        int rows_skipped
        json errors_json
        timestamp imported_at
    }
```

## 4. Attendance Submission Flow (Synchronous + Asynchronous)

```mermaid
sequenceDiagram
    participant Pump as Pump (frontend)
    participant API as SvelteKit Backend
    participant Q as Job Queue
    participant W as Background Worker
    participant AI as FastAPI AI Microservice
    participant DB as Postgres + pgvector

    Pump->>API: POST /api/attendance/submit (photo, gps)
    activate API
    API->>API: Compute "today" in IST explicitly
    API->>DB: Expire stale open morning sessions (> EVENING_PAIRING_WINDOW_HOURS)
    API->>DB: Find most recent OPEN morning session for this pump
    alt no open morning session
        API->>API: session_type = morning, session_date = today (IST)
    else open morning session exists
        API->>API: compute elapsed hours vs morning.submitted_at
        alt elapsed < 9 hours
            API-->>Pump: 409 "9-hour rule: X hours remaining"
        else elapsed >= 9 hours
            API->>API: session_type = evening, session_date = COPIED from morning
        end
    else no open/expired morning AND today already complete
        API-->>Pump: 409 "day complete"
    end
    API->>DB: Hash photo (sha256); reject if photo_hash exists (idempotency)
    API->>DB: INSERT attendance_sessions (status=pending, paired_session_id if evening)
    API->>Q: enqueue job(session_id, request_id)
    API-->>Pump: 202 { session_id, status: pending }
    deactivate API

    Pump->>API: GET /api/attendance/status/:session_id (poll every ~2s)

    Q->>W: deliver job
    activate W
    W->>DB: pg_advisory_xact_lock(area_id)
    Note over W,DB: Blocks if another session in same Area is mid-processing
    W->>DB: mark session status=processing
    W->>AI: POST /internal/face/extract (image, request_id header)
    activate AI
    AI-->>W: [{ bbox, embedding[512], crop_base64 }, ...]
    deactivate AI

    loop for each detected face
        W->>DB: CROSS-PUMP CHECK - cosine similarity vs other pumps in SAME AREA (symmetric, any vendor)
        alt match >= FACE_MATCH_THRESHOLD in Area
            W->>DB: INSERT fraud_flags (person_id, matched_pump, similarity)
            Note over W: face skipped, no attendance write, continue to next face
        else no cross-pump match
            W->>DB: LOCAL MATCH - best similarity vs this pump's person gallery
            alt match >= FACE_MATCH_THRESHOLD at this pump
                W->>DB: upsert daily_person_attendance (morning_matched or evening_matched = true)
                W->>DB: append embedding to gallery (drop oldest beyond ~5)
            else no match anywhere
                W->>DB: AUTO-CREATE new persons row + first gallery embedding
                W->>DB: create daily_person_attendance row for this session_date
            end
        end
    end

    W->>DB: mark session status=completed, processed_at=now()
    alt this was an EVENING session
        W->>DB: upsert person_attendance_yearly (days_present / days_morning_only / days_evening_only)
    end
    W->>DB: COMMIT (releases advisory lock)
    deactivate W

    Pump->>API: GET /api/attendance/status/:session_id
    API-->>Pump: { status: completed, matched[], new_persons[], fraud_flags[] }
```

## 5. Session Pairing State Machine

```mermaid
stateDiagram-v2
    [*] --> Open : morning photo submitted\n(session_date = today IST)

    Open --> Paired : evening photo submitted\nwithin the pairing window (default 16h, admin setting)\n(evening inherits morning's session_date)

    Open --> Expired : EVENING_PAIRING_WINDOW_HOURS elapsed\nwith no evening submission\n(checked lazily on next submit AND via periodic sweep)

    Paired --> [*] : day finalized as PRESENT\n(both morning_matched + evening_matched true)\n-> increments days_present

    Expired --> [*] : day finalized as MORNING-ONLY\n(morning_matched true, evening_matched false)\n-> increments days_morning_only\nnext submission at this pump starts a NEW Open morning session
```

## 6. Cross-Pump Fraud Check Scope

```mermaid
flowchart LR
    Face["New face embedding\nfrom pump P in Area X"]
    ResolveArea["Resolve Area of pump P\n(via plant.area_id)"]
    Scope["Comparison scope =\nALL other pumps in Area X\n(any vendor - symmetric for every account)"]
    Search["pgvector cosine similarity search\nWHERE session_date = today\nAND pump_id != P\nAND pump_id IN (pumps in Area X)"]
    Match{"best similarity >=\nFACE_MATCH_THRESHOLD?"}
    Flag["Write fraud_flags\n(person_id, matched pump, similarity)\nNO attendance write for this face"]
    Local["Proceed to LOCAL MATCH\n(within pump P's own person gallery)"]

    Face --> ResolveArea --> Scope --> Search --> Match
    Match -- yes --> Flag
    Match -- no --> Local

    Note1["Note: RDC Concrete-style Area-split vendor\naccounts differ only in LOGIN/DASHBOARD scope\n(one login per Area) - fraud-check scope above\nis identical for every vendor account, split or not"]
    Scope -.-> Note1
```

## 7. Merge Candidate Review Flow (Same-Pump Only)

```mermaid
flowchart TD
    Job["Background merge-candidate job\n(nightly or admin-triggered)"]
    Scan["Scan, PER PUMP ONLY,\nfor active person-pairs with\nbest-pair similarity in 0.55-0.68 band\n(never cross-pump)"]
    Candidates["merge_candidates surfaced\nto Admin UI"]
    Review{"Admin reviews\nside-by-side crops +\nattendance history"}
    Confirm["CONFIRM:\nreassign daily_person_attendance rows\nfold gallery embeddings into kept person\nmerged person -> status=merged, merged_into_person_id\nwrite person_merge_log row"]
    Dismiss["DISMISS:\nmark candidate reviewed,\nnever resurfaces"]

    Job --> Scan --> Candidates --> Review
    Review -- confirm --> Confirm
    Review -- dismiss --> Dismiss
```

## 8. Structured Logging & Request Correlation

```mermaid
flowchart LR
    subgraph RequestID["request_id (UUID) generated at /api/attendance/submit"]
        direction TB
        L1["SvelteKit backend logs:\nsession decision, rejection reasons,\nexpiry events - JSON, IST timestamp"]
        L2["Worker logs:\nadvisory-lock wait time,\nmatch results, fraud flags - same request_id"]
        L3["AI microservice logs:\nface-extraction timing - same request_id\n(passed as header)"]
    end

    L1 -.-> L2 -.-> L3
    L1 --> Stdout["stdout (JSON per line)"]
    L2 --> Stdout
    L3 --> Stdout
    Stdout --> Aggregator["Future: Loki / CloudWatch / etc.\n(zero code change - already structured)"]
```

## 9. Worker Job Claiming & Per-Area Locking

There is no message broker (Redis/BullMQ) in the current implementation — `attendance_jobs` is a plain Postgres table acting as the queue. Every worker process runs the same poll loop every `POLL_INTERVAL_MS` (1.5s). Concurrency safety comes from two separate Postgres mechanisms: `FOR UPDATE SKIP LOCKED` for claiming jobs, and (as of the optimistic-concurrency change below) `SERIALIZABLE` transaction isolation for the matching/write phase.

> **Update (2026-09-03): the per-Area blocking lock described in the diagrams below has been replaced.**
> `worker/index.js`'s `processJob()` no longer takes `pg_advisory_xact_lock(hashtext(area_id))` before matching. Instead:
> - AI extraction now happens *before* any transaction is opened at all (it needs no exclusivity), so multiple jobs' extraction calls run fully concurrently regardless of Area.
> - The matching + fraud-check + write step runs inside a single `BEGIN ISOLATION LEVEL SERIALIZABLE` transaction, with no lock acquired. Two jobs in the same Area (even the same `session_date`) can now enter this phase at the same time — nothing blocks them.
> - Postgres's Serializable Snapshot Isolation (SSI) tracks what each concurrent transaction actually reads and writes, and aborts one with a `serialization_failure` (SQLSTATE `40001`, or `40P01` for a plain deadlock) if committing both would be impossible under any one-at-a-time ordering — i.e. it catches exactly the same cross-pump race the old lock prevented by blocking, just after the fact instead of before it.
> - On that error, `processJob()` retries the whole matching/write phase from scratch (up to `SERIALIZATION_RETRY_LIMIT`, default 5) — cheap, since only the DB-only phase repeats, not the AI call. Retries exhausted falls through to the normal job-attempt retry (`MAX_JOB_ATTEMPTS`).
> - This also subsumes the finer-grained idea of scoping a lock key by `(area_id, session_date)`: SSI's conflict detection is already scoped to whatever rows a transaction actually touched (which includes `session_date` via the existing query filters), so it's strictly more precise than any hand-picked lock key — two jobs that don't actually read/write overlapping rows never conflict at all, Area or date not withstanding.
>
> The diagrams and prose immediately below describe the **previous** (blocking-lock) design; they're kept as-is because the *shape* of the problem (per-Area contention under burst load) and the claiming mechanism (`SKIP LOCKED`) are unchanged — only the concurrency-control strategy for the matching/write step changed, from pessimistic (block) to optimistic (detect-and-retry).

```mermaid
flowchart TB
    subgraph Workers["Multiple Worker Processes (all run the same loop() every 1.5s)"]
        W1["Worker 1"]
        W2["Worker 2"]
        W3["Worker 3"]
    end

    subgraph JobsTable["Postgres: attendance_jobs table (acts as the queue)"]
        J1["job A — Area X — queued"]
        J2["job B — Area X — queued"]
        J3["job C — Area Y — queued"]
    end

    W1 -- "UPDATE ... FOR UPDATE SKIP LOCKED\nLIMIT 1" --> JobsTable
    W2 -- "UPDATE ... FOR UPDATE SKIP LOCKED\nLIMIT 1" --> JobsTable
    W3 -- "UPDATE ... FOR UPDATE SKIP LOCKED\nLIMIT 1" --> JobsTable

    JobsTable -- "claims job A\n(row-locked, others skip it)" --> W1
    JobsTable -- "sees A locked, skips it\nclaims job B instead" --> W2
    JobsTable -- "claims job C" --> W3

    W1 --> LockX["pg_advisory_xact_lock(hashtext('Area X'))"]
    W2 --> LockX
    LockX -- "W1 holds lock\nW2 BLOCKS until W1 commits" --> W2Wait["Worker 2 waits"]

    W3 --> LockY["pg_advisory_xact_lock(hashtext('Area Y'))"]
    LockY -- "no contention\nruns immediately" --> W3

    W1 -- "POST /internal/face/extract" --> AI["Single AI Microservice\n(FastAPI + ONNX, CPU-bound)"]
    W2Wait -. "once unblocked" .-> AI
    W3 -- "POST /internal/face/extract" --> AI

    AI -- "faces: [bbox, embedding, crop]" --> W1
    AI -- "faces: [...]" --> W3

    W1 --> Commit1["COMMIT\n(releases Area X lock)\njob A -> done"]
    Commit1 -.-> W2Wait
    W3 --> Commit3["COMMIT\njob C -> done"]
```

Same-Area contention in sequence form — two workers claiming different jobs but the same Area serialize at the lock, not at the claim:

```mermaid
sequenceDiagram
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant PG as Postgres
    participant AI as AI Microservice

    par Both poll at once
        W1->>PG: claimNextJob() — SKIP LOCKED
        W2->>PG: claimNextJob() — SKIP LOCKED
    end
    PG-->>W1: job A (Area X)
    PG-->>W2: job B (Area X)

    W1->>PG: BEGIN; pg_advisory_xact_lock(Area X)
    Note over PG: lock acquired by W1

    W2->>PG: BEGIN; pg_advisory_xact_lock(Area X)
    Note over W2,PG: W2 BLOCKS here — same Area lock held by W1

    W1->>AI: POST /internal/face/extract
    AI-->>W1: embeddings

    W1->>PG: fraud check + local match + writes
    W1->>PG: COMMIT
    Note over PG: lock released

    Note over W2,PG: W2 unblocks, acquires lock
    W2->>AI: POST /internal/face/extract
    AI-->>W2: embeddings
    W2->>PG: fraud check + local match + writes
    W2->>PG: COMMIT
```

**Scaling notes:**
- Claiming jobs is fully parallel — `SKIP LOCKED` hands different rows to different workers with no coordination overhead.
- Processing jobs from the *same* Area is serialized by the advisory lock; processing jobs from *different* Areas runs fully concurrently.
- The current `docker-compose.yml` runs a single `worker` replica with no `replicas:` count set, but the claiming logic already supports `docker compose up --scale worker=N` safely today.
- The AI microservice is a single CPU-bound container shared by every worker — it, not the worker count, is the real throughput ceiling until it is scaled out too.
- Stale/crashed jobs (`status='claimed'` past `JOB_CLAIM_TIMEOUT_MINUTES`) are automatically re-claimable by any worker, up to `MAX_JOB_ATTEMPTS`.
