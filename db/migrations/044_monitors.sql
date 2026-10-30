-- Monitors: people who watch the pumps of whole Areas every day (e.g. Mumbai) and fix their
-- attendance like a plant manager. A monitor is a plant-manager login marked is_monitor, assigned
-- to Areas instead of single plants, so every plant-manager page, fix and audit trail works for
-- them unchanged. Several monitors may watch one Area.
ALTER TABLE plant_managers ADD COLUMN IF NOT EXISTS is_monitor BOOLEAN NOT NULL DEFAULT false;
-- Set when an admin removes a monitor that manages no plants: the login can no longer sign in,
-- and a session already open ends on its next request (hooks.server.ts). Cleared when the login is
-- made a monitor again or given a plant.
ALTER TABLE plant_managers ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS monitor_areas (
    manager_id UUID NOT NULL REFERENCES plant_managers(id) ON DELETE CASCADE,
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES admins(id),
    PRIMARY KEY (manager_id, area_id)
);
CREATE INDEX IF NOT EXISTS monitor_areas_area_idx ON monitor_areas (area_id);

-- Every plant a plant-manager login can see: its own plants, and every plant of the Areas it
-- monitors. Access checks read this view; assigning plants still writes plant_manager_assignments.
CREATE OR REPLACE VIEW manager_plants AS
    SELECT plant_id, manager_id FROM plant_manager_assignments
    UNION
    SELECT pl.id AS plant_id, ma.manager_id FROM monitor_areas ma JOIN plants pl ON pl.area_id = ma.area_id;

-- "Checked" for one pump and day: who looked at it and what they did. One row per pump and day;
-- the latest check replaces the earlier one.
CREATE TABLE IF NOT EXISTS pump_day_checks (
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    checked_by_manager_id UUID REFERENCES plant_managers(id) ON DELETE SET NULL,
    checked_by_admin_id UUID REFERENCES admins(id) ON DELETE SET NULL,
    note TEXT,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pump_id, session_date)
);

-- The evening email to each monitor, once per monitor and day (the worker may run several times).
CREATE TABLE IF NOT EXISTS monitor_digest_log (
    manager_id UUID NOT NULL REFERENCES plant_managers(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (manager_id, day)
);
