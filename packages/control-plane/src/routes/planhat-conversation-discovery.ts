import { readBodyCapped } from "@open-inspect/shared/http-body";
import { Hono } from "hono";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  isValidPlanhatDiscoveryQuery,
  listPlanhatCompanyConversations,
  PLANHAT_DISCOVERY_CANDIDATE_LIMIT,
  PLANHAT_DISCOVERY_LIST_OPERATION,
  PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES,
  PLANHAT_DISCOVERY_SEARCH_OPERATION,
  PlanhatConversationDiscoveryTransportError,
  SAFE_PLANHAT_ID,
  searchPlanhatConversations,
  type PlanhatConversationDiscoveryResult,
} from "../planhat/conversation-discovery-transport";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { authorizePlanhatGateway, authorizePlanhatSandbox } from "./planhat-gateway-authorization";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:planhat-conversation-discovery");
const REQUEST_MAX_BYTES = 2048;
const FAILURE_MESSAGE = "Planhat Conversation discovery unavailable";

/** Platform kill switch. Only the exact value "true" enables provider work. */
export const PLANHAT_CONVERSATION_DISCOVERY_ENABLED_NAME =
  "PLANHAT_CONVERSATION_DISCOVERY_ENABLED" as const;

/**
 * The caller chooses only one of two fixed operations and its bounded input. Tool, model, fields,
 * limit, URL, filters and retry are platform-owned and rejected by the strict schemas.
 */
const requestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal(PLANHAT_DISCOVERY_SEARCH_OPERATION),
      query: z.string().refine(isValidPlanhatDiscoveryQuery),
    })
    .strict(),
  z
    .object({
      operation: z.literal(PLANHAT_DISCOVERY_LIST_OPERATION),
      companyId: z.string().regex(SAFE_PLANHAT_ID),
    })
    .strict(),
]);
type DiscoveryRequest = z.infer<typeof requestSchema>;

function discoveryEnabled(env: Pick<Env, typeof PLANHAT_CONVERSATION_DISCOVERY_ENABLED_NAME>) {
  return env[PLANHAT_CONVERSATION_DISCOVERY_ENABLED_NAME] === "true";
}

async function readRequest(request: Request): Promise<DiscoveryRequest | Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    return error("Request is too large", 413);
  }
  const bytes = await readBodyCapped(request.body, REQUEST_MAX_BYTES);
  if (!bytes) return error("Request is too large", 413);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return error("Invalid JSON body", 400);
  }
  const parsed = requestSchema.safeParse(value);
  return parsed.success ? parsed.data : error("Invalid Conversation discovery request", 400);
}

function failure(correlationId: string, stage: string, status: number): Response {
  return json({ error: FAILURE_MESSAGE, correlationId, stage }, status);
}

interface ConversationDiscoveryDependencies {
  authorizeSandbox: typeof authorizePlanhatSandbox;
  authorizeGateway: typeof authorizePlanhatGateway;
  search: (
    accessToken: string,
    request: { query: string }
  ) => Promise<PlanhatConversationDiscoveryResult>;
  list: (
    accessToken: string,
    request: { companyId: string }
  ) => Promise<PlanhatConversationDiscoveryResult>;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: ConversationDiscoveryDependencies = {
  authorizeSandbox: authorizePlanhatSandbox,
  authorizeGateway: authorizePlanhatGateway,
  search: (accessToken, request) => searchPlanhatConversations(accessToken, request),
  list: (accessToken, request) => listPlanhatCompanyConversations(accessToken, request),
  now: Date.now,
};

/**
 * Envelope evidence for application validation. A search candidate's `companyId` is null when the
 * provider's ranked hit carried no Company identity (#254); list candidates always equal the request. `truncated` means the provider returned at least
 * `candidateLimit` records, so more matching Conversations may exist than were returned.
 */
function envelope(
  parsed: DiscoveryRequest,
  result: PlanhatConversationDiscoveryResult,
  requestedAt: string,
  correlationId: string
) {
  if (
    !Number.isSafeInteger(result.providerCount) ||
    result.providerCount < result.candidates.length ||
    result.candidates.length > PLANHAT_DISCOVERY_CANDIDATE_LIMIT ||
    !result.candidates.every(
      ({ companyId, conversationId }) =>
        SAFE_PLANHAT_ID.test(conversationId) &&
        (parsed.operation === PLANHAT_DISCOVERY_LIST_OPERATION
          ? companyId === parsed.companyId
          : companyId === null || SAFE_PLANHAT_ID.test(companyId))
    )
  ) {
    throw new PlanhatConversationDiscoveryTransportError("parse", "malformed");
  }
  const body = {
    operation: parsed.operation,
    model: "Conversation" as const,
    companyId: parsed.operation === PLANHAT_DISCOVERY_LIST_OPERATION ? parsed.companyId : null,
    candidates: result.candidates.map(({ companyId, conversationId }) => ({
      companyId,
      conversationId,
    })),
    candidateLimit: PLANHAT_DISCOVERY_CANDIDATE_LIMIT,
    providerCount: result.providerCount,
    returnedCount: result.candidates.length,
    truncated: result.providerCount >= PLANHAT_DISCOVERY_CANDIDATE_LIMIT,
    requestedAt,
    correlationId,
  };
  if (
    new TextEncoder().encode(JSON.stringify(body)).byteLength > PLANHAT_DISCOVERY_RESPONSE_MAX_BYTES
  ) {
    throw new PlanhatConversationDiscoveryTransportError("parse", "oversized");
  }
  return body;
}

export async function handleConversationDiscovery(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext,
  dependencies: ConversationDiscoveryDependencies = DEFAULT_DEPENDENCIES
): Promise<Response> {
  const startedAt = dependencies.now();
  const correlationId = generateId(16);
  const sandboxFailure = dependencies.authorizeSandbox(request, ctx, (stage, status) =>
    failure(correlationId, stage, status)
  );
  if (sandboxFailure) return sandboxFailure;
  if (!discoveryEnabled(env)) return failure(correlationId, "disabled", 403);
  const parsed = await readRequest(request);
  if (parsed instanceof Response) return parsed;

  const authorized = await dependencies.authorizeGateway(
    request,
    env,
    params.id,
    ctx,
    logger,
    (stage, status) => failure(correlationId, stage, status),
    { validateBeforeBrokerage: () => discoveryEnabled(env) }
  );
  if (authorized instanceof Response) return authorized;

  const requestedAt = new Date(startedAt).toISOString();
  const logContext = {
    correlation_id: correlationId,
    session_id: params.id,
    environment_id: authorized.environmentId,
    automation_id: authorized.automationId,
    assignment_mode: authorized.assignmentMode,
    operation: parsed.operation,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  };
  try {
    const result =
      parsed.operation === PLANHAT_DISCOVERY_SEARCH_OPERATION
        ? await dependencies.search(authorized.accessToken, { query: parsed.query })
        : await dependencies.list(authorized.accessToken, { companyId: parsed.companyId });
    const body = envelope(parsed, result, requestedAt, correlationId);
    logger.info("Planhat Conversation discovery completed", {
      event: "planhat_gateway.discovery_completed",
      ...logContext,
      outcome: "success",
      response_bytes: result.responseBytes,
      provider_count: body.providerCount,
      returned_count: body.returnedCount,
      truncated: body.truncated,
      duration_ms: dependencies.now() - startedAt,
    });
    return json(body);
  } catch (cause) {
    const transport =
      cause instanceof PlanhatConversationDiscoveryTransportError
        ? cause
        : new PlanhatConversationDiscoveryTransportError("read", "provider");
    logger.warn("Planhat Conversation discovery failed", {
      event: "planhat_gateway.discovery_failed",
      ...logContext,
      stage: transport.stage,
      outcome: transport.outcome,
      provider_status_class: transport.statusClass,
      response_bytes: transport.responseBytes,
      response_shape: transport.responseShape,
      duration_ms: dependencies.now() - startedAt,
    });
    return failure(correlationId, transport.stage, transport.outcome === "timeout" ? 504 : 502);
  }
}

export const planhatConversationDiscoveryRoutes = new Hono<ControlPlaneHonoEnv>();

planhatConversationDiscoveryRoutes.post(
  "/sessions/:id/planhat-mcp/conversation-discovery",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleConversationDiscovery)
);
