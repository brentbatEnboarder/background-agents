import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET, DELETE } from "./[id]/integrations/planhat/oauth/route";
import { POST } from "./[id]/integrations/planhat/oauth/connect/route";
import { PUT } from "./[id]/integrations/planhat/oauth/assignment/route";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

const environmentId = "env/with reserved characters";
const context = { params: Promise.resolve({ id: environmentId }) };
const cookie = "__Secure-openinspect.session_token=session.signature";

function request(path: string, method: string, body?: object): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Planhat OAuth web routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(controlPlaneUserFetch).mockResolvedValue(Response.json({ status: "ok" }));
  });

  it("proxies connection status through the authenticated web channel", async () => {
    const response = await GET(request("/api/status", "GET"), context);

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/environments/env%2Fwith%20reserved%20characters/integrations/planhat/oauth",
      undefined
    );
  });

  it("proxies confidential connection setup without interpreting its body", async () => {
    const body = {
      clientId: "pk-client",
      clientSecret: "sk-secret",
      expectedGrant: "conversation-view",
    };
    const response = await POST(request("/api/connect", "POST", body), context);

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/environments/env%2Fwith%20reserved%20characters/integrations/planhat/oauth/connect",
      { method: "POST", body: JSON.stringify(body) }
    );
  });

  it("proxies assignment changes without widening the target route", async () => {
    const body = { enabled: false, revision: 2 };
    const response = await PUT(request("/api/assignment", "PUT", body), context);

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/environments/env%2Fwith%20reserved%20characters/integrations/planhat/oauth/assignment",
      { method: "PUT", body: JSON.stringify(body) }
    );
  });

  it("proxies disconnect through the exact environment route", async () => {
    const response = await DELETE(request("/api/disconnect", "DELETE"), context);

    expect(response.status).toBe(200);
    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/environments/env%2Fwith%20reserved%20characters/integrations/planhat/oauth",
      { method: "DELETE" }
    );
  });
});
