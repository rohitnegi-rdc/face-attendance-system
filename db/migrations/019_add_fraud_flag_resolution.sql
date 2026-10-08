-- Lets an admin resolve a cross-pump fraud flag as "not fraud, mark present". The worker skips a
-- flagged face entirely (no person, vector or attendance at the flagged pump), so the face itself
-- is kept on the flag; without it there is nothing to restore. Flags raised before this migration
-- have no stored face and can only be confirmed (or fixed through manual attendance correction).
ALTER TABLE fraud_flags
    ADD COLUMN IF NOT EXISTS face_embedding vector(512),
    ADD COLUMN IF NOT EXISTS face_crop_url TEXT,
    ADD COLUMN IF NOT EXISTS resolution TEXT CHECK (resolution IN ('confirmed_fraud', 'not_fraud')),
    ADD COLUMN IF NOT EXISTS resolved_by_admin_id UUID REFERENCES admins(id),
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_person_id UUID REFERENCES persons(id) ON DELETE SET NULL;
