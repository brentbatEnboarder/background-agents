-- Environment-scoped Planhat OAuth custody for the bounded CS Conversation gateway.
-- Provider credentials are AES-GCM ciphertext; plaintext tokens never enter D1.

CREATE TABLE planhat_oauth_connections (
  environment_id                TEXT    PRIMARY KEY,
  revision                      INTEGER NOT NULL DEFAULT 1,
  client_id                     TEXT    NOT NULL,
  client_secret_encrypted       TEXT    NOT NULL,
  access_token_encrypted        TEXT    NOT NULL,
  refresh_token_encrypted       TEXT    NOT NULL,
  access_token_expires_at       INTEGER NOT NULL,
  expected_grant                TEXT    NOT NULL,
  assignment_enabled            INTEGER NOT NULL DEFAULT 0,
  connected_at                  INTEGER NOT NULL,
  created_at                    INTEGER NOT NULL,
  updated_at                    INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CHECK (revision > 0),
  CHECK (expected_grant = 'conversation-view'),
  CHECK (assignment_enabled IN (0, 1)),
  CHECK (access_token_expires_at > 0)
);

CREATE TABLE planhat_oauth_authorizations (
  state_hash                    TEXT    PRIMARY KEY,
  environment_id               TEXT    NOT NULL UNIQUE,
  client_id                     TEXT    NOT NULL,
  client_secret_encrypted       TEXT    NOT NULL,
  code_verifier_encrypted       TEXT    NOT NULL,
  redirect_uri                  TEXT    NOT NULL,
  expected_grant                TEXT    NOT NULL,
  expires_at                    INTEGER NOT NULL,
  created_at                    INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE,
  CHECK (length(state_hash) = 64),
  CHECK (expected_grant = 'conversation-view'),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_planhat_oauth_authorizations_expires
  ON planhat_oauth_authorizations (expires_at);
