ALTER TABLE plants
    ADD COLUMN IF NOT EXISTS external_code TEXT,
    ADD COLUMN IF NOT EXISTS manager_name TEXT,
    ADD COLUMN IF NOT EXISTS manager_email TEXT;
