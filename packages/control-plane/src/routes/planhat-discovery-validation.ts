import { readBodyCapped } from "@open-inspect/shared/http-body";
import { Hono } from "hono";
import { z } from "zod";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  observePlanhatDiscovery,
  PLANHAT_DISCOVERY_MAX_RECORD_COUNT,
  PlanhatDiscoverySchemaTransportError,
  type PlanhatDiscoveryValidationOperation,
  type PlanhatDiscoveryValidationProbe,
} from "../planhat/discovery-validation-transport";
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

const logger = createLogger("router:planhat-discovery-validation");
const REQUEST_MAX_BYTES = 256;
const RESPONSE_MAX_BYTES = 256 * 1024;
const MAX_AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const SAFE_PLANHAT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,199}$/;

const requestSchema = z
  .object({
    operation: z.enum([
      "planhat.mcp.validate-conversation-search",
      "planhat.mcp.validate-conversation-list",
      "planhat.mcp.validate-conversation-get",
    ]),
  })
  .strict();

export interface PlanhatDiscoveryValidationConfiguration {
  operation: PlanhatDiscoveryValidationOperation;
  expiresAt: number;
  probe: PlanhatDiscoveryValidationProbe;
}

/** Fail-closed external activation. No default or source-controlled probe exists. */
export function readPlanhatDiscoveryValidationConfiguration(
  env: Pick<
    Env,
    | "PLANHAT_DISCOVERY_VALIDATION_ENABLED"
    | "PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT"
    | "PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY"
    | "PLANHAT_DISCOVERY_VALIDATION_LIST_COMPANY_ID"
    | "PLANHAT_DISCOVERY_VALIDATION_GET_COMPANY_ID"
    | "PLANHAT_DISCOVERY_VALIDATION_GET_CONVERSATION_ID"
  >,
  operation: PlanhatDiscoveryValidationOperation,
  now = Date.now()
): PlanhatDiscoveryValidationConfiguration | null {
  if (env.PLANHAT_DISCOVERY_VALIDATION_ENABLED !== "true") return null;
  const expiresAt = Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT ?? "");
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > MAX_AUTHORIZATION_WINDOW_MS
  ) {
    return null;
  }
  if (operation === "planhat.mcp.validate-conversation-search") {
    const searchQuery = env.PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY;
    if (!searchQuery || searchQuery.length > 500) return null;
    return { operation, expiresAt, probe: { searchQuery } };
  }
  if (operation === "planhat.mcp.validate-conversation-list") {
    const listCompanyId = env.PLANHAT_DISCOVERY_VALIDATION_LIST_COMPANY_ID;
    if (!listCompanyId || !SAFE_PLANHAT_ID.test(listCompanyId)) return null;
    return { operation, expiresAt, probe: { listCompanyId } };
  }
  const getCompanyId = env.PLANHAT_DISCOVERY_VALIDATION_GET_COMPANY_ID;
  const getConversationId = env.PLANHAT_DISCOVERY_VALIDATION_GET_CONVERSATION_ID;
  if (
    !getCompanyId ||
    !SAFE_PLANHAT_ID.test(getCompanyId) ||
    !getConversationId ||
    !SAFE_PLANHAT_ID.test(getConversationId)
  ) {
    return null;
  }
  return { operation, expiresAt, probe: { getCompanyId, getConversationId } };
}

async function readRequest(request: Request): Promise<z.infer<typeof requestSchema> | Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > REQUEST_MAX_BYTES) {
    return error("Request is too large", 413);
  }
  const bytes = await readBodyCapped(request.body, REQUEST_MAX_BYTES);
  if (!bytes) return error("Request is too large", 413);
  try {
    const parsed = requestSchema.safeParse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes))
    );
    return parsed.success ? parsed.data : error("Invalid discovery validation request", 400);
  } catch {
    return error("Invalid JSON body", 400);
  }
}

function failure(correlationId: string, stage: string, status: number): Response {
  return json(
    {
      error: "Planhat Conversation discovery validation unavailable",
      correlationId,
      stage,
    },
    status
  );
}

interface DiscoveryValidationDependencies {
  authorizeSandbox: typeof authorizePlanhatSandbox;
  authorizeGateway: typeof authorizePlanhatGateway;
  observe: typeof observePlanhatDiscovery;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: DiscoveryValidationDependencies = {
  authorizeSandbox: authorizePlanhatSandbox,
  authorizeGateway: authorizePlanhatGateway,
  observe: observePlanhatDiscovery,
  now: Date.now,
};

export async function handleDiscoveryValidation(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext,
  dependencies: DiscoveryValidationDependencies = DEFAULT_DEPENDENCIES
): Promise<Response> {
  const startedAt = dependencies.now();
  const correlationId = generateId(16);
  const sandboxFailure = dependencies.authorizeSandbox(request, ctx, (stage, status) =>
    failure(correlationId, stage, status)
  );
  if (sandboxFailure) return sandboxFailure;
  const parsed = await readRequest(request);
  if (parsed instanceof Response) return parsed;
  const configuration = readPlanhatDiscoveryValidationConfiguration(
    env,
    parsed.operation,
    dependencies.now()
  );
  if (!configuration) return failure(correlationId, "authorization", 403);

  const authorized = await dependencies.authorizeGateway(
    request,
    env,
    params.id,
    ctx,
    logger,
    (stage, status) => failure(correlationId, stage, status)
  );
  if (authorized instanceof Response) return authorized;
  if (dependencies.now() >= configuration.expiresAt) {
    return failure(correlationId, "authorization", 403);
  }

  try {
    const observation = await dependencies.observe(
      authorized.accessToken,
      configuration.operation,
      configuration.probe
    );
    if (
      !Number.isSafeInteger(observation.response.recordCount) ||
      observation.response.recordCount < 0 ||
      observation.response.recordCount > PLANHAT_DISCOVERY_MAX_RECORD_COUNT
    ) {
      throw new PlanhatDiscoverySchemaTransportError("parse", "malformed");
    }
    const envelope = { operation: configuration.operation, correlationId, observation };
    if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > RESPONSE_MAX_BYTES) {
      throw new PlanhatDiscoverySchemaTransportError("parse", "oversized");
    }
    logger.info("Planhat Conversation discovery validation observed", {
      event: "planhat_gateway.discovery_validation_observed",
      correlation_id: correlationId,
      session_id: params.id,
      environment_id: authorized.environmentId,
      automation_id: authorized.automationId,
      assignment_mode: authorized.assignmentMode,
      operation: configuration.operation,
      outcome: "success",
      response_bytes: observation.response.byteLength,
      record_count: observation.response.recordCount,
      duration_ms: dependencies.now() - startedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return json(envelope);
  } catch (cause) {
    const transport =
      cause instanceof PlanhatDiscoverySchemaTransportError
        ? cause
        : new PlanhatDiscoverySchemaTransportError("schema", "provider");
    logger.warn("Planhat Conversation discovery validation failed", {
      event: "planhat_gateway.discovery_validation_failed",
      correlation_id: correlationId,
      session_id: params.id,
      environment_id: authorized.environmentId,
      automation_id: authorized.automationId,
      assignment_mode: authorized.assignmentMode,
      operation: configuration.operation,
      stage: transport.stage,
      outcome: transport.outcome,
      provider_status_class: transport.statusClass,
      duration_ms: dependencies.now() - startedAt,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return failure(correlationId, transport.stage, transport.outcome === "timeout" ? 504 : 502);
  }
}

export const planhatDiscoveryValidationRoutes = new Hono<ControlPlaneHonoEnv>();

planhatDiscoveryValidationRoutes.post(
  "/sessions/:id/planhat-mcp/conversation-discovery-validation",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    cacheControl: "no-store",
    authorization: NO_AUTHORIZATION,
  }),
  (c) => dispatch(c, handleDiscoveryValidation)
);
