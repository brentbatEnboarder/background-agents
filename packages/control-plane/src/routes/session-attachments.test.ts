import { describe, expect, it, vi } from "vitest";
import { SESSION_ATTACHMENT_MAX_REQUEST_BYTES } from "../media";
import {
  SESSION_ATTACHMENT_TEXT_MAX_BYTES,
  SESSION_ATTACHMENT_PDF_MAX_BYTES,
} from "@open-inspect/shared/types/session-attachments";
import type { Env } from "../types";
import { handleAttachmentGet, handleAttachmentPost } from "./session-attachments";
import type { RequestContext } from "./shared";
import type { SqlDatabase } from "../db/sql-database";
import { TEST_BACKGROUND_TASK_CONTEXT, fakeSessionRuntimeDispatch } from "../router.test-support";
import { withSessionRuntime } from "./session-route";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      sqlQueries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function createEnv(fetch: (request: Request) => Promise<Response>) {
  const put = vi.fn(async () => null);
  const remove = vi.fn(async () => undefined);
  const env = {
    SESSION: fakeSessionRuntimeDispatch(fetch),
    MEDIA_BUCKET: {
      put,
      delete: remove,
      head: vi.fn(),
      get: vi.fn(),
    },
  } as unknown as Env;
  return { env, put, remove };
}

function attachmentUploadRequest(): Request {
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "image.png", { type: "image/png" }));
  return new Request("https://test.local/sessions/session-1/attachments", {
    method: "POST",
    body: form,
  });
}

function documentUploadRequest(bytes: Uint8Array, mimeType: string, name = "file"): Request {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: mimeType }));
  return new Request("https://test.local/sessions/session-1/attachments", {
    method: "POST",
    body: form,
  });
}

function oversizedStreamingUploadRequest(): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(SESSION_ATTACHMENT_MAX_REQUEST_BYTES + 1));
      controller.close();
    },
  });
  return new Request("https://test.local/sessions/session-1/attachments", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=test" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("session attachment routes", () => {
  it.each([
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/tab-separated-values",
    "application/pdf",
  ])("persists canonical %s without storing the supplied filename", async (mimeType) => {
    let command: unknown;
    const fetch = vi.fn(async (request: Request) => {
      command = await request.json();
      return Response.json({ status: "ok" });
    });
    const { env, put } = createEnv(fetch);
    const bytes = new TextEncoder().encode(mimeType === "application/pdf" ? "%PDF-1.4\n" : "hello");
    const response = await handleAttachmentPost(
      documentUploadRequest(bytes, mimeType, "secret-name.csv"),
      env,
      { id: "session-1" },
      withSessionRuntime(env, createContext())
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ attachmentId: expect.any(String), mimeType });
    expect(fetch).toHaveBeenCalledOnce();
    expect(command).toMatchObject({ action: "record", mimeType, sizeBytes: bytes.length });
    expect(JSON.stringify(command)).not.toContain("secret-name");
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^sessions\/session-1\/attachments\/[^/]+$/),
      bytes,
      { contentType: mimeType }
    );
  });

  it("rejects over-limit text and malformed documents before registration", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { env, put } = createEnv(fetch);
    for (const request of [
      documentUploadRequest(
        new Uint8Array(SESSION_ATTACHMENT_TEXT_MAX_BYTES + 1).fill(65),
        "text/plain"
      ),
      documentUploadRequest(
        new Uint8Array(SESSION_ATTACHMENT_PDF_MAX_BYTES + 1).fill(65),
        "application/pdf"
      ),
      documentUploadRequest(new TextEncoder().encode("%PDF-1.4"), "text/plain"),
      documentUploadRequest(new TextEncoder().encode("not pdf"), "application/pdf"),
      documentUploadRequest(Uint8Array.from([0xff]), "text/plain"),
    ]) {
      const response = await handleAttachmentPost(
        request,
        env,
        { id: "session-1" },
        withSessionRuntime(env, createContext())
      );
      expect(response.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("serves a stored document with canonical content type", async () => {
    const { env } = createEnv(async () => Response.json({ status: "ok" }));
    const bytes = new TextEncoder().encode("hello");
    const metadata = {
      size: bytes.length,
      writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "text/plain"),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
    (env.MEDIA_BUCKET.get as ReturnType<typeof vi.fn>).mockResolvedValue(metadata);
    const response = await handleAttachmentGet(
      new Request("https://test.local/sessions/session-1/attachments/att-1"),
      env,
      { id: "session-1", attachmentId: "att-1" },
      withSessionRuntime(env, createContext())
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  it("bounds streamed requests when Content-Length is unavailable", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const { env, put } = createEnv(fetch);

    const response = await handleAttachmentPost(
      oversizedStreamingUploadRequest(),
      env,
      { id: "session-1" },
      withSessionRuntime(env, createContext())
    );

    expect(response.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    [404, "Session not found", 404],
    [429, "Quota exceeded", 429],
    [500, "Registry failed", 502],
  ])(
    "maps attachment service failures to route responses: %s -> %s",
    async (registryStatus, message, routeStatus) => {
      const fetch = vi.fn(async () =>
        Response.json({ error: message }, { status: registryStatus })
      );
      const { env, put } = createEnv(fetch);

      const response = await handleAttachmentPost(
        attachmentUploadRequest(),
        env,
        { id: "session-1" },
        withSessionRuntime(env, createContext())
      );

      expect(response.status).toBe(routeStatus);
      await expect(response.json()).resolves.toEqual({ error: message });
      expect(put).not.toHaveBeenCalled();
    }
  );

  it("maps cleanup failures to a service-unavailable response", async () => {
    const responses = [
      Response.json({
        status: "cleanup_required",
        cleanupClaimedAt: 1000,
        staleAttachments: [
          { attachmentId: "old-1", objectKey: "sessions/session-1/attachments/old-1" },
        ],
      }),
      Response.json({ status: "ok" }),
    ];
    const fetch = vi.fn(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Missing test response");
      return response;
    });
    const { env, put, remove } = createEnv(fetch);
    remove.mockRejectedValue(new Error("R2 unavailable"));

    const response = await handleAttachmentPost(
      attachmentUploadRequest(),
      env,
      { id: "session-1" },
      withSessionRuntime(env, createContext())
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to clean up expired attachments; please retry",
    });
    expect(put).not.toHaveBeenCalled();
  });
});
