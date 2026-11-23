-- Who approves a plant's missed days (regularisation), one rule for the app, the worker's emails,
-- the nav badge and the 9 am email (2026-11-18: "For regularisation approval of kerala BH should not
-- be there plant manager will only do it"; then: everywhere a plant has no business manager).
-- The plant's business manager (business_manager_plants, not disabled); a plant without one: its
-- plant managers (plant_manager_assignments, not disabled); a plant with neither has no row here and
-- goes to the admins. Business heads never decide. Admins can always decide, and a request waiting
-- 48 hours is escalated to them (worker/regularisationEmail.js).
CREATE OR REPLACE VIEW missed_day_deciders AS
SELECT b.plant_id, b.manager_id, 'business manager'::text AS via
FROM business_manager_plants b
JOIN plant_managers m ON m.id = b.manager_id AND m.disabled_at IS NULL
UNION ALL
SELECT pa.plant_id, pa.manager_id, 'plant manager'::text AS via
FROM plant_manager_assignments pa
JOIN plant_managers m ON m.id = pa.manager_id AND m.disabled_at IS NULL
WHERE NOT EXISTS (
    SELECT 1 FROM business_manager_plants b
    JOIN plant_managers bm ON bm.id = b.manager_id AND bm.disabled_at IS NULL
    WHERE b.plant_id = pa.plant_id
);

-- A plant manager deciding now records as such (it was business manager or admin only).
ALTER TABLE regularisations DROP CONSTRAINT IF EXISTS regularisations_decided_by_role_check;
ALTER TABLE regularisations ADD CONSTRAINT regularisations_decided_by_role_check
    CHECK (decided_by_role IN ('business_manager', 'plant_manager', 'admin'));
