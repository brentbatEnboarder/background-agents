import { readBodyCapped } from "@open-inspect/shared/http-body";
import { z } from "zod";
import { Hono } from "hono";
import {
  PlanhatOAuthAssignmentDisabledError,
  PlanhatOAuthConcurrencyError,
  PlanhatOAuthNotConfiguredError,
  PlanhatOAuthStorageError,
  PlanhatOAuthTokenBroker,
  type PlanhatExpectedAssignment,
  PlanhatOAuthUpstreamError,
} from "../auth/planhat-token-broker";
import { generateId } from "../auth/crypto";
import { AutomationStore } from "../db/automation-store";
import { PlanhatOAuthConnectionStore } from "../db/planhat-oauth-connections";
import { SessionIndexStore } from "../db/session-index";
import { requireTokenEncryptionKey } from "../env-validation";
import { createLogger } from "../logger";
import {
  getExactPlanhatConversation,
  PLANHAT_MCP_OPERATION,
  PlanhatExactConversationTransportError,
} from "../planhat/exact-conversation-transport";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

const logger = createLogger("router:planhat-exact-conversation");
const REQUEST_MAX_BYTES = 1024;
const SAFE_PLANHAT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;

const requestSchema = z
  .object({
    operation: z.literal(PLANHAT_MCP_OPERATION),
    companyId: z.string().regex(SAFE_PLANHAT_ID),
    conversationId: z.string().regex(SAFE_PLANHAT_ID),
  })
  .strict();

async function readRequest(request: Request): Promise<z.infer<typeof requestSchema> | Response> {
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
  return parsed.success ? parsed.data : error("Invalid exact Conversation request", 400);
}

function failure(
  correlationId: string,
  stage: string,
  status: number,
  message = "Planhat exact Conversation retrieval unavailable"
): Response {
  return json({ error: message, correlationId, stage }, status);
}

async function handleExactConversation(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const startedAt = Date.now();
  const correlationId = generateId(16);
  const sandboxId = ctx.principal.sandboxId ?? null;
  const headerSandboxId = request.headers.get("X-Sandbox-ID");
  if (!sandboxId || (headerSandboxId && headerSandboxId !== sandboxId)) {
    return failure(correlationId, "sandbox", 403, "Wrong sandbox");
  }

  const parsed = await readRequest(request);
  if (parsed instanceof Response) return parsed;

  const connectionStore = new PlanhatOAuthConnectionStore(ctx.db, requireTokenEncryptionKey(env));
  let session;
  let connection;
  try {
    [session, connection] = await Promise.all([
      new SessionIndexStore(ctx.db).get(params.id),
      connectionStore.getMetadataForSession(params.id),
    ]);
  } catch {
    logger.error("Planhat gateway authorization lookup failed", {
      event: "planhat_gateway.authorization_lookup_failed",
      correlation_id: correlationId,
      session_id: params.id,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return failure(correlationId, "authorization", 503);
  }

  if (!session) return failure(correlationId, "authorization", 404, "Session not found");
  if (!session.environmentId || !connection) {
    return failure(correlationId, "assignment", 403, "Planhat gateway is not assigned");
  }
  if (connection.environmentId !== session.environmentId || !connection.assignmentEnabled) {
    return failure(correlationId, "assignment", 403, "Planhat gateway is not assigned");
  }

  let expectedAssignment: PlanhatExpectedAssignment;
  if (connection.assignmentMode === "automation") {
    if (!session.automationId || connection.assignedAutomationId !== session.automationId) {
      return failure(correlationId, "assignment", 403, "Planhat gateway is not assigned");
    }
    try {
      const automations = new AutomationStore(ctx.db);
      const [automation, environments] = await Promise.all([
        automations.getById(session.automationId),
        automations.getEnvironmentsForAutomation(session.automationId),
      ]);
      if (
        !automation ||
        !environments.some((row) => row.environment_id === session.environmentId)
      ) {
        return failure(correlationId, "assignment", 403, "Planhat gateway is not assigned");
      }
    } catch {
      return failure(correlationId, "authorization", 503);
    }
    expectedAssignment = { mode: "automation", automationId: session.automationId };
  } else {
    const isTopLevelActorBoundSlackSession =
      session.spawnSource === "slack-bot" &&
      Boolean(session.userId) &&
      !session.automationId &&
      !session.parentSessionId &&
      session.spawnDepth === 0;
    if (connection.assignedAutomationId || !isTopLevelActorBoundSlackSession) {
      return failure(correlationId, "assignment", 403, "Planhat gateway is not assigned");
    }
    expectedAssignment = { mode: "slack-environment", automationId: null };
  }

  let accessToken: string;
  try {
    accessToken = await new PlanhatOAuthTokenBroker(connectionStore, logger).getAccessToken(
      session.environmentId,
      expectedAssignment
    );
  } catch (cause) {
    const unavailable =
      cause instanceof PlanhatOAuthStorageError || cause instanceof PlanhatOAuthConcurrencyError;
    const denied =
      cause instanceof PlanhatOAuthNotConfiguredError ||
      cause instanceof PlanhatOAuthAssignmentDisabledError;
    logger.warn("Planhat gateway credential unavailable", {
      event: "planhat_gateway.credential_unavailable",
      correlation_id: correlationId,
      session_id: params.id,
      environment_id: session.environmentId,
      automation_id: session.automationId,
      assignment_mode: connection.assignmentMode,
      outcome: denied ? "denied" : unavailable ? "storage" : "upstream",
      duration_ms: Date.now() - startedAt,
    });
    return failure(
      correlationId,
      "credential",
      denied ? 403 : cause instanceof PlanhatOAuthUpstreamError ? 502 : 503
    );
  }

  try {
    const result = await getExactPlanhatConversation(accessToken, parsed);
    logger.info("Planhat exact Conversation retrieved", {
      event: "planhat_gateway.retrieved",
      correlation_id: correlationId,
      session_id: params.id,
      environment_id: session.environmentId,
      automation_id: session.automationId,
      assignment_mode: connection.assignmentMode,
      operation: PLANHAT_MCP_OPERATION,
      outcome: "success",
      response_bytes: result.responseBytes,
      duration_ms: Date.now() - startedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json({
      operation: PLANHAT_MCP_OPERATION,
      companyId: parsed.companyId,
      conversationId: parsed.conversationId,
      record: result.record,
      correlationId,
    });
  } catch (cause) {
    const transport =
      cause instanceof PlanhatExactConversationTransportError
        ? cause
        : new PlanhatExactConversationTransportError("read", "provider");
    logger.warn("Planhat exact Conversation retrieval failed", {
      event: "planhat_gateway.failed",
      correlation_id: correlationId,
      session_id: params.id,
      environment_id: session.environmentId,
      automation_id: session.automationId,
      assignment_mode: connection.assignmentMode,
      operation: PLANHAT_MCP_OPERATION,
      stage: transport.stage,
      outcome: transport.outcome,
      provider_status_class: transport.statusClass,
      response_bytes: transport.responseBytes,
      duration_ms: Date.now() - startedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return failure(correlationId, transport.stage, transport.outcome === "timeout" ? 504 : 502);
  }
}

export const planhatExactConversationRoutes = new Hono<ControlPlaneHonoEnv>();

planhatExactConversationRoutes.post(
  "/sessions/:id/planhat-mcp/conversation-messages",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleExactConversation)
);
