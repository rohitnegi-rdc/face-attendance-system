-- Face-Recognition Attendance Management System — schema
-- Matches plans/MasterPlan.md §4 exactly (including the session-pairing,
-- Area-split vendor, and yearly-rollup fixes agreed during planning).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------- Identity & hierarchy ----------

CREATE TABLE areas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id UUID NOT NULL REFERENCES areas(id),
    name TEXT NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    geofence_radius_m INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (area_id, name)
);

CREATE TABLE vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    area_id UUID REFERENCES areas(id), -- NULL unless an Area-split vendor account (§1/§8b)
    group_name TEXT, -- display rollup label for Area-split accounts
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, area_id)
);

CREATE TABLE pumps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id UUID NOT NULL REFERENCES plants(id),
    vendor_id UUID NOT NULL REFERENCES vendors(id),
    pump_code TEXT NOT NULL,
    login_email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON pumps (pump_code);

CREATE TABLE admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Auto-discovered identities (no enrollment — §2a) ----------

CREATE TABLE persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pump_id UUID NOT NULL REFERENCES pumps(id), -- permanent, never merged cross-pump
    display_seq INTEGER NOT NULL, -- stable per-pump sequence, e.g. "BGLPRVN1 Worker 3"
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_review', 'active', 'merged', 'archived')),
    merged_into_person_id UUID REFERENCES persons(id),
    UNIQUE (pump_id, display_seq)
);

CREATE TABLE person_face_vectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id),
    embedding vector(512) NOT NULL,
    source_photo_crop_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON person_face_vectors USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON person_face_vectors (person_id);

-- ---------- Attendance ----------

CREATE TABLE attendance_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    session_type TEXT NOT NULL CHECK (session_type IN ('morning', 'evening')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'review', 'completed', 'failed')),
    pairing_status TEXT NOT NULL DEFAULT 'open' CHECK (pairing_status IN ('open', 'paired', 'expired')),
    photo_url TEXT,
    photo_hash TEXT NOT NULL,
    gps_lat DOUBLE PRECISION,
    gps_lng DOUBLE PRECISION,
    error_reason TEXT,
    processing_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    paired_session_id UUID REFERENCES attendance_sessions(id)
);
CREATE UNIQUE INDEX ON attendance_sessions (pump_id, session_date, session_type);
CREATE UNIQUE INDEX ON attendance_sessions (photo_hash);
CREATE INDEX ON attendance_sessions (pump_id, session_type, pairing_status);

ALTER TABLE person_face_vectors
    ADD COLUMN session_id UUID REFERENCES attendance_sessions(id);
CREATE INDEX ON person_face_vectors (session_id);

CREATE TABLE daily_person_attendance (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id),
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    morning_matched BOOLEAN NOT NULL DEFAULT false,
    evening_matched BOOLEAN NOT NULL DEFAULT false,
    morning_confidence DOUBLE PRECISION,
    evening_confidence DOUBLE PRECISION,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (person_id, session_date)
);

CREATE TABLE attendance_face_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id),
    face_crop_url TEXT,
    match_confidence DOUBLE PRECISION,
    liveness_status TEXT NOT NULL DEFAULT 'unverified' CHECK (liveness_status IN ('live', 'suspicious', 'unverified')),
    liveness_score DOUBLE PRECISION,
    liveness_quality TEXT NOT NULL DEFAULT 'insufficient' CHECK (liveness_quality IN ('sufficient', 'insufficient')),
    liveness_reason TEXT,
    liveness_model TEXT,
    liveness_inference_ms DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, person_id)
);
CREATE INDEX ON attendance_face_evidence (person_id, created_at DESC);

CREATE TABLE flagged_guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    embedding vector(512) NOT NULL,
    face_crop_url TEXT,
    reviewed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fraud_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    person_id UUID NOT NULL REFERENCES persons(id),
    matched_at_pump_id UUID NOT NULL REFERENCES pumps(id),
    matched_session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    similarity_score DOUBLE PRECISION NOT NULL,
    reviewed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance_review_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    person_id UUID REFERENCES persons(id),
    reason TEXT NOT NULL CHECK (
        reason IN ('incorrect_match', 'missing_person', 'wrong_session', 'poor_photo', 'other')
    ),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    flagged_by_admin_id UUID NOT NULL REFERENCES admins(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX ON attendance_review_flags (session_id, status);
CREATE INDEX ON attendance_review_flags (person_id, status);

CREATE TABLE attendance_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id),
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    previous_morning_matched BOOLEAN NOT NULL,
    previous_evening_matched BOOLEAN NOT NULL,
    corrected_morning_matched BOOLEAN NOT NULL,
    corrected_evening_matched BOOLEAN NOT NULL,
    reason TEXT NOT NULL,
    corrected_by_admin_id UUID NOT NULL REFERENCES admins(id),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attendance_corrections_person_date_idx ON attendance_corrections (person_id, session_date DESC);
CREATE INDEX attendance_corrections_pump_date_idx ON attendance_corrections (pump_id, session_date DESC);

CREATE TABLE attendance_duplicate_resolutions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kept_person_id UUID NOT NULL REFERENCES persons(id),
    duplicate_person_id UUID NOT NULL REFERENCES persons(id),
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    session_type TEXT NOT NULL CHECK (session_type IN ('morning', 'evening')),
    previous_kept_present BOOLEAN,
    previous_duplicate_present BOOLEAN,
    reason TEXT NOT NULL,
    resolved_by_admin_id UUID NOT NULL REFERENCES admins(id),
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reversed_at TIMESTAMPTZ,
    reversed_by_admin_id UUID REFERENCES admins(id),
    CHECK (kept_person_id <> duplicate_person_id)
);
CREATE INDEX attendance_duplicate_resolutions_pump_date_idx
    ON attendance_duplicate_resolutions (pump_id, session_date DESC);
CREATE INDEX attendance_duplicate_resolutions_active_idx
    ON attendance_duplicate_resolutions (pump_id, session_date, duplicate_person_id)
    WHERE reversed_at IS NULL;

CREATE TABLE person_merge_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kept_person_id UUID NOT NULL REFERENCES persons(id),
    merged_person_id UUID NOT NULL REFERENCES persons(id),
    admin_id UUID NOT NULL REFERENCES admins(id),
    similarity_score DOUBLE PRECISION,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE merge_review_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lower_person_id UUID NOT NULL REFERENCES persons(id),
    higher_person_id UUID NOT NULL REFERENCES persons(id),
    decision TEXT NOT NULL CHECK (decision IN ('dismissed', 'merged')),
    reviewed_by_admin_id UUID NOT NULL REFERENCES admins(id),
    similarity_score DOUBLE PRECISION,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (lower_person_id < higher_person_id),
    UNIQUE (lower_person_id, higher_person_id)
);
CREATE INDEX merge_review_decisions_reviewed_at_idx ON merge_review_decisions (reviewed_at DESC);

-- ---------- Aggregates ----------

CREATE TABLE person_attendance_yearly (
    person_id UUID NOT NULL REFERENCES persons(id),
    year INTEGER NOT NULL,
    days_present INTEGER NOT NULL DEFAULT 0,
    days_morning_only INTEGER NOT NULL DEFAULT 0,
    days_evening_only INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (person_id, year)
);

CREATE TABLE attendance_rollup_finalizations (
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pump_id, session_date)
);

-- ---------- Bulk import audit trail ----------

CREATE TABLE csv_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID NOT NULL REFERENCES admins(id),
    filename TEXT NOT NULL,
    rows_total INTEGER NOT NULL DEFAULT 0,
    rows_created INTEGER NOT NULL DEFAULT 0,
    rows_skipped INTEGER NOT NULL DEFAULT 0,
    errors_json JSONB NOT NULL DEFAULT '[]',
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Migration tracking (scripts/migrate.ts) ----------

CREATE TABLE schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Fresh installs already have display_seq via the persons table above, so mark 001 as applied.
INSERT INTO schema_migrations (filename) VALUES ('001_add_person_display_seq.sql');
INSERT INTO schema_migrations (filename) VALUES ('002_add_merge_review_decisions.sql');

-- ---------- Job queue (Postgres-backed, no Redis — per Prompt A's own prototype option) ----------

CREATE TABLE attendance_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    request_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'done', 'error')),
    claimed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON attendance_jobs (status, created_at);
CREATE UNIQUE INDEX ON attendance_jobs (session_id);
