-- Central log: warnings and errors from the app and the worker, one place for the admin to look
-- (/admin/logs). Every line still goes to the container's stdout as JSON too; this table keeps
-- only warn and error, for LOG_RETENTION_DAYS (default 30), swept hourly by the worker.
CREATE TABLE IF NOT EXISTS system_logs (
    id BIGSERIAL PRIMARY KEY,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    level TEXT NOT NULL CHECK (level IN ('warn', 'error', 'fatal')),
    service TEXT NOT NULL,
    message TEXT NOT NULL,
    request_id TEXT,
    session_id TEXT,
    pump_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS system_logs_logged_at_idx ON system_logs (logged_at DESC);
CREATE INDEX IF NOT EXISTS system_logs_request_id_idx ON system_logs (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS system_logs_session_id_idx ON system_logs (session_id) WHERE session_id IS NOT NULL;
