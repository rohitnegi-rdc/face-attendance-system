-- When the pump finished the first sign-in guide on the pump screen. NULL means the guide opens,
-- and cannot be skipped, at the next visit. Pumps that already took attendance know the screen,
-- so they are marked done; they can still open the guide from the Help button.
ALTER TABLE pumps ADD COLUMN IF NOT EXISTS guide_done_at TIMESTAMPTZ;

UPDATE pumps SET guide_done_at = now()
WHERE guide_done_at IS NULL
  AND EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.pump_id = pumps.id);
