import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

afterEach(cleanD1Tables);

describe("migration 0079: automation Slack delivery mention user", () => {
  it("adds a nullable Slack user ID constrained to fixed-destination automations", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(automations)").all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toContain("slack_delivery_mention_user_id");

    await env.DB.prepare(
      `INSERT INTO automations
         (id, name, instructions, trigger_type, schedule_tz, model, enabled,
          consecutive_failures, created_by, created_at, updated_at, slack_delivery_channel,
          slack_delivery_mention_user_id)
       VALUES ('auto-1', 'Delivery', 'Deliver', 'webhook', 'UTC', 'test-model', 0,
               0, 'user-1', 1000, 1000, 'C0C0MEE8F7E', 'U0C0MEE8F7E')`
    ).run();

    await expect(
      env.DB.prepare(
        "UPDATE automations SET slack_delivery_mention_user_id = 'uBad' WHERE id = 'auto-1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE automations SET slack_delivery_channel = NULL WHERE id = 'auto-1'"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE automations SET slack_delivery_mention_user_id = NULL, slack_delivery_channel = NULL WHERE id = 'auto-1'"
    ).run();
  });
});
