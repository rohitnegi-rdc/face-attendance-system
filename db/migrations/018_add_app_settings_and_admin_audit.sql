-- Admin-editable runtime settings. A row here overrides the matching env var; with no row the
-- code falls back to env, then to its built-in default (see src/lib/server/settings.ts).
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by_admin_id UUID REFERENCES admins(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who changed or deleted what. Deletions of attendance data must stay traceable even though
-- the rows themselves are gone.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES admins(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
