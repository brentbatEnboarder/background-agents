import { describe, expect, it, vi } from "vitest";
import { PlanhatConversationDiscoveryTransportError } from "../planhat/conversation-discovery-transport";
import type { Env } from "../types";
import type { SandboxRouteContext } from "./shared";
import {
  handleConversationDiscovery,
  PLANHAT_CONVERSATION_DISCOVERY_ENABLED_NAME,
} from "./planhat-conversation-discovery";

const NOW = Date.parse("2026-11-22T00:01:00.000Z");
const ENABLED = { PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "true" } as unknown as Env;
const COMPANY = "company-invented";

const ROUTE_CONTEXT = {
  principal: { sandboxId: "sandbox-invented" },
  request_id: "request-invented",
  trace_id: "trace-invented",
} as unknown as SandboxRouteContext;

function routeRequest(body: unknown): Request {
  return new Request(
    "https://test.local/sessions/session-invented/planhat-mcp/conversation-discovery",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sandbox-ID": "sandbox-invented" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  );
}

const SEARCH = { operation: "planhat.mcp.search-conversations", query: "invented renewal note" };
const LIST = { operation: "planhat.mcp.list-company-conversations", companyId: COMPANY };

function dependencies() {
  return {
    authorizeSandbox: vi.fn(() => null),
    authorizeGateway: vi.fn(
      async (
        ..._args: unknown[]
      ): Promise<
        | Response
        | {
            accessToken: string;
            environmentId: string;
            automationId: string | null;
            assignmentMode: "slack-environment" | "automation";
          }
      > => ({
        accessToken: "invented-access-token",
        environmentId: "environment-invented",
        automationId: null,
        assignmentMode: "slack-environment" as const,
      })
    ),
    search: vi.fn(async () => ({
      candidates: [{ companyId: "company-b", conversationId: "conversation-b" }],
      providerCount: 1,
      responseBytes: 120,
    })),
    list: vi.fn(async () => ({
      candidates: Array.from({ length: 20 }, (_, index) => ({
        companyId: COMPANY,
        conversationId: `conversation-${index}`,
      })),
      providerCount: 20,
      responseBytes: 900,
    })),
    now: vi.fn(() => NOW),
  };
}

async function handle(body: unknown, env: Env = ENABLED, deps = dependencies()) {
  const response = await handleConversationDiscovery(
    routeRequest(body),
    env,
    { id: "session-invented" },
    ROUTE_CONTEXT,
    deps as never
  );
  return { response, deps, body: (await response.json()) as Record<string, unknown> };
}

describe("Planhat Conversation discovery route", () => {
  it("returns identity-only search candidates with model, cutoff, limit, and truncation evidence", async () => {
    const { response, deps, body } = await handle(SEARCH);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      operation: "planhat.mcp.search-conversations",
      model: "Conversation",
      companyId: null,
      candidates: [{ companyId: "company-b", conversationId: "conversation-b" }],
      candidateLimit: 20,
      providerCount: 1,
      returnedCount: 1,
      truncated: false,
      requestedAt: "2026-11-22T00:01:00.000Z",
      correlationId: expect.stringMatching(/^[A-Za-z0-9-]{1,128}$/),
    });
    expect(deps.search).toHaveBeenCalledWith("invented-access-token", {
      query: "invented renewal note",
    });
    expect(deps.list).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("invented renewal note");
    expect(JSON.stringify(body)).not.toContain("invented-access-token");
  });

  it("returns identity-unknown search candidates as companyId null and nothing else (#254)", async () => {
    const deps = dependencies();
    deps.search.mockResolvedValueOnce({
      candidates: [
        { companyId: null, conversationId: "conversation-a" },
        { companyId: "company-b", conversationId: "conversation-b" },
      ] as never,
      providerCount: 2,
      responseBytes: 300,
    });
    const { response, body } = await handle(SEARCH, ENABLED, deps);
    expect(response.status).toBe(200);
    expect(body.candidates).toEqual([
      { companyId: null, conversationId: "conversation-a" },
      { companyId: "company-b", conversationId: "conversation-b" },
    ]);
    expect(body.returnedCount).toBe(2);
  });

  it("fails closed if a list result ever carries a candidate outside the requested Company", async () => {
    const deps = dependencies();
    deps.list.mockResolvedValueOnce({
      candidates: [{ companyId: null, conversationId: "conversation-a" }] as never,
      providerCount: 1,
      responseBytes: 100,
    });
    const { response, body } = await handle(LIST, ENABLED, deps);
    expect(response.status).toBe(502);
    expect(body).not.toHaveProperty("candidates");
  });

  it("returns a Company list and marks a full page as possibly truncated", async () => {
    const { response, deps, body } = await handle(LIST);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      operation: "planhat.mcp.list-company-conversations",
      model: "Conversation",
      companyId: COMPANY,
      candidateLimit: 20,
      providerCount: 20,
      returnedCount: 20,
      truncated: true,
    });
    expect(deps.list).toHaveBeenCalledWith("invented-access-token", { companyId: COMPANY });
    expect(deps.search).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", {}],
    ["empty", { PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "" }],
    ["false", { PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "false" }],
    ["not exactly true", { PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "TRUE" }],
  ])(
    "is disabled when the kill switch is %s, with no brokerage or provider work",
    async (_label, env) => {
      expect(PLANHAT_CONVERSATION_DISCOVERY_ENABLED_NAME).toBe(
        "PLANHAT_CONVERSATION_DISCOVERY_ENABLED"
      );
      const { response, deps, body } = await handle(SEARCH, env as unknown as Env);
      expect(response.status).toBe(403);
      expect(body.stage).toBe("disabled");
      expect(deps.authorizeGateway).not.toHaveBeenCalled();
      expect(deps.search).not.toHaveBeenCalled();
      expect(deps.list).not.toHaveBeenCalled();
    }
  );

  it("rechecks the kill switch immediately before OAuth brokerage", async () => {
    const env = { PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "true" } as Record<string, string>;
    const deps = dependencies();
    let brokered = false;
    deps.authorizeGateway.mockImplementation(async (...args: unknown[]) => {
      env.PLANHAT_CONVERSATION_DISCOVERY_ENABLED = "false";
      const admission = args[6] as { validateBeforeBrokerage?: () => boolean };
      if (!admission?.validateBeforeBrokerage?.()) return new Response(null, { status: 403 });
      brokered = true;
      return {
        accessToken: "invented-access-token",
        environmentId: "environment-invented",
        automationId: null,
        assignmentMode: "slack-environment" as const,
      };
    });
    const response = await handleConversationDiscovery(
      routeRequest(SEARCH),
      env as unknown as Env,
      { id: "session-invented" },
      ROUTE_CONTEXT,
      deps as never
    );
    expect(response.status).toBe(403);
    expect(brokered).toBe(false);
    expect(deps.search).not.toHaveBeenCalled();
  });

  it.each([
    ["caller-selected tool", { ...SEARCH, tool: "update_model_record" }],
    ["caller-selected model", { ...SEARCH, model: "Company" }],
    ["caller-selected fields", { ...LIST, select: ["body"] }],
    ["caller-selected limit", { ...LIST, limit: 2000 }],
    ["caller-selected URL", { ...SEARCH, url: "https://example.invalid/mcp" }],
    ["retry setting", { ...SEARCH, retry: 3 }],
    ["raw JSON-RPC", { jsonrpc: "2.0", method: "tools/call", params: {} }],
    [
      "exact-get operation",
      {
        operation: "planhat.mcp.get-conversation-messages",
        companyId: COMPANY,
        conversationId: "c",
      },
    ],
    ["mutation operation", { operation: "planhat.mcp.update-conversation", companyId: COMPANY }],
    ["search with a Company", { ...SEARCH, companyId: COMPANY }],
    ["list without a Company", { operation: LIST.operation }],
    ["unsafe Company", { ...LIST, companyId: "../company" }],
    ["empty query", { ...SEARCH, query: " " }],
    ["oversized query", { ...SEARCH, query: "q".repeat(501) }],
    ["control-character query", { ...SEARCH, query: "invented\u0007query" }],
    ["invalid JSON", "{"],
  ])("rejects %s before brokerage or provider access", async (_label, body) => {
    const { response, deps } = await handle(body);
    expect(response.status).toBe(400);
    expect(deps.authorizeGateway).not.toHaveBeenCalled();
    expect(deps.search).not.toHaveBeenCalled();
    expect(deps.list).not.toHaveBeenCalled();
  });

  it("rejects an oversized request body before brokerage", async () => {
    const { response, deps } = await handle({ ...SEARCH, query: "q".repeat(5000) });
    expect(response.status).toBe(413);
    expect(deps.authorizeGateway).not.toHaveBeenCalled();
  });

  it("returns the gateway authorization denial without provider access", async () => {
    const deps = dependencies();
    deps.authorizeGateway.mockResolvedValueOnce(
      Response.json({ error: "denied", correlationId: "c", stage: "assignment" }, { status: 403 })
    );
    const { response } = await handle(LIST, ENABLED, deps);
    expect(response.status).toBe(403);
    expect(deps.list).not.toHaveBeenCalled();
  });

  it("rejects a wrong sandbox before reading the body", async () => {
    const deps = dependencies();
    deps.authorizeSandbox.mockReturnValueOnce(
      Response.json({ stage: "sandbox" }, { status: 403 }) as never
    );
    const { response } = await handle(SEARCH, ENABLED, deps);
    expect(response.status).toBe(403);
    expect(deps.authorizeGateway).not.toHaveBeenCalled();
  });

  it.each([
    [new PlanhatConversationDiscoveryTransportError("read", "timeout"), 504, "read"],
    [new PlanhatConversationDiscoveryTransportError("identity", "mismatch"), 502, "identity"],
    [new PlanhatConversationDiscoveryTransportError("parse", "malformed"), 502, "parse"],
    [new Error("provider detail invented-access-token"), 502, "read"],
  ])("sanitizes transport failure %#", async (cause, status, stage) => {
    const deps = dependencies();
    deps.search.mockRejectedValueOnce(cause);
    const { response, body } = await handle(SEARCH, ENABLED, deps);
    expect(response.status).toBe(status);
    expect(Object.keys(body).sort()).toEqual(["correlationId", "error", "stage"]);
    expect(body.stage).toBe(stage);
    expect(JSON.stringify(body)).not.toContain("invented-access-token");
    expect(deps.search).toHaveBeenCalledOnce();
  });

  it("fails closed when a transport result exceeds the candidate limit", async () => {
    const deps = dependencies();
    deps.search.mockResolvedValueOnce({
      candidates: Array.from({ length: 21 }, (_, index) => ({
        companyId: COMPANY,
        conversationId: `conversation-${index}`,
      })),
      providerCount: 21,
      responseBytes: 10,
    });
    const { response, body } = await handle(SEARCH, ENABLED, deps);
    expect(response.status).toBe(502);
    expect(body.stage).toBe("parse");
  });
});
