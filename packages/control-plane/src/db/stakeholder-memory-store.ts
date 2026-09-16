import { generateId } from "../auth/crypto";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

export const STAKEHOLDER_MEMORY_FACT_KINDS = [
  "context",
  "decision",
  "definition",
  "preference",
  "constraint",
] as const;

type StakeholderMemoryFactKind = (typeof STAKEHOLDER_MEMORY_FACT_KINDS)[number];

export interface StakeholderMemoryFact {
  id: string;
  environmentId: string;
  factKind: StakeholderMemoryFactKind;
  attributedTo: string;
  fact: string;
  sourceSessionId: string;
  sourceUserIdSnapshot: string | null;
  supersedesFactId: string | null;
  supersessionReason: string | null;
  supersededByFactId: string | null;
  createdAt: number;
}

interface StakeholderMemoryFactRow {
  id: string;
  environment_id: string;
  fact_kind: StakeholderMemoryFactKind;
  attributed_to: string;
  fact_text: string;
  source_session_id: string;
  source_user_id_snapshot: string | null;
  supersedes_fact_id: string | null;
  supersession_reason: string | null;
  superseded_by_fact_id: string | null;
  created_at: number;
}

interface FactContent {
  factKind: StakeholderMemoryFactKind;
  attributedTo: string;
  fact: string;
}

interface FactProvenance {
  sourceSessionId: string;
  sourceUserIdSnapshot: string | null;
}

export class StakeholderMemoryFactNotFoundError extends Error {}
export class StakeholderMemoryConflictError extends Error {}

function toFact(row: StakeholderMemoryFactRow): StakeholderMemoryFact {
  return {
    id: row.id,
    environmentId: row.environment_id,
    factKind: row.fact_kind,
    attributedTo: row.attributed_to,
    fact: row.fact_text,
    sourceSessionId: row.source_session_id,
    sourceUserIdSnapshot: row.source_user_id_snapshot,
    supersedesFactId: row.supersedes_fact_id,
    supersessionReason: row.supersession_reason,
    supersededByFactId: row.superseded_by_fact_id,
    createdAt: row.created_at,
  };
}

const FACT_SELECT = `SELECT fact.*,
  successor.id AS superseded_by_fact_id
FROM stakeholder_memory_facts fact
LEFT JOIN stakeholder_memory_facts successor ON successor.supersedes_fact_id = fact.id`;

export class StakeholderMemoryStore {
  constructor(private readonly db: SqlDatabase) {}

  async create(
    environmentId: string,
    content: FactContent,
    provenance: FactProvenance
  ): Promise<StakeholderMemoryFact> {
    return this.insert(environmentId, content, provenance, null, null);
  }

  async list(
    environmentId: string,
    options: { includeSuperseded: boolean; limit: number }
  ): Promise<StakeholderMemoryFact[]> {
    const result = await this.db
      .prepare(
        `${FACT_SELECT}
         WHERE fact.environment_id = ?
           ${options.includeSuperseded ? "" : "AND successor.id IS NULL"}
         ORDER BY fact.created_at DESC, fact.id DESC
         LIMIT ?`
      )
      .bind(environmentId, options.limit)
      .all<StakeholderMemoryFactRow>();
    return result.results.map(toFact);
  }

  async supersede(
    environmentId: string,
    supersedesFactId: string,
    content: FactContent,
    provenance: FactProvenance,
    reason: string | null
  ): Promise<StakeholderMemoryFact> {
    const predecessor = await this.db
      .prepare(
        `SELECT fact.id, successor.id AS successor_id
         FROM stakeholder_memory_facts fact
         LEFT JOIN stakeholder_memory_facts successor ON successor.supersedes_fact_id = fact.id
         WHERE fact.id = ? AND fact.environment_id = ?`
      )
      .bind(supersedesFactId, environmentId)
      .first<{ id: string; successor_id: string | null }>();
    if (!predecessor) {
      throw new StakeholderMemoryFactNotFoundError("Stakeholder memory fact not found");
    }
    if (predecessor.successor_id) {
      throw new StakeholderMemoryConflictError("Stakeholder memory fact is already superseded");
    }
    return this.insert(environmentId, content, provenance, supersedesFactId, reason);
  }

  private async insert(
    environmentId: string,
    content: FactContent,
    provenance: FactProvenance,
    supersedesFactId: string | null,
    reason: string | null
  ): Promise<StakeholderMemoryFact> {
    const id = `memory_${generateId()}`;
    const createdAt = Date.now();
    try {
      await this.db
        .prepare(
          `INSERT INTO stakeholder_memory_facts (
             id, environment_id, fact_kind, attributed_to, fact_text,
             source_session_id, source_user_id_snapshot, supersedes_fact_id,
             supersession_reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          id,
          environmentId,
          content.factKind,
          content.attributedTo,
          content.fact,
          provenance.sourceSessionId,
          provenance.sourceUserIdSnapshot,
          supersedesFactId,
          reason,
          createdAt
        )
        .run();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (
        supersedesFactId &&
        (isUniqueConstraintError(cause) || message.includes("already superseded"))
      ) {
        throw new StakeholderMemoryConflictError("Stakeholder memory fact is already superseded");
      }
      throw cause;
    }
    const row = await this.db
      .prepare(`${FACT_SELECT} WHERE fact.id = ?`)
      .bind(id)
      .first<StakeholderMemoryFactRow>();
    if (!row) throw new Error(`Stakeholder memory fact was not persisted: ${id}`);
    return toFact(row);
  }
}
