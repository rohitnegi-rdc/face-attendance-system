CREATE TABLE IF NOT EXISTS merge_review_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lower_person_id UUID NOT NULL REFERENCES persons(id),
    higher_person_id UUID NOT NULL REFERENCES persons(id),
    decision TEXT NOT NULL CHECK (decision IN ('dismissed', 'merged')),
    reviewed_by_admin_id UUID NOT NULL REFERENCES admins(id),
    similarity_score DOUBLE PRECISION,
    reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (lower_person_id < higher_person_id),
    UNIQUE (lower_person_id, higher_person_id)
);

CREATE INDEX IF NOT EXISTS merge_review_decisions_reviewed_at_idx
    ON merge_review_decisions (reviewed_at DESC);
