ALTER TABLE attendance_sessions
    DROP CONSTRAINT IF EXISTS attendance_sessions_status_check;

ALTER TABLE attendance_sessions
    ADD CONSTRAINT attendance_sessions_status_check
    CHECK (status IN ('pending', 'processing', 'review', 'completed', 'failed', 'fraud_detected'));

ALTER TABLE pumps
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
