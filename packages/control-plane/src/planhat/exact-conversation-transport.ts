export const PLANHAT_MCP_URL = "https://api.planhat.com/v1/mcp";
export const PLANHAT_MCP_OPERATION = "planhat.mcp.get-conversation-messages" as const;
export const PLANHAT_MCP_PROTOCOL_VERSION = "2025-06-18";
export const PLANHAT_MCP_SELECT = ["_id", "companyId", "numberOfParts", "parts"] as const;

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
    public readonly responseBytes?: number
  ) {
    super("Planhat exact Conversation retrieval unavailable");
  }
}

export interface PlanhatExactConversationRequest {
  companyId: string;
  conversationId: string;
}

export interface PlanhatExactConversationResult {
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

function parseJsonRpc(
  body: string,
  contentType: string | null,
  expectedId: number,
  stage: FailureStage,
  responseBytes: number
): JsonRpcResponse {
  let encoded = body;
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    encoded = data.at(-1) ?? "";
  } else if (!contentType?.toLowerCase().includes("application/json")) {
    throw new PlanhatExactConversationTransportError(stage, "malformed", undefined, responseBytes);
  }

  try {
    const value = JSON.parse(encoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const message = value as JsonRpcResponse;
    if (
      message.jsonrpc !== "2.0" ||
      message.id !== expectedId ||
      message.error !== undefined ||
      message.result === undefined
    ) {
      throw new Error();
    }
    return message;
  } catch {
    throw new PlanhatExactConversationTransportError(stage, "malformed", undefined, responseBytes);
  }
}

function projectToolRecord(
  value: unknown,
  request: PlanhatExactConversationRequest,
  responseBytes: number
): PlanhatExactConversationResult["record"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlanhatExactConversationTransportError(
      "parse",
      "malformed",
      undefined,
      responseBytes
    );
  }
  const result = value as Record<string, unknown>;
  if (result.isError === true) {
    throw new PlanhatExactConversationTransportError("read", "provider", undefined, responseBytes);
  }

  let record: unknown = result.structuredContent;
  if (record === undefined) {
    if (!Array.isArray(result.content) || result.content.length !== 1) {
      throw new PlanhatExactConversationTransportError(
        "parse",
        "malformed",
        undefined,
        responseBytes
      );
    }
    const content = result.content[0];
    if (
      !content ||
      typeof content !== "object" ||
      (content as Record<string, unknown>).type !== "text" ||
      typeof (content as Record<string, unknown>).text !== "string"
    ) {
      throw new PlanhatExactConversationTransportError(
        "parse",
        "malformed",
        undefined,
        responseBytes
      );
    }
    try {
      record = JSON.parse((content as Record<string, string>).text);
    } catch {
      throw new PlanhatExactConversationTransportError(
        "parse",
        "malformed",
        undefined,
        responseBytes
      );
    }
  }

  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new PlanhatExactConversationTransportError(
      "parse",
      "malformed",
      undefined,
      responseBytes
    );
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
    throw new PlanhatExactConversationTransportError(
      "parse",
      "malformed",
      undefined,
      responseBytes
    );
  }
  return {
    _id: request.conversationId,
    companyId: request.companyId,
    numberOfParts: structuredClone(source.numberOfParts),
    parts: structuredClone(source.parts),
  };
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

    const response = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, sessionId),
      redirect: "manual",
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_model_record",
          arguments: {
            MODEL: "Conversation",
            OBJECT_ID: request.conversationId,
            SELECT: PLANHAT_MCP_SELECT,
          },
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
      2,
      "parse",
      responseBody.bytes
    );
    return {
      record: projectToolRecord(message.result, request, responseBody.bytes),
      responseBytes: responseBody.bytes,
    };
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
