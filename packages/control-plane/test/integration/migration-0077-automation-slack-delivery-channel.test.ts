import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

afterEach(cleanD1Tables);

describe("migration 0077: automation Slack delivery channel", () => {
  it("adds a nullable destination constrained to Slack channel IDs", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(automations)").all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toContain("slack_delivery_channel");

    await env.DB.prepare(
      `INSERT INTO automations
         (id, name, instructions, trigger_type, schedule_tz, model, enabled,
          consecutive_failures, created_by, created_at, updated_at, slack_delivery_channel)
       VALUES ('auto-1', 'Delivery', 'Deliver', 'webhook', 'UTC', 'test-model', 0,
               0, 'user-1', 1000, 1000, 'C0C0MEE8F7E')`
    ).run();
    await expect(
      env.DB.prepare(
        "UPDATE automations SET slack_delivery_channel = '#wrong' WHERE id = 'auto-1'"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE automations SET slack_delivery_channel = NULL WHERE id = 'auto-1'"
    ).run();

    expect(
      await env.DB.prepare(
        "SELECT slack_delivery_channel FROM automations WHERE id = 'auto-1'"
      ).first()
    ).toEqual({ slack_delivery_channel: null });
  });
});
