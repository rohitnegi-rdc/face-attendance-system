-- Pump, vendor and admin logins use the RDC domains (@pumps.rdc, @vendors.rdc, @attendance.rdc)
-- instead of the original .local ones. Only the domain changes; a row is skipped if the new
-- address is already taken, so the unique logins never collide.
UPDATE pumps p
SET login_email = regexp_replace(p.login_email, '@pumps\.local$', '@pumps.rdc')
WHERE p.login_email LIKE '%@pumps.local'
  AND NOT EXISTS (
    SELECT 1 FROM pumps other
    WHERE lower(other.login_email) = lower(regexp_replace(p.login_email, '@pumps\.local$', '@pumps.rdc'))
  );

UPDATE vendors v
SET email = regexp_replace(v.email, '@vendors\.local$', '@vendors.rdc')
WHERE v.email LIKE '%@vendors.local'
  AND NOT EXISTS (
    SELECT 1 FROM vendors other
    WHERE lower(other.email) = lower(regexp_replace(v.email, '@vendors\.local$', '@vendors.rdc'))
  );

UPDATE admins
SET email = 'admin@attendance.rdc'
WHERE lower(email) = 'admin@attendance.local'
  AND NOT EXISTS (SELECT 1 FROM admins WHERE lower(email) = 'admin@attendance.rdc');
