import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedSlack from "@open-inspect/shared/slack";
import type { Env } from "../types";

const { mockAppHome, mockHandleInteraction, mockVerifySlackSignature } = vi.hoisted(() => ({
  mockAppHome: vi.fn(),
  mockHandleInteraction: vi.fn(),
  mockVerifySlackSignature: vi.fn(),
}));

vi.mock("@open-inspect/shared/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedSlack>()),
  verifySlackSignature: mockVerifySlackSignature,
}));
vi.mock("../app-home", () => ({ handleAppHomeInteractionRoute: mockAppHome }));
vi.mock("../interactions/dispatcher", () => ({ handleSlackInteraction: mockHandleInteraction }));

import { interactionRoutes } from "./interactions";

function makeEnv(): Env {
  return {
    SLACK_APP_ID: "A123",
    SLACK_TEAM_ID: "T123",
    SLACK_ALLOWED_USER_IDS: "U123",
    SLACK_ALLOWED_CHANNEL_IDS: "C123",
  } as Env;
}

function request(payload: unknown): Request {
  return new Request("http://localhost/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": `${Math.floor(Date.now() / 1000)}`,
    },
    body: new URLSearchParams({ payload: JSON.stringify(payload) }),
  });
}

function makeCtx() {
  return { props: {}, waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;
}

const identity = { api_app_id: "A123", team: { id: "T123" }, user: { id: "U123" } };

describe("POST /interactions ingress policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockAppHome.mockResolvedValue(null);
    mockHandleInteraction.mockResolvedValue(undefined);
  });

  it("dispatches an allowed channel interaction", async () => {
    const ctx = makeCtx();
    const response = await interactionRoutes.fetch(
      request({
        ...identity,
        type: "block_actions",
        channel: { id: "C123" },
        actions: [{ action_id: "view_session" }],
      }),
      makeEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.waitUntil.mock.calls[0][0];
    expect(mockHandleInteraction).toHaveBeenCalledOnce();
  });

  it("allows a transient DM channel", async () => {
    const ctx = makeCtx();
    const response = await interactionRoutes.fetch(
      request({
        ...identity,
        type: "block_actions",
        channel: { id: "DTRANSIENT" },
        actions: [{ action_id: "view_session" }],
      }),
      makeEnv(),
      ctx
    );

    expect(response.status).toBe(200);
    await ctx.waitUntil.mock.calls[0][0];
    expect(mockHandleInteraction).toHaveBeenCalledOnce();
  });

  it("allows an authorized channel-less App Home interaction", async () => {
    mockAppHome.mockResolvedValue({ body: { ok: true }, logContext: {} });
    const response = await interactionRoutes.fetch(
      request({
        ...identity,
        type: "block_actions",
        container: { type: "view" },
        view: { type: "home" },
        actions: [{ action_id: "select_model" }],
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(200);
    expect(mockAppHome).toHaveBeenCalledOnce();
  });

  it("allows an authorized channel-less modal interaction", async () => {
    mockAppHome.mockResolvedValue({ body: { response_action: "clear" }, logContext: {} });
    const response = await interactionRoutes.fetch(
      request({
        ...identity,
        type: "view_submission",
        container: { type: "view" },
        view: { type: "modal", callback_id: "branch_preference_modal" },
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(200);
    expect(mockAppHome).toHaveBeenCalledOnce();
  });

  it("enforces a channel found only in message container provenance", async () => {
    const response = await interactionRoutes.fetch(
      request({
        ...identity,
        type: "block_actions",
        container: { type: "message", channel_id: "C999" },
        actions: [{ action_id: "view_session" }],
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(403);
    expect(mockAppHome).not.toHaveBeenCalled();
    expect(mockHandleInteraction).not.toHaveBeenCalled();
  });

  it("rejects a channel-less interaction without App Home or modal provenance", async () => {
    const response = await interactionRoutes.fetch(
      request({ ...identity, type: "block_actions", actions: [{ action_id: "view_session" }] }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(403);
    expect(mockAppHome).not.toHaveBeenCalled();
    expect(mockHandleInteraction).not.toHaveBeenCalled();
  });

  it.each([
    ["app", { api_app_id: undefined }],
    ["app", { api_app_id: "A999" }],
    ["workspace", { team: undefined }],
    ["workspace", { team: { id: "T999" } }],
    ["user", { user: undefined }],
    ["user", { user: { id: "U999" } }],
    ["channel", { channel: { id: "C999" } }],
  ])("rejects the wrong %s before downstream activity", async (_name, override) => {
    const response = await interactionRoutes.fetch(
      request({
        ...identity,
        type: "block_actions",
        channel: { id: "C123" },
        actions: [{ action_id: "view_session" }],
        ...override,
      }),
      makeEnv(),
      makeCtx()
    );

    expect(response.status).toBe(403);
    expect(mockAppHome).not.toHaveBeenCalled();
    expect(mockHandleInteraction).not.toHaveBeenCalled();
  });

  it("fails closed when ingress bindings are malformed", async () => {
    const response = await interactionRoutes.fetch(
      request({ ...identity, type: "block_actions", actions: [{ action_id: "view_session" }] }),
      { ...makeEnv(), SLACK_ALLOWED_USER_IDS: "" },
      makeCtx()
    );

    expect(response.status).toBe(503);
    expect(mockAppHome).not.toHaveBeenCalled();
    expect(mockHandleInteraction).not.toHaveBeenCalled();
  });
});
