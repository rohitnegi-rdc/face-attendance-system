-- Pump screen language per Area (2026-11-25). Pump screens open in Hindi unless the pump's Area is
-- ticked "pump screen in English" at /admin/settings (audited update_pump_language_areas). A phone
-- where someone tapped EN or हिंदी keeps that choice. Kerala starts in English.
ALTER TABLE areas ADD COLUMN IF NOT EXISTS pump_english BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE areas SET pump_english = true WHERE lower(name) LIKE '%kerala%';
