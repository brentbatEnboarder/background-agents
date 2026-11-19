import { readBodyCapped } from "@open-inspect/shared/http-body";
import { z } from "zod";
import { Hono } from "hono";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  getExactPlanhatConversation,
  PLANHAT_MCP_OPERATION,
  PlanhatExactConversationTransportError,
} from "../planhat/exact-conversation-transport";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { authorizePlanhatGateway } from "./planhat-gateway-authorization";
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
  const parsed = await readRequest(request);
  if (parsed instanceof Response) return parsed;
  const authorized = await authorizePlanhatGateway(
    request,
    env,
    params.id,
    ctx,
    logger,
    (stage, status, message) => failure(correlationId, stage, status, message)
  );
  if (authorized instanceof Response) return authorized;
  const { accessToken, environmentId, automationId, assignmentMode } = authorized;

  try {
    const result = await getExactPlanhatConversation(accessToken, parsed);
    logger.info("Planhat exact Conversation retrieved", {
      event: "planhat_gateway.retrieved",
      correlation_id: correlationId,
      session_id: params.id,
      environment_id: environmentId,
      automation_id: automationId,
      assignment_mode: assignmentMode,
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
      environment_id: environmentId,
      automation_id: automationId,
      assignment_mode: assignmentMode,
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
