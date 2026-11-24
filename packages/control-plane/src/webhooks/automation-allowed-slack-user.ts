/**
 * Authenticated answer to one question: is this Slack user on the Slack bot's allowed users (the one
 * list its ingress admits: `SLACK_ALLOWED_USER_IDS` plus KV `slack:allowed-users`)?
 *
 * For an application that runs outside a session sandbox (for example a scheduled job deciding whom
 * to direct-message) and so cannot use the sandbox-authenticated session request context. It uses the
 * same credential as direct-message delivery: the bearer API key of a dedicated webhook automation
 * (one with no fixed Slack channel). It never changes the list and answers only for one user at a
 * time. A missing or invalid list answers `allowed: false`.
 */

import { resolveAllowedSlackUserIds } from "@open-inspect/shared/slack";
import { Hono } from "hono";
import { z } from "zod";
import { verifyWebhookApiKey } from "../auth/webhook-key";
import { AutomationStore } from "../db/automation-store";
import {
  error,
  json,
  NO_AUTHORIZATION,
  SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE,
} from "../routes/shared";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";

const MAX_REQUEST_BYTES = 1_024;
const requestSchema = z.object({ userId: z.string().regex(/^[UW][A-Z0-9]{2,}$/) }).strict();

export interface AllowedSlackUserPorts {
  findAutomation(id: string): Promise<{
    id: string;
    trigger_type: string;
    trigger_auth_data: string | null;
    slack_delivery_channel?: string | null;
  } | null>;
}

export async function handleAutomationAllowedSlackUser(
  request: Request,
  env: Env,
  params: { id: string },
  ports: AllowedSlackUserPorts
): Promise<Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return error("Content-Type must be application/json", 415);
  }
  const header = request.headers.get("authorization");
  const apiKey = header?.startsWith("Bearer ") && header.length > 7 ? header.slice(7) : null;
  if (!apiKey) return error("Missing API key", 401);
  const automation = await ports.findAutomation(params.id);
  if (!automation || automation.trigger_type !== "webhook") return error("Not found", 404);
  if (!automation.trigger_auth_data) return error("Webhook not configured", 500);
  if (!(await verifyWebhookApiKey(apiKey, automation.trigger_auth_data))) {
    return error("Invalid API key", 401);
  }
  if (automation.slack_delivery_channel) {
    return error("Allowed-user checks require a dedicated automation", 409);
  }

  let userId: string;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return error("Payload too large", 413);
    }
    userId = requestSchema.parse(JSON.parse(raw)).userId;
  } catch {
    return error("Invalid allowed-user check body", 400);
  }
  const allowed = await resolveAllowedSlackUserIds(env.SLACK_ALLOWED_USER_IDS, env.SLACK_KV);
  return json({ userId, allowed: allowed.userIds?.has(userId) === true });
}

export const automationAllowedSlackUserRoutes = new Hono<ControlPlaneHonoEnv>();
automationAllowedSlackUserRoutes.post(
  "/webhooks/automation/:id/allowed-slack-user",
  admit({ ...SCM_AGNOSTIC_HANDLER_AUTHENTICATED_ROUTE, authorization: NO_AUTHORIZATION }),
  (c) =>
    dispatch(c, (request, env, params: { id: string }, ctx) =>
      handleAutomationAllowedSlackUser(request, env, params, {
        findAutomation: (id) => new AutomationStore(ctx.db).getById(id),
      })
    )
);
