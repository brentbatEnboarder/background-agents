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
  now = Date.now()
): Record<(typeof CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_NAMES)[number], string> | null {
  const window = readPlanhatDiscoveryValidationWindow(env, now);
  if (
    !window ||
    session.environmentId !== window.environmentId ||
    session.spawnSource !== "slack-bot" ||
    !isCanonicalUserId(session.userId) ||
    session.automationId !== null ||
    session.parentSessionId !== null ||
    session.spawnDepth !== 0 ||
    !session.repositoriesMatchEnvironment ||
    !Number.isSafeInteger(session.createdAt) ||
    session.createdAt <= window.issuedAt ||
    session.createdAt > now ||
    session.createdAt >= window.expiresAt
  ) {
    return null;
  }
  return {
    CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
    CS_PLANHAT_DISCOVERY_VALIDATION_ISSUED_AT: window.issuedAtIso,
    CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: window.expiresAtIso,
    CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: window.windowId,
  };
}
