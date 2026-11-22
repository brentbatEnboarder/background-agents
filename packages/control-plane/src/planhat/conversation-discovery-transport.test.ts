import { describe, expect, it, vi } from "vitest";
import { PLANHAT_MCP_URL } from "./exact-conversation-transport";
import {
  listPlanhatCompanyConversations,
  PLANHAT_DISCOVERY_CANDIDATE_LIMIT,
  PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES,
  PlanhatConversationDiscoveryTransportError,
  searchPlanhatConversations,
} from "./conversation-discovery-transport";

const COMPANY = "company-invented";

function initialize(sessionId = "mcp-session"): Response {
  return Response.json(
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
    { headers: { "mcp-session-id": sessionId } }
  );
}

function toolResult(structuredContent: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: 2, result: { structuredContent } });
}

function record(id: string, companyId = COMPANY, extra: Record<string, unknown> = {}) {
  return { _id: id, companyId, subject: "invented subject", body: "invented body", ...extra };
}

function sequence(read: Response) {
  return vi
    .fn()
    .mockResolvedValueOnce(initialize())
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(read)
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
}

function recordingTransport(read: () => Response) {
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
    return read();
  });
  return { calls, bodies, transport };
}

describe("Planhat Conversation discovery transport", () => {
  it("searches with only the sealed MODEL and QUERY arguments and projects identity only", async () => {
    const { calls, bodies, transport } = recordingTransport(() =>
      toolResult({ records: [record("conversation-a"), record("conversation-b", "company-b")] })
    );

    const result = await searchPlanhatConversations(
      "access-token-invented",
      { query: "invented renewal question" },
      transport
    );

    expect(result).toEqual({
      candidates: [
        { companyId: COMPANY, conversationId: "conversation-a" },
        { companyId: "company-b", conversationId: "conversation-b" },
      ],
      providerCount: 2,
      responseBytes: expect.any(Number),
    });
    expect(JSON.stringify(result)).not.toContain("invented body");
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(calls.every((call) => call.url === PLANHAT_MCP_URL)).toBe(true);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(bodies[2]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search_records",
        arguments: { MODEL: "Conversation", QUERY: "invented renewal question" },
      },
    });
  });

  it("lists one Company with the sealed MODEL, companyId filter, and LIMIT 20", async () => {
    const { bodies, transport } = recordingTransport(() =>
      toolResult([record("conversation-a"), record("conversation-a"), record("conversation-c")])
    );

    const result = await listPlanhatCompanyConversations(
      "access-token-invented",
      { companyId: COMPANY },
      transport
    );

    expect(PLANHAT_DISCOVERY_CANDIDATE_LIMIT).toBe(20);
    expect(bodies[2]).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "list_model_records",
        arguments: { MODEL: "Conversation", FILTERS: { companyId: COMPANY }, LIMIT: 20 },
      },
    });
    expect(result.candidates).toEqual([
      { companyId: COMPANY, conversationId: "conversation-a" },
      { companyId: COMPANY, conversationId: "conversation-c" },
    ]);
    expect(result.providerCount).toBe(3);
  });

  it("accepts a single SSE text-content result", async () => {
    const transport = sequence(
      new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              { type: "text", text: JSON.stringify({ results: [record("conversation-a")] }) },
            ],
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    await expect(
      searchPlanhatConversations("token", { query: "invented" }, transport)
    ).resolves.toMatchObject({
      candidates: [{ companyId: COMPANY, conversationId: "conversation-a" }],
    });
  });

  it("keeps at most the candidate limit while reporting the provider count", async () => {
    const records = Array.from({ length: 25 }, (_, index) => record(`conversation-${index}`));
    const result = await searchPlanhatConversations(
      "token",
      { query: "invented" },
      sequence(toolResult({ items: records }))
    );
    expect(result.candidates).toHaveLength(20);
    expect(result.providerCount).toBe(25);
  });

  it("fails list identity drift when any record belongs to another Company", async () => {
    await expect(
      listPlanhatCompanyConversations(
        "token",
        { companyId: COMPANY },
        sequence(toolResult([record("conversation-a"), record("conversation-b", "company-other")]))
      )
    ).rejects.toMatchObject({ stage: "identity", outcome: "mismatch" });
  });

  it("fails search identity drift when one Conversation appears under two Companies", async () => {
    await expect(
      searchPlanhatConversations(
        "token",
        { query: "invented" },
        sequence(toolResult([record("conversation-a"), record("conversation-a", "company-other")]))
      )
    ).rejects.toMatchObject({ stage: "identity", outcome: "mismatch" });
  });

  it.each([
    ["missing _id", { data: [{ companyId: COMPANY }] }],
    ["missing companyId", { data: [{ _id: "conversation-a" }] }],
    ["non-string identity", { data: [{ _id: 7, companyId: COMPANY }] }],
    ["unsafe identity", { data: [{ _id: "../conversation", companyId: COMPANY }] }],
    ["record that is not an object", { data: ["conversation-a"] }],
    ["envelope without a record array", { total: 1 }],
    ["scalar payload", "conversation-a"],
  ])("fails closed on schema drift: %s", async (_label, payload) => {
    await expect(
      searchPlanhatConversations("token", { query: "invented" }, sequence(toolResult(payload)))
    ).rejects.toMatchObject({ stage: "parse", outcome: "malformed" });
  });

  it("reports an unparseable reply's structure without any of its values (#254)", async () => {
    const secretText = "Invented Customer said something private";
    const reply = Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          { type: "text", text: secretText },
          {
            type: "text",
            text: JSON.stringify({ hits: [{ id: "x", score: 1, title: secretText }], total: 1 }),
          },
        ],
      },
    });
    const error = await searchPlanhatConversations(
      "token",
      { query: "invented" },
      sequence(reply)
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanhatConversationDiscoveryTransportError);
    const shape = (error as PlanhatConversationDiscoveryTransportError).responseShape ?? "";
    expect(shape).toBe("{content:array(2)<{type:string(4),text:non-json-text(40)}>}");
    expect(shape).not.toContain("Invented");
  });

  it("reports a JSON-text payload's field names when no record array is recognised (#254)", async () => {
    const reply = Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ hits: [{ id: "x", score: 1, "Private Name": "y" }] }),
          },
        ],
      },
    });
    const error = (await searchPlanhatConversations(
      "token",
      { query: "invented" },
      sequence(reply)
    ).catch((caught: unknown) => caught)) as PlanhatConversationDiscoveryTransportError;
    expect(error.stage).toBe("parse");
    expect(error.responseShape).toBe("{hits:array(1)<{id:string(1),score:number,?:string(1)}>}");
  });

  it("returns an empty candidate set for an empty record array", async () => {
    await expect(
      searchPlanhatConversations("token", { query: "invented" }, sequence(toolResult([])))
    ).resolves.toMatchObject({ candidates: [], providerCount: 0 });
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "q".repeat(501)],
    ["control character", "invented\u0000query"],
    ["not a string", 7 as unknown as string],
  ])("rejects a %s query before provider access", async (_label, query) => {
    const transport = vi.fn();
    await expect(searchPlanhatConversations("token", { query }, transport)).rejects.toBeInstanceOf(
      PlanhatConversationDiscoveryTransportError
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an unsafe Company identity before provider access", async () => {
    const transport = vi.fn();
    await expect(
      listPlanhatCompanyConversations("token", { companyId: "../company" }, transport)
    ).rejects.toMatchObject({ stage: "identity", outcome: "mismatch" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fails closed on a read larger than 256 KiB", async () => {
    expect(PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES).toBe(256 * 1024);
    await expect(
      searchPlanhatConversations(
        "token",
        { query: "invented" },
        sequence(
          new Response("x".repeat(PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES + 1), {
            headers: { "content-type": "application/json" },
          })
        )
      )
    ).rejects.toMatchObject({ stage: "read", outcome: "oversized" });
  });

  it("makes one attempt and sanitizes a provider failure", async () => {
    const transport = sequence(
      new Response("provider body containing access-token-invented", { status: 503 })
    );
    const failure = await searchPlanhatConversations(
      "access-token-invented",
      { query: "invented" },
      transport
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(PlanhatConversationDiscoveryTransportError);
    expect(failure).toMatchObject({ stage: "read", outcome: "provider", statusClass: "5xx" });
    expect(JSON.stringify(failure)).not.toContain("access-token-invented");
    expect(String(failure.message)).not.toContain("access-token-invented");
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("maps a provider tool error to a sanitized provider failure", async () => {
    await expect(
      searchPlanhatConversations(
        "token",
        { query: "invented" },
        sequence(Response.json({ jsonrpc: "2.0", id: 2, result: { isError: true } }))
      )
    ).rejects.toMatchObject({ stage: "read", outcome: "provider" });
  });

  it("rejects provider redirects without following them", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://example.invalid/mcp" } })
      );
    await expect(
      listPlanhatCompanyConversations("token", { companyId: COMPANY }, transport)
    ).rejects.toMatchObject({ stage: "initialize", outcome: "provider", statusClass: "3xx" });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("classifies a timeout without exposing its cause or retrying", async () => {
    const transport = vi.fn(async () => {
      throw new DOMException("upstream detail", "TimeoutError");
    });
    const failure = await searchPlanhatConversations(
      "token",
      { query: "invented" },
      transport
    ).catch((error) => error);
    expect(failure).toMatchObject({ stage: "initialize", outcome: "timeout" });
    expect(JSON.stringify(failure)).not.toContain("upstream detail");
    expect(transport).toHaveBeenCalledOnce();
  });
});
