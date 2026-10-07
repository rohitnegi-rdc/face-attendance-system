ALTER TABLE attendance_duplicate_resolutions
    ADD COLUMN IF NOT EXISTS previous_kept_present BOOLEAN,
    ADD COLUMN IF NOT EXISTS previous_duplicate_present BOOLEAN,
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by_admin_id UUID REFERENCES admins(id);

-- Older decisions did not preserve enough state to support a safe undo.
UPDATE attendance_duplicate_resolutions
SET reversed_at = resolved_at
WHERE previous_kept_present IS NULL OR previous_duplicate_present IS NULL;

CREATE INDEX IF NOT EXISTS attendance_duplicate_resolutions_active_idx
    ON attendance_duplicate_resolutions (pump_id, session_date, duplicate_person_id)
    WHERE reversed_at IS NULL;
