ALTER TABLE attendance_face_evidence
    ADD COLUMN IF NOT EXISTS liveness_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (liveness_status IN ('live', 'suspicious', 'unverified')),
    ADD COLUMN IF NOT EXISTS liveness_score DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS liveness_quality TEXT NOT NULL DEFAULT 'insufficient'
        CHECK (liveness_quality IN ('sufficient', 'insufficient')),
    ADD COLUMN IF NOT EXISTS liveness_reason TEXT,
    ADD COLUMN IF NOT EXISTS liveness_model TEXT,
    ADD COLUMN IF NOT EXISTS liveness_inference_ms DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS attendance_face_evidence_liveness_review_idx
    ON attendance_face_evidence (liveness_status, created_at DESC)
    WHERE liveness_status != 'live';
