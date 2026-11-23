/**
 * Webhook route modules, mounted in precedence order.
 */

import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { sentryWebhookRoutes } from "./sentry";
import { automationWebhookRoutes } from "./automation-webhook";
import { automationArtifactDeliveryRoutes } from "./automation-artifact-delivery";
import { automationDirectMessageDeliveryRoutes } from "./automation-direct-message-delivery";
import { githubAutomationEventRoutes } from "./github";
import { slackAutomationEventRoutes } from "./slack";

export const webhookRoutes = new Hono<ControlPlaneHonoEnv>();
for (const module of [
  sentryWebhookRoutes,
  automationWebhookRoutes,
  automationArtifactDeliveryRoutes,
  automationDirectMessageDeliveryRoutes,
  githubAutomationEventRoutes,
  slackAutomationEventRoutes,
]) {
  webhookRoutes.route("/", module);
}
