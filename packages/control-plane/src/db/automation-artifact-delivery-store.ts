import type { SqlDatabase } from "./sql-database";

export type AutomationArtifactDeliveryStatus =
  | "claimed"
  | "delivered"
  | "attachment-failed"
  | "thread-mapping-failed"
  | "unknown";

export interface AutomationArtifactDeliveryRow {
  automation_id: string;
  idempotency_key: string;
  report_sha256: string;
  summary_sha256: string;
  context_sha256: string;
  evidence_bundle_id: string;
  workflow_version: string;
  reporting_starts_on: string;
  reporting_ends_on: string;
  report_revision: number;
  status: AutomationArtifactDeliveryStatus;
  invocation_id: string | null;
  run_id: string | null;
  session_id: string | null;
  channel_id: string | null;
  message_ts: string | null;
  attachment_id: string | null;
  thread_mapping: "mapped" | "failed" | null;
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
}

export type AutomationArtifactClaim = Pick<
  AutomationArtifactDeliveryRow,
  | "automation_id"
  | "idempotency_key"
  | "report_sha256"
  | "summary_sha256"
  | "context_sha256"
  | "evidence_bundle_id"
  | "workflow_version"
  | "reporting_starts_on"
  | "reporting_ends_on"
  | "report_revision"
  | "created_at"
>;

export class AutomationArtifactDeliveryStore {
  constructor(private readonly db: SqlDatabase) {}

  async claim(
    input: AutomationArtifactClaim
  ): Promise<{ created: boolean; row: AutomationArtifactDeliveryRow }> {
    const result = await this.db
      .prepare(
        `INSERT INTO automation_artifact_deliveries (
           automation_id, idempotency_key, report_sha256, summary_sha256,
           context_sha256, evidence_bundle_id,
           workflow_version, reporting_starts_on, reporting_ends_on,
           report_revision, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)
         ON CONFLICT (automation_id, idempotency_key) DO NOTHING`
      )
      .bind(
        input.automation_id,
        input.idempotency_key,
        input.report_sha256,
        input.summary_sha256,
        input.context_sha256,
        input.evidence_bundle_id,
        input.workflow_version,
        input.reporting_starts_on,
        input.reporting_ends_on,
        input.report_revision,
        input.created_at
      )
      .run();
    const row = await this.get(input.automation_id, input.idempotency_key);
    if (!row) throw new Error("Automation artifact claim was not persisted");
    return { created: (result.meta?.changes ?? 0) === 1, row };
  }

  async get(
    automationId: string,
    idempotencyKey: string
  ): Promise<AutomationArtifactDeliveryRow | null> {
    return this.db
      .prepare(
        `SELECT * FROM automation_artifact_deliveries
         WHERE automation_id = ? AND idempotency_key = ?`
      )
      .bind(automationId, idempotencyKey)
      .first<AutomationArtifactDeliveryRow>();
  }

  async complete(
    automationId: string,
    idempotencyKey: string,
    completion: Pick<
      AutomationArtifactDeliveryRow,
      | "status"
      | "invocation_id"
      | "run_id"
      | "session_id"
      | "channel_id"
      | "message_ts"
      | "attachment_id"
      | "thread_mapping"
      | "error_code"
      | "completed_at"
    >
  ): Promise<AutomationArtifactDeliveryRow> {
    const result = await this.db
      .prepare(
        `UPDATE automation_artifact_deliveries
         SET status = ?, invocation_id = ?, run_id = ?, session_id = ?,
             channel_id = ?, message_ts = ?, attachment_id = ?, thread_mapping = ?,
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
        completion.attachment_id,
        completion.thread_mapping,
        completion.error_code,
        completion.completed_at,
        automationId,
        idempotencyKey
      )
      .run();
    if ((result.meta?.changes ?? 0) !== 1) {
      throw new Error("Automation artifact delivery was already completed");
    }
    const row = await this.get(automationId, idempotencyKey);
    if (!row) throw new Error("Automation artifact completion was not persisted");
    return row;
  }
}
