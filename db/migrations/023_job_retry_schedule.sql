-- Worker retries wait before the next attempt (available_at), so a short AI-service outage does
-- not use up every attempt within seconds. claimed_by names the worker holding a job, so a
-- restarted worker can hand back its own unfinished jobs at once instead of after the 10-minute
-- claim timeout. See docs/Architecture.md section 9.
ALTER TABLE attendance_jobs
    ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS claimed_by TEXT;
