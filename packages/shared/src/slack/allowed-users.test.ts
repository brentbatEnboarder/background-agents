import { describe, expect, it, vi } from "vitest";
import { SLACK_ALLOWED_USERS_KV_KEY, resolveAllowedSlackUserIds } from "./allowed-users";

function kv(value: string | null | Error) {
  return {
    get: vi.fn(async () => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe("resolveAllowedSlackUserIds (the one list of who may use the Slack bot)", () => {
  it("is the configured users plus the users added in KV", async () => {
    const store = kv("U086E0ML2AJ,\nU777 ");

    const list = await resolveAllowedSlackUserIds("U123, U456", store);

    expect([...list.userIds!].sort()).toEqual(["U086E0ML2AJ", "U123", "U456", "U777"]);
    expect(list.kv).toBe("applied");
    expect(store.get).toHaveBeenCalledWith(SLACK_ALLOWED_USERS_KV_KEY, { cacheTtl: 60 });
  });

  it("is the configured users alone when KV is empty, missing, unreadable or invalid", async () => {
    const cases = [
      [kv(null), "absent"],
      [kv(""), "absent"],
      [undefined, "absent"],
      [kv(new Error("kv down")), "unavailable"],
      [kv("U086E0ML2AJ,C123"), "invalid"],
    ] as const;
    for (const [store, status] of cases) {
      const list = await resolveAllowedSlackUserIds("U123", store);
      expect([...list.userIds!]).toEqual(["U123"]);
      expect(list.kv).toBe(status);
    }
  });

  it("admits nobody when the configured list is empty or invalid, whatever KV holds", async () => {
    for (const configured of [undefined, "", "  ", "not-a-user", "U123,,U456"]) {
      const store = kv("U086E0ML2AJ");
      const list = await resolveAllowedSlackUserIds(configured, store);
      expect(list.userIds).toBeNull();
      expect(store.get).not.toHaveBeenCalled();
    }
  });
});
