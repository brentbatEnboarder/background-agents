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

  it("ends only a claim made before the cut-off that never completed, as unknown", async () => {
    const store = new AutomationDirectMessageDeliveryStore(env.DB);
    await store.claim(CLAIM);

    const fresh = await store.expireStaleClaim(AUTOMATION.id, CLAIM.idempotency_key, {
      claimedBefore: CLAIM.created_at - 1,
      completedAt: 500,
    });
    expect(fresh).toMatchObject({ status: "claimed", error_code: null, completed_at: null });

    const expired = await store.expireStaleClaim(AUTOMATION.id, CLAIM.idempotency_key, {
      claimedBefore: CLAIM.created_at,
      completedAt: 600,
    });
    expect(expired).toMatchObject({
      status: "unknown",
      error_code: "claim-expired",
      completed_at: 600,
      session_id: null,
      channel_id: null,
    });
    await expect(
      store.complete(AUTOMATION.id, CLAIM.idempotency_key, {
        status: "delivered",
        invocation_id: "inv-1",
        run_id: "run-1",
        session_id: "sess-1",
        channel_id: "D0123456789",
        message_ts: "1700000000.000100",
        thread_mapping: "mapped",
        error_code: null,
        completed_at: 700,
      })
    ).rejects.toThrow("already completed");
  });

  it("leaves a completed delivery as it is", async () => {
    const store = new AutomationDirectMessageDeliveryStore(env.DB);
    await store.claim(CLAIM);
    await store.complete(AUTOMATION.id, CLAIM.idempotency_key, {
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

    const row = await store.expireStaleClaim(AUTOMATION.id, CLAIM.idempotency_key, {
      claimedBefore: 10_000,
      completedAt: 10_000,
    });

    expect(row).toMatchObject({ status: "delivered", error_code: null, completed_at: 200 });
  });
});
