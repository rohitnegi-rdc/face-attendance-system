CREATE TABLE IF NOT EXISTS attendance_face_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id),
    face_crop_url TEXT,
    match_confidence DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, person_id)
);
CREATE INDEX IF NOT EXISTS attendance_face_evidence_person_idx
    ON attendance_face_evidence (person_id, created_at DESC);

INSERT INTO attendance_face_evidence
    (session_id, person_id, face_crop_url, created_at)
SELECT DISTINCT ON (session_id, person_id)
       session_id, person_id, source_photo_crop_url, created_at
FROM person_face_vectors
WHERE session_id IS NOT NULL
ORDER BY session_id, person_id, created_at DESC
ON CONFLICT (session_id, person_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS attendance_review_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES attendance_sessions(id),
    person_id UUID REFERENCES persons(id),
    reason TEXT NOT NULL CHECK (
        reason IN ('incorrect_match', 'missing_person', 'wrong_session', 'poor_photo', 'other')
    ),
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    flagged_by_admin_id UUID NOT NULL REFERENCES admins(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS attendance_review_flags_session_idx
    ON attendance_review_flags (session_id, status);
CREATE INDEX IF NOT EXISTS attendance_review_flags_person_idx
    ON attendance_review_flags (person_id, status);
