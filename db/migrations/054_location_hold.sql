-- Shift start location hold, then ask (2026-11-18: "it should wait sometime before sending the
-- approval ... make sure the mails are very simple to understand by the plant manager ... button
-- should also be provided in the mail only for approval or rejection").
-- A start held by the location check waits until location_ask_at (submit + the admin's
-- location_hold_minutes, default 30; at once when the phone shared no location). Meanwhile the
-- worker (worker/locationHold.js) watches the pump GPS: a reading near the photo spot clears it on
-- its own (location_auto_cleared_at). Otherwise at location_ask_at it goes to the plant managers
-- and monitors (location_asked_at), each with an email whose Approve and Reject buttons open
-- /location/<signed token> under location_link_base.
ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS location_ask_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS location_asked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS location_link_base TEXT,
    ADD COLUMN IF NOT EXISTS location_auto_cleared_at TIMESTAMPTZ;

-- Holds from before this change were already on the Approvals page (and emailed): asked.
UPDATE attendance_sessions
SET location_ask_at = submitted_at, location_asked_at = submitted_at
WHERE location_status IN ('pending', 'approved', 'rejected') AND location_asked_at IS NULL;

CREATE INDEX IF NOT EXISTS attendance_sessions_location_waiting
    ON attendance_sessions (location_ask_at)
    WHERE location_status = 'pending' AND location_asked_at IS NULL;
