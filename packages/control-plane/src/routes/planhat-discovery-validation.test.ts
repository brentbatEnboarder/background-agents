import { describe, expect, it } from "vitest";
import { readPlanhatDiscoveryValidationConfiguration } from "./planhat-discovery-validation";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");

describe("Planhat discovery validation route configuration", () => {
  it("is disabled by default and rejects invalid, expired, and long-lived activation", () => {
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        {},
        "planhat.mcp.validate-conversation-search",
        NOW
      )
    ).toBeNull();
    for (const expiresAt of ["invalid", "2026-11-19T10:00:00.000Z", "2026-11-20T10:00:00.001Z"]) {
      expect(
        readPlanhatDiscoveryValidationConfiguration(
          {
            PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
            PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: expiresAt,
            PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY: "invented query",
          },
          "planhat.mcp.validate-conversation-search",
          NOW
        )
      ).toBeNull();
    }
  });

  it("accepts only the operation-specific operator probe", () => {
    const base = {
      PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
      PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-19T11:00:00.000Z",
    };
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        { ...base, PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY: "invented query" },
        "planhat.mcp.validate-conversation-search",
        NOW
      )
    ).toEqual({
      operation: "planhat.mcp.validate-conversation-search",
      expiresAt: Date.parse("2026-11-19T11:00:00.000Z"),
      probe: { searchQuery: "invented query" },
    });
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        { ...base, PLANHAT_DISCOVERY_VALIDATION_LIST_COMPANY_ID: "company-invented" },
        "planhat.mcp.validate-conversation-list",
        NOW
      )
    ).toEqual({
      operation: "planhat.mcp.validate-conversation-list",
      expiresAt: Date.parse("2026-11-19T11:00:00.000Z"),
      probe: { listCompanyId: "company-invented" },
    });
  });

  it("does not expose generic tools, models, fields, queries, retries, or redirects", () => {
    const source = readPlanhatDiscoveryValidationConfiguration.toString();
    expect(source).not.toMatch(/tool|model|field|redirect|retry/i);
  });
});
