-- Add an explicit Slack-environment assignment without weakening the existing
-- automation-pinned mode. Existing enabled assignments remain automation-pinned.

ALTER TABLE planhat_oauth_connections RENAME TO planhat_oauth_connections_automation_only;

CREATE TABLE planhat_oauth_connections (
  environment_id                TEXT    PRIMARY KEY,
  revision                      INTEGER NOT NULL DEFAULT 1,
  client_id                     TEXT    NOT NULL,
  client_secret_encrypted       TEXT    NOT NULL,
  access_token_encrypted        TEXT    NOT NULL,
  refresh_token_encrypted       TEXT    NOT NULL,
  access_token_expires_at       INTEGER NOT NULL,
  expected_grant                TEXT    NOT NULL,
  assignment_mode               TEXT    NOT NULL DEFAULT 'automation',
  assigned_automation_id        TEXT,
  assignment_enabled            INTEGER NOT NULL DEFAULT 0,
  connected_at                  INTEGER NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_automation_id) REFERENCES automations(id) ON DELETE RESTRICT,
  CHECK (revision > 0),
  CHECK (expected_grant = 'conversation-view'),
  CHECK (assignment_enabled IN (0, 1)),
  CHECK (assignment_mode IN ('automation', 'slack-environment')),
  CHECK (
    (assignment_enabled = 0 AND assignment_mode = 'automation' AND assigned_automation_id IS NULL)
    OR
    (assignment_enabled = 1 AND assignment_mode = 'automation' AND assigned_automation_id IS NOT NULL)
    OR
    (assignment_enabled = 1 AND assignment_mode = 'slack-environment' AND assigned_automation_id IS NULL)
  ),
  CHECK (access_token_expires_at > 0)
);

INSERT INTO planhat_oauth_connections (
  environment_id,
  revision,
  client_id,
  client_secret_encrypted,
  access_token_encrypted,
  refresh_token_encrypted,
  access_token_expires_at,
  expected_grant,
  assignment_mode,
  assigned_automation_id,
  assignment_enabled,
  connected_at,
  created_at,
  updated_at
)
SELECT
  environment_id,
  revision,
  client_id,
  client_secret_encrypted,
  access_token_encrypted,
  refresh_token_encrypted,
  access_token_expires_at,
  expected_grant,
  'automation',
  assigned_automation_id,
  assignment_enabled,
  connected_at,
  created_at,
  updated_at
FROM planhat_oauth_connections_automation_only;

DROP TABLE planhat_oauth_connections_automation_only;
