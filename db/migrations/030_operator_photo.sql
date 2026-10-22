-- Operator photo: with every shift photo the pump also sends a photo of the pump operator alone,
-- so the operator's attendance is recorded like a worker's and tagged "Operator".
-- The worker reads the operator face from it; if the operator is also in the group photo, the
-- two faces are the same person and are counted once.
ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS operator_photo_url TEXT,
    ADD COLUMN IF NOT EXISTS operator_photo_hash TEXT;

-- Same rule as the group photo: a photo already sent is refused, never counted twice.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_operator_photo_hash_idx
    ON attendance_sessions (operator_photo_hash) WHERE operator_photo_hash IS NOT NULL;

-- Which face in a session is the operator, and which people have been the operator (the label).
ALTER TABLE attendance_face_evidence
    ADD COLUMN IF NOT EXISTS is_operator BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE persons
    ADD COLUMN IF NOT EXISTS is_operator BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fraud_flags
    ADD COLUMN IF NOT EXISTS is_operator BOOLEAN NOT NULL DEFAULT FALSE;
