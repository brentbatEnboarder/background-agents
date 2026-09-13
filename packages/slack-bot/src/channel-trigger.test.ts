import { describe, expect, it, vi, beforeEach } from "vitest";
import type * as SlackModule from "@open-inspect/shared/slack";
import type { Env } from "./types";

const {
  mockVerifySlackSignature,
  mockAuthTest,
  mockGetChannelInfo,
  mockGetPermalink,
  mockAddReaction,
} = vi.hoisted(() => ({
  mockVerifySlackSignature: vi.fn(),
  mockAuthTest: vi.fn(),
  mockGetChannelInfo: vi.fn(),
  mockGetPermalink: vi.fn(),
  mockAddReaction: vi.fn(),
}));

vi.mock("@open-inspect/shared/slack", async () => {
  const actual = await vi.importActual<typeof SlackModule>("@open-inspect/shared/slack");
  return {
    ...actual, // keep the real Slack client functions not under test
    verifySlackSignature: mockVerifySlackSignature,
    authTest: mockAuthTest,
    getChannelInfo: mockGetChannelInfo,
    getPermalink: mockGetPermalink,
    addReaction: mockAddReaction,
  };
});

import { handleChannelTrigger } from "./channel-trigger";
import { clearLocalCache } from "./classifier/repos";
import { clearBotUserIdCache } from "./bot-identity";

const BOT_USER_ID = "UBOT123";

function createMockKV() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (!value) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

/** Control-plane fetch mock: serves the watched-channel set and records forwards. */
function makeControlPlaneFetch(
  watched: string[],
  triggered: number,
  steered: number,
  forwardResponse?: unknown
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.includes("/integration-settings/slack/watched-channels")) {
      return new Response(JSON.stringify({ channels: watched }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/internal/slack-event")) {
      const skipped = triggered === 0 && steered === 0 ? 1 : 0;
      return new Response(
        JSON.stringify(forwardResponse ?? { ok: true, triggered, skipped, steered }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function makeEnv(
  opts: {
    watched?: string[];
    triggered?: number;
    steered?: number;
    forwardResponse?: unknown;
  } = {}
): Env {
  return {
    SLACK_KV: createMockKV() as unknown as KVNamespace,
    CONTROL_PLANE: {
      fetch: makeControlPlaneFetch(
        opts.watched ?? ["C123"],
        opts.triggered ?? 1,
        opts.steered ?? 0,
        opts.forwardResponse
      ),
    } as unknown as Fetcher,
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control-plane.test",
    WEB_APP_URL: "https://app.test",
    DEFAULT_MODEL: "anthropic/claude-haiku-4-5",
    CLASSIFICATION_MODEL: "anthropic/claude-haiku-4-5",
    SLACK_APP_ID: "A123",
    SLACK_TEAM_ID: "T123",
    SLACK_ALLOWED_USER_IDS: "U999",
    SLACK_ALLOWED_CHANNEL_IDS: "C123",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_SIGNING_SECRET: "secret",
    SERVICE_AUTH_SECRET: "internal-secret",
  } as unknown as Env;
}

function channelMessage(event: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel_type: "channel",
    channel: "C123",
    ts: "1700000000.000100",
    user: "U999",
    text: "the deploy job keeps failing",
    ...event,
  };
}

function forwardedSlackEvents(fetchMock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).includes("/internal/slack-event"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

describe("handleChannelTrigger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalCache();
    clearBotUserIdCache();
    mockVerifySlackSignature.mockResolvedValue(true);
    mockAuthTest.mockResolvedValue({ ok: true, user_id: BOT_USER_ID });
    mockGetChannelInfo.mockResolvedValue({ ok: true, channel: { id: "C123", name: "ops" } });
    mockGetPermalink.mockResolvedValue({
      ok: true,
      permalink: "https://slack.com/archives/C123/p1700000000000100",
    });
    mockAddReaction.mockResolvedValue({ ok: true });
  });

  it("forwards a normalized event for a candidate message in a watched channel", async () => {
    const env = makeEnv({ watched: ["C123"] });

    await handleChannelTrigger(channelMessage(), env, "trace-1");

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      source: "slack",
      channelId: "C123",
      channelName: "ops",
      actorUserId: "U999",
      text: "the deploy job keeps failing",
      triggerKey: "slack:msg:C123:1700000000.000100",
    });
    expect(mockAddReaction).toHaveBeenCalledWith("xoxb-test", "C123", "1700000000.000100", "eyes");
  });

  it("does not react when the forward matches no automation (triggered: 0)", async () => {
    const env = makeEnv({ watched: ["C123"], triggered: 0 });

    await handleChannelTrigger(channelMessage(), env, undefined);

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("reacts when a follow-up steers an active run", async () => {
    const env = makeEnv({ watched: ["C123"], triggered: 0, steered: 1 });

    await handleChannelTrigger(
      channelMessage({ ts: "1700000000.000200", thread_ts: "1700000000.000100" }),
      env,
      undefined
    );
    expect(mockAddReaction).toHaveBeenCalledWith("xoxb-test", "C123", "1700000000.000200", "eyes");
  });

  it("does not react when the control-plane forward response is malformed", async () => {
    const env = makeEnv({
      watched: ["C123"],
      forwardResponse: { triggered: "1", skipped: 0, steered: 0 },
    });
    await handleChannelTrigger(channelMessage(), env, undefined);

    expect(mockAddReaction).not.toHaveBeenCalled();
  });

  it("does not forward a message in an unwatched channel", async () => {
    const env = makeEnv({ watched: ["C-other"] });

    await handleChannelTrigger(channelMessage(), env, undefined);

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(0);
  });

  it("suppresses a message that mentions the bot (handled by app_mention)", async () => {
    const env = makeEnv({ watched: ["C123"] });

    await handleChannelTrigger(
      channelMessage({ text: `<@${BOT_USER_ID}> please deploy` }),
      env,
      undefined
    );

    const forwarded = forwardedSlackEvents(
      env.CONTROL_PLANE.fetch as unknown as { mock: { calls: readonly (readonly unknown[])[] } }
    );
    expect(forwarded).toHaveLength(0);
  });
});
