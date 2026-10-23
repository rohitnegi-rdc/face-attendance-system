-- Wrong matches must not feed on themselves through a person's saved faces.
-- in_gallery: the same-pump match compares only these rows. A weak or close-call match still
--   counts attendance and keeps its row (the photo's review screen, Complete and the cross-pump
--   check read rows by session), but it is not used to recognise the person later.
-- is_anchor: the face a person was first created from. Trimming the gallery to its size never
--   drops it, so a run of bad photos cannot push the person's real face out.
ALTER TABLE person_face_vectors
    ADD COLUMN IF NOT EXISTS in_gallery BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS is_anchor BOOLEAN NOT NULL DEFAULT false;

-- Existing people: their oldest saved face becomes the anchor (the first one is already gone for
-- people seen more than five times; the oldest left is the best guess).
UPDATE person_face_vectors v SET is_anchor = true
WHERE v.id IN (
        SELECT DISTINCT ON (person_id) id FROM person_face_vectors
        ORDER BY person_id, created_at, id
    )
  AND NOT EXISTS (
        SELECT 1 FROM person_face_vectors a WHERE a.person_id = v.person_id AND a.is_anchor
    );
