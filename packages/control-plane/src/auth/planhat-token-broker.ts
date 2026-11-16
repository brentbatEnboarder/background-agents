import type { Logger } from "../logger";
import type {
  PlanhatOAuthConnectionStore,
  PlanhatOAuthTokenRecord,
} from "../db/planhat-oauth-connections";
import { OAuthRefreshSingleFlight } from "./oauth-refresh-single-flight";
import {
  planhatAccessTokenLifetimeMs,
  refreshPlanhatAccessToken,
  type PlanhatTokenResponse,
} from "./planhat";

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export class PlanhatOAuthNotConfiguredError extends Error {}
export class PlanhatOAuthAssignmentDisabledError extends Error {}
export class PlanhatOAuthStorageError extends Error {}
export class PlanhatOAuthUpstreamError extends Error {}
export class PlanhatOAuthConcurrencyError extends Error {}

export interface PlanhatOAuthTokenStore {
  getTokens(environmentId: string): Promise<PlanhatOAuthTokenRecord | null>;
  casUpdateTokens(input: {
    environmentId: string;
    expectedRefreshTokenEncrypted: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: number;
  }): Promise<{ ok: true } | { ok: false; reason: "cas-conflict" }>;
}

type RefreshPlanhatToken = typeof refreshPlanhatAccessToken;
const refreshCoordinator = new OAuthRefreshSingleFlight<string>();

export class PlanhatOAuthTokenBroker {
  constructor(
    private readonly store: PlanhatOAuthTokenStore | PlanhatOAuthConnectionStore,
    private readonly log: Logger,
    private readonly refresh: RefreshPlanhatToken = refreshPlanhatAccessToken,
    private readonly now: () => number = Date.now
  ) {}

  async getAccessToken(environmentId: string): Promise<string> {
    const record = await this.readRecord(environmentId);
    if (!record.assignmentEnabled) throw new PlanhatOAuthAssignmentDisabledError();
    if (this.isFresh(record)) return record.accessToken;

    return refreshCoordinator.run({ kind: "environment", environmentId }, record.refreshToken, () =>
      this.refreshAndPersist(record)
    );
  }

  private async refreshAndPersist(record: PlanhatOAuthTokenRecord): Promise<string> {
    let tokens: PlanhatTokenResponse;
    try {
      tokens = await this.refresh({
        refreshToken: record.refreshToken,
        clientId: record.clientId,
        clientSecret: record.clientSecret,
      });
    } catch (error) {
      const concurrent = await this.readConcurrentRotation(record);
      if (concurrent) return concurrent;
      this.log.warn("Planhat OAuth token refresh failed", {
        event: "planhat_oauth.refresh_failed",
        environment_id: record.environmentId,
        error_type: error instanceof Error ? error.name : "unknown",
      });
      throw new PlanhatOAuthUpstreamError("Planhat OAuth token refresh failed", { cause: error });
    }

    const accessTokenExpiresAt = this.now() + planhatAccessTokenLifetimeMs(tokens.expires_in);
    let result: Awaited<ReturnType<PlanhatOAuthTokenStore["casUpdateTokens"]>>;
    try {
      result = await this.store.casUpdateTokens({
        environmentId: record.environmentId,
        expectedRefreshTokenEncrypted: record.refreshTokenEncrypted,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessTokenExpiresAt,
      });
    } catch (error) {
      this.log.error("Planhat OAuth tokens rotated but could not be stored", {
        event: "planhat_oauth.persist_failed",
        environment_id: record.environmentId,
        error_type: error instanceof Error ? error.name : "unknown",
      });
      throw new PlanhatOAuthStorageError(
        "Planhat OAuth tokens rotated but could not be stored; reconnect Planhat",
        { cause: error }
      );
    }

    if (!result.ok) {
      const concurrent = await this.readConcurrentRotation(record);
      if (concurrent) return concurrent;
      throw new PlanhatOAuthConcurrencyError("Planhat OAuth rotation could not be reconciled");
    }

    this.log.info("Planhat OAuth tokens rotated", {
      event: "planhat_oauth.refreshed",
      environment_id: record.environmentId,
    });
    return tokens.access_token;
  }

  private async readRecord(environmentId: string): Promise<PlanhatOAuthTokenRecord> {
    let record: PlanhatOAuthTokenRecord | null;
    try {
      record = await this.store.getTokens(environmentId);
    } catch (error) {
      throw new PlanhatOAuthStorageError("Failed to read Planhat OAuth connection", {
        cause: error,
      });
    }
    if (!record) throw new PlanhatOAuthNotConfiguredError();
    return record;
  }

  private async readConcurrentRotation(previous: PlanhatOAuthTokenRecord): Promise<string | null> {
    let current: PlanhatOAuthTokenRecord | null;
    try {
      current = await this.store.getTokens(previous.environmentId);
    } catch (error) {
      throw new PlanhatOAuthStorageError("Failed to reconcile Planhat OAuth rotation", {
        cause: error,
      });
    }
    if (
      current &&
      current.assignmentEnabled &&
      current.refreshTokenEncrypted !== previous.refreshTokenEncrypted &&
      this.isFresh(current)
    ) {
      return current.accessToken;
    }
    return null;
  }

  private isFresh(record: PlanhatOAuthTokenRecord): boolean {
    return record.accessTokenExpiresAt - this.now() > REFRESH_BUFFER_MS;
  }
}
