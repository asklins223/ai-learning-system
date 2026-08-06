import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { api, ApiError } from "../api.ts";

const originalFetch = globalThis.fetch;
const originalXMLHttpRequest = globalThis.XMLHttpRequest;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input, init = {}) =>
    handler(String(input), init)) as typeof fetch;
}

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = [];

  method = "";
  url = "";
  timeout = 0;
  withCredentials = false;
  status = 0;
  statusText = "";
  responseText = "";
  body: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;
  headers = new Map<string, string>();
  upload = {
    onprogress: null as ((event: ProgressEvent) => void) | null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.body = body;
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  reportProgress(loaded: number, total: number) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent);
  }

  respond(status: number, body: unknown, statusText = "") {
    this.status = status;
    this.statusText = statusText;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }

  timeOut() {
    this.ontimeout?.();
  }
}

function mockXMLHttpRequest() {
  FakeXMLHttpRequest.instances = [];
  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
}

describe("API client", () => {
  it("prefers a human-readable message while preserving the machine error code", async () => {
    mockFetch(() =>
      Response.json(
        {
          error: "no_hard_evidence",
          message: "该关键要点暂无有效硬证据，无法验证",
        },
        { status: 422 },
      ),
    );

    await assert.rejects(
      api.createValidationQuestion("card-1", {
        questionType: "explain",
        question: "why",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.message, "该关键要点暂无有效硬证据，无法验证");
        assert.equal(error.code, "no_hard_evidence");
        return true;
      },
    );
  });

  it("does not mistake Fastify's HTTP reason phrase for a machine code", async () => {
    mockFetch(() =>
      Response.json(
        {
          statusCode: 400,
          error: "Bad Request",
          message: "invalid payload",
        },
        { status: 400 },
      ),
    );

    await assert.rejects(
      api.updateAIConsent("v1"),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.message, "invalid payload");
        assert.equal(error.code, undefined);
        return true;
      },
    );
  });

  it("sets JSON headers through the standard Headers API", async () => {
    let capturedContentType = "";
    mockFetch((_url, init) => {
      capturedContentType = new Headers(init.headers).get("content-type") ?? "";
      return Response.json({ success: true });
    });

    await api.updateAIConsent("v1");

    assert.equal(capturedContentType, "application/json");
  });

  it("downloads note exports through the shared response pipeline", async () => {
    let capturedUrl = "";
    mockFetch((url) => {
      capturedUrl = url;
      return new Response("# Note", {
        headers: { "Content-Type": "text/markdown" },
      });
    });

    const blob = await api.exportNoteMarkdown("note-1");

    assert.match(capturedUrl, /\/export\/notes\/note-1$/);
    assert.equal(await blob.text(), "# Note");
  });

  it("keeps onboarding evidence acknowledgement alive across navigation", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch((_url, init) => {
      capturedInit = init;
      return Response.json({ ok: true });
    });

    await api.markOnboardingStep("evidence_review", "evidence-1");

    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.keepalive, true);
  });

  it("keeps session revocation alive while redirecting to login", async () => {
    let capturedInit: RequestInit | undefined;
    mockFetch((_url, init) => {
      capturedInit = init;
      return new Response(null, { status: 204 });
    });

    await api.logout();

    assert.equal(capturedInit?.method, "POST");
    assert.equal(capturedInit?.keepalive, true);
  });

  it("uploads an image with per-file progress and a caller timeout", async () => {
    mockXMLHttpRequest();
    const progress: Array<[number, number]> = [];
    const file = new File(["image"], "diagram.png", { type: "image/png" });

    const pending = api.uploadImage(file, "note-1", {
      timeoutMs: 12_345,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    const xhr = FakeXMLHttpRequest.instances.at(-1);
    assert.ok(xhr);
    assert.equal(xhr.method, "POST");
    assert.match(xhr.url, /\/uploads\/images$/);
    assert.equal(xhr.timeout, 12_345);
    assert.equal(xhr.withCredentials, true);
    assert.ok(xhr.body instanceof FormData);
    assert.deepEqual(Array.from(xhr.body.keys()), ["noteId", "file"]);

    xhr.reportProgress(3, 5);
    xhr.respond(201, {
      assetId: "asset-1",
      url: "https://example.test/diagram.png",
      objectKey: "images/diagram.png",
      size: 5,
      mimeType: "image/png",
      sha256: "abc",
      width: 10,
      height: 20,
    });

    const result = await pending;
    assert.deepEqual(progress, [[3, 5]]);
    assert.equal(result.assetId, "asset-1");
  });

  it("turns AbortSignal and XHR timeout into stable upload error codes", async () => {
    mockXMLHttpRequest();
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    const controller = new AbortController();

    const cancelled = api.uploadImage(file, "note-1", {
      signal: controller.signal,
    });
    const cancelledXhr = FakeXMLHttpRequest.instances.at(-1);
    assert.ok(cancelledXhr);
    controller.abort();
    await assert.rejects(cancelled, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "upload_cancelled");
      return true;
    });
    assert.equal(cancelledXhr.aborted, true);

    const timedOut = api.uploadImage(file, "note-1");
    const timedOutXhr = FakeXMLHttpRequest.instances.at(-1);
    assert.ok(timedOutXhr);
    timedOutXhr.timeOut();
    await assert.rejects(timedOut, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "upload_timeout");
      return true;
    });
  });

  it("preserves structured API errors returned by image upload", async () => {
    mockXMLHttpRequest();
    const pending = api.uploadImage(
      new File(["image"], "too-large.png", { type: "image/png" }),
      "note-1",
    );
    const xhr = FakeXMLHttpRequest.instances.at(-1);
    assert.ok(xhr);
    xhr.respond(422, {
      error: "image_pixel_limit_exceeded",
      message: "图片像素超过 4000 万限制",
    });

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 422);
      assert.equal(error.code, "image_pixel_limit_exceeded");
      assert.equal(error.message, "图片像素超过 4000 万限制");
      return true;
    });
  });

  it("uses the card-set collection, detail, and lifecycle routes", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    mockFetch((url, init) => {
      requests.push({ url, init });
      if (url.includes("/regenerate")) {
        return Response.json({ runId: "run-2", status: "queued" });
      }
      if (url.includes("/dismiss")) {
        return Response.json({ cardSetId: "set-1", status: "archived" });
      }
      if (url.includes("/card-sets/set-1/cards?")) {
        return Response.json({
          cardSetId: "set-1",
          items: [],
          nextCursor: "next-opaque-cursor",
        });
      }
      if (url.endsWith("/card-sets/set-1")) {
        return Response.json({
          cardSet: { id: "set-1", status: "active" },
          cards: [],
          nextCursor: "first-page-cursor",
        });
      }
      return Response.json({ items: [], nextCursor: null, total: 0 });
    });

    await api.listCardSets({
      status: "partial_ready",
      noteId: "note-1",
      cursor: "cursor-1",
      limit: 25,
    });
    await api.getCardSet("set-1");
    const cardPage = await api.listCardSetCards("set-1", {
      cursor: "opaque+/=",
      limit: 20,
    });
    await api.dismissCardSet("set-1");
    await api.regenerateCardSet("set-1", {
      mode: "strict",
      exclusions: { unitIds: ["unit-1"] },
    });

    assert.match(
      requests[0]?.url ?? "",
      /\/card-sets\?status=partial_ready&noteId=note-1&cursor=cursor-1&limit=25$/,
    );
    assert.match(requests[1]?.url ?? "", /\/card-sets\/set-1$/);
    assert.match(
      requests[2]?.url ?? "",
      /\/card-sets\/set-1\/cards\?cursor=opaque%2B%2F%3D&limit=20$/,
    );
    assert.equal(cardPage.nextCursor, "next-opaque-cursor");
    assert.match(requests[3]?.url ?? "", /\/card-sets\/set-1\/dismiss$/);
    assert.equal(requests[3]?.init.method, "POST");
    assert.match(requests[4]?.url ?? "", /\/card-sets\/set-1\/regenerate$/);
    assert.equal(requests[4]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(requests[4]?.init.body)), {
      mode: "strict",
      exclusions: { unitIds: ["unit-1"] },
    });
  });
});
