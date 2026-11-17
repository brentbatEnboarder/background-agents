import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { PlanhatOAuthTokenRecord } from "../db/planhat-oauth-connections";
import {
  PlanhatOAuthAssignmentDisabledError,
  PlanhatOAuthConcurrencyError,
  PlanhatOAuthStorageError,
  PlanhatOAuthTokenBroker,
  PlanhatOAuthUpstreamError,
  type PlanhatOAuthTokenStore,
} from "./planhat-token-broker";

const NOW = 1_800_000_000_000;

function record(overrides: Partial<PlanhatOAuthTokenRecord> = {}): PlanhatOAuthTokenRecord {
  return {
    environmentId: "env-alex",
    revision: 1,
    expectedGrant: "conversation-view",
    assignedAutomationId: "automation-alex",
    assignmentEnabled: true,
    accessTokenExpiresAt: NOW + 60_000,
    connectedAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    clientId: "client-1",
    clientSecret: "client-secret",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    refreshTokenEncrypted: "encrypted-refresh-old",
    ...overrides,
  };
}

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function tokenStore(initial: PlanhatOAuthTokenRecord | null = record()) {
  let current = initial;
  const store: PlanhatOAuthTokenStore = {
    getTokens: vi.fn(async () => current),
    casUpdateTokens: vi.fn(async (input) => {
      if (!current || input.expectedRefreshTokenEncrypted !== current.refreshTokenEncrypted) {
        return { ok: false, reason: "cas-conflict" } as const;
      }
      current = record({
        ...current,
        revision: current.revision + 1,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        refreshTokenEncrypted: `encrypted-${input.refreshToken}`,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
      });
      return { ok: true } as const;
    }),
  };
  return {
    store,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
}

describe("PlanhatOAuthTokenBroker", () => {
  it("returns a fresh assigned token without refreshing", async () => {
    const state = tokenStore(record({ accessTokenExpiresAt: NOW + 10 * 60_000 }));
    const refresh = vi.fn();
    const broker = new PlanhatOAuthTokenBroker(state.store, logger(), refresh, () => NOW);

    await expect(broker.getAccessToken("env-alex", "automation-alex")).resolves.toBe("access-old");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("denies a disabled assignment before refresh", async () => {
    const state = tokenStore(record({ assignmentEnabled: false }));
    const refresh = vi.fn();
    const broker = new PlanhatOAuthTokenBroker(state.store, logger(), refresh, () => NOW);

    await expect(broker.getAccessToken("env-alex", "automation-alex")).rejects.toBeInstanceOf(
      PlanhatOAuthAssignmentDisabledError
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("denies a token assigned to another automation", async () => {
    const state = tokenStore(record({ accessTokenExpiresAt: NOW + 10 * 60_000 }));
    const refresh = vi.fn();
    const broker = new PlanhatOAuthTokenBroker(state.store, logger(), refresh, () => NOW);

    await expect(broker.getAccessToken("env-alex", "automation-other")).rejects.toBeInstanceOf(
      PlanhatOAuthAssignmentDisabledError
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rotates and persists an expiring token before returning it", async () => {
    const state = tokenStore();
    const refresh = vi.fn(async () => ({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    }));
    const log = logger();
    const broker = new PlanhatOAuthTokenBroker(state.store, log, refresh, () => NOW);

    await expect(broker.getAccessToken("env-alex", "automation-alex")).resolves.toBe("access-new");
    expect(state.store.casUpdateTokens).toHaveBeenCalledOnce();
    expect(state.store.casUpdateTokens).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAutomationId: "automation-alex" })
    );
    expect(state.current?.refreshToken).toBe("refresh-new");
    expect(log.info).toHaveBeenCalledWith("Planhat OAuth tokens rotated", {
      event: "planhat_oauth.refreshed",
      environment_id: "env-alex",
    });
  });

  it("coalesces concurrent same-isolate rotation", async () => {
    const state = tokenStore(record({ environmentId: "env-concurrent" }));
    let release!: (value: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }) => void;
    const pending = new Promise<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>((resolve) => {
      release = resolve;
    });
    const refresh = vi.fn(() => pending);
    const broker = new PlanhatOAuthTokenBroker(state.store, logger(), refresh, () => NOW);

    const first = broker.getAccessToken("env-concurrent", "automation-alex");
    const second = broker.getAccessToken("env-concurrent", "automation-alex");
    release({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 });

    await expect(Promise.all([first, second])).resolves.toEqual(["access-new", "access-new"]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(state.store.casUpdateTokens).toHaveBeenCalledOnce();
  });

  it("uses a safely persisted concurrent rotation after a CAS conflict", async () => {
    const previous = record({ environmentId: "env-cas" });
    const current = record({
      environmentId: "env-cas",
      revision: 2,
      accessToken: "access-winner",
      refreshToken: "refresh-winner",
      refreshTokenEncrypted: "encrypted-refresh-winner",
      accessTokenExpiresAt: NOW + 3_600_000,
    });
    const getTokens = vi.fn().mockResolvedValueOnce(previous).mockResolvedValueOnce(current);
    const store: PlanhatOAuthTokenStore = {
      getTokens,
      casUpdateTokens: vi.fn(async () => ({ ok: false, reason: "cas-conflict" }) as const),
    };
    const broker = new PlanhatOAuthTokenBroker(
      store,
      logger(),
      vi.fn(async () => ({ access_token: "loser", refresh_token: "loser", expires_in: 3600 })),
      () => NOW
    );

    await expect(broker.getAccessToken("env-cas", "automation-alex")).resolves.toBe(
      "access-winner"
    );
  });

  it("fails closed when a rotated token cannot be persisted", async () => {
    const state = tokenStore(record({ environmentId: "env-storage" }));
    vi.mocked(state.store.casUpdateTokens).mockRejectedValue(new Error("database secret detail"));
    const log = logger();
    const broker = new PlanhatOAuthTokenBroker(
      state.store,
      log,
      vi.fn(async () => ({ access_token: "access-new", refresh_token: "refresh-new" })),
      () => NOW
    );

    await expect(broker.getAccessToken("env-storage", "automation-alex")).rejects.toBeInstanceOf(
      PlanhatOAuthStorageError
    );
    const logged = JSON.stringify(vi.mocked(log.error).mock.calls);
    expect(logged).not.toContain("access-new");
    expect(logged).not.toContain("refresh-new");
    expect(logged).not.toContain("database secret detail");
  });

  it("fails closed when refresh and cross-isolate reconciliation both fail", async () => {
    const state = tokenStore(record({ environmentId: "env-upstream" }));
    const log = logger();
    const broker = new PlanhatOAuthTokenBroker(
      state.store,
      log,
      vi.fn(async () => {
        throw new Error("provider body with refresh-old");
      }),
      () => NOW
    );

    await expect(broker.getAccessToken("env-upstream", "automation-alex")).rejects.toBeInstanceOf(
      PlanhatOAuthUpstreamError
    );
    expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("refresh-old");
  });

  it("rejects an unreconciled stale rotation", async () => {
    const previous = record({ environmentId: "env-stale" });
    const store: PlanhatOAuthTokenStore = {
      getTokens: vi.fn(async () => previous),
      casUpdateTokens: vi.fn(async () => ({ ok: false, reason: "cas-conflict" }) as const),
    };
    const broker = new PlanhatOAuthTokenBroker(
      store,
      logger(),
      vi.fn(async () => ({ access_token: "loser", refresh_token: "loser" })),
      () => NOW
    );

    await expect(broker.getAccessToken("env-stale", "automation-alex")).rejects.toBeInstanceOf(
      PlanhatOAuthConcurrencyError
    );
  });
});
