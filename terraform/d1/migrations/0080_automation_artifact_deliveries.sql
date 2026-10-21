-- Durable idempotency and delivery receipts for authenticated automation artifacts.
-- Payload bytes are never stored here; only immutable provenance and delivery coordinates.

CREATE TABLE automation_artifact_deliveries (
  automation_id       TEXT    NOT NULL,
  idempotency_key     TEXT    NOT NULL,
  report_sha256       TEXT    NOT NULL,
  summary_sha256      TEXT    NOT NULL,
  context_sha256      TEXT    NOT NULL,
  evidence_bundle_id  TEXT    NOT NULL,
  workflow_version    TEXT    NOT NULL,
  reporting_starts_on TEXT    NOT NULL,
  reporting_ends_on   TEXT    NOT NULL,
  report_revision     INTEGER NOT NULL,
  status              TEXT    NOT NULL,
  invocation_id       TEXT,
  run_id              TEXT,
  session_id          TEXT,
  channel_id          TEXT,
  message_ts          TEXT,
  attachment_id       TEXT,
  thread_mapping      TEXT,
  error_code          TEXT,
  created_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  PRIMARY KEY (automation_id, idempotency_key),
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  CHECK (length(report_sha256) = 64),
  CHECK (length(summary_sha256) = 64),
  CHECK (length(context_sha256) = 64),
  CHECK (report_revision > 0),
  CHECK (status IN ('claimed', 'delivered', 'attachment-failed', 'thread-mapping-failed', 'unknown')),
  CHECK (thread_mapping IS NULL OR thread_mapping IN ('mapped', 'failed'))
);

CREATE INDEX idx_automation_artifact_deliveries_created
  ON automation_artifact_deliveries (created_at DESC);
