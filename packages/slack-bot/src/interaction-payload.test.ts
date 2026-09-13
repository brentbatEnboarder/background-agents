import { describe, expect, it } from "vitest";

import { slackInteractionPayloadSchema } from "./interaction-payload";

describe("slackInteractionPayloadSchema", () => {
  it("parses a valid modal interaction payload", () => {
    const result = slackInteractionPayloadSchema.safeParse({
      type: "view_submission",
      api_app_id: "A123",
      team: { id: "T123" },
      container: { type: "view" },
      trigger_id: "trigger-1",
      user: { id: "U123" },
      view: {
        type: "modal",
        callback_id: "configure_repo",
        private_metadata: "{}",
        state: {
          values: {
            block: {
              action: { type: "plain_text_input", value: "open-inspect/background-agents" },
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.api_app_id).toBe("A123");
      expect(result.data.team?.id).toBe("T123");
      expect(result.data.user?.id).toBe("U123");
      expect(result.data.container?.type).toBe("view");
      expect(result.data.view?.type).toBe("modal");
    }
  });

  it("rejects a malformed partial interaction payload", () => {
    const result = slackInteractionPayloadSchema.safeParse({
      actions: [{ action_id: "repo_select" }],
    });

    expect(result.success).toBe(false);
  });
});
