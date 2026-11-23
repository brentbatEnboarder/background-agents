import type { SqlDatabase } from "./sql-database";

type AutomationDirectMessageDeliveryStatus =
  | "claimed"
  | "delivered"
  | "thread-mapping-failed"
  | "unknown";

export interface AutomationDirectMessageDeliveryRow {
  automation_id: string;
  idempotency_key: string;
  recipient_user_id: string;
  text_sha256: string;
  /** The caller's opaque thread context, stored verbatim and never interpreted. */
  thread_context: string;
  status: AutomationDirectMessageDeliveryStatus;
  invocation_id: string | null;
  run_id: string | null;
  session_id: string | null;
  channel_id: string | null;
  message_ts: string | null;
  thread_mapping: "mapped" | "failed" | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export type AutomationDirectMessageClaim = Pick<
  AutomationDirectMessageDeliveryRow,
  | "automation_id"
  | "idempotency_key"
  | "recipient_user_id"
  | "text_sha256"
  | "thread_context"
  | "created_at"
>;

export type AutomationDirectMessageCompletion = Pick<
  AutomationDirectMessageDeliveryRow,
  | "status"
  | "invocation_id"
  | "run_id"
  | "session_id"
  | "channel_id"
  | "message_ts"
  | "thread_mapping"
  | "error_code"
  | "completed_at"
>;

/** Recipient allowlist, durable idempotency claims and receipts for automation direct messages. */
export class AutomationDirectMessageDeliveryStore {
  constructor(private readonly db: SqlDatabase) {}

  async isRecipientAllowed(automationId: string, slackUserId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS allowed FROM automation_direct_message_recipients
         WHERE automation_id = ? AND slack_user_id = ?`
      )
      .bind(automationId, slackUserId)
      .first<{ allowed: number }>();
    return row !== null;
  }

  async claim(
    input: AutomationDirectMessageClaim
  ): Promise<{ created: boolean; row: AutomationDirectMessageDeliveryRow }> {
    const result = await this.db
      .prepare(
        `INSERT INTO automation_direct_message_deliveries (
           automation_id, idempotency_key, recipient_user_id, text_sha256,
           thread_context, status, created_at
         ) VALUES (?, ?, ?, ?, ?, 'claimed', ?)
         ON CONFLICT (automation_id, idempotency_key) DO NOTHING`
      )
      .bind(
        input.automation_id,
        input.idempotency_key,
        input.recipient_user_id,
        input.text_sha256,
        input.thread_context,
        input.created_at
      )
      .run();
    const row = await this.get(input.automation_id, input.idempotency_key);
    if (!row) throw new Error("Automation direct message claim was not persisted");
    return { created: (result.meta?.changes ?? 0) === 1, row };
  }

  async get(
    automationId: string,
    idempotencyKey: string
  ): Promise<AutomationDirectMessageDeliveryRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM automation_direct_message_deliveries
         WHERE automation_id = ? AND idempotency_key = ?`
      )
      .bind(automationId, idempotencyKey)
      .first<AutomationDirectMessageDeliveryRow>();
  }

  async complete(
    automationId: string,
    idempotencyKey: string,
    completion: AutomationDirectMessageCompletion
  ): Promise<AutomationDirectMessageDeliveryRow> {
    const result = await this.db
      .prepare(
        `UPDATE automation_direct_message_deliveries
         SET status = ?, invocation_id = ?, run_id = ?, session_id = ?,
             channel_id = ?, message_ts = ?, thread_mapping = ?,
             error_code = ?, completed_at = ?
         WHERE automation_id = ? AND idempotency_key = ? AND status = 'claimed'`
      )
      .bind(
        completion.status,
        completion.invocation_id,
        completion.run_id,
        completion.session_id,
        completion.channel_id,
        completion.message_ts,
        completion.thread_mapping,
        completion.error_code,
        completion.completed_at,
        automationId,
        idempotencyKey
      )
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new Error("Automation direct message delivery was already completed");
    }
    const row = await this.get(automationId, idempotencyKey);
    if (!row) throw new Error("Automation direct message completion was not persisted");
    return row;
  }
}
