import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { PlanhatOAuthConnectionStore } from "../../src/db/planhat-oauth-connections";
import { SessionIndexStore } from "../../src/db/session-index";
import { PLANHAT_MCP_OPERATION } from "../../src/planhat/exact-conversation-transport";
import {
  PLANHAT_DISCOVERY_MAX_RECORD_COUNT,
  type PlanhatDiscoveryValidationOperation,
} from "../../src/planhat/discovery-validation-transport";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSessionDO,
  seedActiveUser,
  seedSandboxAuth,
  sqlDatabase,
  TEST_SESSION_PROVIDER_AUTH,
} from "./helpers";
import { getUserEnvVars, runInSessionDO } from "./session-do-access";
import {
  COMPACT_DISCOVERY_OVERFLOW_RECORD_COUNT,
  compactDiscoveryOverflowJsonRpc,
} from "./planhat-discovery-fixtures";

const ENVIRONMENT_ID = "env-planhat-gateway";
const AUTOMATION_ID = "automation-alex-cs";
const USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let sessionSequence = 0;
let activeSessionId = "";
let activeSandboxId = "";
let activeSandboxToken = "";

function automation(id: string): AutomationRow {
  return {
    id,
    name: id === AUTOMATION_ID ? "Alex – Customer Success" : "Other automation",
    instructions: "Invented integration test automation",
    trigger_type: "webhook",
    schedule_cron: null,
    schedule_tz: "UTC",
    harness: "opencode",
    event_type: null,
    trigger_config: null,
    trigger_auth_data: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    enabled: 1,
    next_run_at: null,
    consecutive_failures: 0,
    created_by: "integration-test",
    user_id: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
  };
}

async function seedEnvironment(environmentId = ENVIRONMENT_ID): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO environments
     (id, name, description, prebuild_enabled, channel_associations, created_at, updated_at)
     VALUES (?, ?, NULL, 0, NULL, ?, ?)`
  )
    .bind(environmentId, environmentId, now, now)
    .run();
}

async function seedAutomation(id = AUTOMATION_ID, environmentId = ENVIRONMENT_ID): Promise<void> {
  await new AutomationStore(env.DB).create(automation(id));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO automation_environments
     (automation_id, environment_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
  )
    .bind(id, environmentId, now, now)
    .run();
}

async function seedSession(
  input: {
    sessionId?: string;
    automationId?: string;
    environmentId?: string;
    sandboxId?: string;
    sandboxToken?: string;
    spawnSource?: "automation" | "slack-bot" | "user" | "agent";
    userId?: string | null;
    parentSessionId?: string | null;
    spawnDepth?: number;
    repoOwner?: string | null;
    repoName?: string | null;
    repoId?: number | null;
    createdAt?: number;
    indexedCreatedAt?: number;
    localCreatedAt?: number;
  } = {}
): Promise<DurableObjectStub> {
  const sessionId = input.sessionId ?? activeSessionId;
  const now =
    input.createdAt ??
    Math.max(Date.now(), Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT ?? "") + 1);
  const indexedCreatedAt = input.indexedCreatedAt ?? now;
  const localCreatedAt = input.localCreatedAt ?? now;
  await new SessionIndexStore(sqlDatabase(env.DB)).create({
    id: sessionId,
    title: "Invented Alex session",
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    parentSessionId: input.parentSessionId ?? null,
    spawnSource: input.spawnSource ?? "automation",
    spawnDepth: input.spawnDepth ?? 0,
    automationId:
      input.automationId === undefined
        ? (input.spawnSource ?? "automation") === "automation"
          ? AUTOMATION_ID
          : null
        : input.automationId,
    userId: input.userId ?? null,
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    providerAuth: TEST_SESSION_PROVIDER_AUTH,
    createdAt: indexedCreatedAt,
    updatedAt: indexedCreatedAt,
  });
  const { stub } = await initNamedSessionDO(sessionId, {
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    repoId: input.repoOwner && input.repoName ? (input.repoId ?? 12345) : null,
    defaultBranch: input.repoOwner && input.repoName ? "main" : null,
    spawnSource: input.spawnSource ?? "automation",
    parentSessionId: input.parentSessionId ?? null,
    spawnDepth: input.spawnDepth ?? 0,
    createdAt: localCreatedAt,
    userId: input.userId ?? "integration-actor",
  });
  await seedSandboxAuth(stub, {
    authToken: input.sandboxToken ?? activeSandboxToken,
    sandboxId: input.sandboxId ?? activeSandboxId,
  });
  return stub;
}

async function replaceLocalSessionCreatedAt(
  stub: DurableObjectStub,
  createdAt: string
): Promise<void> {
  await runInSessionDO(stub, (_instance, state) => {
    state.storage.sql.exec("UPDATE session SET created_at = ?", createdAt);
  });
}

async function deleteLocalSession(stub: DurableObjectStub): Promise<void> {
  await runInSessionDO(stub, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM session");
  });
}

async function seedConnection(
  assign = true,
  assignmentMode: "automation" | "slack-environment" = "automation",
  environmentId = ENVIRONMENT_ID
): Promise<void> {
  const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
  const stateHash = "d".repeat(64);
  await store.beginAuthorization({
    stateHash,
    environmentId,
    clientId: "integration-planhat-client",
    clientSecret: "integration-planhat-secret",
    codeVerifier: "v".repeat(64),
    redirectUri: "https://control.test.local/integrations/planhat/oauth/callback",
    expiresAt: Date.now() + 60_000,
  });
  const pending = await store.getPendingAuthorization(stateHash);
  if (!pending) throw new Error("Pending Planhat authorization not seeded");
  await store.completeAuthorization({
    pending,
    accessToken: "integration-planhat-access",
    refreshToken: "integration-planhat-refresh",
    accessTokenExpiresAt: Date.now() + 3_600_000,
  });
  if (assign) {
    const assigned = await store.setAssignment(
      environmentId,
      true,
      assignmentMode,
      assignmentMode === "automation" ? AUTOMATION_ID : null,
      1
    );
    if (!assigned) throw new Error("Planhat assignment not seeded");
  }
}

async function enableSlackEnvironmentAssignment(): Promise<void> {
  const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
  const disabled = await store.setAssignment(ENVIRONMENT_ID, false, "automation", null, 2);
  if (!disabled) throw new Error("Planhat automation assignment not disabled");
  const assigned = await store.setAssignment(ENVIRONMENT_ID, true, "slack-environment", null, 3);
  if (!assigned) throw new Error("Planhat Slack-environment assignment not enabled");
}

function gatewayFetch(
  conversationId: string,
  overrides: {
    sessionId?: string;
    sandboxId?: string;
    sandboxToken?: string;
    body?: unknown;
  } = {}
): Promise<Response> {
  return SELF.fetch(
    `https://test.local/sessions/${overrides.sessionId ?? activeSessionId}/planhat-mcp/conversation-messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${overrides.sandboxToken ?? activeSandboxToken}`,
        "X-Sandbox-ID": overrides.sandboxId ?? activeSandboxId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        overrides.body ?? {
          operation: PLANHAT_MCP_OPERATION,
          companyId: "company-invented",
          conversationId,
        }
      ),
    }
  );
}

function discoveryValidationFetch(
  operation: PlanhatDiscoveryValidationOperation,
  overrides: {
    body?: unknown;
    sessionId?: string;
    sandboxId?: string;
    sandboxToken?: string;
  } = {}
): Promise<Response> {
  return SELF.fetch(
    `https://test.local/sessions/${overrides.sessionId ?? activeSessionId}/planhat-mcp/conversation-discovery-validation`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${overrides.sandboxToken ?? activeSandboxToken}`,
        "X-Sandbox-ID": overrides.sandboxId ?? activeSandboxId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        overrides.body ?? {
          operation,
          windowId: "window-invented",
          issuedAt: env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT,
          expiresAt: env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT,
        }
      ),
    }
  );
}

describe("Planhat exact Conversation gateway", () => {
  beforeEach(async () => {
    sessionSequence += 1;
    activeSessionId = `session-alex-cs-${sessionSequence}`;
    activeSandboxId = `sandbox-alex-cs-${sessionSequence}`;
    activeSandboxToken = `sandbox-token-alex-cs-${sessionSequence}`;
    await cleanD1Tables();
    await seedActiveUser(USER_ID);
    await seedEnvironment();
    await seedAutomation();
    await seedSession();
    await seedConnection();
  });

  it("returns only the fixed exact Conversation projection to the matching sandbox", async () => {
    const response = await gatewayFetch("conversation-invented");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      operation: PLANHAT_MCP_OPERATION,
      companyId: "company-invented",
      conversationId: "conversation-invented",
      record: {
        _id: "conversation-invented",
        companyId: "company-invented",
        numberOfParts: 1,
        parts: [{ _id: "part-invented", content: "transient invented body" }],
      },
    });
    expect(body).toHaveProperty("correlationId");
    expect((body.record as Record<string, unknown>).unrestricted).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/integration-planhat-(access|refresh|secret)/);
  });

  it("keeps the sandbox authorization gate ahead of exact-route request parsing", async () => {
    const response = await gatewayFetch("must-not-read", {
      sandboxId: "wrong-sandbox",
      body: { unrestricted: "must-not-parse" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ stage: "sandbox" });
  });

  it("admits actor-bound Alex Slack sessions for initial and follow-up exact reads", async () => {
    await enableSlackEnvironmentAssignment();
    await seedSession({
      sessionId: "session-slack-authorized",
      spawnSource: "slack-bot",
      userId: USER_ID,
      sandboxId: "sandbox-slack-authorized",
      sandboxToken: "token-slack-authorized",
    });

    for (const conversationId of ["conversation-slack-initial", "conversation-slack-follow-up"]) {
      const response = await gatewayFetch(conversationId, {
        sessionId: "session-slack-authorized",
        sandboxId: "sandbox-slack-authorized",
        sandboxToken: "token-slack-authorized",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ conversationId });
    }
  });

  it("denies non-Slack, actorless, child, automation, and wrong-environment sessions", async () => {
    await enableSlackEnvironmentAssignment();
    const denied = [
      { id: "session-web", spawnSource: "user" as const, userId: USER_ID },
      { id: "session-slack-actorless", spawnSource: "slack-bot" as const, userId: null },
      { id: "session-automation", spawnSource: "automation" as const, userId: null },
      {
        id: "session-child",
        spawnSource: "agent" as const,
        userId: USER_ID,
        parentSessionId: activeSessionId,
        spawnDepth: 1,
      },
    ];
    for (const candidate of denied) {
      const sandboxId = `sandbox-${candidate.id}`;
      const sandboxToken = `token-${candidate.id}`;
      await seedSession({
        sessionId: candidate.id,
        spawnSource: candidate.spawnSource,
        userId: candidate.userId,
        parentSessionId: candidate.parentSessionId,
        spawnDepth: candidate.spawnDepth,
        sandboxId,
        sandboxToken,
      });
      expect(
        (
          await gatewayFetch("must-not-read", {
            sessionId: candidate.id,
            sandboxId,
            sandboxToken,
          })
        ).status
      ).toBe(403);
    }

    const otherEnvironment = "env-slack-other";
    await seedEnvironment(otherEnvironment);
    await seedSession({
      sessionId: "session-slack-wrong-environment",
      spawnSource: "slack-bot",
      userId: USER_ID,
      environmentId: otherEnvironment,
      sandboxId: "sandbox-slack-wrong-environment",
      sandboxToken: "token-slack-wrong-environment",
    });
    expect(
      (
        await gatewayFetch("must-not-read", {
          sessionId: "session-slack-wrong-environment",
          sandboxId: "sandbox-slack-wrong-environment",
          sandboxToken: "token-slack-wrong-environment",
        })
      ).status
    ).toBe(403);
  });

  it("rejects generic MCP, discovery, search, mutation, and caller-selected fields", async () => {
    const rejected = [
      { operation: "tools/list", companyId: "company-invented", conversationId: "must-not-read" },
      {
        operation: "search_records",
        companyId: "company-invented",
        conversationId: "must-not-read",
      },
      {
        operation: "update_model_record",
        companyId: "company-invented",
        conversationId: "must-not-read",
      },
      {
        operation: PLANHAT_MCP_OPERATION,
        companyId: "company-invented",
        conversationId: "must-not-read",
        tool: "get_model_record",
      },
      {
        operation: PLANHAT_MCP_OPERATION,
        companyId: "company-invented",
        conversationId: "must-not-read",
        select: ["subject"],
      },
      {
        operation: PLANHAT_MCP_OPERATION,
        companyId: "company-invented",
        conversationId: "must-not-read",
        url: "https://example.invalid/mcp",
      },
    ];
    for (const body of rejected) {
      const response = await gatewayFetch("must-not-read", { body });
      expect(response.status).toBe(400);
    }
  });

  it("denies disabled, wrong-automation, and wrong-environment sessions before provider access", async () => {
    const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
    await store.setAssignment(ENVIRONMENT_ID, false, "automation", null, 2);
    expect((await gatewayFetch("must-not-read")).status).toBe(403);

    await store.setAssignment(ENVIRONMENT_ID, true, "automation", AUTOMATION_ID, 3);
    const otherAutomation = "automation-other";
    await seedAutomation(otherAutomation);
    await seedSession({
      sessionId: "session-other-automation",
      automationId: otherAutomation,
      sandboxId: "sandbox-other-automation",
      sandboxToken: "token-other-automation",
    });
    expect(
      (
        await gatewayFetch("must-not-read", {
          sessionId: "session-other-automation",
          sandboxId: "sandbox-other-automation",
          sandboxToken: "token-other-automation",
        })
      ).status
    ).toBe(403);

    const otherEnvironment = "env-other";
    await seedEnvironment(otherEnvironment);
    await seedSession({
      sessionId: "session-other-environment",
      environmentId: otherEnvironment,
      sandboxId: "sandbox-other-environment",
      sandboxToken: "token-other-environment",
    });
    expect(
      (
        await gatewayFetch("must-not-read", {
          sessionId: "session-other-environment",
          sandboxId: "sandbox-other-environment",
          sandboxToken: "token-other-environment",
        })
      ).status
    ).toBe(403);
  });

  it("enforces exact route-session sandbox binding", async () => {
    await seedSession({
      sessionId: "session-second",
      sandboxId: "sandbox-second",
      sandboxToken: "token-second",
    });
    const response = await gatewayFetch("must-not-read", {
      sessionId: activeSessionId,
      sandboxId: "sandbox-second",
      sandboxToken: "token-second",
    });
    expect(response.status).toBe(401);
  });

  it("rejects malformed IDs and oversized request bodies", async () => {
    expect(
      (
        await gatewayFetch("bad/id", {
          body: {
            operation: PLANHAT_MCP_OPERATION,
            companyId: "company-invented",
            conversationId: "bad/id",
          },
        })
      ).status
    ).toBe(400);
    const oversized = await gatewayFetch("must-not-read", {
      body: {
        operation: PLANHAT_MCP_OPERATION,
        companyId: "company-invented",
        conversationId: "must-not-read",
        padding: "x".repeat(2_000),
      },
    });
    expect(oversized.status).toBe(413);
  });

  it.each([
    ["conversation-provider-error", 502, "read"],
    ["conversation-malformed", 502, "parse"],
    ["conversation-oversized", 502, "read"],
    ["conversation-mismatch", 502, "identity"],
  ])("fails closed for %s", async (conversationId, expectedStatus, expectedStage) => {
    const response = await gatewayFetch(conversationId);
    expect(response.status).toBe(expectedStatus);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      error: "Planhat exact Conversation retrieval unavailable",
      stage: expectedStage,
    });
    expect(JSON.stringify(body)).not.toMatch(/provider detail|private timeout|integration-planhat/);
  });
});

describe("Planhat Conversation discovery validation gateway", () => {
  beforeEach(async () => {
    sessionSequence += 1;
    activeSessionId = `session-alex-cs-validation-${sessionSequence}`;
    activeSandboxId = `sandbox-alex-cs-validation-${sessionSequence}`;
    activeSandboxToken = `sandbox-token-alex-cs-validation-${sessionSequence}`;
    await cleanD1Tables();
    await seedActiveUser(USER_ID);
    await seedEnvironment();
    await seedAutomation();
    await seedSession({ spawnSource: "slack-bot", userId: USER_ID });
    await seedConnection(true, "slack-environment");
  });

  it.each([
    "planhat.mcp.validate-conversation-search",
    "planhat.mcp.validate-conversation-get",
  ] as const)("returns the exact text-free #245 envelope for %s", async (operation) => {
    const response = await discoveryValidationFetch(operation);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["correlationId", "observation", "operation"]);
    expect(body.operation).toBe(operation);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toMatch(
      /private invented|example\.test|conversation-validation-invented|company-validation-invented|validation query|provider description|provider example|integration-planhat|Acme|Brent|507f1f77|Main_Street|Sydney/
    );
    expect(body.observation).toMatchObject({
      schema: { inputFields: expect.any(Array), outputFields: expect.any(Array) },
      response: {
        byteLength: expect.any(Number),
        recordCount: 1,
        candidateLimit: operation === "planhat.mcp.validate-conversation-get" ? null : 20,
        truncated: operation === "planhat.mcp.validate-conversation-get" ? null : false,
        continuationPresent: null,
        identityShapes: expect.any(Array),
      },
    });
    const inputFields = (
      body.observation as { schema: { inputFields: Array<Record<string, unknown>> } }
    ).schema.inputFields;
    expect(inputFields).toEqual(
      operation === "planhat.mcp.validate-conversation-search"
        ? [
            { path: "$.MODEL", type: "string", required: true },
            { path: "$.QUERY", type: "string", required: true },
            { path: "$.QUERY.__dynamic__", type: "object", required: true },
            { path: "$.__dynamic__", type: "object", required: true },
          ]
        : [
            { path: "$.MODEL", type: "string", required: true },
            { path: "$.OBJECT_ID", type: "string", required: true },
            { path: "$.SELECT", type: "array", required: false },
            { path: "$.SELECT.__dynamic__", type: "object", required: true },
            { path: "$.__dynamic__", type: "object", required: true },
          ]
    );
    for (const key of [
      "Acme_Corporation",
      "507f1f77bcf86cd799439011",
      "brent.pearson@example.test",
      "123_Main_Street_Sydney",
      "BrentPearson",
    ]) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(encoded).not.toContain(key);
      expect(encoded).not.toContain(encodeURIComponent(key));
      expect(encoded).not.toContain(btoa(key));
      expect(encoded).not.toContain(hex);
    }
  });

  it("rejects the compact 100,001-record provider payload through the real route seam", async () => {
    const providerPayload = compactDiscoveryOverflowJsonRpc(3);
    expect(COMPACT_DISCOVERY_OVERFLOW_RECORD_COUNT).toBe(PLANHAT_DISCOVERY_MAX_RECORD_COUNT + 1);
    expect(new TextEncoder().encode(providerPayload).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(
      (
        JSON.parse(providerPayload) as {
          result: { structuredContent: { records: unknown[] } };
        }
      ).result.structuredContent.records
    ).toHaveLength(100_001);

    const response = await discoveryValidationFetch("planhat.mcp.validate-conversation-list");
    expect(response.status).toBe(502);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      error: "Planhat Conversation discovery validation unavailable",
      stage: "parse",
    });
    expect(Object.keys(body).sort()).toEqual(["correlationId", "error", "stage"]);
    expect(body).not.toHaveProperty("observation");
    expect(body).not.toHaveProperty("operation");
  });

  it("rejects generic MCP, caller tools, models, fields, raw queries, mutation, redirects, and retries", async () => {
    const rejected = [
      { operation: "tools/list" },
      { operation: "update_model_record" },
      { operation: "planhat.mcp.validate-conversation-search", tool: "search_records" },
      { operation: "planhat.mcp.validate-conversation-search", model: "Company" },
      { operation: "planhat.mcp.validate-conversation-search", fields: ["body"] },
      { operation: "planhat.mcp.validate-conversation-search", rawQuery: "private" },
      { operation: "planhat.mcp.validate-conversation-search", redirect: "follow" },
      { operation: "planhat.mcp.validate-conversation-search", retries: 1 },
    ];
    for (const candidate of rejected) {
      expect(
        (
          await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
            body: {
              windowId: "window-invented",
              issuedAt: env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT,
              expiresAt: env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT,
              ...candidate,
            },
          })
        ).status
      ).toBe(400);
    }
  });

  it("requires the matching sandbox and active assignment before provider access", async () => {
    expect(
      (
        await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
          sandboxId: "wrong-sandbox",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
          sandboxToken: "wrong-token",
        })
      ).status
    ).toBe(401);
    await seedSession({
      sessionId: "validation-other-sandbox-session",
      spawnSource: "slack-bot",
      userId: USER_ID,
      sandboxId: "sandbox-validation-other-session",
      sandboxToken: "token-validation-other-session",
    });
    expect(
      (
        await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
          sandboxId: "sandbox-validation-other-session",
          sandboxToken: "token-validation-other-session",
        })
      ).status
    ).toBe(401);
    const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
    await store.setAssignment(ENVIRONMENT_ID, false, "automation", null, 2);
    expect(
      (await discoveryValidationFetch("planhat.mcp.validate-conversation-search")).status
    ).toBe(403);
  });

  it("denies a pre-window Slack session and an exact-expiry mismatch before the provider seam", async () => {
    const oldSessionId = "validation-pre-window-session";
    const oldSandboxId = "sandbox-validation-pre-window";
    const oldSandboxToken = "token-validation-pre-window";
    await seedSession({
      sessionId: oldSessionId,
      spawnSource: "slack-bot",
      userId: USER_ID,
      sandboxId: oldSandboxId,
      sandboxToken: oldSandboxToken,
      createdAt: Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT!) - 1,
    });
    expect(
      (
        await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
          sessionId: oldSessionId,
          sandboxId: oldSandboxId,
          sandboxToken: oldSandboxToken,
        })
      ).status
    ).toBe(403);

    expect(
      (
        await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
          body: {
            operation: "planhat.mcp.validate-conversation-search",
            windowId: "window-invented",
            issuedAt: env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT,
            expiresAt: new Date(
              Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT!) - 1
            ).toISOString(),
          },
        })
      ).status
    ).toBe(403);
  });

  it("exposes the complete tuple only to one fresh canonical Alex Slack session", async () => {
    const ineligible = [
      { id: "tuple-actorless", userId: null },
      { id: "tuple-noncanonical", userId: "slack:U123" },
      { id: "tuple-automation-linked", userId: USER_ID, automationId: AUTOMATION_ID },
      { id: "tuple-web", userId: USER_ID, spawnSource: "user" as const },
      {
        id: "tuple-child",
        userId: USER_ID,
        spawnSource: "slack-bot" as const,
        parentSessionId: activeSessionId,
        spawnDepth: 1,
      },
      {
        id: "tuple-repository",
        userId: USER_ID,
        spawnSource: "slack-bot" as const,
        repoOwner: "invented",
        repoName: "repository",
        repoId: 12345,
      },
      {
        id: "tuple-pre-window",
        userId: USER_ID,
        spawnSource: "slack-bot" as const,
        createdAt: Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT!) - 1,
      },
    ];

    for (const candidate of ineligible) {
      const stub = await seedSession({
        ...candidate,
        sessionId: candidate.id,
        spawnSource: candidate.spawnSource ?? "slack-bot",
      });
      const sandboxEnv = await getUserEnvVars(stub, true);
      expect(
        Object.keys(sandboxEnv ?? {}).filter((key) =>
          key.startsWith("CS_PLANHAT_DISCOVERY_VALIDATION_")
        ),
        candidate.id
      ).toEqual([]);
    }

    const otherEnvironment = "env-planhat-tuple-other";
    await seedEnvironment(otherEnvironment);
    const wrongEnvironmentStub = await seedSession({
      sessionId: "tuple-wrong-environment",
      spawnSource: "slack-bot",
      userId: USER_ID,
      environmentId: otherEnvironment,
    });
    expect(
      Object.keys((await getUserEnvVars(wrongEnvironmentStub, true)) ?? {}).filter((key) =>
        key.startsWith("CS_PLANHAT_DISCOVERY_VALIDATION_")
      )
    ).toEqual([]);

    const qualifyingStub = await seedSession({
      sessionId: "tuple-qualifying",
      spawnSource: "slack-bot",
      userId: USER_ID,
    });
    await expect(getUserEnvVars(qualifyingStub, false)).resolves.toBeUndefined();
    await expect(getUserEnvVars(qualifyingStub, true)).resolves.toEqual({
      CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
      CS_PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT: env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT,
      CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT,
      CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: "window-invented",
    });
  });

  it("requires exact local/index creation-time authority before exposing the tuple", async () => {
    const fresh = Math.max(Date.now(), Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT!) + 1);
    const old = Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT!) - 1;
    const mismatches = [
      { id: "tuple-fresh-index-old-local", indexedCreatedAt: fresh, localCreatedAt: old },
      { id: "tuple-old-index-fresh-local", indexedCreatedAt: old, localCreatedAt: fresh },
    ];
    for (const candidate of mismatches) {
      const stub = await seedSession({
        ...candidate,
        sessionId: candidate.id,
        spawnSource: "slack-bot",
        userId: USER_ID,
      });
      expect(
        Object.keys((await getUserEnvVars(stub, true)) ?? {}).filter((key) =>
          key.startsWith("CS_PLANHAT_DISCOVERY_VALIDATION_")
        ),
        candidate.id
      ).toEqual([]);
    }

    const offsetStub = await seedSession({
      sessionId: "tuple-equivalent-offset-local",
      spawnSource: "slack-bot",
      userId: USER_ID,
      createdAt: fresh,
    });
    await replaceLocalSessionCreatedAt(
      offsetStub,
      new Date(fresh).toISOString().replace("Z", "+00:00")
    );
    expect(
      Object.keys((await getUserEnvVars(offsetStub, true)) ?? {}).filter((key) =>
        key.startsWith("CS_PLANHAT_DISCOVERY_VALIDATION_")
      )
    ).toEqual([]);

    const invalidIndexStub = await seedSession({
      sessionId: "tuple-invalid-index-time",
      spawnSource: "slack-bot",
      userId: USER_ID,
      createdAt: fresh,
    });
    await env.DB.prepare("UPDATE sessions SET created_at = ? WHERE id = ?")
      .bind(new Date(fresh).toISOString().replace("Z", "+00:00"), "tuple-invalid-index-time")
      .run();
    expect(
      Object.keys((await getUserEnvVars(invalidIndexStub, true)) ?? {}).filter((key) =>
        key.startsWith("CS_PLANHAT_DISCOVERY_VALIDATION_")
      )
    ).toEqual([]);

    const missingLocalStub = await seedSession({
      sessionId: "tuple-missing-local-time",
      spawnSource: "slack-bot",
      userId: USER_ID,
      createdAt: fresh,
    });
    await deleteLocalSession(missingLocalStub);
    await expect(getUserEnvVars(missingLocalStub, true)).resolves.toBeUndefined();
  });

  it("turns the prior direct automation-sandbox bypass into a fail-closed denial", async () => {
    const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
    await store.setAssignment(ENVIRONMENT_ID, false, "slack-environment", null, 2);
    await store.setAssignment(ENVIRONMENT_ID, true, "automation", AUTOMATION_ID, 3);
    await seedSession({
      sessionId: "session-direct-automation-validation",
      spawnSource: "automation",
      automationId: AUTOMATION_ID,
      sandboxId: "sandbox-direct-automation-validation",
      sandboxToken: "token-direct-automation-validation",
    });

    const response = await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
      sessionId: "session-direct-automation-validation",
      sandboxId: "sandbox-direct-automation-validation",
      sandboxToken: "token-direct-automation-validation",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ stage: "assignment" });
  });

  it("admits only a repository-free top-level canonical Slack actor in the exact environment", async () => {
    const candidates = [
      { id: "validation-web", spawnSource: "user" as const, userId: USER_ID },
      { id: "validation-actorless", spawnSource: "slack-bot" as const, userId: null },
      { id: "validation-noncanonical", spawnSource: "slack-bot" as const, userId: "slack:U123" },
      {
        id: "validation-child",
        spawnSource: "agent" as const,
        userId: USER_ID,
        parentSessionId: activeSessionId,
        spawnDepth: 1,
      },
      {
        id: "validation-repository",
        spawnSource: "slack-bot" as const,
        userId: USER_ID,
        repoOwner: "invented",
        repoName: "repository",
      },
      {
        id: "validation-slack-with-automation",
        spawnSource: "slack-bot" as const,
        userId: USER_ID,
        automationId: AUTOMATION_ID,
      },
    ];

    for (const candidate of candidates) {
      const sandboxId = `sandbox-${candidate.id}`;
      const sandboxToken = `token-${candidate.id}`;
      await seedSession({ ...candidate, sessionId: candidate.id, sandboxId, sandboxToken });
      const response = await discoveryValidationFetch("planhat.mcp.validate-conversation-search", {
        sessionId: candidate.id,
        sandboxId,
        sandboxToken,
      });
      expect(response.status, candidate.id).toBe(403);
      expect(await response.json()).toMatchObject({ stage: "assignment" });
    }

    const otherEnvironment = "env-planhat-other";
    await seedEnvironment(otherEnvironment);
    await seedConnection(true, "slack-environment", otherEnvironment);
    await seedSession({
      sessionId: "validation-wrong-environment",
      spawnSource: "slack-bot",
      userId: USER_ID,
      environmentId: otherEnvironment,
      sandboxId: "sandbox-validation-wrong-environment",
      sandboxToken: "token-validation-wrong-environment",
    });
    const wrongEnvironment = await discoveryValidationFetch(
      "planhat.mcp.validate-conversation-search",
      {
        sessionId: "validation-wrong-environment",
        sandboxId: "sandbox-validation-wrong-environment",
        sandboxToken: "token-validation-wrong-environment",
      }
    );
    expect(wrongEnvironment.status).toBe(403);
    await expect(wrongEnvironment.json()).resolves.toMatchObject({ stage: "assignment" });

    const qualifying = await discoveryValidationFetch("planhat.mcp.validate-conversation-search");
    expect(qualifying.status).toBe(200);
    await expect(qualifying.json()).resolves.toMatchObject({
      operation: "planhat.mcp.validate-conversation-search",
    });
  });
});
