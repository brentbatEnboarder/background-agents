import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { IntegrationSettingsStore } from "../../src/db/integration-settings";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { initNamedSessionDO, queryDO, seedSandboxAuth } from "./helpers";

async function setupSession(opts?: {
  agentNotificationsEnabled?: boolean;
  mentionsPolicy?: "allow" | "escape" | "strip";
  parentSessionId?: string | null;
  spawnSource?: "user" | "agent";
  userId?: string;
}) {
  const sessionName = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { stub } = await initNamedSessionDO(sessionName, {
    repoOwner: "acme",
    repoName: "web-app",
    userId: opts?.userId ?? "user-1",
  });

  const sandboxToken = `sb-tok-${Date.now()}`;
  await seedSandboxAuth(stub, {
    authToken: sandboxToken,
    sandboxId: `sb-${Date.now()}`,
  });

  const sessionStore = new SessionIndexStore(env.DB);
  const now = Date.now();
  await sessionStore.create({
    id: sessionName,
    title: "Test session",
    repoOwner: "acme",
    repoName: "web-app",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    status: "active",
    parentSessionId: opts?.parentSessionId ?? null,
    spawnSource: opts?.spawnSource ?? "user",
    spawnDepth: 0,
    userId: opts?.userId ?? "user-1",
    createdAt: now,
    updatedAt: now,
  });

  if (opts?.agentNotificationsEnabled !== undefined || opts?.mentionsPolicy !== undefined) {
    const store = new IntegrationSettingsStore(env.DB);
    await store.setGlobal("slack", {
      defaults: {
        agentNotificationsEnabled: opts?.agentNotificationsEnabled ?? false,
        mentionsPolicy: opts?.mentionsPolicy ?? "allow",
      },
    });
  }

  return { sessionName, stub, sandboxToken };
}

function buildSlackFetchMock(handlers: {
  postMessage?: () => Response;
  getPermalink?: () => Response;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("chat.postMessage")) {
      return handlers.postMessage
        ? handlers.postMessage()
        : new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), { status: 200 });
    }
    if (url.includes("chat.getPermalink")) {
      return handlers.getPermalink
        ? handlers.getPermalink()
        : new Response(
            JSON.stringify({
              ok: true,
              permalink: "https://x.slack.com/archives/C1/p12",
              channel: "C1",
            }),
            { status: 200 }
          );
    }
    throw new Error(`Unmocked fetch: ${url}`);
  });
}

describe("POST /sessions/:id/slack-notify", () => {
  beforeEach(cleanD1Tables);
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 401 without sandbox auth", async () => {
    const { sessionName } = await setupSession({ agentNotificationsEnabled: true });

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "#ops", text: "hi" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 403 feature_disabled when master switch is off", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      agentNotificationsEnabled: false,
    });

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({ channel: "#ops", text: "hi" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("feature_disabled");
  });

  it("returns the success envelope and persists no events of its own", async () => {
    const { sessionName, sandboxToken, stub } = await setupSession({
      agentNotificationsEnabled: true,
      mentionsPolicy: "allow",
      spawnSource: "agent",
    });

    vi.stubGlobal("fetch", buildSlackFetchMock({}));

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({
        channel: "#ops",
        text: "Migration complete",
        reason: "user asked",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      ok: boolean;
      channelInput: string;
      channelId: string;
      messageTs: string;
      permalink: string;
    }>();
    expect(body.ok).toBe(true);
    expect(body.channelInput).toBe("#ops");
    expect(body.channelId).toBe("C1");
    expect(body.permalink).toContain("slack.com");

    // Handler must inject no transcript events — the agent's own tool_call is the source of truth.
    const slackEvents = await queryDO<{ type: string; data: string }>(
      stub,
      "SELECT type, data FROM events WHERE data LIKE '%slack-notify%' ORDER BY created_at"
    );
    expect(slackEvents).toHaveLength(0);
  });

  it("maps Slack channel_not_found to 404 channel_not_found_or_forbidden", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      agentNotificationsEnabled: true,
    });

    vi.stubGlobal(
      "fetch",
      buildSlackFetchMock({
        postMessage: () =>
          new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
      })
    );

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({ channel: "#nope", text: "hi" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("passes channel verbatim to Slack — both name and ID forms", async () => {
    const { sessionName, sandboxToken } = await setupSession({
      agentNotificationsEnabled: true,
    });

    let capturedChannel: string | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("chat.postMessage")) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          capturedChannel = body.channel as string;
          return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), {
            status: 200,
          });
        }
        if (url.includes("chat.getPermalink")) {
          return new Response(
            JSON.stringify({ ok: true, permalink: "https://x.slack.com/p", channel: "C1" }),
            { status: 200 }
          );
        }
        throw new Error(`Unmocked fetch: ${url}`);
      })
    );

    await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sandboxToken}`,
      },
      body: JSON.stringify({ channel: "C01ABC", text: "hi" }),
    });
    expect(capturedChannel).toBe("C01ABC");
  });

  it("attaches interactive HTML to the active authenticated Slack thread", async () => {
    const { sessionName, sandboxToken, stub } = await setupSession({
      agentNotificationsEnabled: true,
      mentionsPolicy: "strip",
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await queryDO(
      stub,
      `INSERT INTO messages
         (id, author_id, content, source, callback_context, status, created_at, started_at)
       VALUES (?, ?, ?, 'slack', ?, 'processing', ?, ?)`,
      "message-active",
      authorId,
      "Revise the report",
      JSON.stringify({
        source: "slack",
        channel: "C0TRUSTED1",
        threadTs: "111.222",
        repoFullName: "acme/web-app",
        model: "anthropic/claude-sonnet-4-6",
      }),
      Date.now(),
      Date.now()
    );

    const slackFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("chat.postMessage")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ channel: "C0TRUSTED1", thread_ts: "111.222" });
        return Response.json({ ok: true, channel: "C0TRUSTED1", ts: "333.444" });
      }
      if (url.includes("files.getUploadURLExternal")) {
        return Response.json({
          ok: true,
          upload_url: "https://upload.slack.test/v2",
          file_id: "F2",
        });
      }
      if (url === "https://upload.slack.test/v2") return new Response("", { status: 200 });
      if (url.includes("files.completeUploadExternal")) {
        return Response.json({ ok: true, files: [{ id: "F2", title: "report-v2.html" }] });
      }
      if (url.includes("chat.update")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({ channel: "C0TRUSTED1", ts: "333.444", file_ids: ["F2"] });
        return Response.json({ ok: true });
      }
      if (url.includes("chat.getPermalink")) {
        return Response.json({ ok: true, permalink: "https://x.slack.com/p2", channel: "C1" });
      }
      throw new Error(`Unmocked fetch: ${url}`);
    });
    vi.stubGlobal("fetch", slackFetch);

    const form = new FormData();
    form.set("channel", "C0SPOOFED");
    form.set("thread_ts", "999.000");
    form.set("text", "Revised weekly report");
    form.set("file", new File(["<html>report v2</html>"], "report-v2.html"));
    const response = await SELF.fetch(`https://test.local/sessions/${sessionName}/slack-notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sandboxToken}` },
      body: form,
    });

    expect(response.status).toBe(200);
    expect(slackFetch).toHaveBeenCalledTimes(6);
  });
});
