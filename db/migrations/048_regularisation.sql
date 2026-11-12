-- Regularisation of a missed day (src/lib/server/regularisation.ts). A pump that was Active or Idle
-- on a past day (pump_day_status) but sent no photo asks for the day to be counted: the operator on
-- the pump screen, or the plant manager for them (broken phone). The plant's business manager
-- approves or rejects it from an email or in the app; an admin can too. An approved request writes
-- the ticked workers into daily_person_attendance (regularisation_id), so every count includes the
-- day and every screen can label it Regularised. Nothing touches the face gallery.

-- Business managers: plant-manager logins marked is_business_manager (sign in with Google like
-- plant managers), one per plant. Their plants join manager_plants so the plant-manager pages show
-- them; a business manager that manages no plants of its own is read-only (hooks.server.ts).
ALTER TABLE plant_managers ADD COLUMN IF NOT EXISTS is_business_manager BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS business_manager_plants (
    plant_id UUID PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
    manager_id UUID NOT NULL REFERENCES plant_managers(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS business_manager_plants_manager_idx ON business_manager_plants (manager_id);

-- Rows of the business manager list whose plant is not in the system yet (no pumps added). They
-- join business_manager_plants by plant code or name once the plant exists.
CREATE TABLE IF NOT EXISTS business_manager_waiting (
    plant_code TEXT PRIMARY KEY,
    plant_name TEXT NOT NULL,
    manager_id UUID NOT NULL REFERENCES plant_managers(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW manager_plants AS
    SELECT plant_id, manager_id FROM plant_manager_assignments
    UNION
    SELECT pl.id AS plant_id, ma.manager_id FROM monitor_areas ma JOIN plants pl ON pl.area_id = ma.area_id
    UNION
    SELECT plant_id, manager_id FROM business_manager_plants;

CREATE TABLE IF NOT EXISTS regularisations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('no_network', 'phone_problem', 'app_problem', 'forgot', 'other')),
    note TEXT CHECK (char_length(note) <= 500),
    -- A spoken reason recorded on the pump screen, under UPLOAD_DIR/regularisations.
    voice_path TEXT,
    voice_type TEXT,
    requested_by_role TEXT NOT NULL CHECK (requested_by_role IN ('pump', 'plant_manager', 'admin')),
    requested_by_id UUID NOT NULL,
    requested_by_name TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'undone')),
    decided_by_role TEXT CHECK (decided_by_role IN ('business_manager', 'admin')),
    decided_by_id UUID,
    decided_by_name TEXT,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT CHECK (char_length(decision_reason) <= 500),
    undone_by_admin_id UUID REFERENCES admins(id),
    undone_at TIMESTAMPTZ,
    -- The app's address when the request was made, for the links in the worker's reminder emails.
    link_base TEXT NOT NULL,
    reminded_at TIMESTAMPTZ,
    escalated_at TIMESTAMPTZ
);
-- One open request per pump and day; a rejected, cancelled or undone one can be asked again.
CREATE UNIQUE INDEX IF NOT EXISTS regularisations_one_open
    ON regularisations (pump_id, day) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS regularisations_pending_idx ON regularisations (requested_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS regularisation_workers (
    regularisation_id UUID NOT NULL REFERENCES regularisations(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    PRIMARY KEY (regularisation_id, person_id)
);

ALTER TABLE daily_person_attendance
    ADD COLUMN IF NOT EXISTS regularisation_id UUID REFERENCES regularisations(id);
CREATE INDEX IF NOT EXISTS daily_person_attendance_regularisation_idx
    ON daily_person_attendance (regularisation_id) WHERE regularisation_id IS NOT NULL;

-- Once a day the worker reminds a pump phone of a missed day it has not asked about.
CREATE TABLE IF NOT EXISTS regularisation_push_log (
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    sent_on DATE NOT NULL,
    PRIMARY KEY (pump_id, sent_on)
);

-- "PUN-TPL Metro" is PUN-TPL Metro 1 (plant code 3014); Metro 2 (3021) is a separate plant.
UPDATE plants SET name = 'PUN-TPL Metro 1', external_code = COALESCE(external_code, '3014')
WHERE name = 'PUN-TPL Metro'
  AND NOT EXISTS (SELECT 1 FROM plants p2 WHERE p2.area_id = plants.area_id AND p2.name = 'PUN-TPL Metro 1');
INSERT INTO plant_manager_assignments (plant_id, manager_id)
SELECT pl.id, pm.id FROM plants pl JOIN plant_managers pm ON lower(pm.email) = 'abhijeet.pawar@rdc.in'
WHERE pl.name = 'PUN-TPL Metro 1'
ON CONFLICT (plant_id) DO NOTHING;
