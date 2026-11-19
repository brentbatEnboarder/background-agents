import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import {
  PlanhatOAuthAssignmentDisabledError,
  PlanhatOAuthConcurrencyError,
  PlanhatOAuthNotConfiguredError,
  PlanhatOAuthStorageError,
  PlanhatOAuthTokenBroker,
  type PlanhatExpectedAssignment,
  PlanhatOAuthUpstreamError,
} from "../auth/planhat-token-broker";
import { AutomationStore } from "../db/automation-store";
import { PlanhatOAuthConnectionStore } from "../db/planhat-oauth-connections";
import { SessionIndexStore } from "../db/session-index";
import { requireTokenEncryptionKey } from "../env-validation";
import type { Logger } from "../logger";
import type { Env } from "../types";
import type { SandboxRouteContext } from "./shared";

export interface AuthorizedPlanhatGateway {
  accessToken: string;
  environmentId: string;
  automationId: string | null;
  assignmentMode: "automation" | "slack-environment";
}

export interface PlanhatGatewayAdmission {
  /** Omitted for the exact Conversation route, which retains automation compatibility. */
  discoveryValidationEnvironmentId?: string;
}

type Failure = (stage: string, status: number, message?: string) => Response;

/** Preserve the exact route's fail-closed sandbox check before reading its body. */
export function authorizePlanhatSandbox(
  request: Request,
  ctx: SandboxRouteContext,
  failure: Failure
): Response | null {
  const sandboxId = ctx.principal.sandboxId ?? null;
  const headerSandboxId = request.headers.get("X-Sandbox-ID");
  return !sandboxId || (headerSandboxId && headerSandboxId !== sandboxId)
    ? failure("sandbox", 403, "Wrong sandbox")
    : null;
}

/** Shared exact assignment and OAuth-broker boundary for every fixed Planhat route. */
export async function authorizePlanhatGateway(
  request: Request,
  env: Env,
  sessionId: string,
  ctx: SandboxRouteContext,
  logger: Logger,
  failure: Failure,
  admission: PlanhatGatewayAdmission = {}
): Promise<AuthorizedPlanhatGateway | Response> {
  const sandboxFailure = authorizePlanhatSandbox(request, ctx, failure);
  if (sandboxFailure) return sandboxFailure;

  const connectionStore = new PlanhatOAuthConnectionStore(ctx.db, requireTokenEncryptionKey(env));
  let session;
  let connection;
  try {
    [session, connection] = await Promise.all([
      new SessionIndexStore(ctx.db).get(sessionId),
      connectionStore.getMetadataForSession(sessionId),
    ]);
  } catch {
    logger.error("Planhat gateway authorization lookup failed", {
      event: "planhat_gateway.authorization_lookup_failed",
      session_id: sessionId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return failure("authorization", 503);
  }

  if (!session) return failure("authorization", 404, "Session not found");
  if (!session.environmentId || !connection) {
    return failure("assignment", 403, "Planhat gateway is not assigned");
  }
  if (connection.environmentId !== session.environmentId || !connection.assignmentEnabled) {
    return failure("assignment", 403, "Planhat gateway is not assigned");
  }

  if (admission.discoveryValidationEnvironmentId !== undefined) {
    const isApprovedSlackValidationSession =
      session.environmentId === admission.discoveryValidationEnvironmentId &&
      connection.assignmentMode === "slack-environment" &&
      connection.assignedAutomationId === null &&
      session.spawnSource === "slack-bot" &&
      isCanonicalUserId(session.userId) &&
      session.automationId === null &&
      session.parentSessionId === null &&
      session.spawnDepth === 0 &&
      session.repoOwner === null &&
      session.repoName === null;
    if (!isApprovedSlackValidationSession) {
      return failure("assignment", 403, "Planhat gateway is not assigned");
    }
  }

  let expectedAssignment: PlanhatExpectedAssignment;
  if (connection.assignmentMode === "automation") {
    if (!session.automationId || connection.assignedAutomationId !== session.automationId) {
      return failure("assignment", 403, "Planhat gateway is not assigned");
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
        return failure("assignment", 403, "Planhat gateway is not assigned");
      }
    } catch {
      return failure("authorization", 503);
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
      return failure("assignment", 403, "Planhat gateway is not assigned");
    }
    expectedAssignment = { mode: "slack-environment", automationId: null };
  }

  try {
    const accessToken = await new PlanhatOAuthTokenBroker(connectionStore, logger).getAccessToken(
      session.environmentId,
      expectedAssignment
    );
    return {
      accessToken,
      environmentId: session.environmentId,
      automationId: session.automationId ?? null,
      assignmentMode: connection.assignmentMode,
    };
  } catch (cause) {
    const unavailable =
      cause instanceof PlanhatOAuthStorageError || cause instanceof PlanhatOAuthConcurrencyError;
    const denied =
      cause instanceof PlanhatOAuthNotConfiguredError ||
      cause instanceof PlanhatOAuthAssignmentDisabledError;
    logger.warn("Planhat gateway credential unavailable", {
      event: "planhat_gateway.credential_unavailable",
      session_id: sessionId,
      environment_id: session.environmentId,
      automation_id: session.automationId,
      assignment_mode: connection.assignmentMode,
      outcome: denied ? "denied" : unavailable ? "storage" : "upstream",
    });
    return failure(
      "credential",
      denied ? 403 : cause instanceof PlanhatOAuthUpstreamError ? 502 : 503
    );
  }
}
