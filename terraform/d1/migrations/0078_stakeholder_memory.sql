-- Environment-scoped, append-only stakeholder business context for Marcus.
-- Supersession creates a new row; fact content is never updated in place.

CREATE TABLE stakeholder_memory_facts (
  id                      TEXT PRIMARY KEY,
  environment_id          TEXT NOT NULL,
  fact_kind                TEXT NOT NULL
    CHECK (fact_kind IN ('context', 'decision', 'definition', 'preference', 'constraint')),
  attributed_to            TEXT NOT NULL
    CHECK (length(trim(attributed_to)) BETWEEN 1 AND 120),
  fact_text                TEXT NOT NULL
    CHECK (length(trim(fact_text)) BETWEEN 1 AND 1000),
  source_session_id        TEXT NOT NULL,
  source_user_id_snapshot  TEXT,
  supersedes_fact_id       TEXT UNIQUE,
  supersession_reason      TEXT
    CHECK (
      supersession_reason IS NULL
      OR length(trim(supersession_reason)) BETWEEN 1 AND 500
    ),
  created_at               INTEGER NOT NULL
);

CREATE INDEX idx_stakeholder_memory_environment_created
  ON stakeholder_memory_facts(environment_id, created_at DESC, id DESC);
