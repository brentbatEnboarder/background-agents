/**
 * This file ships verbatim into the sandbox image and cannot import from the
 * workspace, so REASON_GUIDANCE keys must stay symmetric with
 * SLACK_DENIAL_REASONS in @open-inspect/shared/slack/types by hand.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch } from "./_bridge-client.js";

const HTML_MAX_BYTES = 5 * 1024 * 1024;

const REASON_GUIDANCE = {
  feature_unavailable:
    "The deployment is not configured to send agent notifications. Tell the user this is unavailable.",
  feature_disabled:
    "Agent notifications are disabled for this repository. Ask the user to enable them in integration settings.",
  channel_not_found_or_forbidden:
    "The channel was not found, is archived, or the bot is not in it. If the channel name is correct and not archived, ask the user to invite the bot.",
  empty_message_after_sanitization:
    "The message body was empty after sanitization. Try again with non-empty content.",
  rate_limited: "Slack rate-limited the request. Wait before retrying.",
  slack_api_error: "Slack returned an unexpected error. The post did not go through.",
  delivery_unknown:
    "Slack may have posted the notification, but confirmation timed out. Do not retry automatically; check the channel first to avoid posting it twice.",
  invalid_input: "The notification arguments were invalid; correct them and retry.",
  bridge_error: "Could not reach the control plane to post the notification.",
};

const STATUS_FALLBACK_REASON = {
  400: "invalid_input",
  403: "feature_disabled",
  404: "channel_not_found_or_forbidden",
  422: "empty_message_after_sanitization",
  429: "rate_limited",
  503: "feature_unavailable",
};

function buildFailureEnvelope(reason, message, retryAfter) {
  const guidance = REASON_GUIDANCE[reason] ?? REASON_GUIDANCE.slack_api_error;
  const detail = message ? `${guidance} (${message})` : guidance;
  const envelope = { ok: false, reason, agentMessage: detail };
  if (typeof retryAfter === "number") {
    envelope.retryAfterSeconds = retryAfter;
  }
  return JSON.stringify(envelope);
}

async function readErrorBody(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return { reason: undefined, message: undefined, retryAfter: undefined };
  }
  try {
    const body = JSON.parse(text);
    return {
      reason: typeof body.error === "string" ? body.error : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined,
    };
  } catch {
    return { reason: undefined, message: text || undefined, retryAfter: undefined };
  }
}

export default tool({
  name: "slack-notify",
  description:
    "Post a message to a Slack channel that the user has authorized. For ordinary sessions, use this only when the user explicitly asks you to notify Slack; use the channel they specify and do not guess. The bot must already be invited to the channel. Plain text and Slack mrkdwn only; the server adds attribution. A destination-bound automation always uses its configured channel, may use {{delivery_mention}} to mention its configured recipient (never guess a Slack user ID), and may attach one HTML file to its top-level summary. While processing an interactive Slack-originated prompt, a session may attach one revised HTML file to a new reply in the authenticated source thread; the server ignores supplied channel and thread coordinates for that attachment.",
  args: {
    channel: z
      .string()
      .describe(
        "Target channel as either a channel ID (e.g. C01ABC) or the channel name as the user said it (e.g. ops or #ops). Passed verbatim to Slack — no resolution or lookup."
      ),
    text: z
      .string()
      .describe(
        "Message body. Plain text + Slack mrkdwn (bold *...*, italic _..._, inline code `...`, fenced blocks, lists, blockquotes). No interactive elements. Direct user mentions <@U...> are subject to the workspace's mentions policy; broadcast mentions <!channel>/<!here>/<!subteam^...> are always stripped server-side."
      ),
    thread_ts: z
      .string()
      .optional()
      .describe(
        "Optional Slack thread timestamp to reply within an existing thread. Same channel-membership rules apply."
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Optional short note explaining why you are posting. Recorded server-side for audit; not shown in Slack."
      ),
    filePath: z
      .string()
      .optional()
      .describe(
        "Optional absolute path to one non-empty UTF-8 .html file up to 5 MiB. Available to destination-bound automations and while processing an interactive Slack-originated prompt."
      ),
  },
  async execute(args) {
    let body;
    if (args.filePath) {
      try {
        const info = await stat(args.filePath);
        if (!info.isFile() || info.size === 0 || info.size > HTML_MAX_BYTES) {
          return buildFailureEnvelope(
            "invalid_input",
            "HTML file must be non-empty and at most 5 MiB"
          );
        }
        if (!args.filePath.toLowerCase().endsWith(".html")) {
          return buildFailureEnvelope("invalid_input", "Attachment must use the .html extension");
        }
        const bytes = await readFile(args.filePath);
        const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (html.includes("\0")) {
          return buildFailureEnvelope("invalid_input", "HTML file must not contain NUL bytes");
        }
        if (!/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(html)) {
          return buildFailureEnvelope("invalid_input", "Attachment must contain an HTML document");
        }
        const form = new FormData();
        form.set("channel", args.channel);
        form.set("text", args.text);
        if (args.thread_ts) form.set("thread_ts", args.thread_ts);
        if (args.reason) form.set("reason", args.reason);
        form.set("file", new Blob([bytes], { type: "text/html" }), basename(args.filePath));
        body = form;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildFailureEnvelope("invalid_input", message);
      }
    } else {
      body = JSON.stringify({
        channel: args.channel,
        text: args.text,
        thread_ts: args.thread_ts,
        reason: args.reason,
      });
    }
    let response;
    try {
      response = await bridgeFetch("/slack-notify", {
        method: "POST",
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildFailureEnvelope("bridge_error", message);
    }

    if (response.ok) {
      try {
        const result = await response.json();
        return JSON.stringify(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildFailureEnvelope(
          "slack_api_error",
          `Control plane returned a non-JSON 2xx response: ${message}`
        );
      }
    }

    const { reason, message, retryAfter } = await readErrorBody(response);
    const fallbackReason = STATUS_FALLBACK_REASON[response.status] ?? "slack_api_error";
    const finalReason =
      typeof reason === "string" && Object.hasOwn(REASON_GUIDANCE, reason)
        ? reason
        : fallbackReason;
    return buildFailureEnvelope(finalReason, message, retryAfter);
  },
});
