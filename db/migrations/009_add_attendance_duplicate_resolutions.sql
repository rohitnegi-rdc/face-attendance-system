CREATE TABLE IF NOT EXISTS attendance_duplicate_resolutions (
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

CREATE INDEX IF NOT EXISTS attendance_duplicate_resolutions_pump_date_idx
    ON attendance_duplicate_resolutions (pump_id, session_date DESC);
CREATE INDEX IF NOT EXISTS attendance_duplicate_resolutions_active_idx
    ON attendance_duplicate_resolutions (pump_id, session_date, duplicate_person_id)
    WHERE reversed_at IS NULL;
