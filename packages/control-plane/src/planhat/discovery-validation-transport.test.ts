import { describe, expect, it, vi } from "vitest";
import {
  inspectPlanhatDiscoverySchema,
  observePlanhatDiscovery,
  PLANHAT_DISCOVERY_SCHEMA_OPERATIONS,
  PlanhatDiscoverySchemaTransportError,
} from "./discovery-validation-transport";

function initialize(): Response {
  return Response.json(
    { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
    { headers: { "mcp-session-id": "schema-session-invented" } }
  );
}

function toolsList(): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: 2,
    result: {
      tools: [
        {
          name: "search_records",
          description: "discarded provider detail",
          inputSchema: {
            type: "object",
            required: ["MODEL", "QUERY"],
            properties: {
              MODEL: { type: "string", description: "discarded" },
              QUERY: { type: "string", examples: ["discarded raw query"] },
              LIMIT: { type: "number" },
            },
          },
        },
        {
          name: "list_model_records",
          inputSchema: { type: "object", properties: { MODEL: { type: "string" } } },
        },
        {
          name: "get_model_record",
          inputSchema: { type: "object", properties: { OBJECT_ID: { type: "string" } } },
        },
        { name: "update_model_record", inputSchema: { type: "object", properties: {} } },
      ],
    },
  });
}

describe("Planhat discovery schema validation transport", () => {
  it("runs one fixed search probe and returns only the text-free observation envelope", async () => {
    const calls: Request[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      if (body.method === "initialize") return initialize();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return toolsList();
      return Response.json({
        jsonrpc: "2.0",
        id: 3,
        result: {
          structuredContent: {
            records: [
              {
                _id: "conversation-invented-a",
                companyId: "company-invented-a",
                body: "invented private body",
                fromAddress: "invented@example.test",
              },
              { _id: "conversation-invented-b", companyId: "company-invented-b" },
            ],
            limit: 20,
            truncated: false,
            nextCursor: null,
          },
        },
      });
    });

    const observation = await observePlanhatDiscovery(
      "invented-access-token",
      "planhat.mcp.validate-conversation-search",
      { searchQuery: "invented private query" },
      transport,
      vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_042).mockReturnValue(1_042)
    );

    expect(observation).toMatchObject({
      observedAt: "1970-01-01T00:00:01.042Z",
      durationMs: 42,
      response: {
        recordCount: 2,
        candidateLimit: 20,
        truncated: false,
        continuationPresent: false,
      },
    });
    expect(observation.response.identityShapes).toHaveLength(2);
    expect(observation.response.identityShapes[0]?.companyIdHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(observation)).not.toMatch(
      /invented private|example\.test|conversation-invented|company-invented|access-token/
    );
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "POST", "DELETE"]);
    const probeCall = JSON.parse(await calls[3].text());
    expect(probeCall).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_records",
        arguments: { MODEL: "Conversation", QUERY: "invented private query" },
      },
    });
  });

  it("keeps list probes fixed to Conversation, bounded company filtering, and no selected fields", async () => {
    const calls: Request[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      if (body.method === "initialize") return initialize();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return toolsList();
      return Response.json({
        jsonrpc: "2.0",
        id: 3,
        result: { structuredContent: { records: [] } },
      });
    });
    await observePlanhatDiscovery(
      "invented-access-token",
      "planhat.mcp.validate-conversation-list",
      { listCompanyId: "company-invented" },
      transport
    );
    const probeCall = JSON.parse(await calls[3].text());
    expect(probeCall.params).toEqual({
      name: "list_model_records",
      arguments: {
        MODEL: "Conversation",
        FILTERS: { companyId: "company-invented" },
        LIMIT: 20,
      },
    });
    expect(JSON.stringify(probeCall)).not.toMatch(/SELECT|update|delete|mutation/i);
  });

  it("inspects only one allowlisted tool and emits structural input metadata", async () => {
    const calls: Request[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      if (body.method === "initialize") return initialize();
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return toolsList();
    });

    const observation = await inspectPlanhatDiscoverySchema(
      "invented-access-token",
      "planhat.mcp.validate-conversation-search",
      transport
    );
    expect(observation).toEqual({
      operation: "planhat.mcp.validate-conversation-search",
      tool: "search_records",
      inputFields: [
        { path: "$.MODEL", type: "string", required: true },
        { path: "$.QUERY", type: "string", required: true },
        { path: "$.LIMIT", type: "number", required: false },
      ],
    });
    expect(JSON.stringify(observation)).not.toMatch(/token|discarded|raw query|update_model/i);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    const schemaCall = JSON.parse(await calls[2].text());
    expect(schemaCall).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });

  it.each(Object.keys(PLANHAT_DISCOVERY_SCHEMA_OPERATIONS))(
    "keeps %s on the fixed schema-inspection sequence",
    async (operation) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(initialize())
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(toolsList())
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(
        inspectPlanhatDiscoverySchema(
          "invented-access-token",
          operation as keyof typeof PLANHAT_DISCOVERY_SCHEMA_OPERATIONS,
          transport
        )
      ).resolves.toMatchObject({ operation });
    }
  );

  it("fails safely on missing, malformed, oversized, timeout, and provider outcomes", async () => {
    const outcomes: Array<
      [string, () => ReturnType<typeof vi.fn>, Partial<PlanhatDiscoverySchemaTransportError>]
    > = [
      [
        "missing tool",
        () =>
          vi
            .fn()
            .mockResolvedValueOnce(initialize())
            .mockResolvedValueOnce(new Response(null, { status: 202 }))
            .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 2, result: { tools: [] } }))
            .mockResolvedValueOnce(new Response(null, { status: 204 })),
        { stage: "schema", outcome: "unsupported" },
      ],
      [
        "malformed",
        () =>
          vi
            .fn()
            .mockResolvedValueOnce(initialize())
            .mockResolvedValueOnce(new Response(null, { status: 202 }))
            .mockResolvedValueOnce(
              new Response("private provider body", {
                headers: { "content-type": "application/json" },
              })
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 })),
        { stage: "parse", outcome: "malformed" },
      ],
      [
        "oversized",
        () =>
          vi
            .fn()
            .mockResolvedValueOnce(initialize())
            .mockResolvedValueOnce(new Response(null, { status: 202 }))
            .mockResolvedValueOnce(
              new Response("{}", {
                headers: {
                  "content-type": "application/json",
                  "content-length": String(256 * 1024 + 1),
                },
              })
            )
            .mockResolvedValueOnce(new Response(null, { status: 204 })),
        { stage: "schema", outcome: "oversized" },
      ],
      [
        "timeout",
        () =>
          vi.fn(async () => {
            throw new DOMException("private timeout", "TimeoutError");
          }),
        { stage: "initialize", outcome: "timeout" },
      ],
      [
        "provider",
        () => vi.fn().mockResolvedValueOnce(new Response("private provider body", { status: 503 })),
        { stage: "initialize", outcome: "provider", statusClass: "5xx" },
      ],
    ];

    for (const [_name, makeTransport, expected] of outcomes) {
      const failure = await inspectPlanhatDiscoverySchema(
        "invented-access-token",
        "planhat.mcp.validate-conversation-search",
        makeTransport() as typeof fetch
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(PlanhatDiscoverySchemaTransportError);
      expect(failure).toMatchObject(expected);
      expect(JSON.stringify(failure)).not.toMatch(/private|invented-access-token/);
    }
  });
});
