-- When each user last opened a page, for the counts on the side navigation (new attendance since
-- the last visit). One row per user and page; users live in three tables (admins, vendors,
-- plant_managers), so the row is keyed by role plus id, without a foreign key.
CREATE TABLE IF NOT EXISTS nav_seen (
    role TEXT NOT NULL CHECK (role IN ('admin', 'vendor', 'plant-manager')),
    user_id UUID NOT NULL,
    section TEXT NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (role, user_id, section)
);

-- The new-attendance count reads sessions by submit time.
CREATE INDEX IF NOT EXISTS attendance_sessions_submitted_at_idx
    ON attendance_sessions (submitted_at DESC);
