import { describe, expect, it, vi } from "vitest";
import {
  inspectPlanhatDiscoverySchema,
  observePlanhatDiscovery,
  PLANHAT_DISCOVERY_MAX_RECORD_COUNT,
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
          inputSchema: {
            type: "object",
            required: ["MODEL", "OBJECT_ID"],
            properties: {
              MODEL: { type: "string" },
              OBJECT_ID: { type: "string" },
              SELECT: { type: "array" },
            },
          },
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

  it("validates fixed exact-get schema and identity without caller-selected arguments", async () => {
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
            _id: "conversation-invented",
            companyId: "company-invented",
            body: "private body",
          },
        },
      });
    });

    const observation = await observePlanhatDiscovery(
      "invented-access-token",
      "planhat.mcp.validate-conversation-get",
      { getCompanyId: "company-invented", getConversationId: "conversation-invented" },
      transport
    );
    const probeCall = JSON.parse(await calls[3].text());
    expect(probeCall.params).toEqual({
      name: "get_model_record",
      arguments: {
        MODEL: "Conversation",
        OBJECT_ID: "conversation-invented",
        SELECT: ["_id", "companyId", "numberOfParts", "parts"],
      },
    });
    expect(observation.response).toMatchObject({ recordCount: 1 });
    expect(JSON.stringify(observation)).not.toMatch(
      /private body|company-invented|conversation-invented/
    );
  });

  it("fails closed when fixed exact-get returns a different identity", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(toolsList())
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: 3,
          result: {
            structuredContent: { _id: "conversation-other", companyId: "company-invented" },
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      observePlanhatDiscovery(
        "invented-access-token",
        "planhat.mcp.validate-conversation-get",
        { getCompanyId: "company-invented", getConversationId: "conversation-invented" },
        transport
      )
    ).rejects.toMatchObject({ stage: "identity", outcome: "malformed" });
  });

  it("replaces provider-controlled object keys with a non-sensitive structural marker", async () => {
    const dynamicKeys = [
      "507f1f77bcf86cd799439011",
      "Acme_Corporation",
      "Brent Pearson <brent.pearson@example.test>",
    ];
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(toolsList())
      .mockResolvedValueOnce(
        Response.json({
          jsonrpc: "2.0",
          id: 3,
          result: {
            structuredContent: {
              records: [
                {
                  _id: "conversation-invented",
                  companyId: "company-invented",
                  parts: [
                    {
                      _id: "part-invented",
                      [dynamicKeys[2]!]: "private body",
                    },
                  ],
                  [dynamicKeys[0]!]: { [dynamicKeys[2]!]: true },
                  [dynamicKeys[1]!]: "customer name",
                },
              ],
            },
          },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const observation = await observePlanhatDiscovery(
      "invented-access-token",
      "planhat.mcp.validate-conversation-search",
      { searchQuery: "invented query" },
      transport
    );

    expect(observation.schema.outputFields).toEqual([
      { path: "$._id", types: ["string"], presenceCount: 1 },
      { path: "$.companyId", types: ["string"], presenceCount: 1 },
      { path: "$.parts", types: ["array"], presenceCount: 1 },
      { path: "$.parts[]", types: ["object"], presenceCount: 1 },
      { path: "$.parts[]._id", types: ["string"], presenceCount: 1 },
      { path: "$.parts[].__dynamic__", types: ["string"], presenceCount: 1 },
      { path: "$.__dynamic__", types: ["object", "string"], presenceCount: 1 },
      { path: "$.__dynamic__.__dynamic__", types: ["boolean"], presenceCount: 1 },
    ]);
    const encoded = JSON.stringify(observation);
    for (const key of dynamicKeys) {
      expect(encoded).not.toContain(key);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(encoded).not.toContain(hex);
    }
    expect(encoded).not.toMatch(/Brent|Pearson|Acme|507f1f77|example\.test|private body/);
  });

  it("rejects a 15,979-byte payload with the demonstrated 2,561-character path", async () => {
    const segment = "a".repeat(127);
    let record: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 20; depth += 1) record = { [segment]: record };
    expect(`$${`.${segment}`.repeat(20)}`).toHaveLength(2_561);

    const makeBody = (padding: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        result: { structuredContent: { records: [record], padding } },
      });
    const empty = makeBody("");
    const encoded = makeBody("p".repeat(15_979 - new TextEncoder().encode(empty).byteLength));
    expect(new TextEncoder().encode(encoded)).toHaveLength(15_979);

    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(toolsList())
      .mockResolvedValueOnce(
        new Response(encoded, { headers: { "content-type": "application/json" } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      observePlanhatDiscovery(
        "invented-access-token",
        "planhat.mcp.validate-conversation-search",
        { searchQuery: "invented query" },
        transport
      )
    ).rejects.toMatchObject({ stage: "parse", outcome: "malformed" });
  });

  it("rejects the compact 100,001-record response before emitting an incompatible count", async () => {
    const encoded = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        structuredContent: {
          records: Array.from({ length: PLANHAT_DISCOVERY_MAX_RECORD_COUNT + 1 }, () => 0),
        },
      },
    });
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(256 * 1024);

    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(toolsList())
      .mockResolvedValueOnce(
        new Response(encoded, { headers: { "content-type": "application/json" } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      observePlanhatDiscovery(
        "invented-access-token",
        "planhat.mcp.validate-conversation-search",
        { searchQuery: "invented query" },
        transport
      )
    ).rejects.toMatchObject({ stage: "parse", outcome: "malformed" });
    expect(transport).toHaveBeenCalledTimes(5);
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

  it("collapses unknown top-level and nested input keys without leaking their values or order", async () => {
    const sensitiveKeys = [
      "Acme_Corporation",
      "507f1f77bcf86cd799439011",
      "brent.pearson@example.test",
      "123_Main_Street_Sydney",
      "BrentPearson",
    ];
    const response = Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "search_records",
            inputSchema: {
              type: "object",
              required: ["MODEL", "QUERY", sensitiveKeys[0], sensitiveKeys[1]],
              properties: {
                [sensitiveKeys[4]!]: { type: "boolean" },
                MODEL: { type: "string" },
                [sensitiveKeys[0]!]: { type: "string" },
                QUERY: {
                  type: "string",
                  required: [sensitiveKeys[2]],
                  properties: {
                    [sensitiveKeys[3]!]: { type: "number" },
                    [sensitiveKeys[2]!]: { type: "string" },
                  },
                },
                [sensitiveKeys[1]!]: { type: "array" },
                LIMIT: { type: "number" },
              },
            },
          },
        ],
      },
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const observation = await inspectPlanhatDiscoverySchema(
      "invented-access-token",
      "planhat.mcp.validate-conversation-search",
      transport
    );

    expect(observation.inputFields).toEqual([
      { path: "$.MODEL", type: "string", required: true },
      { path: "$.QUERY", type: "string", required: true },
      { path: "$.QUERY.__dynamic__", type: "object", required: true },
      { path: "$.LIMIT", type: "number", required: false },
      { path: "$.__dynamic__", type: "object", required: true },
    ]);
    const encoded = JSON.stringify(observation);
    expect(encoded.match(/__dynamic__/g)).toHaveLength(2);
    for (const key of sensitiveKeys) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(encoded).not.toContain(key);
      expect(encoded).not.toContain(encodeURIComponent(key));
      expect(encoded).not.toContain(btoa(key));
      expect(encoded).not.toContain(hex);
    }
    expect(encoded).not.toMatch(/Acme|Brent|507f1f77|example\.test|Main_Street|Sydney/);
  });

  it("rejects required names that do not describe a property instead of misreporting status", async () => {
    const response = Response.json({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          {
            name: "search_records",
            inputSchema: {
              type: "object",
              required: ["MODEL", "Acme_Corporation"],
              properties: { MODEL: { type: "string" }, QUERY: { type: "string" } },
            },
          },
        ],
      },
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(initialize())
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      inspectPlanhatDiscoverySchema(
        "invented-access-token",
        "planhat.mcp.validate-conversation-search",
        transport
      )
    ).rejects.toMatchObject({ stage: "parse", outcome: "malformed" });
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
