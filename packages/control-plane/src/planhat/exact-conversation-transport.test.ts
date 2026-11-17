import { describe, expect, it, vi } from "vitest";
import {
  getExactPlanhatConversation,
  PLANHAT_MCP_OPERATION,
  PLANHAT_MCP_RESPONSE_MAX_BYTES,
  PLANHAT_MCP_SELECT,
  PLANHAT_MCP_URL,
  PlanhatExactConversationTransportError,
} from "./exact-conversation-transport";

const REQUEST = { companyId: "company-invented", conversationId: "conversation-invented" };

function initialize(sessionId = "mcp-session"): Response {
  return Response.json(
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
    { headers: { "mcp-session-id": sessionId } }
  );
}

function toolResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: 2,
    result: {
      structuredContent: {
        _id: REQUEST.conversationId,
        companyId: REQUEST.companyId,
        numberOfParts: 1,
        parts: [{ _id: "part-invented" }],
        unrestricted: "discarded",
        ...overrides,
      },
    },
  });
}

describe("Planhat exact Conversation transport", () => {
  it("performs only the fixed initialize, acknowledgement, read, and cleanup sequence", async () => {
    const calls: Request[] = [];
    const bodies: unknown[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      bodies.push(body);
      if (body.method === "initialize") return initialize();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return toolResponse();
    });

    await expect(
      getExactPlanhatConversation("access-token-invented", REQUEST, transport)
    ).resolves.toMatchObject({
      record: {
        _id: REQUEST.conversationId,
        companyId: REQUEST.companyId,
        numberOfParts: 1,
        parts: [{ _id: "part-invented" }],
      },
    });

    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(calls.every((call) => call.url === PLANHAT_MCP_URL)).toBe(true);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(
      calls
        .slice(0, 3)
        .every((call) => call.headers.get("authorization") === "Bearer access-token-invented")
    ).toBe(true);
    expect(calls[0].headers.get("mcp-session-id")).toBeNull();
    expect(
      calls.slice(1).every((call) => call.headers.get("mcp-session-id") === "mcp-session")
    ).toBe(true);
    const read = bodies[2];
    expect(read).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_model_record",
        arguments: {
          MODEL: "Conversation",
          OBJECT_ID: REQUEST.conversationId,
          SELECT: PLANHAT_MCP_SELECT,
        },
      },
    });
    expect(JSON.stringify(read)).not.toMatch(/list_model|search|update|delete/i);
    expect(PLANHAT_MCP_OPERATION).toBe("planhat.mcp.get-conversation-messages");
  });

  it("accepts a single SSE JSON-RPC result", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    _id: REQUEST.conversationId,
                    companyId: REQUEST.companyId,
                    numberOfParts: 0,
                    parts: [],
                  }),
                },
              ],
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(getExactPlanhatConversation("token", REQUEST, transport)).resolves.toMatchObject({
      record: { numberOfParts: 0, parts: [] },
    });
  });

  it("makes one read attempt and sanitizes provider failures", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response("provider body containing access-token-invented", { status: 503 })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const failure = await getExactPlanhatConversation(
      "access-token-invented",
      REQUEST,
      transport
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(PlanhatExactConversationTransportError);
    expect(failure).toMatchObject({ stage: "read", outcome: "provider", statusClass: "5xx" });
    expect(JSON.stringify(failure)).not.toContain("access-token-invented");
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("rejects provider redirects without following them", async () => {
    const transport = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.invalid/untrusted-mcp" },
      })
    );

    await expect(getExactPlanhatConversation("token", REQUEST, transport)).rejects.toMatchObject({
      stage: "initialize",
      outcome: "provider",
      statusClass: "3xx",
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("fails closed on an oversized read without parsing it", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response("small", {
          headers: { "content-length": String(PLANHAT_MCP_RESPONSE_MAX_BYTES + 1) },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(getExactPlanhatConversation("token", REQUEST, transport)).rejects.toMatchObject({
      stage: "read",
      outcome: "oversized",
    });
  });

  it.each([
    [
      "wrong JSON-RPC id",
      Response.json({ jsonrpc: "2.0", id: 99, result: {} }),
      "parse",
      "malformed",
    ],
    [
      "provider tool error",
      Response.json({ jsonrpc: "2.0", id: 2, result: { isError: true } }),
      "read",
      "provider",
    ],
    ["wrong Conversation", toolResponse({ _id: "conversation-other" }), "identity", "mismatch"],
    ["wrong Company", toolResponse({ companyId: "company-other" }), "identity", "mismatch"],
  ])("rejects %s", async (_label, response, stage, outcome) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(getExactPlanhatConversation("token", REQUEST, transport)).rejects.toMatchObject({
      stage,
      outcome,
    });
  });

  it("classifies a timeout without exposing its cause", async () => {
    const transport = vi.fn(async () => {
      throw new DOMException("upstream detail", "TimeoutError");
    });
    const failure = await getExactPlanhatConversation("token", REQUEST, transport).catch(
      (error) => error
    );
    expect(failure).toMatchObject({ stage: "initialize", outcome: "timeout" });
    expect(JSON.stringify(failure)).not.toContain("upstream detail");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects an unsafe provider session header before acknowledgement", async () => {
    const transport = vi.fn().mockResolvedValueOnce(initialize("s".repeat(257)));
    await expect(getExactPlanhatConversation("token", REQUEST, transport)).rejects.toMatchObject({
      stage: "initialize",
      outcome: "malformed",
    });
    expect(transport).toHaveBeenCalledOnce();
  });
});
