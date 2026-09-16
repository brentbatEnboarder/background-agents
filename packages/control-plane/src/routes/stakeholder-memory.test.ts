import { describe, expect, it } from "vitest";
import {
  configuredEnvironmentId,
  STAKEHOLDER_MEMORY_DEFAULT_LIMIT,
  stakeholderMemoryRequestSchema,
} from "./stakeholder-memory";
import type { Env } from "../types";

describe("stakeholderMemoryRequestSchema", () => {
  it("fails closed for absent or malformed environment configuration", () => {
    expect(configuredEnvironmentId({} as Env)).toBeNull();
    expect(
      configuredEnvironmentId({ MARCUS_MEMORY_ENVIRONMENT_ID: "not-an-environment" } as Env)
    ).toBeNull();
    expect(configuredEnvironmentId({ MARCUS_MEMORY_ENVIRONMENT_ID: " env_marcus " } as Env)).toBe(
      "env_marcus"
    );
  });

  it("parses each bounded operation and supplies safe list defaults", () => {
    expect(stakeholderMemoryRequestSchema.parse({ operation: "list" })).toEqual({
      operation: "list",
      includeSuperseded: false,
      limit: STAKEHOLDER_MEMORY_DEFAULT_LIMIT,
    });
    expect(
      stakeholderMemoryRequestSchema.parse({
        operation: "create",
        factKind: "decision",
        attributedTo: " Brent ",
        fact: " Use the approved contract. ",
      })
    ).toMatchObject({ attributedTo: "Brent", fact: "Use the approved contract." });
    expect(
      stakeholderMemoryRequestSchema.safeParse({
        operation: "supersede",
        factId: "memory_1",
        factKind: "context",
        attributedTo: "Brent",
        fact: "Updated context",
        reason: "Changed",
      }).success
    ).toBe(true);
  });

  it("rejects unbounded, inferred, or client-provenance-shaped input", () => {
    expect(
      stakeholderMemoryRequestSchema.safeParse({ operation: "list", limit: 101 }).success
    ).toBe(false);
    expect(
      stakeholderMemoryRequestSchema.safeParse({
        operation: "create",
        factKind: "inference",
        attributedTo: "Marcus",
        fact: "A guess",
      }).success
    ).toBe(false);
    expect(
      stakeholderMemoryRequestSchema.safeParse({
        operation: "create",
        factKind: "context",
        attributedTo: "Brent",
        fact: "Explicit context",
        environmentId: "env_other",
        sourceSessionId: "forged",
      }).success
    ).toBe(false);
  });
});
