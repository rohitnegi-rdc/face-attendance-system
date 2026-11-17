-- Area CC (2026-11-17): addresses copied on one Area's 9 am attendance email only, beside the
-- global CC list (app_settings digest_cc) that is copied on every Area's email. Set by admins at
-- /admin/settings, one address at a time, audited (update_area_cc). worker/attendanceDigest.js adds
-- them to that Area's CC; an address already in To or in the global CC is not repeated.
CREATE TABLE IF NOT EXISTS area_digest_cc (
    area_id UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    email TEXT NOT NULL CHECK (email = lower(email)),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    added_by_admin_id UUID REFERENCES admins(id) ON DELETE SET NULL,
    PRIMARY KEY (area_id, email)
);
