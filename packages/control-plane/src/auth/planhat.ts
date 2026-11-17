import { z } from "zod";
import { fetchProvider, parseProviderResponse } from "./provider-response";

const PLANHAT_TOKEN_URL = "https://api.planhat.com/oauth/token";
export const PLANHAT_AUTHORIZE_URL = "https://ws.planhat.com/oauth/authorize";
export const PLANHAT_OAUTH_SCOPE = "inclusive";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const lifetimeSchema = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  .pipe(z.number().int().positive().max(MAX_TOKEN_LIFETIME_SECONDS));

const planhatTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  refresh_token: z.string().min(1).max(16_384),
  expires_in: lifetimeSchema.optional(),
  token_type: z.string().min(1).max(64).optional(),
  scope: z.string().min(1).max(1024).optional(),
});

export type PlanhatTokenResponse = z.infer<typeof planhatTokenResponseSchema>;

export class PlanhatOAuthProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

export function planhatAccessTokenLifetimeMs(expiresIn?: number): number {
  return (expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000;
}

function providerError(operation: string) {
  return (reason: "oversized" | "http" | "invalid_json" | "invalid_data", status: number) =>
    new PlanhatOAuthProviderError(
      reason === "http"
        ? `Planhat OAuth ${operation} failed`
        : `Planhat OAuth ${operation} returned invalid data`,
      reason === "http" ? status : 502
    );
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function requestTokens(
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
  operation: string
): Promise<PlanhatTokenResponse> {
  const response = await fetchProvider(PLANHAT_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthorization(clientId, clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  return parseProviderResponse(response, planhatTokenResponseSchema, providerError(operation));
}

export function buildPlanhatAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(PLANHAT_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: PLANHAT_OAUTH_SCOPE,
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export function exchangePlanhatAuthorizationCode(input: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<PlanhatTokenResponse> {
  return requestTokens(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    input.clientId,
    input.clientSecret,
    "authorization-code exchange"
  );
}

export function refreshPlanhatAccessToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<PlanhatTokenResponse> {
  return requestTokens(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
    input.clientId,
    input.clientSecret,
    "token refresh"
  );
}
