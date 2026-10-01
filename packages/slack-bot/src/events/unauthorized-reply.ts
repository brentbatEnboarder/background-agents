import { postMessage } from "@open-inspect/shared/slack";
import { createLogger } from "../logger";
import type { Env } from "../types";
import type { SlackEventPayload } from "./payload";

const log = createLogger("unauthorized-reply");

/**
 * Answer a user the allowlist rejects with the deployment's fixed reply, instead of silence.
 *
 * Only a direct message to the bot or an explicit mention in an allowed channel is answered, so
 * ordinary channel conversation is never replied to. No session starts and nothing reaches the
 * agent. An empty `SLACK_UNAUTHORIZED_REPLY` keeps the default silent rejection.
 */
export async function replyToUnauthorizedUser(
  payload: SlackEventPayload,
  env: Env,
  traceId: string | undefined
): Promise<void> {
  const text = env.SLACK_UNAUTHORIZED_REPLY?.trim();
  const event = payload.event;
  if (!text || !event?.channel || !event.ts || !event.user || event.bot_id) return;

  const isDirectMessage =
    event.type === "message" &&
    event.channel.startsWith("D") &&
    (!event.subtype || event.subtype === "file_share");
  const allowedChannels = new Set(
    (env.SLACK_ALLOWED_CHANNEL_IDS ?? "").split(",").map((id) => id.trim())
  );
  const isAllowedMention = event.type === "app_mention" && allowedChannels.has(event.channel);
  if (!isDirectMessage && !isAllowedMention) return;

  try {
    const result = await postMessage(env.SLACK_BOT_TOKEN, event.channel, text, {
      thread_ts: event.thread_ts ?? event.ts,
    });
    log.info("slack.ingress.unauthorized_reply", {
      trace_id: traceId,
      channel: event.channel,
      user: event.user,
      ok: result.ok,
    });
  } catch (error) {
    log.warn("slack.ingress.unauthorized_reply_failed", {
      trace_id: traceId,
      channel: event.channel,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
