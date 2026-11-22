import { describe, expect, it } from "vitest";
import {
  resolvePlanhatDiscoveryValidationSandboxEnv,
  type PlanhatDiscoveryValidationDecisionTrace,
  type PlanhatDiscoveryValidationSessionProvenance,
} from "./discovery-validation-window";

const NOW = Date.parse("2026-11-22T00:00:00.000Z");
const ENV = {
  PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
  PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT: "2026-11-21T23:50:00.000Z",
  PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-22T00:10:00.000Z",
  PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: "window-invented",
  PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID: "env-invented",
} as const;
const SESSION: PlanhatDiscoveryValidationSessionProvenance = {
  sessionId: "session-invented",
  environmentId: "env-invented",
  spawnSource: "slack-bot",
  userId: "0123456789abcdef0123456789abcdef",
  automationId: null,
  parentSessionId: null,
  spawnDepth: 0,
  repoOwner: "invented-owner",
  repoName: "invented-repo",
  repoId: 42,
  repositoryCount: 1,
  repositoriesMatchEnvironment: true,
  createdAt: Date.parse("2026-11-21T23:55:00.000Z"),
};

describe("discovery validation decision trace", () => {
  it("attaches the exact four-key tuple and emits per-boundary evidence", () => {
    let trace: PlanhatDiscoveryValidationDecisionTrace | undefined;
    expect(
      resolvePlanhatDiscoveryValidationSandboxEnv(ENV, SESSION, NOW, (value) => (trace = value))
    ).toEqual({
      CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
      CS_PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT: ENV.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT,
      CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: ENV.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT,
      CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: ENV.PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID,
    });
    expect(trace).toMatchObject({
      correlationId: "planhat-discovery:window-invented:session-invented",
      decision: "attached",
      firstFailedPredicate: null,
    });
    expect(trace?.facts.every((fact) => fact.passed)).toBe(true);
  });

  it.each([
    ["environment.id", { environmentId: "env-other" }],
    ["session.spawnSource", { spawnSource: "user" }],
    ["session.userIdCanonical", { userId: "not-canonical" }],
    ["session.automationId", { automationId: "automation-invented" }],
    ["session.parentSessionId", { parentSessionId: "parent-invented" }],
    ["session.spawnDepth", { spawnDepth: 1 }],
    ["repository.authorityParity", { repositoriesMatchEnvironment: false }],
    ["session.createdAtInteger", { createdAt: Number.NaN }],
    [
      "session.createdAfterWindowIssued",
      { createdAt: Date.parse(ENV.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT) },
    ],
    ["session.createdNotInFuture", { createdAt: NOW + 1 }],
  ])("withholds at %s", (predicate, patch) => {
    let trace: PlanhatDiscoveryValidationDecisionTrace | undefined;
    expect(
      resolvePlanhatDiscoveryValidationSandboxEnv(
        ENV,
        { ...SESSION, ...patch },
        NOW,
        (value) => (trace = value)
      )
    ).toBeNull();
    expect(trace?.decision).toBe("withheld");
    expect(trace?.firstFailedPredicate).toBe(predicate);
  });

  it.each([
    ["disabled", { PLANHAT_DISCOVERY_VALIDATION_ENABLED: "false" }],
    ["missing expiry", { PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: undefined }],
    ["expired", { PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-22T00:00:00.000Z" }],
    ["overlong", { PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: "2026-11-22T00:30:00.001Z" }],
  ])("withholds an invalid platform window: %s", (_name, patch) => {
    let trace: PlanhatDiscoveryValidationDecisionTrace | undefined;
    expect(
      resolvePlanhatDiscoveryValidationSandboxEnv(
        { ...ENV, ...patch },
        SESSION,
        NOW,
        (value) => (trace = value)
      )
    ).toBeNull();
    expect(trace?.firstFailedPredicate).toBe("window.current");
  });
});
