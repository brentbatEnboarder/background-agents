import {
  PLANHAT_MCP_CLEANUP_TIMEOUT_MS,
  PLANHAT_MCP_PROTOCOL_VERSION,
  PLANHAT_MCP_URL,
} from "./exact-conversation-transport";

export const PLANHAT_DISCOVERY_SCHEMA_OPERATIONS = {
  "planhat.mcp.validate-conversation-search": "search_records",
  "planhat.mcp.validate-conversation-list": "list_model_records",
  "planhat.mcp.validate-conversation-get": "get_model_record",
} as const;

export type PlanhatDiscoverySchemaOperation = keyof typeof PLANHAT_DISCOVERY_SCHEMA_OPERATIONS;

const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 256 * 1024;
const MAX_SCHEMA_FIELDS = 200;
const MAX_IDENTITY_SHAPES = 20;
const SAFE_SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;

type FailureStage = "initialize" | "acknowledge" | "schema" | "parse";
type FailureOutcome = "provider" | "timeout" | "oversized" | "malformed" | "unsupported";

export class PlanhatDiscoverySchemaTransportError extends Error {
  constructor(
    public readonly stage: FailureStage,
    public readonly outcome: FailureOutcome,
    public readonly statusClass?: string
  ) {
    super("Planhat Conversation discovery schema validation unavailable");
  }
}

export interface PlanhatDiscoverySchemaObservation {
  operation: PlanhatDiscoverySchemaOperation;
  tool: "search_records" | "list_model_records" | "get_model_record";
  inputFields: Array<{ path: string; type: string; required: boolean }>;
}

export type PlanhatDiscoveryValidationOperation = Exclude<
  PlanhatDiscoverySchemaOperation,
  "planhat.mcp.validate-conversation-get"
>;

export interface PlanhatDiscoveryValidationProbe {
  searchQuery?: string;
  listCompanyId?: string;
}

export interface PlanhatDiscoveryValidationObservation {
  observedAt: string;
  durationMs: number;
  schema: {
    inputFields: PlanhatDiscoverySchemaObservation["inputFields"];
    outputFields: Array<{ path: string; types: string[]; presenceCount: number }>;
  };
  response: {
    byteLength: number;
    recordCount: number;
    candidateLimit: number | null;
    truncated: boolean | null;
    continuationPresent: boolean | null;
    identityShapes: Array<{
      companyIdPresent: boolean;
      conversationIdPresent: boolean;
      companyIdHash: string | null;
      conversationIdHash: string | null;
    }>;
  };
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

async function readBounded(response: Response, stage: FailureStage): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_MAX_BYTES) {
    throw new PlanhatDiscoverySchemaTransportError(stage, "oversized");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PlanhatDiscoverySchemaTransportError(stage, "malformed");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new PlanhatDiscoverySchemaTransportError(stage, "oversized");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    if (error instanceof PlanhatDiscoverySchemaTransportError) throw error;
    throw new PlanhatDiscoverySchemaTransportError(stage, "malformed");
  }
}

function parseJsonRpc(
  response: Response,
  body: string,
  expectedId: number,
  stage: FailureStage
): JsonRpcResponse {
  let encoded = body;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    encoded =
      body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .at(-1) ?? "";
  } else if (!contentType.includes("application/json")) {
    throw new PlanhatDiscoverySchemaTransportError(stage, "malformed");
  }
  try {
    const value = JSON.parse(encoded) as JsonRpcResponse;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.jsonrpc !== "2.0" ||
      value.id !== expectedId ||
      value.error !== undefined ||
      value.result === undefined
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new PlanhatDiscoverySchemaTransportError(stage, "malformed");
  }
}

function schemaType(value: unknown): string {
  if (
    typeof value === "string" &&
    ["array", "boolean", "null", "number", "object", "string"].includes(value)
  ) {
    return value;
  }
  return "object";
}

function projectSchema(
  result: unknown,
  operation: PlanhatDiscoverySchemaOperation
): PlanhatDiscoverySchemaObservation {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  const target = PLANHAT_DISCOVERY_SCHEMA_OPERATIONS[operation];
  const matching = tools.filter(
    (tool) =>
      tool &&
      typeof tool === "object" &&
      !Array.isArray(tool) &&
      (tool as Record<string, unknown>).name === target
  );
  if (matching.length !== 1)
    throw new PlanhatDiscoverySchemaTransportError("schema", "unsupported");
  const inputSchema = (matching[0] as Record<string, unknown>).inputSchema;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  const schema = inputSchema as Record<string, unknown>;
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  const required = new Set(
    Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string")
      ? (schema.required as string[])
      : []
  );
  const entries = Object.entries(properties);
  if (
    entries.length > MAX_SCHEMA_FIELDS ||
    entries.some(([name]) => !SAFE_SCHEMA_NAME.test(name))
  ) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  return {
    operation,
    tool: target,
    inputFields: entries.map(([name, definition]) => ({
      path: `$.${name}`,
      type: schemaType(
        definition && typeof definition === "object" && !Array.isArray(definition)
          ? (definition as Record<string, unknown>).type
          : undefined
      ),
      required: required.has(name),
    })),
  };
}

function parseToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  const source = result as Record<string, unknown>;
  if (source.isError === true) {
    throw new PlanhatDiscoverySchemaTransportError("schema", "provider", undefined);
  }
  if (source.structuredContent !== undefined) return source.structuredContent;
  if (!Array.isArray(source.content) || source.content.length !== 1) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  const content = source.content[0];
  if (
    !content ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    (content as Record<string, unknown>).type !== "text" ||
    typeof (content as Record<string, unknown>).text !== "string"
  ) {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
  try {
    return JSON.parse((content as Record<string, string>).text);
  } catch {
    throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
  }
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function candidateRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const source = value as Record<string, unknown>;
  for (const key of ["records", "results", "items", "data"]) {
    if (Array.isArray(source[key])) return source[key];
  }
  return [value];
}

function structuralFields(records: unknown[]): Array<{
  path: string;
  types: string[];
  presenceCount: number;
}> {
  const fields = new Map<string, { types: Set<string>; presenceCount: number }>();
  const visit = (value: unknown, path: string, seen: Set<string>, depth: number): void => {
    if (depth > 20 || fields.size > MAX_SCHEMA_FIELDS) {
      throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
    }
    if (path) {
      const entry = fields.get(path) ?? { types: new Set<string>(), presenceCount: 0 };
      entry.types.add(valueType(value));
      if (!seen.has(path)) {
        entry.presenceCount += 1;
        seen.add(path);
      }
      fields.set(path, entry);
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, `${path}[]`, seen, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (!SAFE_SCHEMA_NAME.test(key)) {
          throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
        }
        visit(child, `${path}.${key}`, seen, depth + 1);
      }
    }
  };
  records.forEach((record) => visit(record, "$", new Set(), 0));
  return [...fields.entries()]
    .filter(([path]) => path !== "$")
    .slice(0, MAX_SCHEMA_FIELDS)
    .map(([path, value]) => ({
      path,
      types: [...value.types].sort(),
      presenceCount: value.presenceCount,
    }));
}

async function hashIdentity(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function identityShapes(
  records: unknown[]
): Promise<PlanhatDiscoveryValidationObservation["response"]["identityShapes"]> {
  const shapes = [];
  for (const record of records.slice(0, MAX_IDENTITY_SHAPES)) {
    const source =
      record && typeof record === "object" && !Array.isArray(record)
        ? (record as Record<string, unknown>)
        : {};
    const companyIdHash = await hashIdentity(source.companyId);
    const conversationIdHash = await hashIdentity(source.conversationId ?? source._id);
    shapes.push({
      companyIdPresent: companyIdHash !== null,
      conversationIdPresent: conversationIdHash !== null,
      companyIdHash,
      conversationIdHash,
    });
  }
  return shapes;
}

function findMetadata(value: unknown): {
  candidateLimit: number | null;
  truncated: boolean | null;
  continuationPresent: boolean | null;
} {
  let candidateLimit: number | null = null;
  let truncated: boolean | null = null;
  let continuationPresent: boolean | null = null;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 8 || !candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (
        candidateLimit === null &&
        (normalized === "limit" || normalized === "candidatelimit") &&
        Number.isSafeInteger(child) &&
        Number(child) >= 0 &&
        Number(child) <= 10_000
      ) {
        candidateLimit = Number(child);
      }
      if (truncated === null && normalized === "truncated" && typeof child === "boolean") {
        truncated = child;
      }
      if (["cursor", "next", "nextcursor", "continuation", "offset"].includes(normalized)) {
        continuationPresent = child !== null && child !== undefined && child !== "";
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return { candidateLimit, truncated, continuationPresent };
}

function probeArguments(
  operation: PlanhatDiscoveryValidationOperation,
  probe: PlanhatDiscoveryValidationProbe
): Record<string, unknown> {
  if (operation === "planhat.mcp.validate-conversation-search") {
    if (!probe.searchQuery) throw new PlanhatDiscoverySchemaTransportError("schema", "unsupported");
    return { MODEL: "Conversation", QUERY: probe.searchQuery };
  }
  if (!probe.listCompanyId) throw new PlanhatDiscoverySchemaTransportError("schema", "unsupported");
  return {
    MODEL: "Conversation",
    FILTERS: { companyId: probe.listCompanyId },
    LIMIT: 20,
  };
}

/**
 * Inspects one allowlisted Conversation tool schema. This module is deliberately
 * not registered as an HTTP route: source review can proceed while production
 * remains disabled, and a later reviewed route must add assignment and expiry
 * enforcement before this code can receive an OAuth token.
 */
export async function inspectPlanhatDiscoverySchema(
  accessToken: string,
  operation: PlanhatDiscoverySchemaOperation,
  transport: typeof fetch = fetch
): Promise<PlanhatDiscoverySchemaObservation> {
  let sessionId: string | null = null;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
          clientInfo: { name: "alex-cs-discovery-schema-validator", version: "1.0.0" },
        },
      }),
    });
    if (!initialize.ok) {
      throw new PlanhatDiscoverySchemaTransportError(
        "initialize",
        "provider",
        statusClass(initialize.status)
      );
    }
    const initialized = await readBounded(initialize, "initialize");
    parseJsonRpc(initialize, initialized, 1, "initialize");
    const candidateSessionId = initialize.headers.get("mcp-session-id");
    if (candidateSessionId !== null) {
      if (!/^[\x21-\x7e]{1,256}$/.test(candidateSessionId)) {
        throw new PlanhatDiscoverySchemaTransportError("initialize", "malformed");
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
      throw new PlanhatDiscoverySchemaTransportError(
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    if (!response.ok) {
      throw new PlanhatDiscoverySchemaTransportError(
        "schema",
        "provider",
        statusClass(response.status)
      );
    }
    const body = await readBounded(response, "schema");
    return projectSchema(parseJsonRpc(response, body, 2, "parse").result, operation);
  } catch (error) {
    if (error instanceof PlanhatDiscoverySchemaTransportError) throw error;
    throw new PlanhatDiscoverySchemaTransportError(
      sessionId === null ? "initialize" : "schema",
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

/** Runs one fixed, operator-configured search or list probe and discards all provider values. */
export async function observePlanhatDiscovery(
  accessToken: string,
  operation: PlanhatDiscoveryValidationOperation,
  probe: PlanhatDiscoveryValidationProbe,
  transport: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<PlanhatDiscoveryValidationObservation> {
  let sessionId: string | null = null;
  const startedAt = now();
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
          clientInfo: { name: "alex-cs-discovery-validator", version: "1.0.0" },
        },
      }),
    });
    if (!initialize.ok) {
      throw new PlanhatDiscoverySchemaTransportError(
        "initialize",
        "provider",
        statusClass(initialize.status)
      );
    }
    parseJsonRpc(initialize, await readBounded(initialize, "initialize"), 1, "initialize");
    const candidateSessionId = initialize.headers.get("mcp-session-id");
    if (candidateSessionId !== null) {
      if (!/^[\x21-\x7e]{1,256}$/.test(candidateSessionId)) {
        throw new PlanhatDiscoverySchemaTransportError("initialize", "malformed");
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
      throw new PlanhatDiscoverySchemaTransportError(
        "acknowledge",
        "provider",
        statusClass(acknowledgement.status)
      );
    }

    const listed = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, sessionId),
      redirect: "manual",
      signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    if (!listed.ok) {
      throw new PlanhatDiscoverySchemaTransportError(
        "schema",
        "provider",
        statusClass(listed.status)
      );
    }
    const schema = projectSchema(
      parseJsonRpc(listed, await readBounded(listed, "schema"), 2, "parse").result,
      operation
    );

    const called = await transport(PLANHAT_MCP_URL, {
      method: "POST",
      headers: headers(accessToken, sessionId),
      redirect: "manual",
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: PLANHAT_DISCOVERY_SCHEMA_OPERATIONS[operation],
          arguments: probeArguments(operation, probe),
        },
      }),
    });
    if (!called.ok) {
      throw new PlanhatDiscoverySchemaTransportError(
        "schema",
        "provider",
        statusClass(called.status)
      );
    }
    const encoded = await readBounded(called, "schema");
    const payload = parseToolResult(parseJsonRpc(called, encoded, 3, "parse").result);
    const records = candidateRecords(payload);
    const metadata = findMetadata(payload);
    return {
      observedAt: new Date(now()).toISOString(),
      durationMs: Math.max(0, now() - startedAt),
      schema: {
        inputFields: schema.inputFields,
        outputFields: structuralFields(records),
      },
      response: {
        byteLength: new TextEncoder().encode(encoded).byteLength,
        recordCount: records.length,
        ...metadata,
        identityShapes: await identityShapes(records),
      },
    };
  } catch (error) {
    if (error instanceof PlanhatDiscoverySchemaTransportError) throw error;
    throw new PlanhatDiscoverySchemaTransportError(
      sessionId === null ? "initialize" : "schema",
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
