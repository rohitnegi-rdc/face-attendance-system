-- Admin fixes for faces (src/lib/server/faceFixes.ts): flagged errors get closed with what was
-- done, and a merge can be undone.
ALTER TABLE attendance_review_flags
    ADD COLUMN IF NOT EXISTS resolution TEXT
        CHECK (resolution IS NULL OR resolution IN ('moved', 'new_worker', 'marked_present', 'dismissed')),
    ADD COLUMN IF NOT EXISTS resolved_by_admin_id UUID REFERENCES admins(id),
    ADD COLUMN IF NOT EXISTS resolved_person_id UUID REFERENCES persons(id);

CREATE INDEX IF NOT EXISTS attendance_review_flags_open_idx
    ON attendance_review_flags (created_at DESC) WHERE status = 'open';

ALTER TABLE person_merge_log
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reversed_by_admin_id UUID REFERENCES admins(id);
