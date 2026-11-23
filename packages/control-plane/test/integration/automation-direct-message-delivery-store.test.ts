import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { AutomationDirectMessageDeliveryStore } from "../../src/db/automation-direct-message-delivery-store";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";

const AUTOMATION: AutomationRow = {
  id: "auto-direct-message",
  name: "Direct message delivery",
  instructions: "Answer replies in the delivered thread.",
  trigger_type: "webhook",
  schedule_cron: null,
  schedule_tz: "UTC",
  harness: "opencode",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: null,
  consecutive_failures: 0,
  created_by: "user-1",
  user_id: "user-1",
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: "hash",
  slack_delivery_channel: null,
  slack_delivery_mention_user_id: null,
};

const CLAIM = {
  automation_id: AUTOMATION.id,
  idempotency_key: "weekly-brief:2026-11-29:U0123456789",
  recipient_user_id: "U0123456789",
  text_sha256: "a".repeat(64),
  thread_context: '{"kind":"opaque","draftId":"d-1"}',
  created_at: 100,
};

describe("AutomationDirectMessageDeliveryStore (D1 integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await new AutomationStore(env.DB).create(AUTOMATION);
  });

  it("admits only recipients on the automation's own allowlist", async () => {
    await env.DB.prepare(
      `INSERT INTO automation_direct_message_recipients (automation_id, slack_user_id, created_at)
       VALUES (?, ?, 1)`
    )
      .bind(AUTOMATION.id, "U0123456789")
      .run();
    const store = new AutomationDirectMessageDeliveryStore(env.DB);

    expect(await store.isRecipientAllowed(AUTOMATION.id, "U0123456789")).toBe(true);
    expect(await store.isRecipientAllowed(AUTOMATION.id, "U9999999999")).toBe(false);
    expect(await store.isRecipientAllowed("another-automation", "U0123456789")).toBe(false);
  });

  it("rejects malformed recipient IDs at the schema", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO automation_direct_message_recipients (automation_id, slack_user_id, created_at)
         VALUES (?, 'C0123456789', 1)`
      )
        .bind(AUTOMATION.id)
        .run()
    ).rejects.toThrow();
  });

  it("claims once, stores the thread context verbatim, and completes exactly once", async () => {
    const store = new AutomationDirectMessageDeliveryStore(env.DB);
    const first = await store.claim(CLAIM);
    expect(first.created).toBe(true);
    expect(first.row).toMatchObject({ status: "claimed", thread_context: CLAIM.thread_context });
    expect((await store.claim(CLAIM)).created).toBe(false);

    const completed = await store.complete(AUTOMATION.id, CLAIM.idempotency_key, {
      status: "delivered",
      invocation_id: "inv-1",
      run_id: "run-1",
      session_id: "sess-1",
      channel_id: "D0123456789",
      message_ts: "1700000000.000100",
      thread_mapping: "mapped",
      error_code: null,
      completed_at: 200,
    });
    expect(completed).toMatchObject({
      status: "delivered",
      session_id: "sess-1",
      channel_id: "D0123456789",
      thread_mapping: "mapped",
    });
    await expect(
      store.complete(AUTOMATION.id, CLAIM.idempotency_key, {
        status: "unknown",
        invocation_id: null,
        run_id: null,
        session_id: null,
        channel_id: null,
        message_ts: null,
        thread_mapping: null,
        error_code: "retry",
        completed_at: 300,
      })
    ).rejects.toThrow("already completed");
  });

  it("refuses a parent outside a direct-message conversation", async () => {
    const store = new AutomationDirectMessageDeliveryStore(env.DB);
    await store.claim(CLAIM);
    await expect(
      store.complete(AUTOMATION.id, CLAIM.idempotency_key, {
        status: "delivered",
        invocation_id: "inv-1",
        run_id: "run-1",
        session_id: "sess-1",
        channel_id: "C0123456789",
        message_ts: "1700000000.000100",
        thread_mapping: "mapped",
        error_code: null,
        completed_at: 200,
      })
    ).rejects.toThrow();
  });
});
