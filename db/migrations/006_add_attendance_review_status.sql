ALTER TABLE attendance_sessions
    DROP CONSTRAINT IF EXISTS attendance_sessions_status_check;

ALTER TABLE attendance_sessions
    ADD CONSTRAINT attendance_sessions_status_check
    CHECK (status IN ('pending', 'processing', 'review', 'completed', 'failed'));
