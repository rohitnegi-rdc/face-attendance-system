-- The 9 am attendance tracker for the previous day (worker/attendanceDigest.js) replaces the
-- monitors' 8 pm "needs a look" email. One email per Area and day; its row here is claimed before
-- sending, so two workers never both send it. `recipient` is 'area:<id>'.
CREATE TABLE IF NOT EXISTS attendance_digest_log (
    recipient TEXT NOT NULL,
    day DATE NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (recipient, day)
);

DROP TABLE IF EXISTS monitor_digest_log;

-- Which Areas get the email, ticked at /admin/settings. The project starts in Mumbai only. The name
-- is compared on its letters alone, so 'Mumbai', ' MUMBAI ', 'mumbai.' all match.
-- The CC line comes only from the list at /admin/settings; it starts with these two addresses.
INSERT INTO app_settings (key, value) VALUES ('digest_cc', 'anesh.gaikwad@rdc.in, ksbhoon@rdc.in')
ON CONFLICT (key) DO NOTHING;
-- The first email is Monday 2 Nov 2026 at 9 am, about Sunday 1 Nov. No email for an earlier day.
INSERT INTO app_settings (key, value) VALUES ('digest_first_day', '2026-11-01')
ON CONFLICT (key) DO NOTHING;
ALTER TABLE areas ADD COLUMN IF NOT EXISTS digest_enabled BOOLEAN NOT NULL DEFAULT false;
UPDATE areas SET digest_enabled = true
WHERE regexp_replace(lower(name), '[^a-z]', '', 'g') = 'mumbai';
