-- Whether a pump is working, day by day: Active, Idle or Inactive (closed). A row is written when
-- an admin, a plant manager or a monitor sets a pump's status for today or tomorrow at Pump status
-- (src/lib/server/pumpStatus.ts); it holds from that day until the pump's next row. A pump with no
-- row on or before a day was Inactive that day: every pump starts Inactive and is set Active by the
-- people who run it. Past days are never changed, so the week / month /
-- year day counts stay true. The 9 am attendance tracker (worker/attendanceDigest.js) lists the
-- Active and Idle pumps of the day before, a zero in red; Inactive ones are left out.
-- The row also holds the site the pump works at (typed on the same page, shown under the pump in the
-- email); like the status it holds until the pump's next row.
-- Separate from pumps.status, the fraud lockout of the pump login.
CREATE TABLE IF NOT EXISTS pump_day_status (
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    day DATE NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'inactive')),
    site_name TEXT CHECK (char_length(site_name) BETWEEN 1 AND 80),
    set_by_role TEXT NOT NULL CHECK (set_by_role IN ('admin', 'plant_manager')),
    set_by_id UUID NOT NULL,
    set_by_name TEXT NOT NULL,
    set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (pump_id, day)
);
