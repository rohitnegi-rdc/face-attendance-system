-- Admin Split (shiftSessions.splitEndIntoStart) used to leave the old date's
-- attendance_rollup_finalizations row pointing at the end photo it moved to another date. That
-- row then blocked every delete of the photo (foreign key). Point it at the old date's own shift
-- start instead, or drop it when that date has no start left.
UPDATE attendance_rollup_finalizations f
SET session_id = start.id
FROM attendance_sessions moved, attendance_sessions start
WHERE moved.id = f.session_id
  AND moved.session_date <> f.session_date
  AND start.pump_id = f.pump_id
  AND start.session_date = f.session_date
  AND start.session_type = 'morning';

DELETE FROM attendance_rollup_finalizations f
USING attendance_sessions moved
WHERE moved.id = f.session_id
  AND moved.session_date <> f.session_date;
