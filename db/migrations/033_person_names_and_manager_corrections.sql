-- Worker names. The operator names every unnamed worker in a photo before completing it (the
-- face stays the identity; the name is a label for people and reports). The vendor and the admin
-- can correct a name later. One name per worker at a pump: a second worker with the same name is
-- usually the same person split in two, which is the admin's merge review, not a new name.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS name TEXT
    CHECK (name IS NULL OR char_length(name) BETWEEN 2 AND 60);
ALTER TABLE persons ADD COLUMN IF NOT EXISTS named_by TEXT
    CHECK (named_by IS NULL OR named_by IN ('pump', 'vendor', 'admin'));
ALTER TABLE persons ADD COLUMN IF NOT EXISTS named_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS persons_pump_name_idx
    ON persons (pump_id, lower(name))
    WHERE name IS NOT NULL AND status IN ('active', 'pending_review');

-- Plant managers can correct attendance for their own plants (e.g. a missed shift start turned
-- the end photo into a start). Exactly one of the two "by" columns is set.
ALTER TABLE attendance_corrections ALTER COLUMN corrected_by_admin_id DROP NOT NULL;
ALTER TABLE attendance_corrections ADD COLUMN IF NOT EXISTS corrected_by_manager_id UUID
    REFERENCES plant_managers(id);
ALTER TABLE attendance_corrections DROP CONSTRAINT IF EXISTS attendance_corrections_one_actor;
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_one_actor
    CHECK ((corrected_by_admin_id IS NULL) <> (corrected_by_manager_id IS NULL));
