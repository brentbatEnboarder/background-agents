import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePlanhatDiscoveryValidationSandboxEnv } from "../../src/planhat/discovery-validation-window";
import { buildSandboxEnvVars, scmCloneIdentity } from "../../src/sandbox/sandbox-env";

const csRepo = process.env.CS_REPO;
const crossRepo = csRepo ? describe : describe.skip;
const issuedAt = "2026-11-22T00:00:00.000Z";
const expiresAt = "2026-11-22T00:20:00.000Z";
const now = Date.parse("2026-11-22T00:01:00.000Z");

function platformSandboxEnvironment(
  options: Readonly<{
    fresh: boolean;
    repositoriesMatch?: boolean;
    at?: number;
  }>
) {
  const tuple = options.fresh
    ? resolvePlanhatDiscoveryValidationSandboxEnv(
        {
          PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
          PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT: issuedAt,
          PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: expiresAt,
          PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: "window-invented",
          PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID: "env-invented",
        },
        {
          sessionId: "session-invented",
          environmentId: "env-invented",
          spawnSource: "slack-bot",
          userId: "a".repeat(32),
          automationId: null,
          parentSessionId: null,
          spawnDepth: 0,
          repoOwner: "invented",
          repoName: "customer-success-agents",
          repoId: 42,
          repositoryCount: 1,
          repositoriesMatchEnvironment: options.repositoriesMatch ?? true,
          createdAt: now,
        },
        options.at ?? now
      )
    : null;
  return buildSandboxEnvVars(
    {
      sessionId: "session-invented",
      sandboxId: "sandbox-invented",
      repoOwner: "invented",
      repoName: "customer-success-agents",
      controlPlaneUrl: "https://control-plane.example",
      sandboxAuthToken: "invented-sandbox-token",
      harness: "opencode",
      provider: "openai",
      model: "openai/gpt-invented",
      userEnvVars: tuple ?? undefined,
    },
    { scmIdentity: scmCloneIdentity("github") }
  );
}

crossRepo("issue #246 platform-to-CS production seam", () => {
  it("feeds the platform resolver and canonical sandbox builder directly into managed CS parser and transport", async () => {
    const command = await import(
      pathToFileURL(resolve(csRepo!, "dist/src/alex-planhat-discovery-command.js")).href
    );
    const validation = await import(
      pathToFileURL(resolve(csRepo!, "dist/src/planhat-discovery-validation.js")).href
    );
    const environment = platformSandboxEnvironment({ fresh: true });
    const operations: string[] = [];
    const harness = validation.createConfiguredPlanhatDiscoveryValidationHarness(
      environment,
      async (_input: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { operation: string };
        operations.push(body.operation);
        return Response.json({
          operation: body.operation,
          correlationId: "correlation-invented",
          observation: {
            observedAt: "2026-11-22T00:01:01.000Z",
            durationMs: 1,
            schema: { inputFields: [], outputFields: [] },
            response: {
              byteLength: 1,
              recordCount: 0,
              candidateLimit: null,
              truncated: null,
              continuationPresent: false,
              identityShapes: [],
            },
          },
        });
      },
      () => now
    );
    const result = await command.executeAlexManagedPlanhatDiscoveryRoute(
      {
        phrase: command.PLANHAT_DISCOVERY_VALIDATION_PHRASE,
        transport: "slack",
        topLevel: true,
      },
      "U12345678",
      {
        authorizer: { authorizeSession: async () => ({ authorized: true }) },
        createHarness: () => harness,
      }
    );
    expect(result.status).toBe("observations");
    expect(result.communicationSearchActivated).toBe(false);
    expect(operations).toEqual([
      "planhat.mcp.validate-conversation-search",
      "planhat.mcp.validate-conversation-list",
      "planhat.mcp.validate-conversation-get",
    ]);
  });

  it.each([
    ["restored session", platformSandboxEnvironment({ fresh: false })],
    ["expired window", platformSandboxEnvironment({ fresh: true, at: Date.parse(expiresAt) })],
    ["repository mismatch", platformSandboxEnvironment({ fresh: true, repositoriesMatch: false })],
  ])("withholds transport for %s using actual platform output", async (_name, environment) => {
    const validation = await import(
      pathToFileURL(resolve(csRepo!, "dist/src/planhat-discovery-validation.js")).href
    );
    expect(
      validation.createConfiguredPlanhatDiscoveryValidationHarness(environment)
    ).toBeUndefined();
  });

  it("rejects an incomplete tuple after canonical sandbox construction", async () => {
    const validation = await import(
      pathToFileURL(resolve(csRepo!, "dist/src/planhat-discovery-validation.js")).href
    );
    const environment = platformSandboxEnvironment({ fresh: true });
    delete environment.CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT;
    expect(() => validation.createConfiguredPlanhatDiscoveryValidationHarness(environment)).toThrow(
      /expiry configuration/
    );
  });
});
