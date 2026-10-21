import { describe, expect, it } from "vitest";
import { isNormalizedEvidenceObject } from "./automation-artifact-delivery";

describe("automation artifact normalized evidence", () => {
  it("accepts bounded analytical fields", () => {
    expect(
      isNormalizedEvidenceObject({
        evidenceBundleId: "bundle-1",
        rankedAccounts: [{ companyId: "PH-1", score: 100, whyNow: "Renewal is near." }],
        limitations: ["Missing evidence remains unknown."],
      })
    ).toBe(true);
  });

  it.each([
    "body",
    "content",
    "description",
    "rawBody",
    "rawText",
    "snippet",
    "text",
    "transcript",
  ])("rejects nested raw source field %s", (field) => {
    expect(isNormalizedEvidenceObject({ rankedAccounts: [{ [field]: "source material" }] })).toBe(
      false
    );
  });

  it("rejects non-object contexts", () => {
    expect(isNormalizedEvidenceObject(null)).toBe(false);
    expect(isNormalizedEvidenceObject([])).toBe(false);
    expect(isNormalizedEvidenceObject("evidence")).toBe(false);
  });
});
