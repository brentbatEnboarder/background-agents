/**
 * The one list of Slack users who may use the Slack bot: the configured `SLACK_ALLOWED_USER_IDS`
 * plus any users an operator added in the Slack bot's KV under `slack:allowed-users`.
 *
 * Every Slack-user admission decision (the Slack bot's ingress, the control plane's automation
 * direct messages) reads it through this module, so there is no second list to keep in step.
 *
 * The configured list is the floor: KV can only add users, an unreadable or invalid KV value admits
 * the floor alone, and an empty or invalid configured list admits nobody (KV never bootstraps it).
 */
export const SLACK_ALLOWED_USERS_KV_KEY = "slack:allowed-users";
/** How long a Worker may serve a cached copy of the KV additions. */
export const SLACK_ALLOWED_USERS_CACHE_TTL_SECONDS = 60;
const SLACK_USER_ID = /^[UW][A-Z0-9]+$/;

export interface AllowedSlackUsersKv {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>;
}

export interface AllowedSlackUsers {
  /** Null when the configured list is empty or invalid: nobody is admitted. */
  userIds: ReadonlySet<string> | null;
  /** What the KV additions contributed; `applied` is the only status that added users. */
  kv: "applied" | "absent" | "unavailable" | "invalid";
}

/** Parses a comma-separated Slack user ID list; null when empty or when any entry is invalid. */
export function parseSlackUserIdList(value: string | undefined): Set<string> | null {
  const ids = (value ?? "").split(",").map((id) => id.trim());
  if (ids.some((id) => !SLACK_USER_ID.test(id))) return null;
  return new Set(ids);
}

/** Parses the KV value of operator-added users (comma- or whitespace-separated user IDs). */
export function parseSlackAllowedUserAdditions(
  stored: string | null
): { status: "applied"; userIds: string[] } | { status: "absent" | "invalid" } {
  const userIds = (stored ?? "").split(/[\s,]+/).filter((id) => id !== "");
  if (userIds.length === 0) return { status: "absent" };
  if (userIds.some((id) => !SLACK_USER_ID.test(id))) return { status: "invalid" };
  return { status: "applied", userIds };
}

export async function resolveAllowedSlackUserIds(
  configured: string | undefined,
  kv: AllowedSlackUsersKv | undefined
): Promise<AllowedSlackUsers> {
  const floor = parseSlackUserIdList(configured);
  if (!floor) return { userIds: null, kv: "absent" };
  if (!kv) return { userIds: floor, kv: "absent" };
  let stored: string | null;
  try {
    stored = await kv.get(SLACK_ALLOWED_USERS_KV_KEY, {
      cacheTtl: SLACK_ALLOWED_USERS_CACHE_TTL_SECONDS,
    });
  } catch {
    return { userIds: floor, kv: "unavailable" };
  }
  const additions = parseSlackAllowedUserAdditions(stored);
  if (additions.status !== "applied") return { userIds: floor, kv: additions.status };
  return { userIds: new Set([...floor, ...additions.userIds]), kv: "applied" };
}
