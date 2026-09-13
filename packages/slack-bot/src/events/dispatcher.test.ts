import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { SlackEventPayload } from "./payload";

const { mockPublishAppHome, mockHandleAppMention, mockHandleDirectMessage, mockContinuation } =
  vi.hoisted(() => ({
    mockPublishAppHome: vi.fn(),
    mockHandleAppMention: vi.fn(),
    mockHandleDirectMessage: vi.fn(),
    mockContinuation: vi.fn(),
  }));

vi.mock("../app-home", () => ({ publishAppHome: mockPublishAppHome }));
vi.mock("./message-handler", () => ({
  handleAppMention: mockHandleAppMention,
  handleDirectMessage: mockHandleDirectMessage,
  handleThreadContinuation: mockContinuation,
}));

import { handleSlackEvent } from "./dispatcher";

const env = {
  SLACK_APP_ID: "A123",
  SLACK_TEAM_ID: "T123",
  SLACK_ALLOWED_USER_IDS: "U123,U456",
  SLACK_ALLOWED_CHANNEL_IDS: "C123",
} as Env;
const scheduleBackground = vi.fn();

function payload(event: SlackEventPayload["event"]): SlackEventPayload {
  return {
    type: "event_callback",
    api_app_id: "A123",
    team_id: "T123",
    event,
  };
}

describe("handleSlackEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes an authorized ordinary channel reply only to continuation", async () => {
    await handleSlackEvent(
      payload({
        type: "message",
        text: "continue this",
        user: "U456",
        channel: "C123",
        ts: "222.333",
        thread_ts: "111.222",
        files: [{ id: "F123", name: "chart.png" }],
        attachments: [{ is_share: true, text: "forwarded body" }],
      }),
      env,
      "trace-1",
      scheduleBackground
    );

    expect(mockContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "continue this",
        user: "U456",
        channel: "C123",
        thread_ts: "111.222",
        files: [{ id: "F123", name: "chart.png" }],
        attachments: [{ is_share: true, text: "forwarded body" }],
      }),
      env,
      "trace-1"
    );
    expect(mockHandleAppMention).not.toHaveBeenCalled();
    expect(mockHandleDirectMessage).not.toHaveBeenCalled();
  });

  it("silently ignores an authorized ordinary top-level channel message", async () => {
    await handleSlackEvent(
      payload({
        type: "message",
        text: "ambient conversation",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      undefined,
      scheduleBackground
    );

    expect(mockContinuation).not.toHaveBeenCalled();
    expect(mockHandleAppMention).not.toHaveBeenCalled();
    expect(mockHandleDirectMessage).not.toHaveBeenCalled();
  });

  it("retains explicit mention and direct-message routing", async () => {
    await handleSlackEvent(
      payload({
        type: "app_mention",
        text: "<@U999> investigate",
        user: "U123",
        channel: "C123",
        ts: "111.222",
      }),
      env,
      undefined,
      scheduleBackground
    );
    await handleSlackEvent(
      payload({
        type: "message",
        text: "investigate",
        user: "U123",
        channel: "D123",
        channel_type: "im",
        ts: "333.444",
      }),
      env,
      undefined,
      scheduleBackground
    );

    expect(mockHandleAppMention).toHaveBeenCalledOnce();
    expect(mockHandleDirectMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ["app", { api_app_id: "A999" }],
    ["workspace", { team_id: "T999" }],
    [
      "user",
      { event: { type: "message", user: "U999", channel: "C123", ts: "2", thread_ts: "1" } },
    ],
    [
      "channel",
      { event: { type: "message", user: "U123", channel: "C999", ts: "2", thread_ts: "1" } },
    ],
    ["bot", { event: { type: "message", bot_id: "B123", channel: "C123" } }],
    ["subtype", { event: { type: "message", subtype: "message_changed" } }],
  ])("reapplies %s admission before handler side effects", async (_label, override) => {
    const base = payload({
      type: "message",
      text: "continue",
      user: "U123",
      channel: "C123",
      ts: "2",
      thread_ts: "1",
    });
    const eventOverride = (override as { event?: SlackEventPayload["event"] }).event;
    const candidate = {
      ...base,
      ...override,
      event: {
        ...base.event,
        ...eventOverride,
      },
    } as SlackEventPayload;

    await handleSlackEvent(candidate, env, undefined, scheduleBackground);

    expect(mockPublishAppHome).not.toHaveBeenCalled();
    expect(mockContinuation).not.toHaveBeenCalled();
    expect(mockHandleAppMention).not.toHaveBeenCalled();
    expect(mockHandleDirectMessage).not.toHaveBeenCalled();
  });
});
