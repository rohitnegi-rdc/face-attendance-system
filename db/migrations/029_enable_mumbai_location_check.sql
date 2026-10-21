-- 024 turned the shift start location check on for Mumbai, but on a fresh database it ran before
-- 027 created the areas, so it changed nothing. Repeat it now that the Mumbai area exists.
UPDATE areas SET location_check_enabled = true WHERE lower(name) = 'mumbai';
