import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { AutomationArtifactDeliveryStore } from "../../src/db/automation-artifact-delivery-store";
import { AutomationStore, type AutomationRow } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";

const AUTOMATION: AutomationRow = {
  id: "auto-artifact",
  name: "Artifact delivery",
  instructions: "Preserve immutable evidence.",
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
  slack_delivery_channel: "C0123456789",
  slack_delivery_mention_user_id: null,
};

describe("AutomationArtifactDeliveryStore (D1 integration)", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await new AutomationStore(env.DB).create(AUTOMATION);
  });

  it("claims one immutable request, deduplicates it, and persists mapped delivery", async () => {
    const store = new AutomationArtifactDeliveryStore(env.DB);
    const claim = {
      automation_id: AUTOMATION.id,
      idempotency_key: "weekly:2026-10-17",
      report_sha256: "a".repeat(64),
      summary_sha256: "b".repeat(64),
      context_sha256: "c".repeat(64),
      evidence_bundle_id: "bundle-1",
      workflow_version: "weekly/v1",
      reporting_starts_on: "2026-10-11",
      reporting_ends_on: "2026-10-17",
      report_revision: 1,
      created_at: 100,
    };
    expect((await store.claim(claim)).created).toBe(true);
    expect((await store.claim(claim)).created).toBe(false);

    const completed = await store.complete(AUTOMATION.id, claim.idempotency_key, {
      status: "delivered",
      invocation_id: "inv-1",
      run_id: "run-1",
      session_id: "sess-1",
      channel_id: "C0123456789",
      message_ts: "1.2",
      attachment_id: "F1",
      thread_mapping: "mapped",
      error_code: null,
      completed_at: 200,
    });
    expect(completed).toMatchObject({
      status: "delivered",
      invocation_id: "inv-1",
      session_id: "sess-1",
      thread_mapping: "mapped",
    });
    await expect(
      store.complete(AUTOMATION.id, claim.idempotency_key, {
        status: "unknown",
        invocation_id: null,
        run_id: null,
        session_id: null,
        channel_id: null,
        message_ts: null,
        attachment_id: null,
        thread_mapping: null,
        error_code: "retry",
        completed_at: 300,
      })
    ).rejects.toThrow("already completed");
  });
});
