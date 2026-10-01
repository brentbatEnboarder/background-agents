import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type { SlackEventPayload } from "./payload";

const { mockPostMessage } = vi.hoisted(() => ({ mockPostMessage: vi.fn() }));
vi.mock("@open-inspect/shared/slack", () => ({ postMessage: mockPostMessage }));

import { replyToUnauthorizedUser } from "./unauthorized-reply";

const reply = "Sorry, I am not responding on Slack.";
const env = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_ALLOWED_CHANNEL_IDS: "C123, C456",
  SLACK_UNAUTHORIZED_REPLY: reply,
} as Env;

function event(fields: NonNullable<SlackEventPayload["event"]>): SlackEventPayload {
  return { type: "event_callback", api_app_id: "A123", team_id: "T123", event: fields };
}

describe("replyToUnauthorizedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessage.mockResolvedValue({ ok: true });
  });

  it("answers a direct message in its thread", async () => {
    await replyToUnauthorizedUser(
      event({ type: "message", user: "U9", channel: "D123", channel_type: "im", ts: "1.1" }),
      env,
      undefined
    );
    expect(mockPostMessage).toHaveBeenCalledWith("xoxb-test", "D123", reply, { thread_ts: "1.1" });
  });

  it("answers a mention in an allowed channel, inside an existing thread", async () => {
    await replyToUnauthorizedUser(
      event({ type: "app_mention", user: "U9", channel: "C456", ts: "2.2", thread_ts: "2.0" }),
      env,
      undefined
    );
    expect(mockPostMessage).toHaveBeenCalledWith("xoxb-test", "C456", reply, { thread_ts: "2.0" });
  });

  it.each([
    ["ordinary channel chatter", { type: "message", user: "U9", channel: "C123", ts: "3.1" }],
    [
      "a mention outside the allowed channels",
      { type: "app_mention", user: "U9", channel: "C999", ts: "3.2" },
    ],
    [
      "an edited direct message",
      { type: "message", subtype: "message_changed", user: "U9", channel: "D1", ts: "3.3" },
    ],
    ["a bot message", { type: "message", bot_id: "B1", user: "U9", channel: "D1", ts: "3.4" }],
  ])("stays silent for %s", async (_label, fields) => {
    await replyToUnauthorizedUser(
      event(fields as NonNullable<SlackEventPayload["event"]>),
      env,
      undefined
    );
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("stays silent when no reply is configured", async () => {
    await replyToUnauthorizedUser(
      event({ type: "message", user: "U9", channel: "D123", ts: "4.1" }),
      { ...env, SLACK_UNAUTHORIZED_REPLY: "  " } as Env,
      undefined
    );
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it("never throws when Slack rejects the reply", async () => {
    mockPostMessage.mockRejectedValue(new Error("not_in_channel"));
    await expect(
      replyToUnauthorizedUser(
        event({ type: "message", user: "U9", channel: "D123", ts: "5.1" }),
        env,
        undefined
      )
    ).resolves.toBeUndefined();
  });
});
