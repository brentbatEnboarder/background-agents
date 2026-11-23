/**
 * Fixed Planhat Conversation discovery transport (issue #247).
 *
 * Exactly two purpose-specific MCP calls are possible here, each with the argument shape sealed by the
 * issue #246 validation:
 * - search: `search_records {MODEL:"Conversation", QUERY}` (no LIMIT; #246 never sent one);
 * - list:   `list_model_records {MODEL:"Conversation", FILTERS:{companyId}, LIMIT:20}`.
 * Exact-get remains `getExactPlanhatConversation`.
 *
 * Projection limitation: each candidate carries only `{companyId, conversationId}` taken from
 * `companyId` and `_id`. Live search hits (#254) were observed as `{_id, type, subject, snippet, model}`
 * with no `companyId`; such a search candidate has `companyId: null`. List records always carry it. Every other provider field is dropped here and never forwarded. Type, date, subject and
 * participants must be filled by the application through exact-get or its approved REST read until a
 * reviewed observation adds them to `PLANHAT_DISCOVERY_CANDIDATE_FIELDS`.
 */
import {
  PLANHAT_MCP_CLEANUP_TIMEOUT_MS,
  PLANHAT_MCP_INITIALIZE_MAX_BYTES,
  PLANHAT_MCP_PROTOCOL_VERSION,
  PLANHAT_MCP_REQUEST_TIMEOUT_MS,
  PLANHAT_MCP_URL,
} from "./exact-conversation-transport";
import { describeResponseShape, shapeOf } from "./response-shape";

export { describeResponseShape };

export const PLANHAT_DISCOVERY_SEARCH_OPERATION = "planhat.mcp.search-conversations" as const;
export const PLANHAT_DISCOVERY_LIST_OPERATION = "planhat.mcp.list-company-conversations" as const;
export type PlanhatConversationDiscoveryOperation =
  | typeof PLANHAT_DISCOVERY_SEARCH_OPERATION
  | typeof PLANHAT_DISCOVERY_LIST_OPERATION;

export const PLANHAT_DISCOVERY_CANDIDATE_LIMIT = 20;
export const PLANHAT_DISCOVERY_QUERY_MAX_LENGTH = 500;
export const PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES = 256 * 1024;
export const PLANHAT_DISCOVERY_CANDIDATE_FIELDS = ["companyId", "conversationId"] as const;
export const SAFE_PLANHAT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;

const RECORD_ARRAY_KEYS = ["records", "results", "items", "data"] as const;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type FailureStage = "request" | "initialize" | "acknowledge" | "read" | "parse" | "identity";
type FailureOutcome = "invalid" | "provider" | "timeout" | "oversized" | "malformed" | "mismatch";

export class PlanhatConversationDiscoveryTransportError extends Error {
  constructor(
    public readonly stage: FailureStage,
    public readonly outcome: FailureOutcome,
    public readonly statusClass?: string,
    public readonly responseBytes?: number,
    /** Text-free structure of an unparseable provider reply: field names and value types only (#254). */
    public readonly responseShape?: string
  ) {
    super("Planhat Conversation discovery unavailable");
  }
}

export interface PlanhatConversationCandidate {
  /** Null only for a search hit the provider returned without a Company identity (#254). */
  companyId: string | null;
  conversationId: string;
}

export interface PlanhatConversationDiscoveryResult {
  candidates: PlanhatConversationCandidate[];
  /** Records the provider returned before deduplication and the candidate cap. */
  providerCount: number;
  responseBytes: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

function fail(
  stage: FailureStage,
  outcome: FailureOutcome,
  statusClass?: string,
  responseBytes?: number,
  responseShape?: string
): never {
  throw new PlanhatConversationDiscoveryTransportError(
    stage,
    outcome,
    statusClass,
    responseBytes,
    responseShape
  );
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(
  response: Response,
  limit: number,
  stage: FailureStage
): Promise<{ body: string; bytes: number }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    fail(stage, "oversized", undefined, declaredLength);
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
        await reader.cancel().catch(() => undefined);
        fail(stage, "oversized", undefined, bytes);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return { body, bytes };
  } catch (error) {
    if (error instanceof PlanhatConversationDiscoveryTransportError) throw error;
    fail(stage, "malformed", undefined, bytes);
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
  let framing = "json";
  if (contentType?.toLowerCase().includes("text/event-stream")) {
    const data = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    encoded = data.at(-1) ?? "";
    framing = `event-stream(data-lines:${data.length})`;
  } else if (!contentType?.toLowerCase().includes("application/json")) {
    const mediaType = /^[a-z]+\/[a-z0-9.+-]+/.exec(contentType?.toLowerCase() ?? "")?.[0] ?? "none";
    fail(stage, "malformed", undefined, responseBytes, `content-type:${mediaType}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    fail(stage, "malformed", undefined, responseBytes, `${framing}:non-json(${encoded.length})`);
  }
  if (!isObject(value)) fail(stage, "malformed", undefined, responseBytes, shapeOf(value));
  const message = value as unknown as JsonRpcResponse;
  if (
    message.jsonrpc !== "2.0" ||
    message.id !== expectedId ||
    message.error !== undefined ||
    message.result === undefined
  ) {
    fail(stage, "malformed", undefined, responseBytes, shapeOf(value));
  }
  return message;
}

function toolPayload(result: unknown, responseBytes: number): unknown {
  if (!isObject(result)) fail("parse", "malformed", undefined, responseBytes, shapeOf(result));
  if (result.isError === true) fail("read", "provider", undefined, responseBytes);
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const only = content.length === 1 ? content[0] : undefined;
  if (!isObject(only) || only.type !== "text" || typeof only.text !== "string") {
    fail("parse", "malformed", undefined, responseBytes, shapeOf(result));
  }
  try {
    return JSON.parse(only.text) as unknown;
  } catch {
    fail("parse", "malformed", undefined, responseBytes, shapeOf(result));
  }
}

/**
 * Accepts a top-level record array or the first reviewed record-array key. Anything else is schema
 * drift: a single object is never guessed to be a one-record result.
 */
function recordArray(payload: unknown, responseBytes: number): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isObject(payload)) {
    for (const key of RECORD_ARRAY_KEYS) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
  }
  fail("parse", "malformed", undefined, responseBytes, shapeOf(payload));
}

function isConversationModel(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "string" && value.toLowerCase() === "conversation")
  );
}

/**
 * Search (`requiredCompanyId === null`): live #254 ranked hits carry `_id` and `model` but no
 * `companyId`, so a hit may be identity-unknown (`companyId: null`) and the application resolves its
 * Company through its approved single-Conversation read. A present `companyId` must still be safe, and
 * a hit whose `model` is not Conversation is skipped rather than guessed at.
 * List: every record must carry a safe `companyId` equal to the requested Company.
 */
function projectCandidates(
  payload: unknown,
  requiredCompanyId: string | null,
  responseBytes: number
): PlanhatConversationDiscoveryResult {
  const records = recordArray(payload, responseBytes);
  const search = requiredCompanyId === null;
  const candidateByConversation = new Map<string, PlanhatConversationCandidate>();
  const companyByConversation = new Map<string, string | null>();
  const candidates: PlanhatConversationCandidate[] = [];
  for (const source of records) {
    const companyPresent = isObject(source) && source.companyId !== undefined;
    if (
      !isObject(source) ||
      typeof source._id !== "string" ||
      !SAFE_PLANHAT_ID.test(source._id) ||
      ((!search || companyPresent) &&
        (typeof source.companyId !== "string" || !SAFE_PLANHAT_ID.test(source.companyId)))
    ) {
      fail("parse", "malformed", undefined, responseBytes, `record:${shapeOf(source)}`);
    }
    if (search && !isConversationModel(source.model)) continue;
    const conversationId = source._id;
    const companyId = companyPresent ? (source.companyId as string) : null;
    if (requiredCompanyId !== null && companyId !== requiredCompanyId) {
      fail("identity", "mismatch", undefined, responseBytes);
    }
    if (companyByConversation.has(conversationId)) {
      const seenCompany = companyByConversation.get(conversationId) ?? null;
      if (seenCompany !== null && companyId !== null && seenCompany !== companyId) {
        fail("identity", "mismatch", undefined, responseBytes);
      }
      if (seenCompany === null && companyId !== null) {
        companyByConversation.set(conversationId, companyId);
        const candidate = candidateByConversation.get(conversationId);
        if (candidate) candidate.companyId = companyId;
      }
      continue;
    }
    companyByConversation.set(conversationId, companyId);
    if (candidates.length < PLANHAT_DISCOVERY_CANDIDATE_LIMIT) {
      const candidate = { companyId, conversationId };
      candidates.push(candidate);
      candidateByConversation.set(conversationId, candidate);
    }
  }
  return { candidates, providerCount: records.length, responseBytes };
}

async function callFixedDiscoveryTool(
  accessToken: string,
  tool: { name: "search_records" | "list_model_records"; arguments: Record<string, unknown> },
  requiredCompanyId: string | null,
  transport: typeof fetch
): Promise<PlanhatConversationDiscoveryResult> {
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
          clientInfo: { name: "alex-cs-conversation-discovery-gateway", version: "1.0.0" },
        },
      }),
    });
    if (!initialize.ok) fail("initialize", "provider", statusClass(initialize.status));
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
      if (!/^[\x21-\x7e]{1,256}$/.test(candidateSessionId)) fail("initialize", "malformed");
      sessionId = candidateSessionId;
    }

    const acknowledgement = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, sessionId),
      redirect: "manual",
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    if (!acknowledgement.ok) fail("acknowledge", "provider", statusClass(acknowledgement.status));

    const response = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, sessionId),
      redirect: "manual",
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: tool }),
    });
    if (!response.ok) fail("read", "provider", statusClass(response.status));
    const responseBody = await readBounded(response, PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES, "read");
    const message = parseJsonRpc(
      responseBody.body,
      response.headers.get("content-type"),
      2,
      "parse",
      responseBody.bytes
    );
    return projectCandidates(
      toolPayload(message.result, responseBody.bytes),
      requiredCompanyId,
      responseBody.bytes
    );
  } catch (error) {
    if (error instanceof PlanhatConversationDiscoveryTransportError) throw error;
    throw new PlanhatConversationDiscoveryTransportError(
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

export function isValidPlanhatDiscoveryQuery(query: unknown): query is string {
  return (
    typeof query === "string" &&
    query.trim().length > 0 &&
    query.length <= PLANHAT_DISCOVERY_QUERY_MAX_LENGTH &&
    !CONTROL_CHARACTERS.test(query)
  );
}

export async function searchPlanhatConversations(
  accessToken: string,
  request: { query: string },
  transport: typeof fetch = fetch
): Promise<PlanhatConversationDiscoveryResult> {
  if (!isValidPlanhatDiscoveryQuery(request.query)) fail("request", "invalid");
  return callFixedDiscoveryTool(
    accessToken,
    { name: "search_records", arguments: { MODEL: "Conversation", QUERY: request.query } },
    null,
    transport
  );
}

export async function listPlanhatCompanyConversations(
  accessToken: string,
  request: { companyId: string },
  transport: typeof fetch = fetch
): Promise<PlanhatConversationDiscoveryResult> {
  if (typeof request.companyId !== "string" || !SAFE_PLANHAT_ID.test(request.companyId)) {
    fail("identity", "mismatch");
  }
  return callFixedDiscoveryTool(
    accessToken,
    {
      name: "list_model_records",
      arguments: {
        MODEL: "Conversation",
        FILTERS: { companyId: request.companyId },
        LIMIT: PLANHAT_DISCOVERY_CANDIDATE_LIMIT,
      },
    },
    request.companyId,
    transport
  );
}
