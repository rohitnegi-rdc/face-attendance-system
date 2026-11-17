-- Business heads (2026-11-17, mapping BHBMPLANTSMAPPING.MD): one per plant, like business
-- managers (migration 048). Each is a plant-manager login marked is_business_head that signs in
-- with Google (no password) and sees its plants read only through manager_plants; it decides
-- nothing. It is copied (CC) on the 9 am attendance email of every Area with one of its plants
-- (worker/attendanceDigest.js). A row of the list whose plant is not in the system yet waits in
-- business_head_waiting and joins its plant once the plant exists. Admins change the list at
-- /admin/business-heads (src/lib/server/businessManagers.ts, role 'head').
DROP TABLE IF EXISTS area_business_heads;

ALTER TABLE plant_managers ADD COLUMN IF NOT EXISTS is_business_head BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS business_head_plants (
    plant_id UUID PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
    manager_id UUID NOT NULL REFERENCES plant_managers(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS business_head_plants_manager_idx ON business_head_plants (manager_id);

CREATE TABLE IF NOT EXISTS business_head_waiting (
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
    SELECT plant_id, manager_id FROM business_manager_plants
    UNION
    SELECT plant_id, manager_id FROM business_head_plants;
