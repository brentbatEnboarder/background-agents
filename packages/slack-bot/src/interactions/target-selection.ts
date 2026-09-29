import {
  escapeMrkdwnText,
  getMessageDetails,
  postMessage,
  updateMessage,
} from "@open-inspect/shared/slack";
import {
  classifySlackFiles,
  notifyDroppedAttachments,
  type ClassifiedSlackFile,
} from "../attachments";
import { collectForwardedMessages } from "../forwarded-messages";
import { createLogger } from "../logger";
import {
  buildWorkingMessageBlocks,
  scheduleStartingStatus,
  type BackgroundTaskScheduler,
} from "../messages/blocks";
import { formatAttributedRequest } from "../messages/context";
import { deletePendingRequest, getPendingRequest } from "../pending-requests/pending-request-store";
import { startSessionAndSendPrompt } from "../sessions/session-launcher";
import { resolveTargetValue } from "../target-clarification";
import { targetLabel } from "../targets";
import type { Env } from "../types";
import { resolveSlackActorIdentity } from "../user-identity";

const log = createLogger("target-selection");

export async function handleTargetSelection(
  selectedValue: string,
  channel: string,
  messageTs: string,
  threadTs: string | undefined,
  requesterUserId: string | undefined,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  const threadKey = threadTs || messageTs;
  const pendingData = await getPendingRequest(env, channel, threadKey);
  if (!pendingData) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't find your original request. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }

  if (!requesterUserId || pendingData.userId !== requesterUserId) {
    log.warn("slack.target_selection.requester_mismatch", {
      trace_id: traceId,
      outcome: "rejected",
    });
    return;
  }

  const {
    message,
    userId,
    previousMessages,
    channelName,
    channelDescription,
    attachmentOnly,
    imageOnly,
    sourceMessage,
    unattributedPrompt,
  } = pendingData;
  const target = await resolveTargetValue(env, selectedValue, traceId);
  if (!target) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, that repository or environment is no longer available. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }

  // Pending requests persist only the source-message locator; re-fetch the
  // files from Slack now that the target is known.
  let files: ClassifiedSlackFile[] = [];
  if (sourceMessage) {
    const lookup = await getMessageDetails(
      env.SLACK_BOT_TOKEN,
      channel,
      sourceMessage.ts,
      sourceMessage.threadTs
    );
    if (lookup.ok) {
      // The pending prompt already preserves any forwarded-message text, but
      // its images live on the attachment and are re-fetched here like the rest.
      const forwarded = collectForwardedMessages(lookup.attachments);
      files = classifySlackFiles([...lookup.files, ...forwarded.files]);
    } else {
      log.warn("slack.attachment.file_lookup_failed", {
        trace_id: traceId,
        channel,
        message_ts: sourceMessage.ts,
        slack_error: lookup.error,
      });
      files = [{ dropReason: "download_failed" }];
    }
    if (
      (attachmentOnly || imageOnly) &&
      (files.length === 0 || (files.length === 1 && files[0]?.dropReason === "download_failed"))
    ) {
      // The request had no text: without its images there is nothing to run.
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Sorry, I couldn't retrieve the attached file(s) from Slack, so I didn't start on this request. Please try again. Accepted formats: PNG, JPEG, WebP, GIF, Markdown, TXT, CSV, TSV, and text-based PDF.",
        { thread_ts: threadKey }
      );
      return;
    }
  }
  if ((attachmentOnly || imageOnly) && files.length > 0 && files.every((file) => file.dropReason)) {
    await notifyDroppedAttachments(
      env,
      channel,
      threadKey,
      {
        references: [],
        dropped: files
          .slice(0, 6)
          .map((file) => file.dropReason!)
          .concat(files.slice(6).map(() => "over_cap" as const)),
      },
      { traceId, nothingSent: true }
    );
    return;
  }

  const label = escapeMrkdwnText(targetLabel(target));
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  const ackResult = await postMessage(env.SLACK_BOT_TOKEN, channel, `Working on *${label}*...`, {
    thread_ts: threadKey,
    blocks: buildWorkingMessageBlocks(label),
  });
  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  const actor = await resolveSlackActorIdentity(env.SLACK_BOT_TOKEN, userId);
  // Records written before deferred attribution already contain deliverable text.
  const messageText = unattributedPrompt
    ? formatAttributedRequest(actor.senderLabel, message, unattributedPrompt.forwardedMessages)
    : message;
  const sessionResult = await startSessionAndSendPrompt(env, {
    target,
    channel,
    threadTs: threadKey,
    messageText,
    actor,
    // The original message ts isn't persisted with the pending request, so
    // the "Working on..." ack — or the interaction message when the ack post
    // fails — marks where interim thread context resumes.
    messageTs: ackTs ?? messageTs,
    previousMessages,
    channelName,
    channelDescription,
    files,
    attachmentOnly: attachmentOnly || imageOnly,
    traceId,
  });
  if (!sessionResult) return;

  await deletePendingRequest(env, channel, threadKey);
  if (ackTs) {
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, `Working on *${label}*...`, {
      blocks: buildWorkingMessageBlocks(label, {
        sessionId: sessionResult.sessionId,
        webAppUrl: env.WEB_APP_URL,
      }),
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}
