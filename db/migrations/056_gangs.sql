-- Pump gangs, phase 1 (2026-11-21). A gang is a crew recognised from faces, never from names; it
-- moves between pumps within an Area. Everything here is off until an admin ticks an Area at
-- /admin/settings (areas.gangs_enabled), so an Area left unticked runs exactly as before.

-- Switched on per Area.
ALTER TABLE areas ADD COLUMN IF NOT EXISTS gangs_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- "2 gangs today" (a big pour): set with the pump status. Only an Area with gangs on reads it.
ALTER TABLE pump_day_status ADD COLUMN IF NOT EXISTS gangs SMALLINT NOT NULL DEFAULT 1
    CHECK (gangs BETWEEN 1 AND 4);

-- One shift per gang per day instead of one per pump per day. A pump with one gang always uses
-- slot 1, so its rows and behaviour are unchanged.
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS gang_slot SMALLINT NOT NULL DEFAULT 1;
DO $$
DECLARE idx text;
BEGIN
    SELECT indexname INTO idx FROM pg_indexes
    WHERE tablename = 'attendance_sessions'
      AND indexdef LIKE '%(pump_id, session_date, session_type)%';
    IF idx IS NOT NULL THEN
        EXECUTE format('DROP INDEX %I', idx);
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_pump_day_slot_uidx
    ON attendance_sessions (pump_id, session_date, session_type, gang_slot);

-- One worker known across the pumps of an Area. Person rows stay per pump (attendance stays where
-- the photo was taken); this only links them so names and history follow the worker.
CREATE TABLE IF NOT EXISTS area_workers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE persons ADD COLUMN IF NOT EXISTS area_worker_id UUID REFERENCES area_workers(id);
CREATE INDEX IF NOT EXISTS persons_area_worker_idx ON persons (area_worker_id);

-- A close call is never linked by itself: a plant manager answers "Same person?" side by side.
CREATE TABLE IF NOT EXISTS worker_link_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    other_person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'linked', 'different')),
    decided_by_role TEXT,
    decided_by_id UUID,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (person_id, other_person_id)
);

-- A gang: its first shift photo is its source. Membership is read from its recent shifts.
CREATE TABLE IF NOT EXISTS gangs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    code INT NOT NULL,
    source_session_id UUID REFERENCES attendance_sessions(id) ON DELETE SET NULL,
    first_pump_id UUID REFERENCES pumps(id) ON DELETE SET NULL,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (area_id, code)
);
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS gang_id UUID REFERENCES gangs(id);
CREATE INDEX IF NOT EXISTS attendance_sessions_gang_idx ON attendance_sessions (gang_id, session_date);
