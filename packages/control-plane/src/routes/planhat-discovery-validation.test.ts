import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PLANHAT_DISCOVERY_MAX_RECORD_COUNT,
  PlanhatDiscoverySchemaTransportError,
} from "../planhat/discovery-validation-transport";
import type { Env } from "../types";
import type { SandboxRouteContext } from "./shared";
import {
  handleDiscoveryValidation,
  PLANHAT_DISCOVERY_VALIDATION_CONFIGURATION_NAMES,
  readPlanhatDiscoveryValidationConfiguration,
} from "./planhat-discovery-validation";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");

describe("Planhat discovery validation route configuration", () => {
  it("matches the reviewed issue #246 deployment envelope", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../../terraform/environments/production/candidates/issue-246-planhat-discovery-validation.bindings.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as {
      baselineBindingCount: number;
      expectedBindingCount: number;
      bindings: Array<{ name: string; type: string; value?: string }>;
    };
    const validationBindings = manifest.bindings.filter(({ name }) =>
      name.startsWith("PLANHAT_DISCOVERY_VALIDATION_")
    );
    const baselineFingerprint = createHash("sha256")
      .update(
        manifest.bindings
          .filter(({ name }) => !name.startsWith("PLANHAT_DISCOVERY_VALIDATION_"))
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(({ name, type }) => `${name}:${type}\n`)
          .join("")
      )
      .digest("hex");

    expect(manifest.baselineBindingCount).toBe(39);
    expect(manifest.expectedBindingCount).toBe(46);
    expect(manifest.bindings).toHaveLength(46);
    expect(baselineFingerprint).toBe(
      "f8fc3031e77dbd9fdcafd03eb5a57c889256eada0825eb7bd4e5247e7b4abdf6"
    );
    expect(validationBindings.map(({ name }) => name).sort()).toEqual(
      [...PLANHAT_DISCOVERY_VALIDATION_CONFIGURATION_NAMES].sort()
    );
    expect(validationBindings).toContainEqual({
      name: "PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID",
      type: "plain_text",
      value: "env_819ed9c867b9be4c47e443242c47efae",
    });
    expect(
      validationBindings
        .filter(({ name }) => name !== "PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID")
        .every(({ type, value }) => type === "secret_text" && value === undefined)
    ).toBe(true);
  });

  it("is disabled by default and rejects invalid, expired, and long-lived activation", () => {
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        {},
        "planhat.mcp.validate-conversation-search",
        NOW
      )
    ).toBeNull();
    for (const expiresAt of ["invalid", "2026-11-19T10:00:00.000Z", "2026-11-19T10:30:00.001Z"]) {
      expect(
        readPlanhatDiscoveryValidationConfiguration(
          {
            PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
            PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: expiresAt,
            PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID: "environment-invented",
            PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY: "invented query",
          },
          "planhat.mcp.validate-conversation-search",
          NOW
        )
      ).toBeNull();
    }
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        {
          PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
          PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-19T10:30:00.000Z",
          PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY: "invented query",
        },
        "planhat.mcp.validate-conversation-search",
        NOW
      )
    ).toBeNull();
  });

  it("accepts only the operation-specific operator probe", () => {
    const base = {
      PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
      PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-19T10:30:00.000Z",
      PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID: "environment-invented",
    };
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        { ...base, PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY: "invented query" },
        "planhat.mcp.validate-conversation-search",
        NOW
      )
    ).toEqual({
      operation: "planhat.mcp.validate-conversation-search",
      expiresAt: Date.parse("2026-11-19T10:30:00.000Z"),
      environmentId: "environment-invented",
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
      expiresAt: Date.parse("2026-11-19T10:30:00.000Z"),
      environmentId: "environment-invented",
      probe: { listCompanyId: "company-invented" },
    });
    expect(
      readPlanhatDiscoveryValidationConfiguration(
        {
          ...base,
          PLANHAT_DISCOVERY_VALIDATION_GET_COMPANY_ID: "company-invented",
          PLANHAT_DISCOVERY_VALIDATION_GET_CONVERSATION_ID: "conversation-invented",
        },
        "planhat.mcp.validate-conversation-get",
        NOW
      )
    ).toEqual({
      operation: "planhat.mcp.validate-conversation-get",
      expiresAt: Date.parse("2026-11-19T10:30:00.000Z"),
      environmentId: "environment-invented",
      probe: {
        getCompanyId: "company-invented",
        getConversationId: "conversation-invented",
      },
    });
  });

  it("does not expose generic tools, models, fields, queries, retries, or redirects", () => {
    const source = readPlanhatDiscoveryValidationConfiguration.toString();
    expect(source).not.toMatch(/tool|model|field|redirect|retry/i);
  });
});

const ROUTE_ENVIRONMENT = {
  PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
  PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-19T10:30:00.000Z",
  PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID: "environment-invented",
  PLANHAT_DISCOVERY_VALIDATION_SEARCH_QUERY: "invented query",
} as unknown as Env;

const ROUTE_CONTEXT = {
  principal: { sandboxId: "sandbox-invented" },
  request_id: "request-invented",
  trace_id: "trace-invented",
} as unknown as SandboxRouteContext;

function routeRequest(): Request {
  return new Request("https://test.local/sessions/session-invented/validation", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sandbox-ID": "sandbox-invented" },
    body: JSON.stringify({ operation: "planhat.mcp.validate-conversation-search" }),
  });
}

function routeDependencies(observe: (...args: never[]) => Promise<unknown>) {
  return {
    authorizeSandbox: vi.fn(() => null),
    authorizeGateway: vi.fn(async () => ({
      accessToken: "invented-access-token",
      environmentId: "environment-invented",
      automationId: null,
      assignmentMode: "slack-environment" as const,
    })),
    observe,
    now: vi.fn(() => NOW),
  };
}

describe("Planhat discovery validation route failures", () => {
  it.each([
    ["disabled", { ...ROUTE_ENVIRONMENT, PLANHAT_DISCOVERY_VALIDATION_ENABLED: undefined }],
    [
      "missing environment ID",
      { ...ROUTE_ENVIRONMENT, PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID: undefined },
    ],
    [
      "expired",
      {
        ...ROUTE_ENVIRONMENT,
        PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: new Date(NOW).toISOString(),
      },
    ],
  ])("fails closed when %s before provider access", async (_name, environment) => {
    const dependencies = routeDependencies(vi.fn());
    const response = await handleDiscoveryValidation(
      routeRequest(),
      environment as Env,
      { id: "session-invented" },
      ROUTE_CONTEXT,
      dependencies as never
    );
    expect(response.status).toBe(403);
    expect(dependencies.authorizeGateway).not.toHaveBeenCalled();
    expect(dependencies.observe).not.toHaveBeenCalled();
  });

  it("rechecks expiry after gateway authorization and before provider access", async () => {
    const dependencies = routeDependencies(vi.fn());
    dependencies.now
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(Date.parse(ROUTE_ENVIRONMENT.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT!));
    const response = await handleDiscoveryValidation(
      routeRequest(),
      ROUTE_ENVIRONMENT,
      { id: "session-invented" },
      ROUTE_CONTEXT,
      dependencies as never
    );
    expect(response.status).toBe(403);
    expect(dependencies.authorizeGateway).toHaveBeenCalledOnce();
    expect(dependencies.authorizeGateway).toHaveBeenCalledWith(
      expect.any(Request),
      ROUTE_ENVIRONMENT,
      "session-invented",
      ROUTE_CONTEXT,
      expect.anything(),
      expect.any(Function),
      { discoveryValidationEnvironmentId: "environment-invented" }
    );
    expect(dependencies.observe).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", new PlanhatDiscoverySchemaTransportError("schema", "timeout"), 504],
    ["malformed", new PlanhatDiscoverySchemaTransportError("parse", "malformed"), 502],
    ["oversized", new PlanhatDiscoverySchemaTransportError("schema", "oversized"), 502],
    ["provider", new PlanhatDiscoverySchemaTransportError("schema", "provider", "5xx"), 502],
  ])("sanitizes the %s outcome", async (_name, transportError, status) => {
    const dependencies = routeDependencies(
      vi.fn(async () => {
        throw transportError;
      })
    );
    const response = await handleDiscoveryValidation(
      routeRequest(),
      ROUTE_ENVIRONMENT,
      { id: "session-invented" },
      ROUTE_CONTEXT,
      dependencies as never
    );
    expect(response.status).toBe(status);
    const body = await response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["correlationId", "error", "stage"]);
    expect(JSON.stringify(body)).not.toMatch(
      /invented-access-token|5xx|query|body|address|payload/
    );
  });

  it("rejects the demonstrated 286,802-byte projected envelope before success emission", async () => {
    const longPath = `$${`.${"a".repeat(127)}`.repeat(20)}`;
    const outputFields = Array.from({ length: 109 }, () => ({
      path: longPath,
      types: ["string"],
      presenceCount: 1,
    }));
    const observation = {
      observedAt: "2026-11-19T10:00:01.000Z",
      durationMs: 42,
      schema: { inputFields: [], outputFields },
      response: {
        byteLength: 15_979,
        recordCount: 1,
        candidateLimit: null,
        truncated: null,
        continuationPresent: null,
        identityShapes: [],
      },
    };
    const projected = {
      operation: "planhat.mcp.validate-conversation-search",
      correlationId: "a".repeat(32),
      observation,
    };
    const remaining = 286_802 - new TextEncoder().encode(JSON.stringify(projected)).byteLength;
    outputFields[0]!.path += "a".repeat(remaining);
    expect(new TextEncoder().encode(JSON.stringify(projected))).toHaveLength(286_802);

    const response = await handleDiscoveryValidation(
      routeRequest(),
      ROUTE_ENVIRONMENT,
      { id: "session-invented" },
      ROUTE_CONTEXT,
      routeDependencies(vi.fn(async () => observation)) as never
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ stage: "parse" });
  });

  it("rejects an incompatible record count before route success emission", async () => {
    const observation = {
      observedAt: "2026-11-19T10:00:01.000Z",
      durationMs: 42,
      schema: { inputFields: [], outputFields: [] },
      response: {
        byteLength: 200_080,
        recordCount: PLANHAT_DISCOVERY_MAX_RECORD_COUNT + 1,
        candidateLimit: null,
        truncated: null,
        continuationPresent: null,
        identityShapes: [],
      },
    };

    const response = await handleDiscoveryValidation(
      routeRequest(),
      ROUTE_ENVIRONMENT,
      { id: "session-invented" },
      ROUTE_CONTEXT,
      routeDependencies(vi.fn(async () => observation)) as never
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ stage: "parse" });
  });
});
