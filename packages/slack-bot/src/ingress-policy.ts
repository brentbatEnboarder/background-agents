import type { SlackEventPayload } from "./events/payload";
import type { SlackInteractionPayload } from "./interaction-payload";

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
  allowedChannelIds: Set<string>;
};

const ID_PATTERNS = {
  app: /^A[A-Z0-9]+$/,
  team: /^T[A-Z0-9]+$/,
  user: /^[UW][A-Z0-9]+$/,
  channel: /^[CG][A-Z0-9]+$/,
};

function parseIdList(value: string, pattern: RegExp): Set<string> | null {
  const rawIds = value.split(",");
  const ids = rawIds.map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !pattern.test(id))) return null;
  return new Set(ids);
}

function parsePolicy(bindings: SlackIngressBindings): SlackIngressPolicy | null {
  const appId = (bindings.SLACK_APP_ID ?? "").trim();
  const teamId = (bindings.SLACK_TEAM_ID ?? "").trim();
  const allowedUserIds = parseIdList(bindings.SLACK_ALLOWED_USER_IDS ?? "", ID_PATTERNS.user);
  const allowedChannelIds = parseIdList(
    bindings.SLACK_ALLOWED_CHANNEL_IDS ?? "",
    ID_PATTERNS.channel
  );
  if (
    !ID_PATTERNS.app.test(appId) ||
    !ID_PATTERNS.team.test(teamId) ||
    !allowedUserIds ||
    !allowedChannelIds
  ) {
    return null;
  }
  return { appId, teamId, allowedUserIds, allowedChannelIds };
}

function reject(reason: SlackIngressRejectionReason): SlackIngressDecision {
  return { admitted: false, ignored: false, reason };
}

function admitIdentity(
  policy: SlackIngressPolicy,
  appId: string | undefined,
  teamId: string | undefined,
  userId: string | undefined,
  channelId: string | undefined,
  isDirectMessage: boolean
): SlackIngressDecision {
  if (!appId || !teamId || !userId) return reject("missing_identity");
  if (appId !== policy.appId) return reject("app_mismatch");
  if (teamId !== policy.teamId) return reject("workspace_mismatch");
  if (!policy.allowedUserIds.has(userId)) return reject("user_not_allowed");
  if (channelId && !isDirectMessage && !policy.allowedChannelIds.has(channelId)) {
    return reject("channel_not_allowed");
  }
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
  return admitIdentity(
    policy,
    payload.api_app_id,
    payload.team_id,
    event?.user,
    event?.channel,
    event?.channel?.startsWith("D") === true
  );
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
  return admitIdentity(
    policy,
    payload.api_app_id,
    payload.team?.id,
    payload.user?.id,
    channelId,
    channelId?.startsWith("D") === true
  );
}
