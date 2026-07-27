-- Adds a stable per-pump worker sequence to persons, backfilled by first_seen_at order.
ALTER TABLE persons ADD COLUMN IF NOT EXISTS display_seq INTEGER;

UPDATE persons p
SET display_seq = seq.rn
FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY pump_id ORDER BY first_seen_at) AS rn
    FROM persons
) seq
WHERE seq.id = p.id AND p.display_seq IS NULL;

ALTER TABLE persons ALTER COLUMN display_seq SET NOT NULL;
ALTER TABLE persons ADD CONSTRAINT persons_pump_id_display_seq_key UNIQUE (pump_id, display_seq);
