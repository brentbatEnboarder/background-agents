import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { PlanhatOAuthConnectionStore } from "../../src/db/planhat-oauth-connections";
import { SessionIndexStore } from "../../src/db/session-index";
import {
  PLANHAT_DISCOVERY_LIST_OPERATION,
  PLANHAT_DISCOVERY_SEARCH_OPERATION,
} from "../../src/planhat/conversation-discovery-transport";
import { cleanD1Tables } from "./cleanup";
import {
  initNamedSessionDO,
  seedActiveUser,
  seedSandboxAuth,
  sqlDatabase,
  TEST_SESSION_PROVIDER_AUTH,
} from "./helpers";

const ENVIRONMENT_ID = "env-planhat-discovery";
const AUTOMATION_ID = "automation-alex-cs-discovery";
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const COMPANY = "company-discovery-invented";
let sequence = 0;
let sessionId = "";
let sandboxId = "";
let sandboxToken = "";

function automation(): AutomationRow {
  return {
    id: AUTOMATION_ID,
    name: "Alex – Customer Success",
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

async function seed(assign: boolean): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO environments
     (id, name, description, prebuild_enabled, channel_associations, created_at, updated_at)
     VALUES (?, ?, NULL, 0, NULL, ?, ?)`
  )
    .bind(ENVIRONMENT_ID, ENVIRONMENT_ID, now, now)
    .run();
  await new AutomationStore(env.DB).create(automation());
  await env.DB.prepare(
    `INSERT INTO automation_environments
     (automation_id, environment_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
  )
    .bind(AUTOMATION_ID, ENVIRONMENT_ID, now, now)
    .run();
  await new SessionIndexStore(sqlDatabase(env.DB)).create({
    id: sessionId,
    title: "Invented Alex discovery session",
    repoOwner: null,
    repoName: null,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: null,
    status: "created",
    parentSessionId: null,
    spawnSource: "automation",
    spawnDepth: 0,
    automationId: AUTOMATION_ID,
    userId: null,
    environmentId: ENVIRONMENT_ID,
    providerAuth: TEST_SESSION_PROVIDER_AUTH,
    repositories: [],
    createdAt: now,
    updatedAt: now,
  });
  const { stub } = await initNamedSessionDO(sessionId, {
    environmentId: ENVIRONMENT_ID,
    repoOwner: null,
    repoName: null,
    repoId: null,
    defaultBranch: null,
    spawnSource: "automation",
    parentSessionId: null,
    spawnDepth: 0,
    createdAt: now,
    userId: "integration-actor",
  });
  await seedSandboxAuth(stub, { authToken: sandboxToken, sandboxId });

  const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
  const stateHash = "e".repeat(64);
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
    const assigned = await store.setAssignment(
      ENVIRONMENT_ID,
      true,
      "automation",
      AUTOMATION_ID,
      1
    );
    if (!assigned) throw new Error("Planhat assignment not seeded");
  }
}

function discoveryFetch(body: unknown, overrides: { sandboxId?: string } = {}): Promise<Response> {
  return SELF.fetch(`https://test.local/sessions/${sessionId}/planhat-mcp/conversation-discovery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sandboxToken}`,
      "X-Sandbox-ID": overrides.sandboxId ?? sandboxId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Planhat Conversation discovery gateway", () => {
  beforeEach(async () => {
    sequence += 1;
    sessionId = `session-alex-discovery-${sequence}`;
    sandboxId = `sandbox-alex-discovery-${sequence}`;
    sandboxToken = `sandbox-token-alex-discovery-${sequence}`;
    await cleanD1Tables();
    await seedActiveUser(USER_ID);
  });

  it("returns identity-only search candidates to the assigned sandbox", async () => {
    await seed(true);
    const response = await discoveryFetch({
      operation: PLANHAT_DISCOVERY_SEARCH_OPERATION,
      query: "invented discovery query",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      operation: PLANHAT_DISCOVERY_SEARCH_OPERATION,
      model: "Conversation",
      companyId: null,
      candidates: [{ companyId: COMPANY, conversationId: "conversation-discovery-invented" }],
      candidateLimit: 20,
      providerCount: 1,
      returnedCount: 1,
      truncated: false,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private invented communication|invented@example\.test|integration-planhat-(access|refresh|secret)/
    );
  });

  it("returns a bounded Company list to the assigned sandbox", async () => {
    await seed(true);
    const response = await discoveryFetch({
      operation: PLANHAT_DISCOVERY_LIST_OPERATION,
      companyId: COMPANY,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: PLANHAT_DISCOVERY_LIST_OPERATION,
      companyId: COMPANY,
      candidates: [{ companyId: COMPANY, conversationId: "conversation-discovery-invented" }],
    });
  });

  it("denies an unassigned connection before brokerage or provider access", async () => {
    await seed(false);
    const response = await discoveryFetch({
      operation: PLANHAT_DISCOVERY_LIST_OPERATION,
      companyId: COMPANY,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ stage: "assignment" });
  });

  it("rejects generic MCP and caller-selected tools, models, or fields before provider access", async () => {
    await seed(true);
    for (const body of [
      { jsonrpc: "2.0", method: "tools/call", params: { name: "update_model_record" } },
      { operation: PLANHAT_DISCOVERY_SEARCH_OPERATION, query: "x", tool: "search_records" },
      { operation: PLANHAT_DISCOVERY_LIST_OPERATION, companyId: COMPANY, model: "Company" },
      { operation: PLANHAT_DISCOVERY_LIST_OPERATION, companyId: COMPANY, select: ["body"] },
    ]) {
      const response = await discoveryFetch(body);
      expect(response.status).toBe(400);
    }
  });

  it("requires the matching sandbox", async () => {
    await seed(true);
    const response = await discoveryFetch(
      { operation: PLANHAT_DISCOVERY_SEARCH_OPERATION, query: "invented discovery query" },
      { sandboxId: "wrong-sandbox" }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ stage: "sandbox" });
  });
});
