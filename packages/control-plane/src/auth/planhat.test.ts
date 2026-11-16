import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPlanhatAuthorizationUrl,
  exchangePlanhatAuthorizationCode,
  planhatAccessTokenLifetimeMs,
  PlanhatOAuthProviderError,
  refreshPlanhatAccessToken,
} from "./planhat";

describe("Planhat OAuth provider adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("builds the fixed authorization request without a client secret", () => {
    const value = buildPlanhatAuthorizationUrl({
      clientId: "client-1",
      redirectUri: "https://control.example/integrations/planhat/oauth/callback",
      state: "state-1",
      codeChallenge: "challenge-1",
    });
    const url = new URL(value);
    expect(`${url.origin}${url.pathname}`).toBe("https://ws.planhat.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://control.example/integrations/planhat/oauth/callback",
      scope: "inclusive",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
    expect(value).not.toContain("secret");
  });

  it("exchanges one code using confidential-client authentication", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: "3600",
        provider_metadata: "ignored",
      })
    );

    await expect(
      exchangePlanhatAuthorizationCode({
        code: "code-1",
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUri: "https://control.example/integrations/planhat/oauth/callback",
        codeVerifier: "verifier-1",
      })
    ).resolves.toMatchObject({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    });

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe("https://api.planhat.com/oauth/token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${btoa("client-1:secret-1")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(String(init?.body)).toContain("grant_type=authorization_code");
    expect(String(init?.body)).toContain("code=code-1");
    expect(String(init?.body)).toContain("code_verifier=verifier-1");
    expect(String(init?.body)).not.toContain("secret-1");
  });

  it("rotates a refresh token and applies the bounded default lifetime", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ access_token: "access-2", refresh_token: "refresh-2" }));

    await expect(
      refreshPlanhatAccessToken({
        refreshToken: "refresh-1",
        clientId: "client-1",
        clientSecret: "secret-1",
      })
    ).resolves.toEqual({ access_token: "access-2", refresh_token: "refresh-2" });
    expect(planhatAccessTokenLifetimeMs()).toBe(3_600_000);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body)).toContain(
      "refresh_token=refresh-1"
    );
  });

  it("rejects malformed and failed provider responses without retaining their body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "leaked-access" }))
      .mockResolvedValueOnce(
        new Response('{"error":"invalid_grant","refresh_token":"leaked-refresh"}', {
          status: 401,
        })
      );

    const malformed = await refreshPlanhatAccessToken({
      refreshToken: "refresh-1",
      clientId: "client-1",
      clientSecret: "secret-1",
    }).catch((error) => error);
    expect(malformed).toBeInstanceOf(PlanhatOAuthProviderError);
    expect(JSON.stringify(malformed)).not.toContain("leaked-access");

    const denied = await refreshPlanhatAccessToken({
      refreshToken: "refresh-1",
      clientId: "client-1",
      clientSecret: "secret-1",
    }).catch((error) => error);
    expect(denied).toBeInstanceOf(PlanhatOAuthProviderError);
    expect(denied.status).toBe(401);
    expect(JSON.stringify(denied)).not.toContain("leaked-refresh");
  });
});
