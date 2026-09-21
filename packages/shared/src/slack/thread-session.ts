import { z } from "zod";

/**
 * The thread-to-session mapping that gives a Slack thread conversational continuity.
 *
 * Two workers touch this record and they must agree exactly. The Slack bot reads it when someone
 * replies in a thread; the control plane writes it when a session posts a top-level message, so that
 * replying to an automation-delivered report continues the session that produced the report rather
 * than starting a cold one. The key format and the schema live here, in shared, because a silent
 * divergence between the writer and the reader would surface only as Marcus ignoring a reply --
 * `safeParse` failing returns null, and the reply path treats null as "no mapping" and does nothing.
 */
export const THREAD_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function threadSessionKey(channel: string, threadTs: string): string {
  return `thread:${channel}:${threadTs}`;
}

export interface ThreadSession {
  sessionId: string;
  /** Session-target id: the repo id ("owner/name") or environment id ("env_…"). */
  repoId: string;
  /** Session-target display label: the repo fullName or environment name. */
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  /** Unix timestamp of when the session was created. Used for debugging and observability. */
  createdAt: number;
  /** Slack ts of the last prompt delivered, so interim thread messages can be replayed once. */
  lastPromptTs?: string;
}

export const threadSessionSchema: z.ZodType<ThreadSession> = z.object({
  sessionId: z.string().min(1),
  repoId: z.string().min(1),
  repoFullName: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
  createdAt: z.number().finite().nonnegative(),
  lastPromptTs: z.string().min(1).optional(),
});
