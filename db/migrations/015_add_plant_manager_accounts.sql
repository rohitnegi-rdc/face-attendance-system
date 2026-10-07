CREATE TABLE IF NOT EXISTS plant_managers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS plant_managers_email_lower_idx ON plant_managers (lower(email));

CREATE TABLE IF NOT EXISTS plant_manager_assignments (
    plant_id UUID PRIMARY KEY REFERENCES plants(id) ON DELETE CASCADE,
    manager_id UUID NOT NULL REFERENCES plant_managers(id) ON DELETE RESTRICT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by UUID REFERENCES admins(id)
);
CREATE INDEX IF NOT EXISTS plant_manager_assignments_manager_idx ON plant_manager_assignments (manager_id);

CREATE TABLE IF NOT EXISTS plant_manager_assignment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_id UUID NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    old_manager_id UUID REFERENCES plant_managers(id),
    new_manager_id UUID NOT NULL REFERENCES plant_managers(id),
    changed_by UUID REFERENCES admins(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plant_managers (name, email)
SELECT MIN(NULLIF(TRIM(manager_name), '')), MIN(LOWER(TRIM(manager_email)))
FROM plants
WHERE NULLIF(TRIM(manager_name), '') IS NOT NULL
  AND NULLIF(TRIM(manager_email), '') IS NOT NULL
GROUP BY LOWER(TRIM(manager_email))
ON CONFLICT (lower(email)) DO NOTHING;

INSERT INTO plant_manager_assignments (plant_id, manager_id)
SELECT p.id, pm.id
FROM plants p
JOIN plant_managers pm ON lower(pm.email) = lower(trim(p.manager_email))
WHERE NULLIF(TRIM(p.manager_name), '') IS NOT NULL
  AND NULLIF(TRIM(p.manager_email), '') IS NOT NULL
ON CONFLICT (plant_id) DO NOTHING;
