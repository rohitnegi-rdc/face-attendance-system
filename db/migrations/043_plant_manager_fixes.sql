-- Plant managers fix attendance like the admin (src/lib/server/fixAttendance.ts): they rename
-- workers of their plants, and mark or undo a worker counted twice. Those decisions are logged
-- with the manager instead of an admin; every one names one of them.
ALTER TABLE persons DROP CONSTRAINT IF EXISTS persons_named_by_check;
ALTER TABLE persons ADD CONSTRAINT persons_named_by_check
    CHECK (named_by IS NULL OR named_by IN ('pump', 'vendor', 'admin', 'plant-manager'));

ALTER TABLE attendance_duplicate_resolutions
    ALTER COLUMN resolved_by_admin_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS resolved_by_manager_id UUID REFERENCES plant_managers(id),
    ADD COLUMN IF NOT EXISTS reversed_by_manager_id UUID REFERENCES plant_managers(id);
ALTER TABLE attendance_duplicate_resolutions
    DROP CONSTRAINT IF EXISTS attendance_duplicate_resolutions_actor_check;
ALTER TABLE attendance_duplicate_resolutions ADD CONSTRAINT attendance_duplicate_resolutions_actor_check
    CHECK (resolved_by_admin_id IS NOT NULL OR resolved_by_manager_id IS NOT NULL);
