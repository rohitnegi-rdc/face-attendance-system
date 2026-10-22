-- Forgot password. A reset link carries a random token; only its sha256 is stored. One use,
-- 30 minutes (src/lib/server/passwordReset.ts). account_id points into the table of its role
-- (admins, vendors, plant_managers, pumps), so it has no foreign key.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role TEXT NOT NULL CHECK (role IN ('admin', 'vendor', 'plant-manager', 'pump')),
    account_id UUID NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_account_idx
    ON password_reset_tokens (role, account_id, created_at DESC);

-- Every password reset, by email link or by someone else (admin, plant manager): who, for whom.
CREATE TABLE IF NOT EXISTS password_reset_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    role TEXT NOT NULL,
    account_id UUID NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('email_link', 'temporary_password')),
    by_role TEXT,
    by_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_log_account_idx ON password_reset_log (role, account_id);
