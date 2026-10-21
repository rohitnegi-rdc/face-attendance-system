-- First admin for a fresh database, so a new server can be signed into without running the seed
-- (the seed also imports the 12-row test CSV, which must never reach production).
-- Default login: admin@attendance.rdc / Admin1234!. must_change_password forces a new password
-- (12+ characters) at first sign-in, before any other page opens.
-- Runs only when there is no admin at all: an existing database keeps its admins untouched.
-- crypt() with a bf salt writes the same bcrypt format bcryptjs verifies in auth.ts.
INSERT INTO admins (email, password_hash, must_change_password)
SELECT 'admin@attendance.rdc', crypt('Admin1234!', gen_salt('bf', 10)), TRUE
WHERE NOT EXISTS (SELECT 1 FROM admins);
