/**
 * Forward Slack files into a session as prompt
 * attachments.
 *
 * Slack file bytes live behind `url_private`, which requires the bot token to
 * download (and the `files:read` scope). Raw Slack file payloads are
 * classified once at event ingress; every later stage works with that
 * result. Each supported file is downloaded and uploaded to the control
 * plane's session-attachments store; the prompt then carries only
 * `{ attachmentId, name }` references, matching how the web composer attaches
 * files.
 */

import { postMessage, type SlackMessageFile } from "@open-inspect/shared/slack";
import {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  SESSION_ATTACHMENT_DOCUMENT_MIME_TYPES,
  SESSION_ATTACHMENT_TEXT_MAX_BYTES,
  SESSION_ATTACHMENT_PDF_MAX_BYTES,
  sessionAttachmentUploadResponseSchema,
  type SessionAttachmentReference,
} from "@open-inspect/shared/types/session-attachments";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "./request-options";
import type { Env } from "./types";

const log = createLogger("attachments");

const ATTACHMENT_NAME_MAX_LENGTH = 255;

// Match the control-plane signed multipart ceiling, including form overhead.
const MAX_MULTIPART_BYTES = SESSION_ATTACHMENT_IMAGE_MAX_BYTES + 128 * 1024;
const SUPPORTED_MIME_TYPES = new Set<string>([
  ...SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  ...SESSION_ATTACHMENT_DOCUMENT_MIME_TYPES,
]);

/** Prompt body used when a message carries files but no user text. */
export const ATTACHMENT_ONLY_PROMPT_TEXT = "See the attached file(s).";

/**
 * A Slack-attached file validated at event ingress: supported mime type and a
 * Slack-hosted download URL the bot token may be sent to. This is the only
 * shape that flows past the event handlers — raw `SlackMessageFile` payloads
 * never reach downloads, session launch, or KV state.
 */
export interface SlackAttachment {
  /** Slack file id, used for log correlation only. */
  id?: string;
  /** Display name, bounded to the attachment store's length limit. */
  name: string;
  mimetype: string;
  /** Declared size in bytes, when Slack provided one. */
  size?: number;
  /** https URL on slack.com / *.slack.com serving the file bytes. */
  downloadUrl: string;
}
export type ClassifiedSlackFile =
  | { attachment: SlackAttachment; dropReason?: never }
  | { attachment?: never; dropReason: SlackAttachmentDropReason };

/** Why an attached file did not make it to the session. */
export type SlackAttachmentDropReason =
  | "unsupported_format"
  | "untrusted_url"
  | "download_failed"
  | "empty"
  | "invalid_content"
  | "too_large"
  | "over_cap"
  | "upload_rejected";

/** Downloaded file bytes plus a record of every file that was lost. */
export interface PreparedAttachments {
  files: Array<{ attachment: SlackAttachment; bytes: Uint8Array }>;
  /**
   * One entry per file the user attached that did NOT make it through, so
   * callers can surface a visible warning tailored
   * to the reason — instead of silently dropping it.
   */
  dropped: SlackAttachmentDropReason[];
}

export interface SlackAttachmentUploadResult {
  references: SessionAttachmentReference[];
  /** Drop reasons carried over from download plus any upload failures. */
  dropped: SlackAttachmentDropReason[];
  /**
   * True when every upload was rejected with 404 — the session no longer
   * exists, so the failures are stale-session noise rather than real drops.
   */
  sessionMissing: boolean;
}

/**
 * Only Slack-hosted file URLs may see the bot token. File objects arrive on
 * webhook payloads, and Slack "remote" files (files.remote.add) carry an
 * arbitrary registrant-supplied `url_private` — following one would hand the
 * `Authorization: Bearer` header to that host.
 */
function isTrustedSlackFileUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return (
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))
  );
}

/** Keep unsupported and invalid files in place; extensions only refine generic text. */
export function classifySlackFiles(files: SlackMessageFile[] | undefined): ClassifiedSlackFile[] {
  return (files ?? []).map((file) => {
    const rawName = file.name || file.title || "file";
    const extension = /\.([a-z]+)$/i.exec(rawName)?.[1]?.toLowerCase();
    let mimetype = file.mimetype;
    if (mimetype === "text/plain") {
      if (extension === "md" || extension === "markdown") mimetype = "text/markdown";
      if (extension === "csv") mimetype = "text/csv";
      if (extension === "tsv") mimetype = "text/tab-separated-values";
    }
    if (!mimetype || !SUPPORTED_MIME_TYPES.has(mimetype))
      return { dropReason: "unsupported_format" };
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl || file.mode === "external" || !isTrustedSlackFileUrl(downloadUrl)) {
      return { dropReason: "untrusted_url" };
    }
    const name =
      [...rawName]
        .filter((character) => {
          const code = character.codePointAt(0)!;
          return code > 31 && code !== 127;
        })
        .join("")
        .slice(0, ATTACHMENT_NAME_MAX_LENGTH) || "file";
    return { attachment: { id: file.id, name, mimetype, size: file.size, downloadUrl } };
  });
}

function maxBytes(mimetype: string): number {
  if (mimetype.startsWith("text/")) return SESSION_ATTACHMENT_TEXT_MAX_BYTES;
  return mimetype === "application/pdf"
    ? SESSION_ATTACHMENT_PDF_MAX_BYTES
    : SESSION_ATTACHMENT_IMAGE_MAX_BYTES;
}

/**
 * Fetch a file's bytes with the bot token, enforcing the trusted host policy
 * (re-checked here as defense in depth) and its byte cap. Returns a drop
 * reason instead of bytes when the file cannot be safely fetched.
 */
async function downloadSlackFile(
  token: string,
  attachment: SlackAttachment,
  traceId?: string
): Promise<{ bytes: Uint8Array } | { dropReason: SlackAttachmentDropReason }> {
  if (!isTrustedSlackFileUrl(attachment.downloadUrl)) {
    log.warn("slack.attachment.untrusted_url", { trace_id: traceId, file_id: attachment.id });
    return { dropReason: "untrusted_url" };
  }
  try {
    const res = await fetch(attachment.downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      // A redirect off *.slack.com must not carry the token; fail instead.
      redirect: "manual",
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok || res.redirected || (res.status >= 300 && res.status < 400)) {
      log.warn("slack.attachment.download_failed", {
        trace_id: traceId,
        file_id: attachment.id,
        http_status: res.status,
      });
      return { dropReason: "download_failed" };
    }
    const contentLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes(attachment.mimetype)) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: attachment.id,
        size_bytes: contentLength,
      });
      return { dropReason: "too_large" };
    }
    const bytes = await readBodyCapped(res.body, maxBytes(attachment.mimetype));
    if (bytes === null || bytes.byteLength === 0) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: attachment.id,
        size_bytes: bytes === null ? -1 : 0,
      });
      return { dropReason: bytes === null ? "too_large" : "empty" };
    }
    return { bytes };
  } catch {
    log.warn("slack.attachment.download_error", {
      trace_id: traceId,
      file_id: attachment.id,
      error_category: "network_error",
    });
    return { dropReason: "download_failed" };
  }
}

/**
 * Download bytes for the (capped) attachments concurrently. Runs before
 * a session exists so a file-only request with no usable bytes can stop; bounds wall-clock time to a single
 * download timeout regardless of file count, keeping the work well inside the
 * Worker's post-response `waitUntil` window.
 */
export async function prepareAttachments(
  env: Env,
  attachments: ClassifiedSlackFile[],
  traceId?: string
): Promise<PreparedAttachments> {
  if (attachments.length === 0) return { files: [], dropped: [] };

  const eligible = attachments.slice(0, MAX_SESSION_ATTACHMENTS_PER_MESSAGE);
  const dropped: SlackAttachmentDropReason[] = [];
  type DownloadOutcome =
    | { attachment: SlackAttachment; bytes: Uint8Array }
    | { dropReason: SlackAttachmentDropReason };
  const outcomes = await Promise.all(
    eligible.map(async (entry): Promise<DownloadOutcome> => {
      if (entry.dropReason) return { dropReason: entry.dropReason };
      const attachment = entry.attachment;
      if (typeof attachment.size === "number" && attachment.size > maxBytes(attachment.mimetype)) {
        log.warn("slack.attachment.too_large", {
          trace_id: traceId,
          file_id: attachment.id,
          size_bytes: attachment.size,
        });
        return { dropReason: "too_large" };
      }
      const download = await downloadSlackFile(env.SLACK_BOT_TOKEN, attachment, traceId);
      return "dropReason" in download
        ? { dropReason: download.dropReason }
        : { attachment, bytes: download.bytes };
    })
  );

  const files: PreparedAttachments["files"] = [];
  for (const outcome of outcomes) {
    if ("bytes" in outcome) files.push({ attachment: outcome.attachment, bytes: outcome.bytes });
    else dropped.push(outcome.dropReason);
  }
  for (const _ of attachments.slice(MAX_SESSION_ATTACHMENTS_PER_MESSAGE)) {
    dropped.push("over_cap");
  }
  return { files, dropped };
}

/**
 * Store one file in the session's attachment store and return the prompt
 * reference, or the failure kind when the control plane rejects it.
 */
async function uploadToSession(
  env: Env,
  sessionId: string,
  file: PreparedAttachments["files"][number],
  authorId: string,
  traceId?: string
): Promise<
  | { reference: SessionAttachmentReference }
  | { sessionMissing: boolean; dropReason: SlackAttachmentDropReason }
> {
  const { attachment, bytes } = file;
  try {
    const formData = new FormData();
    formData.append("file", new File([bytes], attachment.name, { type: attachment.mimetype }));
    // sig1 hashes the exact body bytes, so the multipart form (whose boundary
    // is generated at serialization time) is serialized ONCE here; the signed
    // bytes, the Content-Type boundary, and the bytes sent are all from this
    // single serialization.
    const serialized = new Request("https://internal/", { method: "POST", body: formData });
    const multipartBytes = new Uint8Array(await serialized.arrayBuffer());
    if (multipartBytes.byteLength > MAX_MULTIPART_BYTES)
      return { sessionMissing: false, dropReason: "too_large" };
    const contentType = serialized.headers.get("Content-Type");
    if (!contentType) {
      throw new Error("FormData serialization produced no Content-Type");
    }
    const response = await signedControlPlaneFetch(
      env,
      {
        method: "POST",
        url: `https://internal/sessions/${sessionId}/attachments`,
        body: { bytes: multipartBytes, contentType },
        actor: authorId.startsWith("slack:") ? authorId : undefined,
        traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      log.warn("slack.attachment.upload_failed", {
        trace_id: traceId,
        session_id: sessionId,
        file_id: attachment.id,
        http_status: response.status,
      });
      return {
        sessionMissing: response.status === 404,
        dropReason:
          response.status === 400
            ? "invalid_content"
            : response.status === 413
              ? "too_large"
              : "upload_rejected",
      };
    }
    const parsed = sessionAttachmentUploadResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.mimeType !== attachment.mimetype) {
      log.warn("slack.attachment.upload_failed", {
        trace_id: traceId,
        session_id: sessionId,
        file_id: attachment.id,
        error_category: "invalid_response",
      });
      return { sessionMissing: false, dropReason: "upload_rejected" };
    }
    return { reference: { attachmentId: parsed.data.attachmentId, name: attachment.name } };
  } catch {
    log.warn("slack.attachment.upload_error", {
      trace_id: traceId,
      session_id: sessionId,
      file_id: attachment.id,
      error_category: "upload_error",
    });
    return { sessionMissing: false, dropReason: "upload_rejected" };
  }
}

/**
 * Store the prepared files as attachments on `sessionId` concurrently,
 * returning prompt references in the original order. Failed uploads are
 * recorded (never thrown) so a bad file never blocks the message; the result
 * carries the prepare-stage drops forward so one notification covers both.
 */
export async function uploadPreparedAttachments(
  env: Env,
  sessionId: string,
  prepared: PreparedAttachments,
  authorId: string,
  traceId?: string
): Promise<SlackAttachmentUploadResult> {
  const outcomes = await Promise.all(
    prepared.files.map((file) => uploadToSession(env, sessionId, file, authorId, traceId))
  );
  const references: SessionAttachmentReference[] = [];
  const dropped: SlackAttachmentDropReason[] = [...prepared.dropped];
  const failures: Array<{ sessionMissing: boolean; dropReason: SlackAttachmentDropReason }> = [];
  for (const outcome of outcomes) {
    if ("reference" in outcome) references.push(outcome.reference);
    else {
      dropped.push(outcome.dropReason);
      failures.push(outcome);
    }
  }
  return {
    references,
    dropped,
    sessionMissing:
      references.length === 0 && failures.length > 0 && failures.every((f) => f.sessionMissing),
  };
}

/**
 * Tell the user how many of their attached files could not be forwarded, with
 * guidance matched to why. Call this only once the prompt outcome is known —
 * uploads against a stale session fail spuriously and are retried against the
 * replacement session. Best effort — never blocks the message.
 */
export async function notifyDroppedAttachments(
  env: Env,
  channel: string,
  threadTs: string,
  result: { references: SessionAttachmentReference[]; dropped: SlackAttachmentDropReason[] },
  options: {
    traceId?: string;
    /** True when no run started at all because every file was lost. */
    nothingSent?: boolean;
  } = {}
): Promise<void> {
  const { traceId, nothingSent } = options;
  const droppedCount = result.dropped.length;
  if (droppedCount <= 0) return;
  const noun = droppedCount === 1 ? "file" : "files";
  const pronoun = droppedCount === 1 ? "it wasn't" : "they weren't";
  const reasons = new Set(result.dropped);
  const hints: string[] = [];
  if (reasons.has("download_failed")) {
    hints.push(
      "If this keeps happening, the bot may be missing the `files:read` Slack scope — an admin can add it and reinstall the app."
    );
  }
  if (reasons.has("unsupported_format")) hints.push("Unsupported format.");
  if (reasons.has("untrusted_url")) hints.push("Untrusted or unavailable Slack download URL.");
  if (reasons.has("empty")) hints.push("Empty file.");
  if (reasons.has("invalid_content"))
    hints.push(
      "Declared type conflicts with the contents, or the file contains invalid text or PDF data."
    );
  if (reasons.has("too_large"))
    hints.push("Text files must be 2 MB or smaller; PDFs and images must be 10 MB or smaller.");
  if (reasons.has("over_cap")) {
    hints.push(`I can forward at most ${MAX_SESSION_ATTACHMENTS_PER_MESSAGE} files per message.`);
  }
  if (reasons.has("upload_rejected")) hints.push("The attachment upload was rejected.");
  if (nothingSent)
    hints.push(
      "Accepted formats: PNG, JPEG, WebP, GIF, Markdown, TXT, CSV, TSV, and text-based PDF."
    );
  const consequence = nothingSent
    ? "so I didn't start on this request"
    : `so ${pronoun} sent to the agent`;
  const message = [
    `:warning: I couldn't read ${droppedCount} attached ${noun}, ${consequence}.`,
    ...hints,
  ].join(" ");
  const postResult = await postMessage(env.SLACK_BOT_TOKEN, channel, message, {
    thread_ts: threadTs,
  });
  if (!postResult.ok) {
    log.warn("slack.attachment.notify_failed", {
      trace_id: traceId,
      channel,
      slack_error: postResult.error,
    });
  }
}
