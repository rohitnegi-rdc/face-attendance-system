ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS fraud_resolution TEXT
        CHECK (fraud_resolution IN ('confirmed_fraud', 'marked_normal')),
    ADD COLUMN IF NOT EXISTS fraud_resolved_by_admin_id UUID REFERENCES admins(id),
    ADD COLUMN IF NOT EXISTS fraud_resolved_at TIMESTAMPTZ;
