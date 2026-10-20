-- Location check on shift start. The worker copies pump GPS positions from the optimizer
-- database into pump_locations every 5 minutes; a shift start photo is compared with the latest reading. When the phone is more
-- than 100 m away, or a location is missing, the shift starts on hold and the plant manager
-- approves or rejects it. A shift on hold or rejected is left out of the reports.

-- Device / vehicle id the GPS provider uses for the pump, when it is not the pump code.
ALTER TABLE pumps ADD COLUMN IF NOT EXISTS gps_device_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS pumps_gps_device_id_idx
    ON pumps (lower(gps_device_id)) WHERE gps_device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pump_locations (
    id BIGSERIAL PRIMARY KEY,
    pump_id UUID NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 'gps_api' (provider feed) or 'admin' (entered by hand, e.g. for testing).
    source TEXT NOT NULL DEFAULT 'gps_api',
    UNIQUE (pump_id, recorded_at)
);
CREATE INDEX IF NOT EXISTS pump_locations_latest_idx ON pump_locations (pump_id, recorded_at DESC);

-- Turned on per Area; Mumbai first.
ALTER TABLE areas ADD COLUMN IF NOT EXISTS location_check_enabled BOOLEAN NOT NULL DEFAULT false;
UPDATE areas SET location_check_enabled = true WHERE lower(name) = 'mumbai';

ALTER TABLE attendance_sessions
    -- NULL = no check (area off, or a shift end). ok = within range. pending = waiting for the
    -- plant manager. approved / rejected = the manager's decision.
    ADD COLUMN IF NOT EXISTS location_status TEXT
        CHECK (location_status IN ('ok', 'pending', 'approved', 'rejected')),
    -- Why it needs approval: too_far, no_phone_location, no_pump_gps, stale_pump_gps.
    ADD COLUMN IF NOT EXISTS location_issue TEXT,
    ADD COLUMN IF NOT EXISTS location_distance_m INTEGER,
    ADD COLUMN IF NOT EXISTS pump_gps_lat DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS pump_gps_lng DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS pump_gps_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS location_decided_by UUID REFERENCES plant_managers(id),
    ADD COLUMN IF NOT EXISTS location_decided_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS location_note TEXT;
CREATE INDEX IF NOT EXISTS attendance_sessions_location_pending_idx
    ON attendance_sessions (pump_id) WHERE location_status = 'pending';
