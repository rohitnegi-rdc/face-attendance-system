ALTER TABLE admins
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pumps
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE plant_managers
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE admins SET must_change_password = TRUE
WHERE password_hash = crypt('Test1234!', password_hash);

ALTER TABLE admins ALTER COLUMN must_change_password SET DEFAULT TRUE;
ALTER TABLE vendors ALTER COLUMN must_change_password SET DEFAULT TRUE;
ALTER TABLE pumps ALTER COLUMN must_change_password SET DEFAULT TRUE;
ALTER TABLE plant_managers ALTER COLUMN must_change_password SET DEFAULT TRUE;
UPDATE vendors SET must_change_password = TRUE
WHERE password_hash = crypt('Test1234!', password_hash);
UPDATE pumps SET must_change_password = TRUE
WHERE password_hash = crypt('Test1234!', password_hash);
UPDATE plant_managers SET must_change_password = TRUE
WHERE password_hash = crypt('Test1234!', password_hash);
