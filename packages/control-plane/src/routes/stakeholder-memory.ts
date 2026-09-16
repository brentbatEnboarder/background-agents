import { isEnvironmentId } from "@open-inspect/shared/types/environments";
import { Hono } from "hono";
import { z } from "zod";
import { SessionIndexStore } from "../db/session-index";
import {
  StakeholderMemoryConflictError,
  StakeholderMemoryFactNotFoundError,
  STAKEHOLDER_MEMORY_FACT_KINDS,
  StakeholderMemoryStore,
} from "../db/stakeholder-memory-store";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { activePromptAuthorSchema } from "../session/active-prompt-author";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
} from "./shared";

export const STAKEHOLDER_MEMORY_DEFAULT_LIMIT = 50;
const STAKEHOLDER_MEMORY_MAX_LIMIT = 100;

const factContentSchema = z.object({
  factKind: z.enum(STAKEHOLDER_MEMORY_FACT_KINDS),
  attributedTo: z.string().trim().min(1).max(120),
  fact: z.string().trim().min(1).max(1000),
});

export const stakeholderMemoryRequestSchema = z.discriminatedUnion("operation", [
  factContentSchema.extend({ operation: z.literal("create") }).strict(),
  z
    .object({
      operation: z.literal("list"),
      includeSuperseded: z.boolean().optional().default(false),
      limit: z
        .number()
        .int()
        .min(1)
        .max(STAKEHOLDER_MEMORY_MAX_LIMIT)
        .optional()
        .default(STAKEHOLDER_MEMORY_DEFAULT_LIMIT),
    })
    .strict(),
  factContentSchema
    .extend({
      operation: z.literal("supersede"),
      factId: z.string().trim().min(1).max(200),
      reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
]);

export function configuredEnvironmentId(env: Env): string | null {
  const value = env.MARCUS_MEMORY_ENVIRONMENT_ID?.trim() ?? "";
  return isEnvironmentId(value) ? value : null;
}

async function currentPromptAuthorId(
  env: Env,
  ctx: SandboxRouteContext,
  sessionId: string,
  fallbackUserId: string | null
): Promise<string | null> {
  try {
    const response = await createSessionRuntimeClient(env, ctx).fetch(
      sessionId,
      SessionInternalPaths.activePromptAuthor
    );
    if (!response.ok) return fallbackUserId;
    const author = activePromptAuthorSchema.safeParse(await response.json());
    if (!author.success) return fallbackUserId;
    return author.data.canonicalUserId ?? author.data.userId;
  } catch {
    return fallbackUserId;
  }
}

async function handleStakeholderMemory(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
): Promise<Response> {
  const environmentId = configuredEnvironmentId(env);
  if (!environmentId) return error("Stakeholder memory is not configured", 503);

  const session = await new SessionIndexStore(ctx.db).get(params.id);
  if (!session) return error("Session not found", 404);
  if (session.environmentId !== environmentId) return error("Forbidden", 403);

  const body = await parseBody(request, stakeholderMemoryRequestSchema);
  if (body instanceof Response) return body;

  const store = new StakeholderMemoryStore(ctx.db);
  if (body.operation === "list") {
    const facts = await store.list(environmentId, body);
    return json({ facts });
  }

  const content = {
    factKind: body.factKind,
    attributedTo: body.attributedTo,
    fact: body.fact,
  };
  const provenance = {
    sourceSessionId: session.id,
    sourceUserIdSnapshot: await currentPromptAuthorId(env, ctx, session.id, session.userId ?? null),
  };
  if (body.operation === "create") {
    return json({ fact: await store.create(environmentId, content, provenance) }, 201);
  }

  try {
    const fact = await store.supersede(
      environmentId,
      body.factId,
      content,
      provenance,
      body.reason ?? null
    );
    return json({ fact }, 201);
  } catch (cause) {
    if (cause instanceof StakeholderMemoryFactNotFoundError) return error(cause.message, 404);
    if (cause instanceof StakeholderMemoryConflictError) return error(cause.message, 409);
    throw cause;
  }
}

export const stakeholderMemoryRoutes = new Hono<ControlPlaneHonoEnv>();

stakeholderMemoryRoutes.post(
  "/sessions/:id/stakeholder-memory",
  admit({ ...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) => dispatch(c, handleStakeholderMemory)
);
