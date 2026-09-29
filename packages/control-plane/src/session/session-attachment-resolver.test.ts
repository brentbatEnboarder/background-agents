import { describe, expect, it } from "vitest";
import {
  parseStoredSessionAttachments,
  resolveSessionAttachments,
} from "./session-attachment-resolver";

describe("parseStoredSessionAttachments", () => {
  it("normalizes a stored empty array to undefined", () => {
    expect(parseStoredSessionAttachments("[]")).toBeUndefined();
  });
  it("reads image metadata persisted before kind was introduced", () => {
    expect(
      parseStoredSessionAttachments(
        JSON.stringify([{ attachmentId: "att-1", name: "shot.png", mimeType: "image/png" }])
      )
    ).toEqual([{ attachmentId: "att-1", name: "shot.png", mimeType: "image/png", kind: "image" }]);
    expect(
      parseStoredSessionAttachments(
        JSON.stringify([{ attachmentId: "att-1", name: "file.pdf", mimeType: "application/pdf" }])
      )
    ).toBeUndefined();
  });
  it("derives document kind from the stored canonical MIME rather than the display name", () => {
    const reference = { attachmentId: "att-1", name: "picture.png" };
    const resolved = resolveSessionAttachments([reference], {
      getUnreferenced: () => [
        {
          id: "att-1",
          mime_type: "application/pdf",
          size_bytes: 8,
          object_key: "sessions/session-1/attachments/att-1",
          message_id: null,
          cleanup_claimed_at: null,
          created_at: 1,
        },
      ],
    } as never);
    expect(resolved?.attachments).toEqual([
      { ...reference, mimeType: "application/pdf", kind: "document" },
    ]);
    expect(parseStoredSessionAttachments(JSON.stringify(resolved?.attachments))).toEqual(
      resolved?.attachments
    );
  });
});
