-- A pump's direct sign-in link, made and revoked by an admin at /admin/pump-links. Opening the link
-- signs that pump in, for operators who cannot manage an email and password. The link is the row's
-- id with a signature made from JWT_SECRET (src/lib/server/pumpLinks.ts), so no secret is stored
-- here and the admin can copy the same link again. Revoking stops the link and ends every session
-- opened with it; the pump's password keeps working. Rows are kept as the record of who did what.
CREATE TABLE IF NOT EXISTS pump_login_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    created_by UUID REFERENCES admins(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_by UUID REFERENCES admins(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ
);

-- One working link per pump.
CREATE UNIQUE INDEX IF NOT EXISTS pump_login_links_one_active
    ON pump_login_links (pump_id) WHERE revoked_at IS NULL;
