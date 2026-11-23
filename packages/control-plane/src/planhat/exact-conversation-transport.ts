import { describeResponseShape, shapeOf } from "./response-shape";

export const PLANHAT_MCP_URL = "https://api.planhat.com/v1/mcp";
export const PLANHAT_MCP_OPERATION = "planhat.mcp.get-conversation-messages" as const;
export const PLANHAT_MCP_PROTOCOL_VERSION = "2025-06-18";
export const PLANHAT_MCP_SELECT = ["_id", "companyId", "numberOfParts", "parts"] as const;
/**
 * CS #278: Planhat caps one MCP tool reply at about 100,000 characters, so a long thread's full `parts`
 * arrives truncated. Only after that signature does the gateway make one narrower read, selecting just
 * the part fields the CS normalizer and attachment projection read. Whether Planhat honours dotted
 * sub-field selection is what this read establishes; the CS side still validates every part.
 */
export const PLANHAT_MCP_NARROW_SELECT = [
  "_id",
  "companyId",
  "numberOfParts",
  "parts._id",
  "parts.messageId",
  "parts.conversationId",
  "parts.date",
  "parts.fromAddress",
  "parts.toAddresses",
  "parts.ccAddresses",
  "parts.content",
  "parts.type",
  "parts.gmailMessageId",
  "parts.attachments.name",
  "parts.attachments.fileName",
  "parts.attachments.filename",
  "parts.attachments.mimeType",
  "parts.attachments.contentType",
] as const;
/** Tool text at or above this length that is not JSON is treated as provider truncation (CS #278). */
export const PLANHAT_MCP_TRUNCATION_CHARS = 100_000;

export const PLANHAT_MCP_REQUEST_TIMEOUT_MS = 30_000;
export const PLANHAT_MCP_CLEANUP_TIMEOUT_MS = 5_000;
export const PLANHAT_MCP_INITIALIZE_MAX_BYTES = 64 * 1024;
export const PLANHAT_MCP_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;

type FailureStage = "initialize" | "acknowledge" | "read" | "parse" | "identity";
type FailureOutcome = "provider" | "timeout" | "oversized" | "malformed" | "mismatch";

export class PlanhatExactConversationTransportError extends Error {
  constructor(
    public readonly stage: FailureStage,
    public readonly outcome: FailureOutcome,
    public readonly statusClass?: string,
    public readonly responseBytes?: number,
    /** Text-free structure of an unparseable reply: framing, lengths, field names and types (CS #278). */
    public readonly responseShape?: string,
    /** The tool text looked truncated at Planhat's reply cap (CS #278). */
    public readonly truncated = false
  ) {
    super("Planhat exact Conversation retrieval unavailable");
  }
}

export interface PlanhatExactConversationRequest {
  companyId: string;
  conversationId: string;
}

export interface PlanhatExactConversationResult {
  /** Which field selection produced the record: the reviewed full read or the narrow fallback (CS #278). */
  select: "full" | "narrow";
  /** Text-free evidence for a narrow read: earlier full-read shape and the narrow record's part shape. */
  responseShape?: string;
  record: {
    _id: string;
    companyId: string;
    numberOfParts: unknown;
    parts: unknown;
  };
  responseBytes: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function headers(accessToken: string, sessionId: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": PLANHAT_MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
}

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function isTimeout(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
  );
}

async function readBounded(
  response: Response,
  limit: number,
  stage: FailureStage
): Promise<{ body: string; bytes: number }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new PlanhatExactConversationTransportError(stage, "oversized", undefined, declaredLength);
  }

  const reader = response.body?.getReader();
  if (!reader) return { body: "", bytes: 0 };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new PlanhatExactConversationTransportError(stage, "oversized", undefined, bytes);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return { body, bytes };
  } catch (error) {
    if (error instanceof PlanhatExactConversationTransportError) throw error;
    throw new PlanhatExactConversationTransportError(stage, "malformed", undefined, bytes);
  }
}

function malformed(stage: FailureStage, responseBytes: number, responseShape: string): never {
  throw new PlanhatExactConversationTransportError(
    stage,
    "malformed",
    undefined,
    responseBytes,
    responseShape.length > 1500 ? `${responseShape.slice(0, 1500)}…` : responseShape
  );
}

/** Character class of a text's first or last non-blank character, never the character itself. */
function edgeClass(text: string, edge: "start" | "end"): string {
  const trimmed = text.trim();
  const character = edge === "start" ? trimmed.at(0) : trimmed.at(-1);
  switch (character) {
    case undefined:
      return "none";
    case "{":
    case "}":
      return "brace";
    case "[":
    case "]":
      return "bracket";
    case '"':
      return "quote";
    default:
      return /[0-9]/.test(character) ? "digit" : /[A-Za-z]/.test(character) ? "letter" : "other";
  }
}

/** Describes non-JSON text by length and edge classes only, so truncation is distinguishable (CS #278). */
function nonJsonText(text: string): string {
  return `non-json-text(${text.length},starts:${edgeClass(text, "start")},ends:${edgeClass(text, "end")})`;
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Event-stream framing evidence: how many events and `data:` lines arrived, and whether the last
 * event's data lines joined per the SSE rules would parse when the last line alone does not.
 */
function eventStreamFraming(body: string): { encoded: string; framing: string } {
  const events = body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
    )
    .filter((data) => data.length > 0);
  const data = events.flat().map((line) => line.trim());
  const encoded = data.at(-1) ?? "";
  const joined = events.at(-1)?.join("\n") ?? "";
  return {
    encoded,
    framing:
      `event-stream(events:${events.length},data-lines:${data.length},` +
      `last-event-lines:${events.at(-1)?.length ?? 0},joined-last-event-json:${parses(joined) ? "yes" : "no"})`,
  };
}

function parseJsonRpc(
  body: string,
  contentType: string | null,
  expectedId: number,
  stage: FailureStage,
  responseBytes: number
): JsonRpcResponse {
  let encoded = body;
  let framing = "json";
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    ({ encoded, framing } = eventStreamFraming(body));
  } else if (!contentType?.toLowerCase().includes("application/json")) {
    const mediaType = /^[a-z]+\/[a-z0-9.+-]+/.exec(contentType?.toLowerCase() ?? "")?.[0] ?? "none";
    malformed(stage, responseBytes, `content-type:${mediaType}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    malformed(stage, responseBytes, `${framing}:${nonJsonText(encoded)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    malformed(stage, responseBytes, `${framing}:${shapeOf(value)}`);
  }
  const message = value as JsonRpcResponse;
  if (
    message.jsonrpc !== "2.0" ||
    message.id !== expectedId ||
    message.error !== undefined ||
    message.result === undefined
  ) {
    malformed(stage, responseBytes, `${framing}:${shapeOf(value)}`);
  }
  return message;
}

function projectToolRecord(
  value: unknown,
  request: PlanhatExactConversationRequest,
  responseBytes: number
): PlanhatExactConversationResult["record"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    malformed("parse", responseBytes, `result:${shapeOf(value)}`);
  }
  const result = value as Record<string, unknown>;
  if (result.isError === true) {
    throw new PlanhatExactConversationTransportError("read", "provider", undefined, responseBytes);
  }

  let record: unknown = result.structuredContent;
  if (record === undefined) {
    const content = Array.isArray(result.content) ? result.content : [];
    const only = content.length === 1 ? (content[0] as unknown) : undefined;
    if (
      !only ||
      typeof only !== "object" ||
      (only as Record<string, unknown>).type !== "text" ||
      typeof (only as Record<string, unknown>).text !== "string"
    ) {
      malformed("parse", responseBytes, `result:${contentShape(result)}`);
    }
    const text = (only as Record<string, string>).text;
    try {
      record = JSON.parse(text);
    } catch {
      throw new PlanhatExactConversationTransportError(
        "parse",
        "malformed",
        undefined,
        responseBytes,
        `content-text:${nonJsonText(text)}`,
        text.length >= PLANHAT_MCP_TRUNCATION_CHARS
      );
    }
  }

  if (!record || typeof record !== "object" || Array.isArray(record)) {
    malformed("parse", responseBytes, `record:${shapeOf(record)}`);
  }
  const source = record as Record<string, unknown>;
  if (source._id !== request.conversationId || source.companyId !== request.companyId) {
    throw new PlanhatExactConversationTransportError(
      "identity",
      "mismatch",
      undefined,
      responseBytes
    );
  }
  if (!("numberOfParts" in source) || !("parts" in source)) {
    malformed("parse", responseBytes, `record:${shapeOf(source)}`);
  }
  return {
    _id: request.conversationId,
    companyId: request.companyId,
    numberOfParts: structuredClone(source.numberOfParts),
    parts: structuredClone(source.parts),
  };
}

/** Part count and the first part's field names and value types; never values (CS #278). */
function partShape(record: PlanhatExactConversationResult["record"]): string {
  const parts = Array.isArray(record.parts) ? record.parts : [];
  return `parts:${Array.isArray(record.parts) ? parts.length : "?"},numberOfParts:${typeof record.numberOfParts},first:${shapeOf(parts[0])}`;
}

/** Result shape with every text content item described by length and edges, never parsed values. */
function contentShape(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return describeResponseShape(result);
  const items = result.content.slice(0, 5).map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      return describeResponseShape(item);
    const entry = item as Record<string, unknown>;
    return typeof entry.text === "string"
      ? `{type:${typeof entry.type === "string" && /^[a-z_-]{1,20}$/.test(entry.type) ? entry.type : "?"},` +
          `text:${parses(entry.text) ? `json(${entry.text.length})` : nonJsonText(entry.text)}}`
      : describeResponseShape(entry);
  });
  return `{content:array(${result.content.length})<${items.join(",")}>}`;
}

export async function getExactPlanhatConversation(
  accessToken: string,
  request: PlanhatExactConversationRequest,
  transport: typeof fetch = fetch
): Promise<PlanhatExactConversationResult> {
  let sessionId: string | null = null;
  const signal = AbortSignal.timeout(PLANHAT_MCP_REQUEST_TIMEOUT_MS);
  try {
    const initialize = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, null),
      redirect: "manual",
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PLANHAT_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "alex-cs-exact-conversation-gateway", version: "1.0.0" },
        },
      }),
    });
    if (!initialize.ok) {
      throw new PlanhatExactConversationTransportError(
        "initialize",
        "provider",
        statusClass(initialize.status)
      );
    }
    const initializeBody = await readBounded(
      initialize,
      PLANHAT_MCP_INITIALIZE_MAX_BYTES,
      "initialize"
    );
    parseJsonRpc(
      initializeBody.body,
      initialize.headers.get("content-type"),
      1,
      "initialize",
      initializeBody.bytes
    );
    const candidateSessionId = initialize.headers.get("mcp-session-id");
    if (candidateSessionId !== null) {
      if (!/^[\x21-\x7e]{1,256}$/.test(candidateSessionId)) {
        throw new PlanhatExactConversationTransportError("initialize", "malformed");
      }
      sessionId = candidateSessionId;
    }

    const acknowledgement = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, sessionId),
      redirect: "manual",
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    if (!acknowledgement.ok) {
      throw new PlanhatExactConversationTransportError(
        "acknowledge",
        "provider",
        statusClass(acknowledgement.status)
      );
    }

    const readRecord = async (id: number, select: readonly string[]) => {
      const response = await transport(PLANHAT_MCP_URL, {
        method: "POST",
        headers: headers(accessToken, sessionId),
        redirect: "manual",
        signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "get_model_record",
            arguments: { MODEL: "Conversation", OBJECT_ID: request.conversationId, SELECT: select },
          },
        }),
      });
      if (!response.ok) {
        throw new PlanhatExactConversationTransportError(
          "read",
          "provider",
          statusClass(response.status)
        );
      }
      const responseBody = await readBounded(response, PLANHAT_MCP_RESPONSE_MAX_BYTES, "read");
      const message = parseJsonRpc(
        responseBody.body,
        response.headers.get("content-type"),
        id,
        "parse",
        responseBody.bytes
      );
      return {
        record: projectToolRecord(message.result, request, responseBody.bytes),
        responseBytes: responseBody.bytes,
      };
    };

    try {
      return { ...(await readRecord(2, PLANHAT_MCP_SELECT)), select: "full" };
    } catch (error) {
      if (!(error instanceof PlanhatExactConversationTransportError) || !error.truncated)
        throw error;
      const full = `full:${error.responseShape ?? "?"}`;
      try {
        const narrow = await readRecord(3, PLANHAT_MCP_NARROW_SELECT);
        return {
          ...narrow,
          select: "narrow",
          responseShape: `${full};narrow:${partShape(narrow.record)}`,
        };
      } catch (narrowError) {
        const cause =
          narrowError instanceof PlanhatExactConversationTransportError
            ? narrowError
            : new PlanhatExactConversationTransportError(
                "read",
                isTimeout(narrowError) ? "timeout" : "provider"
              );
        throw new PlanhatExactConversationTransportError(
          cause.stage,
          cause.outcome,
          cause.statusClass,
          cause.responseBytes,
          `${full};narrow:${cause.stage}/${cause.outcome}:${cause.responseShape ?? "-"}`.slice(
            0,
            1500
          ),
          cause.truncated
        );
      }
    }
  } catch (error) {
    if (error instanceof PlanhatExactConversationTransportError) throw error;
    throw new PlanhatExactConversationTransportError(
      sessionId === null ? "initialize" : "read",
      isTimeout(error) ? "timeout" : "provider"
    );
  } finally {
    if (sessionId) {
      await transport(PLANHAT_MCP_URL, {
        method: "DELETE",
        headers: headers(accessToken, sessionId),
        redirect: "manual",
        signal: AbortSignal.timeout(PLANHAT_MCP_CLEANUP_TIMEOUT_MS),
      }).catch(() => undefined);
    }
  }
}
