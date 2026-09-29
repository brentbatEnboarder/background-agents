import { z } from "zod";

export const MAX_SESSION_ATTACHMENTS_PER_MESSAGE = 6;
/** Per-image byte cap, enforced by the attachment store and every producer. */
export const SESSION_ATTACHMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const SESSION_ATTACHMENT_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export const SESSION_ATTACHMENT_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const SESSION_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const SESSION_ATTACHMENT_DOCUMENT_MIME_TYPES = [
  "text/markdown",
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "application/pdf",
] as const;

export const sessionAttachmentMimeTypeSchema = z.enum([
  ...SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  ...SESSION_ATTACHMENT_DOCUMENT_MIME_TYPES,
]);
export type SessionAttachmentMimeType = z.infer<typeof sessionAttachmentMimeTypeSchema>;
export type SessionAttachmentKind = "image" | "document";

export function sessionAttachmentKind(mimeType: SessionAttachmentMimeType): SessionAttachmentKind {
  return (SESSION_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)
    ? "image"
    : "document";
}

export function sessionAttachmentMaxBytes(mimeType: SessionAttachmentMimeType): number {
  return mimeType === "application/pdf"
    ? SESSION_ATTACHMENT_PDF_MAX_BYTES
    : sessionAttachmentKind(mimeType) === "image"
      ? SESSION_ATTACHMENT_IMAGE_MAX_BYTES
      : SESSION_ATTACHMENT_TEXT_MAX_BYTES;
}

export const sessionAttachmentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/);

/** Client-supplied reference to an attachment previously uploaded for this session. */
export const sessionAttachmentReferenceSchema = z
  .object({
    attachmentId: sessionAttachmentIdSchema,
    name: z.string().min(1).max(255),
  })
  .strict();

export const sessionAttachmentReferencesSchema = z
  .array(sessionAttachmentReferenceSchema)
  .max(MAX_SESSION_ATTACHMENTS_PER_MESSAGE);
export type SessionAttachmentReference = z.infer<typeof sessionAttachmentReferenceSchema>;

/** Server-resolved attachment metadata persisted with messages and events. */
export const resolvedSessionAttachmentSchema = sessionAttachmentReferenceSchema
  .extend({
    mimeType: sessionAttachmentMimeTypeSchema,
    kind: z.enum(["image", "document"]),
  })
  .strict()
  .refine((attachment) => attachment.kind === sessionAttachmentKind(attachment.mimeType), {
    message: "Attachment kind does not match MIME type",
    path: ["kind"],
  });
export type ResolvedSessionAttachment = z.infer<typeof resolvedSessionAttachmentSchema>;

export const resolvedSessionAttachmentsSchema = z
  .array(resolvedSessionAttachmentSchema)
  .max(MAX_SESSION_ATTACHMENTS_PER_MESSAGE);

/**
 * Body of a successful upload to `POST /sessions/:id/attachments`, parsed by
 * every client that turns an upload into a prompt reference. The id is the
 * canonical one, so an id that the prompt schema would reject is treated as a
 * failed upload where it arrives rather than being carried into client state
 * and failing later at prompt validation. Unknown keys are ignored so the
 * endpoint can add response fields without breaking deployed clients.
 */
export const sessionAttachmentUploadResponseSchema = z.object({
  attachmentId: sessionAttachmentIdSchema,
  mimeType: sessionAttachmentMimeTypeSchema,
});
export type SessionAttachmentUploadResponse = z.infer<typeof sessionAttachmentUploadResponseSchema>;
