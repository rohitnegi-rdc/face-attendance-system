-- An untouched copy of every attendance photo, saved on upload before the AI service reads it.
-- The worker overwrites the session photo with the AI's resized version, and a pump Retry deletes
-- the failed session with its photo, so without this copy a photo that keeps failing is lost.
-- The worker deletes the copy once the photo is processed cleanly; a photo that fails or is
-- flagged as fraud keeps its copy forever, for admin and plant managers to check.
CREATE TABLE IF NOT EXISTS attendance_photo_backups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL once the session is deleted (pump Retry, admin delete); the copy stays.
    session_id UUID REFERENCES attendance_sessions(id) ON DELETE SET NULL,
    pump_id UUID NOT NULL REFERENCES pumps(id),
    session_date DATE NOT NULL,
    session_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    photo_hash TEXT NOT NULL,
    -- waiting = not processed yet. failed / fraud = kept forever.
    status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'failed', 'fraud')),
    -- What the pump was told, and the technical error behind it.
    reason TEXT,
    error_detail TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kept_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS attendance_photo_backups_session_idx
    ON attendance_photo_backups (session_id);
CREATE INDEX IF NOT EXISTS attendance_photo_backups_pump_idx
    ON attendance_photo_backups (pump_id, uploaded_at DESC);
