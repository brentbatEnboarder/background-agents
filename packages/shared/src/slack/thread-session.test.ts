import { describe, expect, it } from "vitest";

import {
  THREAD_SESSION_TTL_SECONDS,
  threadSessionKey,
  threadSessionSchema,
} from "./thread-session";

describe("threadSessionKey", () => {
  it("builds the key both workers agree on", () => {
    // The control plane writes this key and the Slack bot reads it. If they ever disagree the only
    // symptom is Marcus silently ignoring a reply, so the format is pinned by test.
    expect(threadSessionKey("C123", "111.222")).toBe("thread:C123:111.222");
  });
});

describe("threadSessionSchema", () => {
  const valid = {
    sessionId: "s_1",
    repoId: "env_abc",
    repoFullName: "GTM_Analysis",
    model: "openai/gpt-6-astra",
    createdAt: 1_700_000_000_000,
  };

  it("accepts a record with no repo, as an environment session writes", () => {
    expect(threadSessionSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the optional fields", () => {
    expect(
      threadSessionSchema.safeParse({
        ...valid,
        reasoningEffort: "medium",
        lastPromptTs: "111.222",
      }).success
    ).toBe(true);
  });

  it("rejects the shapes that would make a reply vanish", () => {
    // An empty label would be shown to a user; a missing model breaks the callback context. Both
    // fail parsing, and a failed parse reads as "no mapping", which is the silent-failure mode.
    expect(threadSessionSchema.safeParse({ ...valid, repoFullName: "" }).success).toBe(false);
    expect(threadSessionSchema.safeParse({ ...valid, model: undefined }).success).toBe(false);
    expect(threadSessionSchema.safeParse({ ...valid, sessionId: "" }).success).toBe(false);
  });

  it("round-trips through JSON as KV stores it", () => {
    const parsed = threadSessionSchema.safeParse(JSON.parse(JSON.stringify(valid)));
    expect(parsed.success).toBe(true);
  });
});

describe("THREAD_SESSION_TTL_SECONDS", () => {
  it("is seven days in seconds, the unit Cloudflare KV expects", () => {
    expect(THREAD_SESSION_TTL_SECONDS).toBe(604800);
  });
});
