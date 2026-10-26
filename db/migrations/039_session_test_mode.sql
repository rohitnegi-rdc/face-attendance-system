-- Each session remembers whether test mode was on when it was submitted. "Clear test records"
-- on the admin pump page deletes only those shifts, so genuine attendance can never be wiped.
-- Sessions from before this column are all treated as genuine.
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false;
