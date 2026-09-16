import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  StakeholderMemoryFactNotFoundError,
  StakeholderMemoryStore,
} from "../../src/db/stakeholder-memory-store";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedSandboxAuthHash, sqlDatabase } from "./helpers";

const ENVIRONMENT_ID = "env_marcus";

async function session(name: string, environmentId = ENVIRONMENT_ID, userId = "user-1") {
  const initialized = await initSession({ sessionName: name, environmentId, userId });
  const token = `token-${name}`;
  await seedSandboxAuthHash(initialized.stub, { authToken: token, sandboxId: `sandbox-${name}` });
  return { ...initialized, token };
}

function memoryRequest(
  sessionId: string,
  token: string,
  body: Record<string, unknown>
): Promise<Response> {
  return SELF.fetch(`https://test.local/sessions/${sessionId}/stakeholder-memory`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("stakeholder memory", () => {
  beforeEach(cleanD1Tables);

  it("creates, shares, and supersedes append-only facts across sessions", async () => {
    const first = await session("memory-first");
    const second = await session("memory-second", ENVIRONMENT_ID, "user-2");

    const createdResponse = await memoryRequest(first.sessionName, first.token, {
      operation: "create",
      factKind: "constraint",
      attributedTo: "Brent Pearson",
      fact: "Never write stakeholder memory to reporting Supabase.",
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      fact: { id: string; sourceSessionId: string; sourceUserIdSnapshot: string | null };
    };
    expect(created.fact).toMatchObject({
      sourceSessionId: first.sessionName,
      sourceUserIdSnapshot: "user-1",
    });

    const crossSessionList = await memoryRequest(second.sessionName, second.token, {
      operation: "list",
    });
    expect(crossSessionList.status).toBe(200);
    await expect(crossSessionList.json()).resolves.toMatchObject({
      facts: [{ id: created.fact.id, factKind: "constraint" }],
    });

    const supersededResponse = await memoryRequest(second.sessionName, second.token, {
      operation: "supersede",
      factId: created.fact.id,
      factKind: "decision",
      attributedTo: "Brent Pearson",
      fact: "D1 is the approved stakeholder-memory store.",
      reason: "Storage decision finalized",
    });
    expect(supersededResponse.status).toBe(201);
    const superseded = (await supersededResponse.json()) as { fact: { id: string } };

    const activeResponse = await memoryRequest(first.sessionName, first.token, {
      operation: "list",
    });
    const active = (await activeResponse.json()) as { facts: Array<{ id: string }> };
    expect(active.facts.map(({ id }) => id)).toEqual([superseded.fact.id]);

    const historyResponse = await memoryRequest(first.sessionName, first.token, {
      operation: "list",
      includeSuperseded: true,
      limit: 100,
    });
    const history = (await historyResponse.json()) as {
      facts: Array<{ id: string; supersededByFactId: string | null }>;
    };
    expect(history.facts).toHaveLength(2);
    expect(history.facts.find(({ id }) => id === created.fact.id)?.supersededByFactId).toBe(
      superseded.fact.id
    );

    const repeated = await memoryRequest(first.sessionName, first.token, {
      operation: "supersede",
      factId: created.fact.id,
      factKind: "context",
      attributedTo: "Brent Pearson",
      fact: "A conflicting replacement.",
    });
    expect(repeated.status).toBe(409);
  });

  it("fails closed on sandbox, environment, configuration, and body boundaries", async () => {
    const allowed = await session("memory-allowed");
    const other = await session("memory-other", "env_other");

    const wrongSandbox = await memoryRequest(allowed.sessionName, other.token, {
      operation: "list",
    });
    expect(wrongSandbox.status).toBe(401);

    const wrongEnvironment = await memoryRequest(other.sessionName, other.token, {
      operation: "list",
    });
    expect(wrongEnvironment.status).toBe(403);

    const forgedProvenance = await memoryRequest(allowed.sessionName, allowed.token, {
      operation: "create",
      factKind: "context",
      attributedTo: "Brent",
      fact: "Explicit context",
      environmentId: "env_other",
      sourceSessionId: "forged",
    });
    expect(forgedProvenance.status).toBe(400);

    const oversized = await memoryRequest(allowed.sessionName, allowed.token, {
      operation: "create",
      factKind: "context",
      attributedTo: "Brent",
      fact: "x".repeat(1001),
    });
    expect(oversized.status).toBe(400);
  });

  it("enforces same-environment and current-only supersession in the store and D1", async () => {
    await env.DB.prepare(
      `INSERT INTO stakeholder_memory_facts (
         id, environment_id, fact_kind, attributed_to, fact_text,
         source_session_id, created_at
       ) VALUES ('memory_direct', 'env_one', 'context', 'Brent', 'Original', 'session-1', 1)`
    ).run();

    const store = new StakeholderMemoryStore(sqlDatabase(env.DB));
    await expect(
      store.supersede(
        "env_two",
        "memory_direct",
        { factKind: "context", attributedTo: "Brent", fact: "Replacement" },
        { sourceSessionId: "session-2", sourceUserIdSnapshot: null },
        null
      )
    ).rejects.toBeInstanceOf(StakeholderMemoryFactNotFoundError);

    await env.DB.prepare(
      `INSERT INTO stakeholder_memory_facts (
         id, environment_id, fact_kind, attributed_to, fact_text,
         source_session_id, supersedes_fact_id, created_at
       ) VALUES ('memory_successor', 'env_one', 'context', 'Brent', 'Replacement',
                 'session-2', 'memory_direct', 2)`
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO stakeholder_memory_facts (
           id, environment_id, fact_kind, attributed_to, fact_text,
           source_session_id, supersedes_fact_id, created_at
         ) VALUES ('memory_fork', 'env_one', 'context', 'Brent', 'Fork',
                   'session-3', 'memory_direct', 3)`
      ).run()
    ).rejects.toThrow(/already superseded|unique constraint/i);
  });
});
