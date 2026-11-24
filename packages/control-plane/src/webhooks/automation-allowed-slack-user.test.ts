import { beforeEach, describe, expect, it } from "vitest";
import type { CacheStore } from "@open-inspect/shared";
import { hashApiKey } from "../auth/webhook-key";
import type { Env } from "../types";
import {
  handleAutomationAllowedSlackUser,
  type AllowedSlackUserPorts,
} from "./automation-allowed-slack-user";

const API_KEY = "test-allowed-user-key";
const AUTOMATION_ID = "auto-alex-dm";
const MEMBER = "U0123456789";
const OUTSIDER = "U0999999999";
const ENV = { SLACK_ALLOWED_USER_IDS: MEMBER } as Env;

function slackKv(stored: Record<string, string>): CacheStore {
  return { get: async (key: string) => stored[key] ?? null } as unknown as CacheStore;
}

type FakeAutomation = Awaited<ReturnType<AllowedSlackUserPorts["findAutomation"]>>;

describe("allowed Slack user check", () => {
  let automation: FakeAutomation;
  const ports: AllowedSlackUserPorts = {
    findAutomation: async (id) => (automation?.id === id ? automation : null),
  };

  beforeEach(async () => {
    automation = {
      id: AUTOMATION_ID,
      trigger_type: "webhook",
      trigger_auth_data: await hashApiKey(API_KEY),
      slack_delivery_channel: null,
    };
  });

  function ask(
    body: unknown,
    env: Env = ENV,
    headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` }
  ) {
    const request = new Request(
      `https://test.local/webhooks/automation/${AUTOMATION_ID}/allowed-slack-user`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }
    );
    return handleAutomationAllowedSlackUser(request, env, { id: AUTOMATION_ID }, ports);
  }

  it("answers allowed for a user on the Slack bot's allowed users", async () => {
    const response = await ask({ userId: MEMBER });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: MEMBER, allowed: true });
  });

  it("counts users an operator added in KV", async () => {
    const response = await ask({ userId: OUTSIDER }, {
      ...ENV,
      SLACK_KV: slackKv({ "slack:allowed-users": OUTSIDER }),
    } as Env);

    expect(await response.json()).toEqual({ userId: OUTSIDER, allowed: true });
  });

  it.each([
    { case: "is not on the list", env: ENV },
    { case: "is checked with no list configured", env: {} as Env },
    { case: "is checked against an invalid list", env: { SLACK_ALLOWED_USER_IDS: "bad" } as Env },
  ])("answers not allowed when the user $case", async ({ env }) => {
    const response = await ask({ userId: OUTSIDER }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: OUTSIDER, allowed: false });
  });

  it.each<{ case: string; headers: Record<string, string>; status: number }>([
    { case: "no API key", headers: {}, status: 401 },
    { case: "a wrong API key", headers: { Authorization: "Bearer wrong" }, status: 401 },
  ])("refuses a caller with $case", async ({ headers, status }) => {
    const response = await ask({ userId: MEMBER }, ENV, headers);

    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("allowed");
  });

  it("refuses an unknown or non-webhook automation", async () => {
    automation = { ...automation!, trigger_type: "schedule" };

    const response = await ask({ userId: MEMBER });

    expect(response.status).toBe(404);
  });

  it("answers only for a dedicated automation, not one bound to a channel", async () => {
    automation = { ...automation!, slack_delivery_channel: "C0123456789" };

    const response = await ask({ userId: MEMBER });

    expect(response.status).toBe(409);
  });

  it.each([
    { case: "malformed JSON", body: "{" },
    { case: "a non-Slack user ID", body: { userId: "alice" } },
    { case: "extra fields", body: { userId: MEMBER, admit: true } },
  ])("refuses $case", async ({ body }) => {
    const response = await ask(body);

    expect(response.status).toBe(400);
  });
});
