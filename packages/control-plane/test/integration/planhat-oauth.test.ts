import { beforeEach, describe, expect, it } from "vitest";
import { env, SELF } from "cloudflare:test";
import { decryptToken, hashToken } from "../../src/auth/crypto";
import {
  PlanhatOAuthAuthorizationConflictError,
  PlanhatOAuthConnectionStore,
} from "../../src/db/planhat-oauth-connections";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, sqlDatabase } from "./helpers";

const ENVIRONMENT_ID = "env_planhat_alex";
const AUTOMATION_ID = "automation_planhat_alex";

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

async function seedEnvironment(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO environments
     (id, name, description, prebuild_enabled, channel_associations, created_at, updated_at)
     VALUES (?, ?, NULL, 0, NULL, ?, ?)`
  )
    .bind(ENVIRONMENT_ID, "Alex – Customer Success", now, now)
    .run();
  await new AutomationStore(env.DB).create(automation());
  await env.DB.prepare(
    `INSERT INTO automation_environments
     (automation_id, environment_id, created_at, updated_at) VALUES (?, ?, ?, ?)`
  )
    .bind(AUTOMATION_ID, ENVIRONMENT_ID, now, now)
    .run();
}

async function startConnection(): Promise<{ state: string; response: Record<string, unknown> }> {
  const response = await serviceFetch(
    `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth/connect`,
    {
      method: "POST",
      body: JSON.stringify({
        clientId: "integration-planhat-client",
        clientSecret: "integration-planhat-secret",
        expectedGrant: "conversation-view",
      }),
    }
  );
  expect(response.status).toBe(200);
  const body = await response.json<Record<string, unknown>>();
  const authorizationUrl = new URL(String(body.authorizationUrl));
  return { state: authorizationUrl.searchParams.get("state") ?? "", response: body };
}

describe("Planhat OAuth connection API", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await seedEnvironment();
  });

  it("stores a pending confidential authorization encrypted and returns no secret", async () => {
    const { state, response } = await startConnection();

    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(response).toMatchObject({
      status: "pending",
      environmentId: ENVIRONMENT_ID,
      expectedGrant: "conversation-view",
    });
    expect(JSON.stringify(response)).not.toContain("integration-planhat-secret");
    const row = await env.DB.prepare(
      `SELECT state_hash, client_secret_encrypted, code_verifier_encrypted, redirect_uri
       FROM planhat_oauth_authorizations WHERE environment_id = ?`
    )
      .bind(ENVIRONMENT_ID)
      .first<{
        state_hash: string;
        client_secret_encrypted: string;
        code_verifier_encrypted: string;
        redirect_uri: string;
      }>();
    expect(row?.state_hash).toBe(await hashToken(state));
    expect(row?.client_secret_encrypted).not.toBe("integration-planhat-secret");
    expect(await decryptToken(row?.client_secret_encrypted ?? "", env.TOKEN_ENCRYPTION_KEY)).toBe(
      "integration-planhat-secret"
    );
    const codeVerifier = await decryptToken(
      row?.code_verifier_encrypted ?? "",
      env.TOKEN_ENCRYPTION_KEY
    );
    expect(row?.code_verifier_encrypted).not.toBe(codeVerifier);
    expect(codeVerifier).toMatch(/^[a-f0-9]{64}$/);
    const authorizationUrl = new URL(String(response.authorizationUrl));
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    const expectedChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(expectedChallenge);
    expect(row?.redirect_uri).toBe(
      "https://control.test.local/integrations/planhat/oauth/callback"
    );
  });

  it("completes the callback, keeps assignment disabled, and supports revisioned enablement", async () => {
    const { state } = await startConnection();
    const callback = await SELF.fetch(
      `https://test.local/integrations/planhat/oauth/callback?state=${state}&code=integration-planhat-code`
    );

    expect(callback.status).toBe(200);
    const callbackBody = await callback.json<Record<string, unknown>>();
    expect(callbackBody).toEqual({
      status: "connected",
      environmentId: ENVIRONMENT_ID,
      expectedGrant: "conversation-view",
      assignmentEnabled: false,
    });
    expect(JSON.stringify(callbackBody)).not.toMatch(/access|refresh|secret/i);

    const status = await serviceFetch(
      `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth`
    );
    expect(status.status).toBe(200);
    const statusBody = await status.json<Record<string, unknown>>();
    expect(statusBody).toMatchObject({
      status: "connected",
      environmentId: ENVIRONMENT_ID,
      revision: 1,
      expectedGrant: "conversation-view",
      assignmentEnabled: false,
    });
    expect(statusBody).not.toHaveProperty("clientId");
    expect(statusBody).not.toHaveProperty("clientSecret");
    expect(statusBody).not.toHaveProperty("accessToken");
    expect(statusBody).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(statusBody)).not.toContain("integration-planhat");

    const assignment = await serviceFetch(
      `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth/assignment`,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          assignmentMode: "automation",
          automationId: AUTOMATION_ID,
          revision: 1,
        }),
      }
    );
    expect(assignment.status).toBe(200);
    await expect(assignment.json()).resolves.toMatchObject({
      assignmentEnabled: true,
      assignmentMode: "automation",
      assignedAutomationId: AUTOMATION_ID,
      revision: 2,
    });

    const stale = await serviceFetch(
      `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth/assignment`,
      { method: "PUT", body: JSON.stringify({ enabled: false, revision: 1 }) }
    );
    expect(stale.status).toBe(409);
  });

  it("supports explicit Slack-environment assignment without an automation", async () => {
    const { state } = await startConnection();
    await SELF.fetch(
      `https://test.local/integrations/planhat/oauth/callback?state=${state}&code=integration-planhat-code`
    );

    const assignment = await serviceFetch(
      `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth/assignment`,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          assignmentMode: "slack-environment",
          revision: 1,
        }),
      }
    );

    expect(assignment.status).toBe(200);
    await expect(assignment.json()).resolves.toMatchObject({
      assignmentEnabled: true,
      assignmentMode: "slack-environment",
      assignedAutomationId: null,
      revision: 2,
    });
  });

  it("rejects implicit, mixed, and unknown assignment modes", async () => {
    const { state } = await startConnection();
    await SELF.fetch(
      `https://test.local/integrations/planhat/oauth/callback?state=${state}&code=integration-planhat-code`
    );
    const bodies = [
      { enabled: true, automationId: AUTOMATION_ID, revision: 1 },
      {
        enabled: true,
        assignmentMode: "slack-environment",
        automationId: AUTOMATION_ID,
        revision: 1,
      },
      { enabled: true, assignmentMode: "environment", revision: 1 },
    ];
    for (const body of bodies) {
      const response = await serviceFetch(
        `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth/assignment`,
        { method: "PUT", body: JSON.stringify(body) }
      );
      expect(response.status).toBe(400);
    }
  });

  it("rejects wrong and expired callback state before provider access", async () => {
    const wrong = await SELF.fetch(
      "https://test.local/integrations/planhat/oauth/callback?state=wrong&code=integration-planhat-code"
    );
    expect(wrong.status).toBe(400);

    const store = new PlanhatOAuthConnectionStore(sqlDatabase(env.DB), env.TOKEN_ENCRYPTION_KEY);
    const state = "a".repeat(64);
    await store.beginAuthorization({
      stateHash: await hashToken(state),
      environmentId: ENVIRONMENT_ID,
      clientId: "integration-planhat-client",
      clientSecret: "integration-planhat-secret",
      codeVerifier: "a".repeat(64),
      redirectUri: "https://control.test.local/integrations/planhat/oauth/callback",
      expiresAt: Date.now() + 60_000,
    });
    const expiredAt = Date.now() - 1;
    await env.DB.prepare(
      `UPDATE planhat_oauth_authorizations SET expires_at = ?, created_at = ?
       WHERE environment_id = ?`
    )
      .bind(expiredAt, expiredAt - 1_000, ENVIRONMENT_ID)
      .run();
    const expired = await SELF.fetch(
      `https://test.local/integrations/planhat/oauth/callback?state=${state}&code=integration-planhat-code`
    );
    expect(expired.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT 1 FROM planhat_oauth_authorizations WHERE environment_id = ?")
        .bind(ENVIRONMENT_ID)
        .first()
    ).toBeNull();
  });

  it("keeps an existing connection intact while reconnect authorization is pending", async () => {
    const first = await startConnection();
    await SELF.fetch(
      `https://test.local/integrations/planhat/oauth/callback?state=${first.state}&code=integration-planhat-code`
    );

    const second = await startConnection();
    expect(second.state).not.toBe(first.state);
    const metadata = await new PlanhatOAuthConnectionStore(
      sqlDatabase(env.DB),
      env.TOKEN_ENCRYPTION_KEY
    ).getMetadata(ENVIRONMENT_ID);
    expect(metadata).toMatchObject({ revision: 1, assignmentEnabled: false });
  });

  it("refuses a stale callback after a newer authorization replaces its state", async () => {
    const connectionStore = new PlanhatOAuthConnectionStore(
      sqlDatabase(env.DB),
      env.TOKEN_ENCRYPTION_KEY
    );
    const firstState = "b".repeat(64);
    await connectionStore.beginAuthorization({
      stateHash: await hashToken(firstState),
      environmentId: ENVIRONMENT_ID,
      clientId: "client-old",
      clientSecret: "secret-old",
      codeVerifier: "b".repeat(64),
      redirectUri: "https://control.test.local/integrations/planhat/oauth/callback",
      expiresAt: Date.now() + 60_000,
    });
    const first = await connectionStore.getPendingAuthorization(await hashToken(firstState));
    expect(first).not.toBeNull();

    const secondState = "c".repeat(64);
    await connectionStore.beginAuthorization({
      stateHash: await hashToken(secondState),
      environmentId: ENVIRONMENT_ID,
      clientId: "client-new",
      clientSecret: "secret-new",
      codeVerifier: "c".repeat(64),
      redirectUri: "https://control.test.local/integrations/planhat/oauth/callback",
      expiresAt: Date.now() + 60_000,
    });

    await expect(
      connectionStore.completeAuthorization({
        pending: first!,
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        accessTokenExpiresAt: Date.now() + 3_600_000,
      })
    ).rejects.toBeInstanceOf(PlanhatOAuthAuthorizationConflictError);
    await expect(connectionStore.getMetadata(ENVIRONMENT_ID)).resolves.toBeNull();
    await expect(
      connectionStore.getPendingAuthorization(await hashToken(secondState))
    ).resolves.toMatchObject({ clientId: "client-new" });
  });

  it("disconnects encrypted credentials and pending state without exposing them", async () => {
    const { state } = await startConnection();
    await SELF.fetch(
      `https://test.local/integrations/planhat/oauth/callback?state=${state}&code=integration-planhat-code`
    );

    const response = await serviceFetch(
      `https://test.local/environments/${ENVIRONMENT_ID}/integrations/planhat/oauth`,
      { method: "DELETE" }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "not-connected",
      environmentId: ENVIRONMENT_ID,
    });
    expect(
      await env.DB.prepare("SELECT 1 FROM planhat_oauth_connections WHERE environment_id = ?")
        .bind(ENVIRONMENT_ID)
        .first()
    ).toBeNull();
  });

  it("rejects connection setup for an unknown environment", async () => {
    const response = await serviceFetch(
      "https://test.local/environments/env_missing/integrations/planhat/oauth/connect",
      {
        method: "POST",
        body: JSON.stringify({
          clientId: "integration-planhat-client",
          clientSecret: "integration-planhat-secret",
          expectedGrant: "conversation-view",
        }),
      }
    );
    expect(response.status).toBe(404);
  });
});
