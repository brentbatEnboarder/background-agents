import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import {
  THREAD_SESSION_TTL_SECONDS,
  threadSessionKey,
  threadSessionSchema,
} from "@open-inspect/shared/slack";
import { createLogger } from "../logger";
import { targetId, targetLabel, type SlackSessionTarget } from "../targets";
import type { Env, ThreadSession } from "../types";

const log = createLogger("handler");
// Key format, TTL and schema come from `@open-inspect/shared/slack`: the control plane writes this
// same record when a session posts a top-level message, and a divergence would show up only as a
// reply being silently ignored.
const getThreadSessionKey = threadSessionKey;

export async function lookupThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<ThreadSession | null> {
  try {
    const data = await createKvCacheStore(env.SLACK_KV).get(
      getThreadSessionKey(channel, threadTs),
      "json"
    );
    const result = threadSessionSchema.safeParse(data);
    return result.success ? result.data : null;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

export async function storeThreadSession(
  env: Env,
  channel: string,
  threadTs: string,
  session: ThreadSession
): Promise<void> {
  try {
    await createKvCacheStore(env.SLACK_KV).put(
      getThreadSessionKey(channel, threadTs),
      JSON.stringify(session),
      { expirationTtl: THREAD_SESSION_TTL_SECONDS }
    );
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

export async function clearThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<void> {
  try {
    await createKvCacheStore(env.SLACK_KV).delete(getThreadSessionKey(channel, threadTs));
  } catch (e) {
    log.error("kv.delete", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/**
 * Advance the thread mapping's lastPromptTs checkpoint. Concurrent follow-ups
 * can complete out of order, and an older one must not move the checkpoint
 * backwards or later prompts would re-include already-forwarded context, so
 * the mapping is re-read and only written when the new ts is strictly newer.
 * KV has no compare-and-swap, so truly simultaneous writes can still race in
 * a narrow window; a lost race only re-includes a few already-forwarded
 * thread messages in a later prompt. No-op when the mapping is gone (e.g.
 * concurrently cleared) so a dead session is never resurrected.
 */
export async function advanceLastPromptTs(
  env: Env,
  channel: string,
  threadTs: string,
  promptTs: string
): Promise<void> {
  const current = await lookupThreadSession(env, channel, threadTs);
  if (!current) return;
  if (current.lastPromptTs && parseFloat(current.lastPromptTs) >= parseFloat(promptTs)) return;
  await storeThreadSession(env, channel, threadTs, { ...current, lastPromptTs: promptTs });
}

export function buildThreadSession(
  sessionId: string,
  target: SlackSessionTarget,
  model: string,
  reasoningEffort?: string,
  lastPromptTs?: string
): ThreadSession {
  return {
    sessionId,
    repoId: targetId(target),
    repoFullName: targetLabel(target),
    model,
    reasoningEffort,
    createdAt: Date.now(),
    lastPromptTs,
  };
}
