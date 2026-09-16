import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
/**
 * Intentionally emits no transcript events: the agent's own tool_call event
 * is the single source of truth. Audit detail lives in the structured logs.
 */

import {
  completeExternalUpload,
  getExternalUploadUrl,
  getPermalink,
  postBlocks,
  resolveDeliveryMentionPlaceholder,
  sanitizeAgentText,
  splitIntoSlackSections,
  SLACK_DENIAL_STATUS,
  type SlackNotifySuccessOutput,
  type SlackWireDenialReason,
  updateMessage,
  uploadToExternalUrl,
} from "@open-inspect/shared/slack";
import type { SlackGlobalSettings } from "@open-inspect/shared/types/integrations";
import {
  automationSlackDeliveryChannelSchema,
  automationSlackDeliveryMentionUserIdSchema,
} from "@open-inspect/shared/types/automations";
import { z } from "zod";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { AutomationStore } from "../db/automation-store";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import { createSessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import {
  GITHUB_SANDBOX_FALLBACK_ROUTE,
  json,
  requirePermission,
  type RequestContext,
} from "./shared";

const logger = createLogger("slack-notify");

/**
 * Hard cap on the raw text we accept and persist verbatim in event args. Also
 * the sanitizer's ceiling: text longer than one Slack section is split across
 * consecutive sections rather than cut, so the section limit is not a limit on
 * what an agent may post.
 */
const RAW_TEXT_INPUT_MAX_LENGTH = 12_000;
/** Channel name length cap (Slack max is 80). */
const CHANNEL_INPUT_MAX_LENGTH = 80;
/** Reason field cap; recorded for audit only. */
const REASON_MAX_LENGTH = 500;
export const SLACK_HTML_MAX_BYTES = 5 * 1024 * 1024;
const MULTIPART_OVERHEAD_MAX_BYTES = 64 * 1024;
const activeSlackContextSchema = z.object({
  channel: z.string().min(1),
  threadTs: z.string().min(1),
});

interface ParsedBody {
  channel: string;
  text: string;
  threadTs: string | undefined;
  reason: string | undefined;
  attachment: { filename: string; bytes: Uint8Array } | undefined;
}

interface AuditFields {
  prompt_author_user_id: string | null;
  trigger_source: string | null;
  parent_session_id: string | null;
  repo: string | null;
}

export async function handleSlackNotify(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const sessionId = params.id;

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;
  if (parsed.attachment && ctx.principal?.kind !== "sandbox") {
    return failureResponse(
      "feature_disabled",
      "HTML attachments are available only to the session sandbox."
    );
  }

  const session = await new SessionIndexStore(ctx.db).get(sessionId);
  if (!session) {
    return failureResponse("invalid_input", "Session not found.");
  }

  const repoScope =
    session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null;
  const audit: AuditFields = {
    prompt_author_user_id: session.userId ?? null,
    trigger_source: session.spawnSource ?? null,
    parent_session_id: session.parentSessionId ?? null,
    repo: repoScope,
  };

  let automationChannel: string | null = null;
  let automationMentionUserId: string | null = null;
  if (session.automationId) {
    const automation = await new AutomationStore(ctx.db).getById(session.automationId);
    const storedChannel = automation?.slack_delivery_channel;
    if (storedChannel != null) {
      const channel = automationSlackDeliveryChannelSchema.safeParse(storedChannel);
      if (!channel.success) {
        return failureResponse("invalid_input", "Automation Slack destination is invalid.");
      }
      automationChannel = channel.data;
    }
    if (automation?.slack_delivery_mention_user_id != null) {
      const mentionUserId = automationSlackDeliveryMentionUserIdSchema.safeParse(
        automation.slack_delivery_mention_user_id
      );
      if (!mentionUserId.success || !automationChannel) {
        return failureResponse("invalid_input", "Automation Slack mention user is invalid.");
      }
      automationMentionUserId = mentionUserId.data;
    }
  }
  if (automationChannel && ctx.principal?.kind !== "sandbox") {
    return failureResponse(
      "feature_disabled",
      "Automation-owned Slack delivery is available only to the session sandbox."
    );
  }
  let interactiveSlackContext: z.infer<typeof activeSlackContextSchema> | null = null;
  if (parsed.attachment && !automationChannel) {
    let context: ReturnType<typeof activeSlackContextSchema.safeParse> | null = null;
    try {
      const contextResponse = await createSessionRuntimeClient(env, ctx).fetch(
        sessionId,
        SessionInternalPaths.activeSlackContext
      );
      if (contextResponse.ok) {
        context = activeSlackContextSchema.safeParse(await contextResponse.json());
      }
    } catch {
      context = null;
    }
    if (!context?.success) {
      return failureResponse(
        "feature_disabled",
        "HTML attachments require an active Slack-originated prompt."
      );
    }
    interactiveSlackContext = context.data;
  }
  const effective = {
    ...parsed,
    channel: automationChannel ?? interactiveSlackContext?.channel ?? parsed.channel,
    threadTs: parsed.attachment ? interactiveSlackContext?.threadTs : parsed.threadTs,
    reason: parsed.attachment ? undefined : parsed.reason,
  };

  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    // Error (not warn): a missing token is a deployment misconfig and must reach alerting.
    logger.error("Slack notification denied: SLACK_BOT_TOKEN is not configured", {
      session_id: sessionId,
      reason: "feature_unavailable",
      channel_input: effective.channel,
      request_reason: parsed.reason ?? null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...audit,
    });
    return failureResponse("feature_unavailable", "Slack bot token is not configured.");
  }

  let mentionsPolicy: SlackGlobalSettings["mentionsPolicy"] = "strip";
  if (!automationChannel) {
    const settingsStore = new IntegrationSettingsStore(ctx.db);
    const settings = repoScope
      ? (await settingsStore.getResolvedConfig("slack", repoScope)).settings
      : ((await settingsStore.getGlobal("slack"))?.defaults ?? {});
    const resolved = resolveSlackSettings(settings as Partial<SlackGlobalSettings>);
    mentionsPolicy = resolved.mentionsPolicy;
    if (!resolved.agentNotificationsEnabled) {
      logDenial(sessionId, ctx, effective, audit, "feature_disabled");
      return failureResponse(
        "feature_disabled",
        repoScope
          ? "Slack agent notifications are disabled for this repository."
          : "Slack agent notifications are disabled globally."
      );
    }
  }

  const messageText = automationChannel
    ? resolveDeliveryMentionPlaceholder(parsed.text, automationMentionUserId)
    : parsed.text;
  const sanitized = sanitizeAgentText(messageText, {
    mentionsPolicy,
    ...(automationChannel ? { allowedMentionUserId: automationMentionUserId } : {}),
    maxLength: RAW_TEXT_INPUT_MAX_LENGTH,
  });

  if (sanitized.text.trim().length === 0) {
    logDenial(sessionId, ctx, parsed, audit, "empty_message_after_sanitization");
    return failureResponse(
      "empty_message_after_sanitization",
      "Message body is empty after sanitization."
    );
  }

  const sections = splitIntoSlackSections(sanitized.text);
  const blocks = buildBlocks({
    sections,
    sessionId,
    appName: env.APP_NAME ?? "Open-Inspect",
    webAppUrl: env.WEB_APP_URL,
  });
  // Without top-level text, Slack derives screen-reader text from the blocks.
  const post = await postBlocks(token, effective.channel, blocks, {
    thread_ts: effective.threadTs,
    signal: request.signal,
  });

  if (!post.ok) {
    const reasonCode = mapSlackError(post.error);
    logDenial(sessionId, ctx, effective, audit, reasonCode, post.retryAfter);
    return failureResponse(reasonCode, post.error, post.retryAfter);
  }

  const channelId = post.channel;
  const messageTs = post.ts;
  if (parsed.attachment) {
    const uploadUrl = await getExternalUploadUrl(token, {
      filename: parsed.attachment.filename,
      length: parsed.attachment.bytes.byteLength,
      signal: request.signal,
    });
    if (!uploadUrl.ok) {
      const reasonCode = mapSlackError(uploadUrl.error);
      logDenial(sessionId, ctx, effective, audit, reasonCode, uploadUrl.retryAfter);
      return failureResponse(reasonCode, uploadUrl.error, uploadUrl.retryAfter);
    }
    const upload = await uploadToExternalUrl(
      uploadUrl.upload_url,
      parsed.attachment.bytes,
      "text/html; charset=utf-8",
      request.signal
    );
    if (!upload.ok) {
      const reasonCode = mapSlackError(upload.error);
      logDenial(sessionId, ctx, effective, audit, reasonCode, upload.retryAfter);
      return failureResponse(reasonCode, upload.error, upload.retryAfter);
    }
    const complete = await completeExternalUpload(token, {
      files: [{ id: uploadUrl.file_id, title: parsed.attachment.filename }],
      signal: request.signal,
    });
    if (!complete.ok) {
      const reasonCode = mapSlackError(complete.error);
      logDenial(sessionId, ctx, effective, audit, reasonCode, complete.retryAfter);
      return failureResponse(reasonCode, complete.error, complete.retryAfter);
    }
    if (!complete.files.some(({ id }) => id === uploadUrl.file_id)) {
      logDenial(sessionId, ctx, effective, audit, "slack_api_error");
      return failureResponse("slack_api_error", "Slack did not confirm the uploaded file.");
    }
    const update = await updateMessage(token, channelId, messageTs, sanitized.text, {
      blocks,
      fileIds: [uploadUrl.file_id],
      signal: request.signal,
    });
    if (!update.ok) {
      const reasonCode = mapSlackError(update.error);
      logDenial(sessionId, ctx, effective, audit, reasonCode, update.retryAfter);
      return failureResponse(reasonCode, update.error, update.retryAfter);
    }
  }
  const permalinkResp = await getPermalink(token, channelId, messageTs, { signal: request.signal });
  const permalink = permalinkResp.ok ? permalinkResp.permalink : "";

  const result: SlackNotifySuccessOutput = {
    ok: true,
    channelInput: effective.channel,
    channelId,
    messageTs,
    permalink,
    // Only the raw-input cap can truncate now: the splitter's own ceiling
    // (MAX_RESPONSE_SECTIONS sections) is far above RAW_TEXT_INPUT_MAX_LENGTH,
    // and text that merely exceeds one section is split rather than cut.
    truncated: sanitized.truncated,
    strippedBroadcasts: sanitized.strippedBroadcasts,
    mentionsModified: sanitized.mentionsModified,
  };

  logger.info("Slack notification posted", {
    event: "slack_notify.success",
    session_id: sessionId,
    channel_input: effective.channel,
    channel_id: channelId,
    message_ts: messageTs,
    truncated: sanitized.truncated,
    stripped_broadcasts: sanitized.strippedBroadcasts,
    mentions_modified: sanitized.mentionsModified,
    request_reason: effective.reason ?? null,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    ...audit,
  });

  return json(result);
}

async function parseBody(request: Request): Promise<ParsedBody | Response> {
  if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    return parseMultipartBody(request);
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return failureResponse("invalid_input", "Body must be valid JSON.");
  }

  if (raw === null || typeof raw !== "object") {
    return failureResponse("invalid_input", "Body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const channelValue = typeof body.channel === "string" ? body.channel.trim() : "";
  if (channelValue.length === 0 || channelValue.length > CHANNEL_INPUT_MAX_LENGTH) {
    return failureResponse(
      "invalid_input",
      `channel must be 1..${CHANNEL_INPUT_MAX_LENGTH} characters.`
    );
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length === 0) {
    return failureResponse("invalid_input", "text is required.");
  }
  if (text.length > RAW_TEXT_INPUT_MAX_LENGTH) {
    return failureResponse(
      "invalid_input",
      `text must be at most ${RAW_TEXT_INPUT_MAX_LENGTH} characters.`
    );
  }

  const threadTs =
    typeof body.thread_ts === "string" && body.thread_ts.length > 0 ? body.thread_ts : undefined;
  const rawReason = typeof body.reason === "string" ? body.reason : undefined;
  const reason = rawReason ? rawReason.slice(0, REASON_MAX_LENGTH) : undefined;

  return {
    channel: channelValue,
    text,
    threadTs,
    reason,
    attachment: undefined,
  };
}

async function parseMultipartBody(request: Request): Promise<ParsedBody | Response> {
  const maxBodyBytes = SLACK_HTML_MAX_BYTES + MULTIPART_OVERHEAD_MAX_BYTES;
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return failureResponse("invalid_input", "Multipart body is too large.");
  }
  const reader = request.body?.getReader();
  if (!reader) return failureResponse("invalid_input", "Multipart body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBodyBytes) {
      await reader.cancel();
      return failureResponse("invalid_input", "Multipart body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let form: FormData;
  try {
    form = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return failureResponse("invalid_input", "Body must be valid multipart form data.");
  }
  const allowedFields = new Set(["channel", "text", "thread_ts", "reason", "file"]);
  const counts = new Map<string, number>();
  let attachmentFile: File | undefined;
  for (const [key, value] of form.entries()) {
    if (!allowedFields.has(key))
      return failureResponse("invalid_input", "Unknown multipart field.");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (typeof value !== "string") {
      if (key !== "file" || attachmentFile) {
        return failureResponse("invalid_input", "Exactly one HTML file is allowed.");
      }
      attachmentFile = value;
    }
  }
  if ([...counts.values()].some((count) => count > 1) || !attachmentFile) {
    return failureResponse(
      "invalid_input",
      "Exactly one value per field and one HTML file are required."
    );
  }
  if (
    !attachmentFile.name.toLowerCase().endsWith(".html") ||
    attachmentFile.size === 0 ||
    attachmentFile.size > SLACK_HTML_MAX_BYTES
  ) {
    return failureResponse(
      "invalid_input",
      `file must be a non-empty UTF-8 .html file no larger than ${SLACK_HTML_MAX_BYTES} bytes.`
    );
  }
  const attachmentBytes = new Uint8Array(await attachmentFile.arrayBuffer());
  try {
    const html = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      attachmentBytes
    );
    if (html.includes("\0")) throw new Error("NUL is not allowed");
    if (!/^\s*(?:<!doctype\s+html\b[^>]*>\s*)?<html\b/i.test(html)) {
      return failureResponse("invalid_input", "file must contain an HTML document.");
    }
  } catch {
    return failureResponse("invalid_input", "file must contain valid UTF-8 without NUL bytes.");
  }

  const text = typeof form.get("text") === "string" ? String(form.get("text")) : "";
  const channel = typeof form.get("channel") === "string" ? String(form.get("channel")).trim() : "";
  if (!text || text.length > RAW_TEXT_INPUT_MAX_LENGTH) {
    return failureResponse(
      "invalid_input",
      `text must be 1..${RAW_TEXT_INPUT_MAX_LENGTH} characters.`
    );
  }
  if (!channel || channel.length > CHANNEL_INPUT_MAX_LENGTH) {
    return failureResponse(
      "invalid_input",
      `channel must be 1..${CHANNEL_INPUT_MAX_LENGTH} characters.`
    );
  }
  const threadTs = typeof form.get("thread_ts") === "string" ? String(form.get("thread_ts")) : "";
  const rawReason = typeof form.get("reason") === "string" ? String(form.get("reason")) : "";
  return {
    channel,
    text,
    threadTs: threadTs || undefined,
    reason: rawReason ? rawReason.slice(0, REASON_MAX_LENGTH) : undefined,
    attachment: { filename: attachmentFile.name, bytes: attachmentBytes },
  };
}

function buildBlocks(opts: {
  sections: string[];
  sessionId: string;
  appName: string;
  webAppUrl: string | undefined;
}): unknown[] {
  const blocks: unknown[] = [
    ...opts.sections.map((section) => ({
      type: "section",
      text: { type: "mrkdwn", text: section },
    })),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Posted by ${opts.appName} agent on behalf of a session.`,
        },
      ],
    },
  ];

  if (opts.webAppUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Session" },
          url: `${opts.webAppUrl.replace(/\/$/, "")}/session/${opts.sessionId}`,
        },
      ],
    });
  }

  return blocks;
}

function mapSlackError(slackError: string | undefined): SlackWireDenialReason {
  if (!slackError) return "slack_api_error";
  if (
    slackError === "channel_not_found" ||
    slackError === "not_in_channel" ||
    slackError === "is_archived"
  ) {
    return "channel_not_found_or_forbidden";
  }
  if (slackError === "ratelimited") return "rate_limited";
  if (slackError === "delivery_unknown") return "delivery_unknown";
  return "slack_api_error";
}

function failureResponse(
  reason: SlackWireDenialReason,
  message: string | undefined,
  retryAfter?: number
): Response {
  const body: Record<string, unknown> = { error: reason };
  if (message) body.message = message;
  if (typeof retryAfter === "number") body.retryAfter = retryAfter;
  return json(body, SLACK_DENIAL_STATUS[reason]);
}

function logDenial(
  sessionId: string,
  ctx: RequestContext,
  parsed: ParsedBody,
  audit: AuditFields,
  reason: SlackWireDenialReason,
  retryAfter?: number
): void {
  logger.warn("Slack notification denied", {
    event: "slack_notify.denial",
    session_id: sessionId,
    reason,
    channel_input: parsed.channel,
    request_reason: parsed.reason ?? null,
    has_thread_ts: parsed.threadTs !== undefined,
    retry_after: retryAfter ?? null,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    ...audit,
  });
}

export const slackNotifyRoutes = new Hono<ControlPlaneHonoEnv>();

// Agent-initiated Slack notification (sandbox-authenticated).
slackNotifyRoutes.post(
  "/sessions/:id/slack-notify",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requirePermission("sessions.collaborate"),
  }),
  (c) => dispatch(c, handleSlackNotify)
);
