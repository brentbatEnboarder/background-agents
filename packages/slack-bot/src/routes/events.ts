import { verifySlackSignature } from "@open-inspect/shared/slack";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { Hono } from "hono";
import { handleSlackEvent } from "../events/dispatcher";
import { slackEventPayloadSchema } from "../events/payload";
import { admitSlackEvent, resolveIngressBindings } from "../ingress-policy";
import { createLogger } from "../logger";
import type { Env } from "../types";

const log = createLogger("handler");
const EVENT_DEDUPE_TTL_MS = 60 * 60 * 1000;
const inFlightEventClaims = new Map<string, Promise<"claimed" | "duplicate" | "degraded">>();
export const eventRoutes = new Hono<{ Bindings: Env }>();

async function claimSlackEvent(
  env: Env,
  eventId: string,
  context: {
    traceId: string;
    eventType: string | undefined;
    retryNum: string | undefined;
    retryReason: string | undefined;
  }
): Promise<"claimed" | "duplicate" | "degraded"> {
  const dedupeKey = `event:${eventId}`;
  const existing = inFlightEventClaims.get(dedupeKey);
  if (existing) {
    await existing;
    return "duplicate";
  }

  const claim = Promise.resolve().then(async (): Promise<"claimed" | "duplicate" | "degraded"> => {
    const cacheStore = createKvCacheStore(env.SLACK_KV);
    let kvOperation: "get" | "put" = "get";
    try {
      if (await cacheStore.get(dedupeKey)) return "duplicate";
      kvOperation = "put";
      await cacheStore.put(dedupeKey, "1", { expirationTtl: EVENT_DEDUPE_TTL_MS / 1000 });
      return "claimed";
    } catch (error) {
      // This cache is best-effort. Returning 500 would drop the original work and guarantee retries.
      log.error("slack.event.dedupe_unavailable", {
        trace_id: context.traceId,
        event_id: eventId,
        event_type: context.eventType,
        kv_operation: kvOperation,
        slack_retry_num: context.retryNum,
        slack_retry_reason: context.retryReason,
        outcome: "degraded",
        degradation_mode: "process_without_deduplication",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return "degraded";
    }
  });
  inFlightEventClaims.set(dedupeKey, claim);
  try {
    return await claim;
  } finally {
    if (inFlightEventClaims.get(dedupeKey) === claim) inFlightEventClaims.delete(dedupeKey);
  }
}

eventRoutes.post("/events", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const body = await c.req.text();
  const isValid = await verifySlackSignature(
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
    c.env.SLACK_SIGNING_SECRET
  );
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/events",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const parsedPayload = slackEventPayloadSchema.safeParse(parsedJson);
  if (!parsedPayload.success) return c.json({ error: "Invalid payload" }, 400);
  const payload = parsedPayload.data;
  const admission = admitSlackEvent(payload, await resolveIngressBindings(c.env));
  if (!admission.admitted) {
    log.warn("slack.ingress.rejected", {
      trace_id: traceId,
      route: "/events",
      reason: admission.reason,
    });
    return c.json({ ok: true });
  }
  if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });

  const eventId = payload.event_id;
  if (eventId) {
    const claim = await claimSlackEvent(c.env, eventId, {
      traceId,
      eventType: payload.event?.type,
      retryNum: c.req.header("x-slack-retry-num"),
      retryReason: c.req.header("x-slack-retry-reason"),
    });
    if (claim === "duplicate") {
      log.debug("slack.event.duplicate", { trace_id: traceId, event_id: eventId });
      return c.json({ ok: true });
    }
  }
  const scheduleBackground = (promise: Promise<void>) => c.executionCtx.waitUntil(promise);
  const eventTask = Promise.resolve().then(() =>
    handleSlackEvent(payload, c.env, traceId, scheduleBackground)
  );
  c.executionCtx.waitUntil(eventTask);
  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/events",
    http_status: 200,
    event_id: eventId,
    event_type: payload.event?.type,
    duration_ms: Date.now() - startTime,
  });
  return c.json({ ok: true });
});
