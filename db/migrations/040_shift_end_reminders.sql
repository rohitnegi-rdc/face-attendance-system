-- Shift end reminders by Web Push (worker/endReminders.js). A pump allows notifications on its
-- phone; once the evening gap has passed since the shift start the worker sends "time to end the
-- shift", then one every 15 minutes while the shift end photo is still missing, four at most.

-- The app's own VAPID key pair, made once by the app on first use (src/lib/server/push.ts), so
-- push needs no server setting. subject is the site address (https) the push services may contact.
CREATE TABLE IF NOT EXISTS push_keys (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per phone (browser) that allowed notifications for a pump login.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_pump_idx ON push_subscriptions (pump_id);

-- How many shift end reminders went out for this shift start (0 to 4) and when the last one did.
ALTER TABLE attendance_sessions
    ADD COLUMN IF NOT EXISTS end_reminders_sent SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS end_reminder_at TIMESTAMPTZ;

-- Shifts already open when this ships get no reminder: their 9 hours may be long past. With no
-- end_reminder_at the worker's every-15-minutes rule never picks them up either.
UPDATE attendance_sessions SET end_reminders_sent = 2
WHERE session_type = 'morning' AND pairing_status = 'open' AND end_reminders_sent = 0;
