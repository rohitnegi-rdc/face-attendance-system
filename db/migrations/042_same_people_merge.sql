-- "Same people?" on Fix attendance (src/lib/server/samePeople.ts): the admin or the plant manager
-- of the pump merges workers the camera split between a shift's start and end photos. A merge by
-- a plant manager is logged with the manager instead of an admin; every merge names one of them.
ALTER TABLE person_merge_log
    ALTER COLUMN admin_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS merged_by_manager_id UUID REFERENCES plant_managers(id);
ALTER TABLE person_merge_log DROP CONSTRAINT IF EXISTS person_merge_log_actor_check;
ALTER TABLE person_merge_log ADD CONSTRAINT person_merge_log_actor_check
    CHECK (admin_id IS NOT NULL OR merged_by_manager_id IS NOT NULL);
