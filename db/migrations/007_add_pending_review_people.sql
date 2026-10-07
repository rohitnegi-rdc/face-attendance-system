ALTER TABLE persons
    DROP CONSTRAINT IF EXISTS persons_status_check;

ALTER TABLE persons
    ADD CONSTRAINT persons_status_check
    CHECK (status IN ('pending_review', 'active', 'merged', 'archived'));

UPDATE persons AS person
SET status = 'pending_review'
FROM person_face_vectors AS vector
JOIN attendance_sessions AS session ON session.id = vector.session_id
WHERE vector.person_id = person.id
  AND session.status = 'review'
  AND person.status = 'active'
  AND person.first_seen_at >= session.submitted_at;
