import type { Env } from "../types";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";

const MAX_AUTHORIZATION_WINDOW_MS = 30 * 60 * 1000;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SAFE_WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const PLANHAT_DISCOVERY_VALIDATION_WINDOW_CONFIGURATION_NAMES = [
  "PLANHAT_DISCOVERY_VALIDATION_ENABLED",
  "PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT",
  "PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT",
  "PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID",
  "PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID",
] as const;

export const CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_NAMES = [
  "CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED",
  "CS_PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT",
  "CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT",
  "CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID",
] as const;

type WindowConfigurationName =
  (typeof PLANHAT_DISCOVERY_VALIDATION_WINDOW_CONFIGURATION_NAMES)[number];

export interface PlanhatDiscoveryValidationWindow {
  issuedAt: number;
  issuedAtIso: string;
  expiresAt: number;
  expiresAtIso: string;
  windowId: string;
  environmentId: string;
}

export interface PlanhatDiscoveryValidationSessionProvenance {
  sessionId?: string;
  environmentId: string | null;
  spawnSource: string;
  userId: string | null | undefined;
  automationId: string | null | undefined;
  parentSessionId: string | null;
  spawnDepth: number;
  repoOwner: string | null;
  repoName: string | null;
  repoId: number | null;
  repositoryCount: number;
  repositoriesMatchEnvironment: boolean;
  createdAt: number;
}

export interface PlanhatDiscoveryValidationDecisionTrace {
  correlationId: string;
  boundary: "sandbox-validation-contract";
  decision: "attached" | "withheld";
  firstFailedPredicate: string | null;
  facts: readonly Readonly<{
    predicate: string;
    expected: unknown;
    observed: unknown;
    passed: boolean;
  }>[];
}

function canonicalInstant(value: string | undefined): number | null {
  if (!value || !CANONICAL_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

/** One operator-owned platform window is the authority for both route admission and fresh sandbox injection. */
export function readPlanhatDiscoveryValidationWindow(
  env: Pick<Env, WindowConfigurationName>,
  now = Date.now()
): PlanhatDiscoveryValidationWindow | null {
  if (env.PLANHAT_DISCOVERY_VALIDATION_ENABLED !== "true") return null;
  const environmentId = env.PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID;
  const windowId = env.PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID;
  if (!environmentId || !SAFE_ENVIRONMENT_ID.test(environmentId)) return null;
  if (!windowId || !SAFE_WINDOW_ID.test(windowId)) return null;
  const issuedAtIso = env.PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT;
  const expiresAtIso = env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT;
  const issuedAt = canonicalInstant(issuedAtIso);
  const expiresAt = canonicalInstant(expiresAtIso);
  if (
    issuedAt === null ||
    expiresAt === null ||
    issuedAt > now ||
    expiresAt <= now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_AUTHORIZATION_WINDOW_MS
  ) {
    return null;
  }
  return {
    issuedAt,
    issuedAtIso: issuedAtIso!,
    expiresAt,
    expiresAtIso: expiresAtIso!,
    windowId,
    environmentId,
  };
}

/**
 * Returns only the non-secret, short-lived CS admission tuple for a matching fresh sandbox.
 * Caller-defined values with these names are stripped separately and can never enable the route.
 */
export function resolvePlanhatDiscoveryValidationSandboxEnv(
  env: Pick<Env, WindowConfigurationName>,
  session: PlanhatDiscoveryValidationSessionProvenance,
  now = Date.now(),
  trace?: (decision: PlanhatDiscoveryValidationDecisionTrace) => void
): Record<(typeof CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_NAMES)[number], string> | null {
  const window = readPlanhatDiscoveryValidationWindow(env, now);
  const facts = [
    {
      predicate: "window.current",
      expected: true,
      observed: window !== null,
      passed: window !== null,
    },
    {
      predicate: "environment.id",
      expected: window?.environmentId ?? null,
      observed: session.environmentId,
      passed: window !== null && session.environmentId === window.environmentId,
    },
    {
      predicate: "session.spawnSource",
      expected: "slack-bot",
      observed: session.spawnSource,
      passed: session.spawnSource === "slack-bot",
    },
    {
      predicate: "session.userIdCanonical",
      expected: true,
      observed: isCanonicalUserId(session.userId),
      passed: isCanonicalUserId(session.userId),
    },
    {
      predicate: "session.automationId",
      expected: null,
      observed: session.automationId,
      passed: session.automationId === null,
    },
    {
      predicate: "session.parentSessionId",
      expected: null,
      observed: session.parentSessionId,
      passed: session.parentSessionId === null,
    },
    {
      predicate: "session.spawnDepth",
      expected: 0,
      observed: session.spawnDepth,
      passed: session.spawnDepth === 0,
    },
    {
      predicate: "repository.authorityParity",
      expected: true,
      observed: session.repositoriesMatchEnvironment,
      passed: session.repositoriesMatchEnvironment,
    },
    {
      predicate: "session.createdAtInteger",
      expected: true,
      observed: Number.isSafeInteger(session.createdAt),
      passed: Number.isSafeInteger(session.createdAt),
    },
    {
      predicate: "session.createdAfterWindowIssued",
      expected: window?.issuedAt ?? null,
      observed: session.createdAt,
      passed: window !== null && session.createdAt > window.issuedAt,
    },
    {
      predicate: "session.createdNotInFuture",
      expected: now,
      observed: session.createdAt,
      passed: session.createdAt <= now,
    },
    {
      predicate: "session.createdBeforeWindowExpiry",
      expected: window?.expiresAt ?? null,
      observed: session.createdAt,
      passed: window !== null && session.createdAt < window.expiresAt,
    },
  ] as const;
  const firstFailedPredicate = facts.find((fact) => !fact.passed)?.predicate ?? null;
  trace?.({
    correlationId: `planhat-discovery:${window?.windowId ?? "no-window"}:${session.sessionId ?? "unknown-session"}`,
    boundary: "sandbox-validation-contract",
    decision: firstFailedPredicate === null ? "attached" : "withheld",
    firstFailedPredicate,
    facts,
  });
  if (!window || firstFailedPredicate !== null) {
    return null;
  }
  return {
    CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
    CS_PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT: window.issuedAtIso,
    CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: window.expiresAtIso,
    CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: window.windowId,
  };
}
