import { describe, expect, it, vi } from "vitest";
import type { SlackEventPayload } from "./events/payload";
import {
  SLACK_ALLOWED_USERS_KV_KEY,
  admitSlackEvent,
  resolveIngressBindings,
  type SlackIngressBindings,
} from "./ingress-policy";

const configured: SlackIngressBindings = {
  SLACK_APP_ID: "A123",
  SLACK_TEAM_ID: "T123",
  SLACK_ALLOWED_USER_IDS: "U123",
  SLACK_ALLOWED_CHANNEL_IDS: "C123",
};

function kv(value: string | null | Error) {
  return {
    get: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

function dm(user: string): SlackEventPayload {
  return {
    type: "event_callback",
    api_app_id: "A123",
    team_id: "T123",
    event: { type: "message", channel_type: "im", user, channel: "D123", text: "hi", ts: "1.1" },
  };
}

async function admitted(env: Parameters<typeof resolveIngressBindings>[0], user: string) {
  return admitSlackEvent(dm(user), await resolveIngressBindings(env)).admitted;
}

describe("resolveIngressBindings", () => {
  it("admits users added in KV alongside the configured allowlist", async () => {
    const store = kv("U086E0ML2AJ,\nU777 ");
    const env = { ...configured, SLACK_KV: store };
    expect(await admitted(env, "U123")).toBe(true);
    expect(await admitted(env, "U086E0ML2AJ")).toBe(true);
    expect(await admitted(env, "U777")).toBe(true);
    expect(await admitted(env, "U999")).toBe(false);
    expect(store.get).toHaveBeenCalledWith(SLACK_ALLOWED_USERS_KV_KEY, { cacheTtl: 60 });
  });

  it("keeps the configured allowlist when KV is empty, missing, or unreadable", async () => {
    for (const store of [kv(null), kv(""), kv(new Error("kv down")), undefined]) {
      const env = { ...configured, ...(store ? { SLACK_KV: store } : {}) };
      expect(await admitted(env, "U123")).toBe(true);
      expect(await admitted(env, "U999")).toBe(false);
    }
  });

  it("ignores the whole KV value when any entry is not a user ID", async () => {
    const env = { ...configured, SLACK_KV: kv("U086E0ML2AJ,C123") };
    expect(await admitted(env, "U123")).toBe(true);
    expect(await admitted(env, "U086E0ML2AJ")).toBe(false);
  });

  it("never bootstraps an empty or invalid configured allowlist from KV", async () => {
    for (const list of ["", "not-a-user"]) {
      const env = { ...configured, SLACK_ALLOWED_USER_IDS: list, SLACK_KV: kv("U086E0ML2AJ") };
      const decision = admitSlackEvent(dm("U086E0ML2AJ"), await resolveIngressBindings(env));
      expect(decision).toEqual({
        admitted: false,
        ignored: false,
        reason: "invalid_configuration",
      });
    }
  });
});
