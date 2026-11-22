import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listPlanhatCompanyConversations,
  searchPlanhatConversations,
} from "../../src/planhat/conversation-discovery-transport";
import { handleConversationDiscovery } from "../../src/routes/planhat-conversation-discovery";
import type { SandboxRouteContext } from "../../src/routes/shared";
import type { Env } from "../../src/types";

/**
 * Issue #247 seam: the real platform route and fixed transport (with a stubbed provider) feed the real
 * CS discovery client. Run with `CS_REPO=<built CS checkout>`; skipped otherwise.
 */
const csRepo = process.env.CS_REPO;
const crossRepo = csRepo ? describe : describe.skip;
const COMPANY = "company-invented-247";

function provider(records: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(await request.text()) as { method?: string };
    if (body.method === "initialize") {
      return Response.json(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "mcp-session-invented" } }
      );
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: 2, result: { structuredContent: { records } } });
  });
}

async function csClient(
  env: Record<string, string>,
  records: unknown[],
  gateway: "allow" | "deny" = "allow"
) {
  const providerFetch = provider(records);
  const module = await import(
    pathToFileURL(resolve(csRepo!, "dist/src/open-inspect-planhat-discovery-gateway.js")).href
  );
  const platformFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const outgoing = new Request(input, init);
    const request = new Request(outgoing.url, {
      method: outgoing.method,
      headers: { ...Object.fromEntries(outgoing.headers), "X-Sandbox-ID": "sandbox-invented" },
      body: await outgoing.text(),
    });
    return handleConversationDiscovery(
      request,
      env as unknown as Env,
      { id: "session-invented" },
      {
        principal: { sandboxId: "sandbox-invented" },
        request_id: "r",
        trace_id: "t",
      } as unknown as SandboxRouteContext,
      {
        authorizeSandbox: () => null,
        authorizeGateway: async (..._args: unknown[]) =>
          gateway === "deny"
            ? Response.json(
                { error: "denied", correlationId: "c", stage: "assignment" },
                { status: 403 }
              )
            : {
                accessToken: "access-token-invented",
                environmentId: "environment-invented",
                automationId: null,
                assignmentMode: "slack-environment" as const,
              },
        search: (token: string, request: { query: string }) =>
          searchPlanhatConversations(token, request, providerFetch),
        list: (token: string, request: { companyId: string }) =>
          listPlanhatCompanyConversations(token, request, providerFetch),
        now: () => Date.parse("2026-11-22T00:01:00.000Z"),
      } as never
    );
  };
  const source = module.createConfiguredOpenInspectPlanhatConversationDiscovery(
    {
      CS_PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "true",
      CONTROL_PLANE_URL: "https://control-plane.example",
      SANDBOX_AUTH_TOKEN: "sandbox-token-invented",
      SESSION_CONFIG: JSON.stringify({ sessionId: "session-invented" }),
    },
    platformFetch
  );
  return { source, providerFetch };
}

crossRepo("issue #247 platform route to CS discovery client", () => {
  const enabled = { PLANHAT_CONVERSATION_DISCOVERY_ENABLED: "true" };

  it("delivers identity-only search candidates the CS client accepts", async () => {
    const { source } = await csClient(enabled, [
      { _id: "conversation-a", companyId: COMPANY, body: "invented private body" },
      { _id: "conversation-b", companyId: "company-other-247", subject: "invented" },
    ]);
    const result = await source.searchConversations({ query: "invented renewal" });
    expect(result).toMatchObject({
      operation: "planhat.mcp.search-conversations",
      model: "Conversation",
      companyId: null,
      candidates: [
        { companyId: COMPANY, conversationId: "conversation-a" },
        { companyId: "company-other-247", conversationId: "conversation-b" },
      ],
      truncated: false,
      requestedAt: "2026-11-22T00:01:00.000Z",
    });
    expect(JSON.stringify(result)).not.toMatch(/invented private body|access-token-invented/);
  });

  it("delivers a full Company page with truncation evidence", async () => {
    const records = Array.from({ length: 20 }, (_, index) => ({
      _id: `conversation-${index}`,
      companyId: COMPANY,
    }));
    const { source } = await csClient(enabled, records);
    const result = await source.listCompanyConversations({ companyId: COMPANY });
    expect(result).toMatchObject({ companyId: COMPANY, returnedCount: 20, truncated: true });
  });

  it("surfaces platform identity drift as a CS identity failure", async () => {
    const { source } = await csClient(enabled, [{ _id: "conversation-a", companyId: "company-x" }]);
    await expect(source.listCompanyConversations({ companyId: COMPANY })).rejects.toMatchObject({
      stage: "identity",
    });
  });

  it("surfaces the disabled kill switch without provider work", async () => {
    const { source, providerFetch } = await csClient({}, []);
    await expect(source.searchConversations({ query: "invented" })).rejects.toMatchObject({
      stage: "disabled",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("surfaces authorization denial without provider work", async () => {
    const { source, providerFetch } = await csClient(enabled, [], "deny");
    await expect(source.searchConversations({ query: "invented" })).rejects.toMatchObject({
      stage: "assignment",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
