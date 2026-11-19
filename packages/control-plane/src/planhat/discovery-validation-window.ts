import type { Env } from "../types";

const MAX_AUTHORIZATION_WINDOW_MS = 30 * 60 * 1000;
const SAFE_ENVIRONMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SAFE_WINDOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const PLANHAT_DISCOVERY_VALIDATION_WINDOW_CONFIGURATION_NAMES = [
  "PLANHAT_DISCOVERY_VALIDATION_ENABLED",
  "PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT",
  "PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID",
  "PLANHAT_DISCOVERY_VALIDATION_ENVIRONMENT_ID",
] as const;

export const CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_NAMES = [
  "CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED",
  "CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT",
  "CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID",
] as const;

type WindowConfigurationName =
  (typeof PLANHAT_DISCOVERY_VALIDATION_WINDOW_CONFIGURATION_NAMES)[number];

export interface PlanhatDiscoveryValidationWindow {
  expiresAt: number;
  expiresAtIso: string;
  windowId: string;
  environmentId: string;
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
  const expiresAt = Date.parse(env.PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT ?? "");
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt - now > MAX_AUTHORIZATION_WINDOW_MS
  ) {
    return null;
  }
  return { expiresAt, expiresAtIso: new Date(expiresAt).toISOString(), windowId, environmentId };
}

/**
 * Returns only the non-secret, short-lived CS admission tuple for a matching fresh sandbox.
 * Caller-defined values with these names are stripped separately and can never enable the route.
 */
export function resolvePlanhatDiscoveryValidationSandboxEnv(
  env: Pick<Env, WindowConfigurationName>,
  sessionEnvironmentId: string | null,
  now = Date.now()
): Record<(typeof CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_NAMES)[number], string> | null {
  const window = readPlanhatDiscoveryValidationWindow(env, now);
  if (!window || sessionEnvironmentId !== window.environmentId) return null;
  return {
    CS_PLANHAT_DISCOVERY_VALIDATION_ENABLED: "true",
    CS_PLANHAT_DISCOVERY_VALIDATION_EXPIRES_AT: window.expiresAtIso,
    CS_PLANHAT_DISCOVERY_VALIDATION_WINDOW_ID: window.windowId,
  };
}
