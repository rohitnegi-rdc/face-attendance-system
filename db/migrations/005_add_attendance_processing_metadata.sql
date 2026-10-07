ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS processing_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
