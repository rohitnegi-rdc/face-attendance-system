CREATE TABLE IF NOT EXISTS attendance_corrections (
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

CREATE INDEX IF NOT EXISTS attendance_corrections_person_date_idx
    ON attendance_corrections (person_id, session_date DESC);

CREATE INDEX IF NOT EXISTS attendance_corrections_pump_date_idx
    ON attendance_corrections (pump_id, session_date DESC);
