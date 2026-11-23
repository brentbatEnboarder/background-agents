import type { SlackEventPayload } from "./events/payload";
import type { SlackInteractionPayload } from "./interaction-payload";
import {
  SLACK_ALLOWED_USERS_KV_KEY,
  parseSlackUserIdList,
  parseSlackAllowedUserAdditions,
  SLACK_ALLOWED_USERS_CACHE_TTL_SECONDS,
  type AllowedSlackUsersKv,
} from "@open-inspect/shared/slack";
import { createLogger } from "./logger";

const log = createLogger("ingress-policy");

/**
 * Slack users admitted in addition to `SLACK_ALLOWED_USER_IDS`, as comma- or whitespace-separated
 * user IDs. Operators change it with `wrangler kv key put` and no deploy. The list's rules live in
 * `@open-inspect/shared/slack` (`allowed-users.ts`), which the control plane reads too.
 */
export { SLACK_ALLOWED_USERS_KV_KEY };

export interface SlackIngressBindings {
  SLACK_APP_ID?: string;
  SLACK_TEAM_ID?: string;
  SLACK_ALLOWED_USER_IDS?: string;
  SLACK_ALLOWED_CHANNEL_IDS?: string;
}

export type SlackIngressRejectionReason =
  | "invalid_configuration"
  | "missing_identity"
  | "app_mismatch"
  | "workspace_mismatch"
  | "user_not_allowed"
  | "channel_not_allowed";

export type SlackIngressDecision =
  | { admitted: true }
  | {
      admitted: false;
      ignored: boolean;
      reason: SlackIngressRejectionReason | "bot_event" | "unsupported_event";
    };

type SlackIngressPolicy = {
  appId: string;
  teamId: string;
  allowedUserIds: Set<string>;
};

const ID_PATTERNS = {
  app: /^A[A-Z0-9]+$/,
  team: /^T[A-Z0-9]+$/,
  destination: /^[CGD][A-Z0-9]+$/,
};

function parsePolicy(bindings: SlackIngressBindings): SlackIngressPolicy | null {
  const appId = (bindings.SLACK_APP_ID ?? "").trim();
  const teamId = (bindings.SLACK_TEAM_ID ?? "").trim();
  const allowedUserIds = parseSlackUserIdList(bindings.SLACK_ALLOWED_USER_IDS);
  if (!ID_PATTERNS.app.test(appId) || !ID_PATTERNS.team.test(teamId) || !allowedUserIds) {
    return null;
  }
  return { appId, teamId, allowedUserIds };
}

/**
 * Returns the ingress bindings with any KV-managed users appended to the configured allowlist.
 * The configured list is never replaced: if it is empty or invalid the merged value stays invalid,
 * so a misconfigured deployment still fails closed rather than being bootstrapped from KV.
 */
export async function resolveIngressBindings(
  env: SlackIngressBindings & { SLACK_KV?: AllowedSlackUsersKv }
): Promise<SlackIngressBindings> {
  const bindings: SlackIngressBindings = {
    SLACK_APP_ID: env.SLACK_APP_ID,
    SLACK_TEAM_ID: env.SLACK_TEAM_ID,
    SLACK_ALLOWED_USER_IDS: env.SLACK_ALLOWED_USER_IDS,
    SLACK_ALLOWED_CHANNEL_IDS: env.SLACK_ALLOWED_CHANNEL_IDS,
  };
  const configured = (env.SLACK_ALLOWED_USER_IDS ?? "").trim();
  if (!configured || !env.SLACK_KV) return bindings;

  let stored: string | null;
  try {
    stored = await env.SLACK_KV.get(SLACK_ALLOWED_USERS_KV_KEY, {
      cacheTtl: SLACK_ALLOWED_USERS_CACHE_TTL_SECONDS,
    });
  } catch (e) {
    log.warn("slack.ingress.kv_allowlist_unavailable", {
      error: e instanceof Error ? e.message : String(e),
    });
    return bindings;
  }
  const additions = parseSlackAllowedUserAdditions(stored);
  if (additions.status === "invalid") log.warn("slack.ingress.kv_allowlist_invalid");
  if (additions.status !== "applied") return bindings;
  return { ...bindings, SLACK_ALLOWED_USER_IDS: [configured, ...additions.userIds].join(",") };
}

function reject(reason: SlackIngressRejectionReason): SlackIngressDecision {
  return { admitted: false, ignored: false, reason };
}

function admitIdentity(
  policy: SlackIngressPolicy,
  appId: string | undefined,
  teamId: string | undefined,
  userId: string | undefined,
  channelId: string | undefined
): SlackIngressDecision {
  if (!appId || !teamId || !userId) return reject("missing_identity");
  if (appId !== policy.appId) return reject("app_mismatch");
  if (teamId !== policy.teamId) return reject("workspace_mismatch");
  if (!policy.allowedUserIds.has(userId)) return reject("user_not_allowed");
  if (channelId && !ID_PATTERNS.destination.test(channelId)) return reject("channel_not_allowed");
  return { admitted: true };
}

export function admitSlackEvent(
  payload: SlackEventPayload,
  bindings: SlackIngressBindings
): SlackIngressDecision {
  const policy = parsePolicy(bindings);
  if (!policy) return reject("invalid_configuration");

  // Slack's URL verification handshake cannot start work and has no user identity.
  if (payload.type === "url_verification") return { admitted: true };

  const event = payload.event;
  if (payload.api_app_id !== policy.appId) return reject("app_mismatch");
  if (payload.team_id !== policy.teamId) return reject("workspace_mismatch");
  if (event?.bot_id || event?.subtype === "bot_message") {
    return { admitted: false, ignored: true, reason: "bot_event" };
  }
  if (event?.type === "message" && event.subtype && event.subtype !== "file_share") {
    return { admitted: false, ignored: true, reason: "unsupported_event" };
  }
  if (event && !["app_home_opened", "app_mention", "message"].includes(event.type)) {
    return { admitted: false, ignored: true, reason: "unsupported_event" };
  }
  if ((event?.type === "app_mention" || event?.type === "message") && !event.channel) {
    return reject("channel_not_allowed");
  }
  return admitIdentity(policy, payload.api_app_id, payload.team_id, event?.user, event?.channel);
}

export function admitSlackInteraction(
  payload: SlackInteractionPayload,
  bindings: SlackIngressBindings
): SlackIngressDecision {
  const policy = parsePolicy(bindings);
  if (!policy) return reject("invalid_configuration");
  const topLevelChannelId = payload.channel?.id;
  const containerChannelId = payload.container?.channel_id;
  if (topLevelChannelId && containerChannelId && topLevelChannelId !== containerChannelId) {
    return reject("channel_not_allowed");
  }
  const channelId = topLevelChannelId ?? containerChannelId;
  const isViewInteraction =
    (payload.view?.type === "home" || payload.view?.type === "modal") &&
    (!payload.container || payload.container.type === "view");
  if (!channelId && !isViewInteraction) return reject("channel_not_allowed");
  return admitIdentity(policy, payload.api_app_id, payload.team?.id, payload.user?.id, channelId);
}
