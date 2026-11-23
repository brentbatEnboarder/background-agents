import { describe, expect, it, vi } from "vitest";
import {
  getExactPlanhatConversation,
  PLANHAT_MCP_OPERATION,
  PLANHAT_MCP_RESPONSE_MAX_BYTES,
  PLANHAT_MCP_NARROW_SELECT,
  PLANHAT_MCP_SELECT,
  PLANHAT_MCP_TRUNCATION_CHARS,
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

  describe("text-free shape of an unparseable read (CS #278)", () => {
    const SECRET = "Invented private body for Dana";
    const record = {
      _id: REQUEST.conversationId,
      companyId: REQUEST.companyId,
      numberOfParts: 1,
      parts: [{ _id: "part-invented", content: SECRET }],
    };
    const rpc = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 2, result });
    const read = async (reply: Response) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(initialize())
        .mockResolvedValueOnce(new Response(null, { status: 202 }))
        .mockResolvedValueOnce(reply)
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const failure = (await getExactPlanhatConversation("token", REQUEST, transport).catch(
        (error: unknown) => error
      )) as PlanhatExactConversationTransportError;
      expect(failure).toBeInstanceOf(PlanhatExactConversationTransportError);
      expect(failure).toMatchObject({ stage: "parse", outcome: "malformed" });
      expect(failure.responseShape).not.toMatch(
        /Invented|Dana|conversation-invented|company-invented/
      );
      return failure.responseShape;
    };

    it("reports an event whose JSON is split across several data lines", async () => {
      // A server may emit one multi-line JSON payload as several `data:` lines of one event.
      const lines = JSON.stringify(
        JSON.parse(rpc({ content: [{ type: "text", text: JSON.stringify(record) }] })),
        null,
        2
      ).split("\n");
      const shape = await read(
        new Response(`event: message\n${lines.map((line) => `data: ${line}`).join("\n")}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      );
      expect(shape).toBe(
        `event-stream(events:1,data-lines:${lines.length},last-event-lines:${lines.length},` +
          "joined-last-event-json:yes):non-json-text(1,starts:brace,ends:brace)"
      );
    });

    it("reports truncated tool text by length and edge classes", async () => {
      const text = JSON.stringify(record);
      const shape = await read(
        Response.json(JSON.parse(rpc({ content: [{ type: "text", text: text.slice(0, -12) }] })))
      );
      expect(shape).toBe(
        `content-text:non-json-text(${text.length - 12},starts:brace,ends:letter)`
      );
    });

    it("reports several content items without their values", async () => {
      const shape = await read(
        Response.json(
          JSON.parse(
            rpc({
              content: [
                { type: "text", text: JSON.stringify(record).slice(0, 29) },
                { type: "text", text: SECRET },
              ],
            })
          )
        )
      );
      expect(shape).toBe(
        "result:{content:array(2)<{type:text,text:non-json-text(29,starts:brace,ends:letter)}," +
          `{type:text,text:non-json-text(${SECRET.length},starts:letter,ends:letter)}>}`
      );
    });

    it("reports a record missing its parts by field names and types only", async () => {
      const { parts: _parts, ...partless } = record;
      const shape = await read(Response.json(JSON.parse(rpc({ structuredContent: partless }))));
      expect(shape).toBe("record:{_id:string(21),companyId:string(16),numberOfParts:number}");
    });
  });

  describe("narrow read after a truncated full read (CS #278)", () => {
    const SECRET = "Invented private body for Dana";
    const part = { _id: "part-invented", content: SECRET, date: "2026-11-18T09:11:00.000Z" };
    const record = {
      _id: REQUEST.conversationId,
      companyId: REQUEST.companyId,
      numberOfParts: 1,
      parts: [part],
    };
    const truncatedText = () =>
      JSON.stringify({
        ...record,
        parts: [{ ...part, content: "x".repeat(PLANHAT_MCP_TRUNCATION_CHARS) }],
      }).slice(0, PLANHAT_MCP_TRUNCATION_CHARS) + "\n[Output truncated]";
    const text = (value: string, id: number) =>
      Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }] } });
    const run = async (...reads: Response[]) => {
      const bodies: Record<string, unknown>[] = [];
      const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        if (body.method === "initialize") return initialize();
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        bodies.push(body);
        return reads.shift() ?? new Response(null, { status: 500 });
      });
      const outcome = await getExactPlanhatConversation("token", REQUEST, transport).catch(
        (error: unknown) => error
      );
      const selects = bodies.map(
        (body) => (body.params as { arguments: { SELECT: unknown } }).arguments.SELECT
      );
      return { outcome, selects, ids: bodies.map((body) => body.id) };
    };

    it("re-reads once with only the needed part fields and returns that record", async () => {
      const { outcome, selects, ids } = await run(
        text(truncatedText(), 2),
        text(JSON.stringify(record), 3)
      );
      expect(selects).toEqual([PLANHAT_MCP_SELECT, PLANHAT_MCP_NARROW_SELECT]);
      expect(ids).toEqual([2, 3]);
      expect(outcome).toMatchObject({
        select: "narrow",
        record: { numberOfParts: 1, parts: [part] },
      });
      const shape = (outcome as { responseShape: string }).responseShape;
      expect(shape).toMatch(
        /^full:content-text:non-json-text\(\d+,starts:brace,ends:bracket\);narrow:parts:1,numberOfParts:number,first:\{_id:string\(13\),content:string\(30\),date:string\(24\)\}$/
      );
      expect(shape).not.toContain("Invented");
    });

    it("fails closed with both shapes when the narrow read is still truncated", async () => {
      const { outcome, selects } = await run(text(truncatedText(), 2), text(truncatedText(), 3));
      expect(selects).toHaveLength(2);
      expect(outcome).toBeInstanceOf(PlanhatExactConversationTransportError);
      expect(outcome).toMatchObject({ stage: "parse", outcome: "malformed", truncated: true });
      expect((outcome as PlanhatExactConversationTransportError).responseShape).toMatch(
        /^full:content-text:non-json-text\(\d+,[^;]+\);narrow:parse\/malformed:content-text:non-json-text\(/
      );
    });

    it("never re-reads after a short unparseable reply or a successful full read", async () => {
      const short = await run(text(JSON.stringify(record).slice(0, 40), 2));
      expect(short.selects).toEqual([PLANHAT_MCP_SELECT]);
      expect(short.outcome).toMatchObject({
        stage: "parse",
        outcome: "malformed",
        truncated: false,
      });

      const full = await run(text(JSON.stringify(record), 2));
      expect(full.selects).toEqual([PLANHAT_MCP_SELECT]);
      expect(full.outcome).toMatchObject({ select: "full" });
    });
  });
});
