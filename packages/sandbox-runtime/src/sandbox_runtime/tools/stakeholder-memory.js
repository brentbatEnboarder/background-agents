import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch, extractError } from "./_bridge-client.js";

const PURPOSE =
  "Only explicit, durable stakeholder business context belongs here. Never store model inference, raw tool/API responses, credentials, secrets, or deterministic reporting metrics.";

export default tool({
  name: "stakeholder-memory",
  description: `Create, list, or supersede short stakeholder business-context facts shared across Marcus sessions in the configured environment. ${PURPOSE} When a fact changes, supersede the old fact instead of creating a contradictory active fact.`,
  args: {
    operation: z.enum(["create", "list", "supersede"]).describe("The memory operation."),
    factKind: z
      .enum(["context", "decision", "definition", "preference", "constraint"])
      .optional()
      .describe("Required for create and supersede."),
    attributedTo: z
      .string()
      .optional()
      .describe(
        "Required for create and supersede: the stakeholder or group explicitly attributed."
      ),
    fact: z.string().optional().describe(`Required for create and supersede. ${PURPOSE}`),
    factId: z.string().optional().describe("The active fact ID required for supersede."),
    reason: z.string().optional().describe("Optional short reason for supersession."),
    includeSuperseded: z
      .boolean()
      .optional()
      .describe("For list only. Defaults to false, returning active facts."),
    limit: z.number().int().min(1).max(100).optional().describe("For list only; maximum 100."),
  },
  async execute(args) {
    let response;
    try {
      response = await bridgeFetch("/stakeholder-memory", {
        method: "POST",
        body: JSON.stringify(args),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: `Could not reach stakeholder memory: ${message}` });
    }
    if (!response.ok) {
      return JSON.stringify({ ok: false, error: await extractError(response) });
    }
    try {
      return JSON.stringify({ ok: true, ...(await response.json()) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: `Invalid control-plane response: ${message}` });
    }
  },
});
