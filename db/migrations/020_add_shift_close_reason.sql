-- How a shift start (session_type 'morning') stopped waiting for its end, so the admin log can
-- tell "pump pressed End session" from "auto-closed after the pairing window" and admin fixes.
-- NULL for paired starts and for rows closed before this migration.
ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS closed_by TEXT CHECK (closed_by IN ('pump', 'timeout', 'admin')),
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
