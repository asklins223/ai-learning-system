import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { api, ApiError } from "../api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  globalThis.fetch = (async (input, init = {}) =>
    handler(String(input), init)) as typeof fetch;
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
});
