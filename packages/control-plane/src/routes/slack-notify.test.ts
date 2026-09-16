import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import { SECTION_TEXT_MAX_CHARS } from "@open-inspect/shared/slack";
import { handleSlackNotify } from "./slack-notify";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import type { Principal } from "../auth/principal";
import { fakeSessionRuntimeDispatch, TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

const sessionStoreMock = {
  get: vi.fn(),
};

const integrationStoreMock = {
  getResolvedConfig: vi.fn(),
  getGlobal: vi.fn(),
};

const automationStoreMock = {
  getById: vi.fn(),
};

vi.mock("../db/session-index", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    SessionIndexStore: vi.fn().mockImplementation(function () {
      return sessionStoreMock;
    }),
  };
});

vi.mock("../db/integration-settings", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    IntegrationSettingsStore: vi.fn().mockImplementation(function () {
      return integrationStoreMock;
    }),
  };
});

vi.mock("../db/automation-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return automationStoreMock;
    }),
  };
});

const fetchMock = vi.fn();

const sessionFetchMock = vi.fn();

const PATH = "/sessions/sess-1/slack-notify";
const PATTERN = /^\/sessions\/(?<id>[^/]+)\/slack-notify$/;

function createCtx(principal?: Principal): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    ...(principal ? { principal } : {}),
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(overrides?: Partial<Env>): Env {
  return {
    DB: {} as SqlDatabase,
    SESSION: fakeSessionRuntimeDispatch((request) => sessionFetchMock(request)),
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
    SLACK_BOT_TOKEN: "xoxb-test",
    APP_NAME: "Open-Inspect",
    WEB_APP_URL: "https://app.example.com",
    ...overrides,
  } as Env;
}

async function callHandler(
  body: unknown,
  envOverrides?: Partial<Env>,
  principal?: Principal
): Promise<Response> {
  const params = { id: PATH.match(PATTERN)!.groups!.id };
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleSlackNotify(
    new Request(`https://test.local${PATH}`, init),
    createEnv(envOverrides),
    params,
    createCtx(principal)
  );
}

async function callMultipart(
  fields: { channel?: string; text?: string; threadTs?: string; file?: File },
  envOverrides?: Partial<Env>
): Promise<Response> {
  const form = new FormData();
  if (fields.channel !== undefined) form.set("channel", fields.channel);
  if (fields.text !== undefined) form.set("text", fields.text);
  if (fields.threadTs !== undefined) form.set("thread_ts", fields.threadTs);
  if (fields.file) form.set("file", fields.file);
  return handleSlackNotify(
    new Request(`https://test.local${PATH}`, { method: "POST", body: form }),
    createEnv(envOverrides),
    { id: "sess-1" },
    createCtx({ kind: "sandbox", sessionId: "sess-1" })
  );
}

function seedActiveSession(opts?: {
  parentSessionId?: string | null;
  spawnSource?: string;
  userId?: string | null;
  status?: SessionStatus;
  repoOwner?: string | null;
  repoName?: string | null;
  automationId?: string | null;
}) {
  sessionStoreMock.get.mockResolvedValue({
    id: "sess-1",
    title: "Test session",
    repoOwner: opts && "repoOwner" in opts ? opts.repoOwner : "acme",
    repoName: opts && "repoName" in opts ? opts.repoName : "web-app",
    model: "anthropic/claude-sonnet-4-6",
    reasoningEffort: null,
    baseBranch: null,
    status: opts?.status ?? "active",
    parentSessionId: opts?.parentSessionId ?? null,
    spawnSource: opts?.spawnSource ?? "user",
    spawnDepth: 0,
    userId: opts?.userId ?? "user-1",
    automationId: opts?.automationId ?? null,
    createdAt: 1,
    updatedAt: 1,
  });
}

function mockSlackResponse(opts: { status?: number; body?: unknown; retryAfter?: string }) {
  fetchMock.mockResolvedValueOnce(
    new Response(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: opts.retryAfter ? { "retry-after": opts.retryAfter } : undefined,
    })
  );
}

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionFetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

function lastLogPayload(
  spy: ReturnType<typeof vi.spyOn>,
  msg: string
): Record<string, unknown> | undefined {
  for (let i = spy.mock.calls.length - 1; i >= 0; i--) {
    const call = spy.mock.calls[i];
    for (const arg of call) {
      if (typeof arg !== "string") continue;
      try {
        const parsed = JSON.parse(arg) as Record<string, unknown>;
        if (parsed.msg === msg) return parsed;
      } catch {
        /* skip */
      }
    }
  }
  return undefined;
}

describe("handleSlackNotify", () => {
  it("uses the automation destination even when the model supplies another channel", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    const response = await callHandler({ channel: "CWRONG123", text: "hello" }, undefined, {
      kind: "sandbox",
      sessionId: "sess-1",
    });

    expect(response.status).toBe(200);
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { channel: string };
    expect(sent.channel).toBe("C0C0MEE8F7E");
  });

  it("preserves only the automation's exact configured user mention", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
      slack_delivery_mention_user_id: "U0ANGIE123",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    const response = await callHandler(
      {
        channel: "CWRONG123",
        text: "<!channel> {{delivery_mention}} and {{delivery_mention}} <@U0OTHER123>",
      },
      undefined,
      { kind: "sandbox", sessionId: "sess-1" }
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    const text = sent.blocks.find(({ type }) => type === "section")?.text?.text;
    expect(text).toBe(" <@U0ANGIE123> and <@U0ANGIE123> ");
  });

  it("strips every automation direct mention when no user is configured", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
      slack_delivery_mention_user_id: null,
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    const response = await callHandler(
      {
        channel: "CWRONG123",
        text: "Report for {{delivery_mention}} <!here> <@U0ANGIE123>",
      },
      undefined,
      { kind: "sandbox", sessionId: "sess-1" }
    );

    expect(response.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    const text = sent.blocks.find(({ type }) => type === "section")?.text?.text ?? "";
    expect(text.trim()).toBe("Report for");
    expect(text).not.toContain("{{delivery_mention}}");
    expect(text).not.toContain("<!here>");
    expect(text).not.toContain("<@U0ANGIE123>");
  });

  it("does not resolve the automation placeholder for an ordinary session", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C1", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    const response = await callHandler({
      channel: "C1",
      text: "Hi {{delivery_mention}} <@U0OTHER123>",
    });

    expect(response.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(sent.blocks.find(({ type }) => type === "section")?.text?.text).toBe(
      "Hi {{delivery_mention}} "
    );
  });

  it("accepts generic multipart metadata and attaches the HTML to the summary", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({
      body: { ok: true, upload_url: "https://upload.slack.test/u", file_id: "F1" },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    mockSlackResponse({ body: { ok: true, files: [{ id: "F1", title: "report.html" }] } });
    mockSlackResponse({ body: { ok: true } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    const response = await callMultipart({
      channel: "CWRONG123",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", {
        type: "application/octet-stream",
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const post = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(post.channel).toBe("C0C0MEE8F7E");
    expect(post.thread_ts).toBeUndefined();
    expect(String(fetchMock.mock.calls[1][0])).toContain("files.getUploadURLExternal");
    expect(String(fetchMock.mock.calls[2][0])).toBe("https://upload.slack.test/u");
    const complete = JSON.parse(fetchMock.mock.calls[3][1].body as string) as Record<
      string,
      unknown
    >;
    expect(complete).toEqual({ files: [{ id: "F1", title: "report.html" }] });
    const update = JSON.parse(fetchMock.mock.calls[4][1].body as string) as Record<string, unknown>;
    expect(String(fetchMock.mock.calls[4][0])).toContain("chat.update");
    expect(update).toMatchObject({
      channel: "C0C0MEE8F7E",
      ts: "1.2",
      text: "Weekly report",
      file_ids: ["F1"],
    });
    expect(Array.isArray(update.blocks)).toBe(true);
  });

  it("binds an interactive HTML attachment to the active Slack source thread", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });
    sessionFetchMock.mockResolvedValueOnce(
      Response.json({ channel: "C0TRUSTED1", threadTs: "111.222" })
    );
    mockSlackResponse({ body: { ok: true, channel: "C0TRUSTED1", ts: "333.444" } });
    mockSlackResponse({
      body: { ok: true, upload_url: "https://upload.slack.test/u", file_id: "F2" },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    mockSlackResponse({ body: { ok: true, files: [{ id: "F2", title: "report-v2.html" }] } });
    mockSlackResponse({ body: { ok: true } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p2", channel: "C1" } });

    const response = await callMultipart({
      channel: "C0SPOOFED",
      threadTs: "999.000",
      text: "Revised weekly report",
      file: new File(["<html>report v2</html>"], "report-v2.html", { type: "text/html" }),
    });

    expect(response.status).toBe(200);
    const post = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(post.channel).toBe("C0TRUSTED1");
    expect(post.thread_ts).toBe("111.222");
    const update = JSON.parse(fetchMock.mock.calls[4][1].body as string) as Record<string, unknown>;
    expect(update).toMatchObject({ channel: "C0TRUSTED1", ts: "333.444", file_ids: ["F2"] });
  });

  it("rejects interactive HTML without an active Slack prompt", async () => {
    seedActiveSession();
    sessionFetchMock.mockResolvedValueOnce(new Response("No active prompt", { status: 409 }));

    const response = await callMultipart({
      channel: "C0SPOOFED",
      threadTs: "999.000",
      text: "Revised weekly report",
      file: new File(["<html>report v2</html>"], "report-v2.html", { type: "text/html" }),
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an attachment from an ordinary session before calling Slack", async () => {
    seedActiveSession();

    const response = await callMultipart({
      channel: "C12345678",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", { type: "text/html" }),
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an attachment requested by a collaborating user before calling Slack", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    const form = new FormData();
    form.set("channel", "CWRONG123");
    form.set("text", "Weekly report");
    form.set("file", new File(["<html>report</html>"], "report.html", { type: "text/html" }));

    const response = await handleSlackNotify(
      new Request(`https://test.local${PATH}`, { method: "POST", body: form }),
      createEnv(),
      { id: "sess-1" },
      createCtx({ kind: "user", userId: "user-2" })
    );

    expect(response.status).toBe(403);
    expect(sessionStoreMock.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects automation-owned text delivery requested by a collaborating user", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });

    const response = await callHandler({ channel: "CWRONG123", text: "Weekly report" }, undefined, {
      kind: "user",
      userId: "user-2",
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", new File([], "report.html", { type: "text/html" })],
    [
      "oversized",
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "report.html", { type: "text/html" }),
    ],
    ["extension", new File(["report"], "report.txt", { type: "text/html" })],
    ["document", new File(["report"], "report.html", { type: "text/html" })],
    ["utf8", new File([new Uint8Array([0xff])], "report.html", { type: "text/html" })],
    ["nul", new File(["<html>\0</html>"], "report.html", { type: "text/html" })],
  ])("rejects invalid HTML attachment: %s", async (_case, file) => {
    const response = await callMultipart({ channel: "C12345678", text: "Report", file });

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports partial delivery failure without attempting finalization", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({ body: { ok: false, error: "invalid_response" } });

    const response = await callMultipart({
      channel: "C12345678",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", { type: "text/html" }),
    });

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports upload failure without attempting finalization", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({
      body: { ok: true, upload_url: "https://upload.slack.test/u", file_id: "F1" },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));

    const response = await callMultipart({
      channel: "C12345678",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", { type: "text/html" }),
    });

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports finalization failure after upload", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({
      body: { ok: true, upload_url: "https://upload.slack.test/u", file_id: "F1" },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    mockSlackResponse({ body: { ok: false, error: "delivery_unknown" } });

    const response = await callMultipart({
      channel: "C12345678",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", { type: "text/html" }),
    });

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails closed when Slack finalizes without confirming the uploaded file", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({
      body: { ok: true, upload_url: "https://upload.slack.test/u", file_id: "F1" },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    mockSlackResponse({ body: { ok: true, files: [] } });

    const response = await callMultipart({
      channel: "C12345678",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", { type: "text/html" }),
    });

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports failure when the finalized file cannot be attached to the summary", async () => {
    seedActiveSession({ automationId: "auto-1" });
    automationStoreMock.getById.mockResolvedValue({
      id: "auto-1",
      slack_delivery_channel: "C0C0MEE8F7E",
    });
    mockSlackResponse({ body: { ok: true, channel: "C0C0MEE8F7E", ts: "1.2" } });
    mockSlackResponse({
      body: { ok: true, upload_url: "https://upload.slack.test/u", file_id: "F1" },
    });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    mockSlackResponse({ body: { ok: true, files: [{ id: "F1", title: "report.html" }] } });
    mockSlackResponse({ body: { ok: false, error: "cant_update_message" } });

    const response = await callMultipart({
      channel: "C12345678",
      text: "Weekly report",
      file: new File(["<html>report</html>"], "report.html", { type: "text/html" }),
    });

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it("happy path posts no events to the DO — the agent's tool_call is the source of truth", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C1", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    await callHandler({ channel: "#ops", text: "hello" });

    expect(sessionFetchMock).not.toHaveBeenCalled();
  });

  it("returns 503 feature_unavailable and logs at error level when SLACK_BOT_TOKEN is missing", async () => {
    seedActiveSession();
    const res = await callHandler(
      { channel: "#ops", text: "hello" },
      { SLACK_BOT_TOKEN: undefined }
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("feature_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
    // Misconfig must log at error (not warn) so it reaches alerting.
    const errorEntry = lastLogPayload(
      consoleErrorSpy,
      "Slack notification denied: SLACK_BOT_TOKEN is not configured"
    );
    expect(errorEntry).toBeDefined();
    expect(errorEntry?.reason).toBe("feature_unavailable");
  });

  it("returns feature_disabled when global master switch is off", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("feature_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
  });

  // The handler reads only the resolved master switch (returned by
  // getResolvedConfig, which already merges global + repo). Whether the
  // resolved `false` came from a global default or a repo override is not
  // the handler's concern — that resolution is covered by
  // IntegrationSettingsStore tests in db/integration-settings.test.ts.
  it("does not call Slack when feature_disabled regardless of resolution source", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Slack channel_not_found to channel_not_found_or_forbidden", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "channel_not_found" } });

    const res = await callHandler({ channel: "#nope", text: "hello" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("maps Slack not_in_channel to channel_not_found_or_forbidden", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "not_in_channel" } });

    const res = await callHandler({ channel: "#nope", text: "hello" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("maps Slack is_archived to channel_not_found_or_forbidden", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "is_archived" } });

    const res = await callHandler({ channel: "#archive", text: "hello" });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("channel_not_found_or_forbidden");
  });

  it("maps Slack 429 to rate_limited and surfaces Retry-After", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ status: 429, body: "", retryAfter: "30" });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retryAfter?: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retryAfter).toBe(30);
  });

  it("maps Slack 5xx to slack_api_error", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ status: 503, body: "" });

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slack_api_error");
  });

  it("returns empty_message_after_sanitization when sanitized text is empty", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });

    const res = await callHandler({ channel: "#ops", text: "<!channel>" });

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_message_after_sanitization");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits a long message and lets Slack derive accessible fallback text", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C1", ts: "12345.67890" } });
    mockSlackResponse({
      body: { ok: true, permalink: "https://x.slack.com/archives/C1/p1", channel: "C1" },
    });

    // Findings then recommendations: the tail is the part a reader needs, and
    // it is exactly what a hard cut used to remove.
    const findings = Array.from({ length: 40 }, (_, i) => `Finding ${i}: ${"x".repeat(70)}`).join(
      "\n\n"
    );
    const text = `${findings}\n\nRECOMMENDATION: do the thing.`;
    expect(text.length).toBeGreaterThan(SECTION_TEXT_MAX_CHARS);

    const res = await callHandler({ channel: "#ops", text });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { truncated: boolean }).truncated).toBe(false);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(body).not.toHaveProperty("text");
    const sections = body.blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.text!.text.length).toBeLessThanOrEqual(SECTION_TEXT_MAX_CHARS);
    }
    // Nothing lost: the closing recommendation survives.
    expect(sections.map((b) => b.text!.text).join("")).toContain("RECOMMENDATION: do the thing.");
  });

  it("strips broadcasts, sanitizes links, applies mentions policy, and reports metadata", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "strip" },
    });
    mockSlackResponse({
      body: { ok: true, channel: "C1", ts: "12345.67890" },
    });
    mockSlackResponse({
      body: {
        ok: true,
        permalink: "https://x.slack.com/archives/C1/p1234567890",
        channel: "C1",
      },
    });

    const text = "<!here> hi <@U999> see <https://evil|github.com>";
    const res = await callHandler({ channel: "#ops", text });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      strippedBroadcasts: boolean;
      mentionsModified: boolean;
      truncated: boolean;
      channelInput: string;
      permalink: string;
    };
    expect(body.ok).toBe(true);
    expect(body.strippedBroadcasts).toBe(true);
    expect(body.mentionsModified).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.channelInput).toBe("#ops");
    expect(body.permalink).toBe("https://x.slack.com/archives/C1/p1234567890");

    const slackCall = fetchMock.mock.calls[0];
    const slackUrl = (slackCall[0] as URL | string).toString();
    expect(slackUrl).toContain("chat.postMessage");
    const sentBody = JSON.parse(slackCall[1].body as string) as {
      channel: string;
      blocks: Array<{ type: string; text?: { text: string } }>;
    };
    expect(sentBody.channel).toBe("#ops");
    const sentText = sentBody.blocks.find((block) => block.type === "section")?.text?.text ?? "";
    expect(sentText).not.toContain("<!here>");
    expect(sentText).not.toContain("<@U999>");
    expect(sentText).toContain("https://evil");
    expect(sentText).not.toContain("|github.com>");
  });

  it("returns the success envelope (no events emitted) and logs attribution on success", async () => {
    seedActiveSession({
      parentSessionId: "parent-1",
      spawnSource: "agent",
      userId: "user-42",
    });
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({
      body: { ok: true, channel: "C1", ts: "12345.67890" },
    });
    mockSlackResponse({
      body: {
        ok: true,
        permalink: "https://x.slack.com/archives/C1/p1234567890",
        channel: "C1",
      },
    });

    const res = await callHandler({
      channel: "#ops",
      text: "Migration complete",
      reason: "user asked",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.channelInput).toBe("#ops");
    expect(body.channelId).toBe("C1");
    expect(body.messageTs).toBe("12345.67890");
    expect(body.permalink).toBe("https://x.slack.com/archives/C1/p1234567890");
    // Attribution belongs in audit logs only — must not leak to the agent.
    expect(body).not.toHaveProperty("attribution");

    expect(sessionFetchMock).not.toHaveBeenCalled();

    const logEntry = lastLogPayload(consoleLogSpy, "Slack notification posted");
    expect(logEntry).toBeDefined();
    expect(logEntry?.parent_session_id).toBe("parent-1");
    expect(logEntry?.trigger_source).toBe("agent");
    expect(logEntry?.prompt_author_user_id).toBe("user-42");
    expect(logEntry?.repo).toBe("acme/web-app");
    expect(logEntry?.channel_id).toBe("C1");
    expect(logEntry?.request_reason).toBe("user asked");
  });

  it("uses global settings and a null repo audit field for no-repo sessions", async () => {
    seedActiveSession({
      parentSessionId: "parent-1",
      spawnSource: "automation",
      userId: "user-42",
      repoOwner: null,
      repoName: null,
    });
    integrationStoreMock.getGlobal.mockResolvedValue({
      defaults: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({
      body: { ok: true, channel: "C1", ts: "12345.67890" },
    });
    mockSlackResponse({
      body: {
        ok: true,
        permalink: "https://x.slack.com/archives/C1/p1234567890",
        channel: "C1",
      },
    });

    const res = await callHandler({ channel: "#ops", text: "Done" });

    expect(res.status).toBe(200);
    expect(integrationStoreMock.getGlobal).toHaveBeenCalledWith("slack");
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();

    const logEntry = lastLogPayload(consoleLogSpy, "Slack notification posted");
    expect(logEntry).toBeDefined();
    expect(logEntry?.repo).toBeNull();
  });

  it("uses global wording when global Slack settings disable notifications", async () => {
    seedActiveSession({
      spawnSource: "automation",
      repoOwner: null,
      repoName: null,
    });
    integrationStoreMock.getGlobal.mockResolvedValue({
      defaults: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    const res = await callHandler({ channel: "#ops", text: "Done" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "feature_disabled",
      message: "Slack agent notifications are disabled globally.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(integrationStoreMock.getGlobal).toHaveBeenCalledWith("slack");
    expect(integrationStoreMock.getResolvedConfig).not.toHaveBeenCalled();
  });

  it("logs an audit warning with attribution on Slack-side denial (no events emitted)", async () => {
    seedActiveSession({
      parentSessionId: "parent-2",
      spawnSource: "agent",
      userId: "user-99",
    });
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: false, error: "channel_not_found" } });

    await callHandler({ channel: "#nope", text: "hi" });

    expect(sessionFetchMock).not.toHaveBeenCalled();

    const logEntry = lastLogPayload(consoleWarnSpy, "Slack notification denied");
    expect(logEntry).toBeDefined();
    expect(logEntry?.reason).toBe("channel_not_found_or_forbidden");
    expect(logEntry?.parent_session_id).toBe("parent-2");
    expect(logEntry?.trigger_source).toBe("agent");
    expect(logEntry?.prompt_author_user_id).toBe("user-99");
    expect(logEntry?.request_reason).toBeNull();
  });

  it("passes channel input verbatim to Slack — channel ID", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C01ABC", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    await callHandler({ channel: "C01ABC", text: "hi" });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      channel: string;
    };
    expect(sentBody.channel).toBe("C01ABC");
  });

  it("passes channel input verbatim to Slack — name with hash", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    mockSlackResponse({ body: { ok: true, channel: "C123", ts: "1.2" } });
    mockSlackResponse({ body: { ok: true, permalink: "https://x.slack.com/p", channel: "C1" } });

    await callHandler({ channel: "#ops", text: "hi" });

    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      channel: string;
    };
    expect(sentBody.channel).toBe("#ops");
  });

  it("does not call Slack when feature is disabled", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: false, mentionsPolicy: "allow" },
    });

    await callHandler({ channel: "#ops", text: "hi" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps Slack network/fetch failures to slack_api_error", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    // Shared slackFetch wraps fetch() in try/catch and returns
    // { ok: false, error: "network_error" } on TypeError. The handler must
    // map that to slack_api_error rather than letting the rejection escape.
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const res = await callHandler({ channel: "#ops", text: "hello" });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("slack_api_error");
    expect(sessionFetchMock).not.toHaveBeenCalled();
  });

  it("returns a deterministic Slack API error when posting times out", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    const responsePromise = callHandler({ channel: "#ops", text: "hello" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    const res = await responsePromise;
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({
      error: "delivery_unknown",
      message: "delivery_unknown",
    });
  });

  it("rejects raw text longer than the input cap", async () => {
    seedActiveSession();
    integrationStoreMock.getResolvedConfig.mockResolvedValue({
      enabledRepos: null,
      settings: { agentNotificationsEnabled: true, mentionsPolicy: "allow" },
    });

    const oversized = "a".repeat(12_001);
    const res = await callHandler({ channel: "#ops", text: oversized });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionFetchMock).not.toHaveBeenCalled();
  });
});
