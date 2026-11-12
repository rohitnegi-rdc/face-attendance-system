-- A day where a worker has only a start or only an end can be regularised too. `adds` says which
-- half the request adds for that worker: 'start', 'end', or NULL for a day with no photo at all
-- (the whole day). Undo removes only the half that was added, so a real photo is never lost.
ALTER TABLE regularisation_workers
    ADD COLUMN IF NOT EXISTS adds TEXT CHECK (adds IN ('start', 'end'));
