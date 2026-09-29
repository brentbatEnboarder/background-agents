import {
  resolvedSessionAttachmentsSchema,
  sessionAttachmentMimeTypeSchema,
  sessionAttachmentKind,
  sessionAttachmentReferenceSchema,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  type SessionAttachmentReference,
  type ResolvedSessionAttachment,
} from "@open-inspect/shared/types/session-attachments";
import { z } from "zod";
import type { SessionAttachmentRepository } from "./session-attachment-repository";

export class SessionAttachmentError extends Error {}

export interface ResolvedSessionAttachments {
  attachments: ResolvedSessionAttachment[];
  attachmentIds: string[];
}

type SessionAttachmentLookup = Pick<SessionAttachmentRepository, "getUnreferenced">;

export function parseStoredSessionAttachments(
  value: string | null,
  onInvalid?: () => void
): ResolvedSessionAttachment[] | undefined {
  if (!value) return undefined;
  try {
    const stored: unknown = JSON.parse(value);
    const parsed = resolvedSessionAttachmentsSchema.safeParse(stored);
    if (parsed.success) return parsed.data.length > 0 ? parsed.data : undefined;
    // Images already persisted before resolved metadata gained kind remain readable.
    const legacyImages = z
      .array(
        sessionAttachmentReferenceSchema
          .extend({
            mimeType: z.enum(SESSION_ATTACHMENT_IMAGE_MIME_TYPES),
          })
          .strict()
      )
      .max(MAX_SESSION_ATTACHMENTS_PER_MESSAGE)
      .safeParse(stored);
    if (legacyImages.success) {
      return legacyImages.data.map((attachment) => ({ ...attachment, kind: "image" as const }));
    }
  } catch {
    // Report malformed JSON through the same callback as invalid attachment metadata.
  }
  onInvalid?.();
  return undefined;
}

/** Resolve client references against canonical, unclaimed attachment rows. */
export function resolveSessionAttachments(
  references: SessionAttachmentReference[] | undefined,
  repository: SessionAttachmentLookup
): ResolvedSessionAttachments | undefined {
  if (!references || references.length === 0) return undefined;

  const attachmentIds = references.map((reference) => reference.attachmentId);
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new SessionAttachmentError("An attachment can only be attached once per message");
  }

  const rowsById = new Map(
    repository.getUnreferenced(attachmentIds).map((row) => [row.id, row] as const)
  );
  if (rowsById.size !== attachmentIds.length) {
    throw new SessionAttachmentError(
      "One or more attachments are missing, expired, or already used"
    );
  }

  const resolved = references.map((reference): ResolvedSessionAttachment => {
    const row = rowsById.get(reference.attachmentId);
    if (!row) {
      throw new SessionAttachmentError("Attachment not found");
    }
    const mimeType = sessionAttachmentMimeTypeSchema.safeParse(row.mime_type);
    if (!mimeType.success) {
      throw new SessionAttachmentError("Attachment is not a supported format");
    }
    return {
      name: reference.name,
      attachmentId: row.id,
      mimeType: mimeType.data,
      kind: sessionAttachmentKind(mimeType.data),
    };
  });

  return { attachments: resolved, attachmentIds };
}
