-- Direct-message delivery for a dedicated webhook automation.
--
-- automation_direct_message_recipients is the server-side allowlist of Slack users an automation may
-- DM; a leaked webhook key cannot reach anyone else. Operators maintain it directly.
--
-- automation_direct_message_deliveries is the durable idempotency claim and receipt. The message text
-- is never stored, only its SHA-256. thread_context is the caller's opaque, size-bounded string
-- (at most 1024 UTF-8 bytes, enforced by the route); it is stored verbatim and never interpreted.

CREATE TABLE automation_direct_message_recipients (
  automation_id TEXT    NOT NULL,
  slack_user_id TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, slack_user_id),
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  CHECK (
    length(slack_user_id) >= 2
    AND substr(slack_user_id, 1, 1) IN ('U', 'W')
    AND slack_user_id NOT GLOB '*[^A-Z0-9]*'
  )
);

CREATE TABLE automation_direct_message_deliveries (
  automation_id     TEXT    NOT NULL,
  idempotency_key   TEXT    NOT NULL,
  recipient_user_id TEXT    NOT NULL,
  text_sha256       TEXT    NOT NULL,
  thread_context    TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  invocation_id     TEXT,
  run_id            TEXT,
  session_id        TEXT,
  channel_id        TEXT,
  message_ts        TEXT,
  thread_mapping    TEXT,
  error_code        TEXT,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  PRIMARY KEY (automation_id, idempotency_key),
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  CHECK (length(idempotency_key) BETWEEN 1 AND 300),
  CHECK (length(text_sha256) = 64),
  CHECK (length(thread_context) <= 1024),
  CHECK (status IN ('claimed', 'delivered', 'thread-mapping-failed', 'unknown')),
  CHECK (thread_mapping IS NULL OR thread_mapping IN ('mapped', 'failed')),
  CHECK (channel_id IS NULL OR substr(channel_id, 1, 1) = 'D')
);

CREATE INDEX idx_automation_direct_message_deliveries_created
  ON automation_direct_message_deliveries (created_at DESC);
