ALTER TABLE person_face_vectors
    ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES attendance_sessions(id);

CREATE INDEX IF NOT EXISTS person_face_vectors_session_id_idx
    ON person_face_vectors (session_id);

ALTER TABLE attendance_jobs
    ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS attendance_jobs_session_id_uidx
    ON attendance_jobs (session_id);

CREATE TABLE IF NOT EXISTS attendance_rollup_finalizations (
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    finalized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pump_id, session_date)
);
