import { z } from "zod";
import { Hono } from "hono";
import { generateId, hashToken } from "../auth/crypto";
import {
  buildPlanhatAuthorizationUrl,
  exchangePlanhatAuthorizationCode,
  planhatAccessTokenLifetimeMs,
  PlanhatOAuthProviderError,
} from "../auth/planhat";
import {
  PLANHAT_EXPECTED_GRANT,
  PlanhatOAuthConnectionStore,
} from "../db/planhat-oauth-connections";
import { EnvironmentStore } from "../db/environments";
import { requireTokenEncryptionKey } from "../env-validation";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  json,
  NO_AUTHORIZATION,
  requirePermission,
  type RequestContext,
} from "./shared";

const logger = createLogger("router:planhat-oauth");
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE = /^[a-f0-9]{64}$/;
const CONFIDENTIAL_CLIENT_VALUE = /^[\x21-\x7e]+$/;

const connectSchema = z
  .object({
    clientId: z.string().trim().min(1).max(512).regex(CONFIDENTIAL_CLIENT_VALUE),
    clientSecret: z.string().min(1).max(4096).regex(CONFIDENTIAL_CLIENT_VALUE),
    expectedGrant: z.literal(PLANHAT_EXPECTED_GRANT),
  })
  .strict();

const assignmentSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().positive(),
  })
  .strict();

function callbackUrl(env: Env): string {
  if (!env.WORKER_URL) throw new Error("WORKER_URL is required for Planhat OAuth");
  const base = new URL(env.WORKER_URL);
  const loopback = base.hostname === "localhost" || base.hostname === "127.0.0.1";
  if (base.protocol !== "https:" && !(loopback && base.protocol === "http:")) {
    throw new Error("WORKER_URL must be HTTPS for Planhat OAuth");
  }
  return new URL("/integrations/planhat/oauth/callback", base).toString();
}

function store(env: Env, ctx: RequestContext): PlanhatOAuthConnectionStore {
  return new PlanhatOAuthConnectionStore(ctx.db, requireTokenEncryptionKey(env));
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function requireEnvironment(
  environmentId: string,
  ctx: RequestContext
): Promise<Response | null> {
  return (await new EnvironmentStore(ctx.db).getById(environmentId))
    ? null
    : error("Environment not found", 404);
}

async function handleConnect(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const missing = await requireEnvironment(params.id, ctx);
  if (missing) return missing;
  const parsed = await parseBody(request, connectSchema, "Invalid Planhat OAuth configuration");
  if (parsed instanceof Response) return parsed;

  let redirectUri: string;
  try {
    redirectUri = callbackUrl(env);
  } catch {
    return error("Planhat OAuth is not configured", 503);
  }
  const state = generateId(32);
  const codeVerifier = generateId(32);
  const codeChallenge = await pkceChallenge(codeVerifier);
  await store(env, ctx).beginAuthorization({
    stateHash: await hashToken(state),
    environmentId: params.id,
    clientId: parsed.clientId,
    clientSecret: parsed.clientSecret,
    codeVerifier,
    redirectUri,
    expiresAt: Date.now() + AUTHORIZATION_TTL_MS,
  });
  logger.info("Planhat OAuth authorization started", {
    event: "planhat_oauth.authorization_started",
    environment_id: params.id,
    expected_grant: PLANHAT_EXPECTED_GRANT,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({
    status: "pending",
    environmentId: params.id,
    expectedGrant: PLANHAT_EXPECTED_GRANT,
    authorizationUrl: buildPlanhatAuthorizationUrl({
      clientId: parsed.clientId,
      redirectUri,
      state,
      codeChallenge,
    }),
  });
}

async function handleCallback(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !OAUTH_STATE.test(state)) return error("Invalid OAuth callback", 400);
  const connectionStore = store(env, ctx);
  const stateHash = await hashToken(state);
  const pending = await connectionStore.getPendingAuthorization(stateHash);
  if (!pending || pending.expiresAt <= Date.now()) {
    if (pending) await connectionStore.deletePendingAuthorization(stateHash);
    return error("OAuth authorization is invalid or expired", 400);
  }
  if (url.searchParams.has("error") || !code || code.length > 4096) {
    await connectionStore.deletePendingAuthorization(stateHash);
    return error("Planhat authorization was not completed", 400);
  }

  try {
    const tokens = await exchangePlanhatAuthorizationCode({
      code,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    });
    await connectionStore.completeAuthorization({
      pending,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: Date.now() + planhatAccessTokenLifetimeMs(tokens.expires_in),
    });
  } catch (cause) {
    await connectionStore.deletePendingAuthorization(stateHash);
    logger.warn("Planhat OAuth callback failed", {
      event: "planhat_oauth.callback_failed",
      environment_id: pending.environmentId,
      failure_type: cause instanceof PlanhatOAuthProviderError ? "provider" : "storage",
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Planhat OAuth connection failed", 502);
  }

  logger.info("Planhat OAuth connected", {
    event: "planhat_oauth.connected",
    environment_id: pending.environmentId,
    expected_grant: pending.expectedGrant,
    assignment_enabled: false,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({
    status: "connected",
    environmentId: pending.environmentId,
    expectedGrant: pending.expectedGrant,
    assignmentEnabled: false,
  });
}

async function handleStatus(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const missing = await requireEnvironment(params.id, ctx);
  if (missing) return missing;
  const connectionStore = store(env, ctx);
  const [connection, pending] = await Promise.all([
    connectionStore.getMetadata(params.id),
    connectionStore.getPendingMetadata(params.id),
  ]);
  if (connection) return json({ status: "connected", ...connection });
  if (pending && pending.expiresAt > Date.now()) return json({ status: "pending", ...pending });
  return json({ status: "not-connected", environmentId: params.id });
}

async function handleAssignment(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const missing = await requireEnvironment(params.id, ctx);
  if (missing) return missing;
  const parsed = await parseBody(request, assignmentSchema, "Invalid Planhat assignment");
  if (parsed instanceof Response) return parsed;
  const updated = await store(env, ctx).setAssignment(params.id, parsed.enabled, parsed.revision);
  if (!updated) return error("Planhat OAuth connection changed; reload and try again", 409);
  logger.info("Planhat gateway assignment changed", {
    event: "planhat_oauth.assignment_changed",
    environment_id: params.id,
    enabled: parsed.enabled,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ status: "connected", ...updated });
}

async function handleDisconnect(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const deleted = await store(env, ctx).disconnect(params.id);
  logger.info("Planhat OAuth disconnected", {
    event: "planhat_oauth.disconnected",
    environment_id: params.id,
    connection_existed: deleted,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return json({ status: "not-connected", environmentId: params.id });
}

const MANAGE_PLANHAT_OAUTH = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("environments.secrets.manage"),
});
const OAUTH_CALLBACK = admit({
  authentication: { kind: "handler-authenticated" },
  supportedScmProviders: "all",
  authorization: NO_AUTHORIZATION,
  cacheControl: "no-store",
});

export const planhatOAuthRoutes = new Hono<ControlPlaneHonoEnv>();

planhatOAuthRoutes.get("/integrations/planhat/oauth/callback", OAUTH_CALLBACK, (c) =>
  dispatch(c, handleCallback)
);
planhatOAuthRoutes.get("/environments/:id/integrations/planhat/oauth", MANAGE_PLANHAT_OAUTH, (c) =>
  dispatch(c, handleStatus)
);
planhatOAuthRoutes.post(
  "/environments/:id/integrations/planhat/oauth/connect",
  MANAGE_PLANHAT_OAUTH,
  (c) => dispatch(c, handleConnect)
);
planhatOAuthRoutes.put(
  "/environments/:id/integrations/planhat/oauth/assignment",
  MANAGE_PLANHAT_OAUTH,
  (c) => dispatch(c, handleAssignment)
);
planhatOAuthRoutes.delete(
  "/environments/:id/integrations/planhat/oauth",
  MANAGE_PLANHAT_OAUTH,
  (c) => dispatch(c, handleDisconnect)
);
