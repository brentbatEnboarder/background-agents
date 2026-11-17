import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { PlanhatOAuthConnectionStore } from "../../src/db/planhat-oauth-connections";
import { SessionIndexStore } from "../../src/db/session-index";
import { PLANHAT_MCP_OPERATION } from "../../src/planhat/exact-conversation-transport";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, seedSandboxAuth, sqlDatabase } from "./helpers";

const ENVIRONMENT_ID = "env-planhat-gateway";
const AUTOMATION_ID = "automation-alex-cs";
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
  } = {}
): Promise<void> {
  const sessionId = input.sessionId ?? activeSessionId;
  const now = Date.now();
  await new SessionIndexStore(sqlDatabase(env.DB)).create({
    id: sessionId,
    title: "Invented Alex session",
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    parentSessionId: null,
    spawnSource: "automation",
    spawnDepth: 0,
    automationId: input.automationId ?? AUTOMATION_ID,
    environmentId: input.environmentId ?? ENVIRONMENT_ID,
    createdAt: now,
    updatedAt: now,
  });
  const { stub } = await initNamedSessionDO(sessionId);
  await seedSandboxAuth(stub, {
    authToken: input.sandboxToken ?? activeSandboxToken,
    sandboxId: input.sandboxId ?? activeSandboxId,
  });
}

async function seedConnection(assign = true): Promise<void> {
  const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
  const stateHash = "d".repeat(64);
  await store.beginAuthorization({
    stateHash,
    environmentId: ENVIRONMENT_ID,
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
    const assigned = await store.setAssignment(ENVIRONMENT_ID, true, AUTOMATION_ID, 1);
    if (!assigned) throw new Error("Planhat assignment not seeded");
  }
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

describe("Planhat exact Conversation gateway", () => {
  beforeEach(async () => {
    sessionSequence += 1;
    activeSessionId = `session-alex-cs-${sessionSequence}`;
    activeSandboxId = `sandbox-alex-cs-${sessionSequence}`;
    activeSandboxToken = `sandbox-token-alex-cs-${sessionSequence}`;
    await cleanD1Tables();
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
    await store.setAssignment(ENVIRONMENT_ID, false, null, 2);
    expect((await gatewayFetch("must-not-read")).status).toBe(403);

    await store.setAssignment(ENVIRONMENT_ID, true, AUTOMATION_ID, 3);
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
