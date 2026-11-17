import { decryptToken, encryptToken } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export const PLANHAT_EXPECTED_GRANT = "conversation-view" as const;

interface ConnectionRow {
  environment_id: string;
  revision: number;
  client_id: string;
  client_secret_encrypted: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: number;
  expected_grant: typeof PLANHAT_EXPECTED_GRANT;
  assigned_automation_id: string | null;
  assignment_enabled: number;
  connected_at: number;
  created_at: number;
  updated_at: number;
}

interface AuthorizationRow {
  state_hash: string;
  environment_id: string;
  client_id: string;
  client_secret_encrypted: string;
  code_verifier_encrypted: string;
  redirect_uri: string;
  expected_grant: typeof PLANHAT_EXPECTED_GRANT;
  expires_at: number;
  created_at: number;
}

export interface PlanhatOAuthConnectionMetadata {
  environmentId: string;
  revision: number;
  expectedGrant: typeof PLANHAT_EXPECTED_GRANT;
  assignedAutomationId: string | null;
  assignmentEnabled: boolean;
  accessTokenExpiresAt: number;
  connectedAt: number;
  updatedAt: number;
}

export interface PlanhatOAuthTokenRecord extends PlanhatOAuthConnectionMetadata {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  refreshTokenEncrypted: string;
}

export interface PendingPlanhatAuthorization {
  stateHash: string;
  environmentId: string;
  clientId: string;
  clientSecret: string;
  codeVerifier: string;
  redirectUri: string;
  expectedGrant: typeof PLANHAT_EXPECTED_GRANT;
  expiresAt: number;
}

export interface PendingPlanhatAuthorizationMetadata {
  environmentId: string;
  expectedGrant: typeof PLANHAT_EXPECTED_GRANT;
  expiresAt: number;
  createdAt: number;
}

export type PlanhatOAuthCasResult = { ok: true } | { ok: false; reason: "cas-conflict" };
export class PlanhatOAuthAuthorizationConflictError extends Error {}

function metadata(row: ConnectionRow): PlanhatOAuthConnectionMetadata {
  return {
    environmentId: row.environment_id,
    revision: row.revision,
    expectedGrant: row.expected_grant,
    assignedAutomationId: row.assigned_automation_id,
    assignmentEnabled: row.assignment_enabled === 1,
    accessTokenExpiresAt: row.access_token_expires_at,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
  };
}

export class PlanhatOAuthConnectionStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async beginAuthorization(input: {
    stateHash: string;
    environmentId: string;
    clientId: string;
    clientSecret: string;
    codeVerifier: string;
    redirectUri: string;
    expiresAt: number;
  }): Promise<void> {
    const now = Date.now();
    const [encryptedSecret, encryptedVerifier] = await Promise.all([
      encryptToken(input.clientSecret, this.encryptionKey),
      encryptToken(input.codeVerifier, this.encryptionKey),
    ]);
    await this.db.batch([
      this.db
        .prepare("DELETE FROM planhat_oauth_authorizations WHERE environment_id = ?")
        .bind(input.environmentId),
      this.db
        .prepare(
          `INSERT INTO planhat_oauth_authorizations
           (state_hash, environment_id, client_id, client_secret_encrypted, code_verifier_encrypted,
            redirect_uri, expected_grant, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.stateHash,
          input.environmentId,
          input.clientId,
          encryptedSecret,
          encryptedVerifier,
          input.redirectUri,
          PLANHAT_EXPECTED_GRANT,
          input.expiresAt,
          now
        ),
    ]);
  }

  async getPendingAuthorization(stateHash: string): Promise<PendingPlanhatAuthorization | null> {
    const row = await this.db
      .prepare("SELECT * FROM planhat_oauth_authorizations WHERE state_hash = ?")
      .bind(stateHash)
      .first<AuthorizationRow>();
    if (!row) return null;
    return {
      stateHash: row.state_hash,
      environmentId: row.environment_id,
      clientId: row.client_id,
      clientSecret: await decryptToken(row.client_secret_encrypted, this.encryptionKey),
      codeVerifier: await decryptToken(row.code_verifier_encrypted, this.encryptionKey),
      redirectUri: row.redirect_uri,
      expectedGrant: row.expected_grant,
      expiresAt: row.expires_at,
    };
  }

  async getPendingMetadata(
    environmentId: string
  ): Promise<PendingPlanhatAuthorizationMetadata | null> {
    const row = await this.db
      .prepare(
        `SELECT environment_id, expected_grant, expires_at, created_at
         FROM planhat_oauth_authorizations WHERE environment_id = ?`
      )
      .bind(environmentId)
      .first<
        Pick<AuthorizationRow, "environment_id" | "expected_grant" | "expires_at" | "created_at">
      >();
    return row
      ? {
          environmentId: row.environment_id,
          expectedGrant: row.expected_grant,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        }
      : null;
  }

  async deletePendingAuthorization(stateHash: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM planhat_oauth_authorizations WHERE state_hash = ?")
      .bind(stateHash)
      .run();
  }

  async completeAuthorization(input: {
    pending: PendingPlanhatAuthorization;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
  }): Promise<void> {
    const now = Date.now();
    const [accessTokenEncrypted, refreshTokenEncrypted, clientSecretEncrypted] = await Promise.all([
      encryptToken(input.accessToken, this.encryptionKey),
      encryptToken(input.refreshToken, this.encryptionKey),
      encryptToken(input.pending.clientSecret, this.encryptionKey),
    ]);
    const [connection] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO planhat_oauth_connections
           (environment_id, revision, client_id, client_secret_encrypted, access_token_encrypted,
            refresh_token_encrypted, access_token_expires_at, expected_grant,
            assigned_automation_id, assignment_enabled,
            connected_at, created_at, updated_at)
           SELECT ?, 1, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM planhat_oauth_authorizations
             WHERE state_hash = ? AND environment_id = ?
           )
           ON CONFLICT(environment_id) DO UPDATE SET
             revision = planhat_oauth_connections.revision + 1,
             client_id = excluded.client_id,
             client_secret_encrypted = excluded.client_secret_encrypted,
             access_token_encrypted = excluded.access_token_encrypted,
             refresh_token_encrypted = excluded.refresh_token_encrypted,
             access_token_expires_at = excluded.access_token_expires_at,
             expected_grant = excluded.expected_grant,
             assigned_automation_id = NULL,
             assignment_enabled = 0,
             connected_at = excluded.connected_at,
             updated_at = excluded.updated_at`
        )
        .bind(
          input.pending.environmentId,
          input.pending.clientId,
          clientSecretEncrypted,
          accessTokenEncrypted,
          refreshTokenEncrypted,
          input.accessTokenExpiresAt,
          input.pending.expectedGrant,
          now,
          now,
          now,
          input.pending.stateHash,
          input.pending.environmentId
        ),
      this.db
        .prepare("DELETE FROM planhat_oauth_authorizations WHERE state_hash = ?")
        .bind(input.pending.stateHash),
    ]);
    if (connection.meta.changes === 0) {
      throw new PlanhatOAuthAuthorizationConflictError(
        "Planhat OAuth authorization was replaced before completion"
      );
    }
  }

  async getMetadata(environmentId: string): Promise<PlanhatOAuthConnectionMetadata | null> {
    const row = await this.getRow(environmentId);
    return row ? metadata(row) : null;
  }

  async getMetadataForSession(sessionId: string): Promise<PlanhatOAuthConnectionMetadata | null> {
    const row = await this.db
      .prepare(
        `SELECT connection.* FROM planhat_oauth_connections connection
         JOIN sessions session ON session.environment_id = connection.environment_id
         WHERE session.id = ?`
      )
      .bind(sessionId)
      .first<ConnectionRow>();
    return row ? metadata(row) : null;
  }

  async getTokens(environmentId: string): Promise<PlanhatOAuthTokenRecord | null> {
    const row = await this.getRow(environmentId);
    if (!row) return null;
    const [clientSecret, accessToken, refreshToken] = await Promise.all([
      decryptToken(row.client_secret_encrypted, this.encryptionKey),
      decryptToken(row.access_token_encrypted, this.encryptionKey),
      decryptToken(row.refresh_token_encrypted, this.encryptionKey),
    ]);
    return {
      ...metadata(row),
      clientId: row.client_id,
      clientSecret,
      accessToken,
      refreshToken,
      refreshTokenEncrypted: row.refresh_token_encrypted,
    };
  }

  async setAssignment(
    environmentId: string,
    enabled: boolean,
    automationId: string | null,
    expectedRevision: number
  ): Promise<PlanhatOAuthConnectionMetadata | null> {
    const now = Date.now();
    const row = await this.db
      .prepare(
        `UPDATE planhat_oauth_connections
         SET assigned_automation_id = ?, assignment_enabled = ?, revision = revision + 1, updated_at = ?
         WHERE environment_id = ? AND revision = ?
         RETURNING *`
      )
      .bind(enabled ? automationId : null, enabled ? 1 : 0, now, environmentId, expectedRevision)
      .first<ConnectionRow>();
    return row ? metadata(row) : null;
  }

  async casUpdateTokens(input: {
    environmentId: string;
    expectedAutomationId: string;
    expectedRefreshTokenEncrypted: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
  }): Promise<PlanhatOAuthCasResult> {
    const now = Date.now();
    const [accessTokenEncrypted, refreshTokenEncrypted] = await Promise.all([
      encryptToken(input.accessToken, this.encryptionKey),
      encryptToken(input.refreshToken, this.encryptionKey),
    ]);
    const result = await this.db
      .prepare(
        `UPDATE planhat_oauth_connections
         SET access_token_encrypted = ?, refresh_token_encrypted = ?, access_token_expires_at = ?,
             revision = revision + 1, updated_at = ?
          WHERE environment_id = ?
            AND assigned_automation_id = ?
            AND assignment_enabled = 1
            AND refresh_token_encrypted = ?`
      )
      .bind(
        accessTokenEncrypted,
        refreshTokenEncrypted,
        input.accessTokenExpiresAt,
        now,
        input.environmentId,
        input.expectedAutomationId,
        input.expectedRefreshTokenEncrypted
      )
      .run();
    return result.meta.changes > 0 ? { ok: true } : { ok: false, reason: "cas-conflict" };
  }

  async disconnect(environmentId: string): Promise<boolean> {
    const [connection] = await this.db.batch([
      this.db
        .prepare("DELETE FROM planhat_oauth_connections WHERE environment_id = ?")
        .bind(environmentId),
      this.db
        .prepare("DELETE FROM planhat_oauth_authorizations WHERE environment_id = ?")
        .bind(environmentId),
    ]);
    return connection.meta.changes > 0;
  }

  private getRow(environmentId: string): Promise<ConnectionRow | null> {
    return this.db
      .prepare("SELECT * FROM planhat_oauth_connections WHERE environment_id = ?")
      .bind(environmentId)
      .first<ConnectionRow>();
  }
}
