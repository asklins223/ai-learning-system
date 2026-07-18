import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceDetailReturnTarget,
  buildSourceLibraryReturnTarget,
  readSourceLibraryReturnState,
  sanitizeSourceDetailReturnTarget,
  sanitizeSourceLibraryReturnTarget,
  withSourceDetailReturnTarget,
  withSourceLibraryReturnTarget,
} from "../source-return";

describe("source return navigation", () => {
  it("builds and reads a canonical source library target", () => {
    const target = buildSourceLibraryReturnTarget("failed", "  softmax  ");
    assert.equal(target, "/sources?status=failed&q=softmax");
    assert.deepEqual(readSourceLibraryReturnState(target), {
      target,
      status: "failed",
      query: "softmax",
    });
    assert.equal(buildSourceLibraryReturnTarget("all", ""), "/sources");
  });

  it("normalizes filters and rejects external library returns", () => {
    assert.equal(
      sanitizeSourceLibraryReturnTarget("/sources?status=unknown&q=attention&ignored=1"),
      "/sources?q=attention",
    );
    assert.equal(sanitizeSourceLibraryReturnTarget("/search?q=attention"), null);
    assert.equal(sanitizeSourceLibraryReturnTarget("//evil.example/sources"), null);
  });

  it("decorates supported source and note destinations", () => {
    const returnTo = "/sources?status=ready&q=transformer";
    assert.equal(
      withSourceLibraryReturnTarget("/sources/source-1", returnTo),
      "/sources/source-1?returnTo=%2Fsources%3Fstatus%3Dready%26q%3Dtransformer",
    );
    assert.equal(
      withSourceLibraryReturnTarget("/notes/note-1", returnTo),
      "/notes/note-1?returnTo=%2Fsources%3Fstatus%3Dready%26q%3Dtransformer",
    );
    assert.equal(withSourceLibraryReturnTarget("/settings", returnTo), null);
  });

  it("keeps a source-detail-to-note return chain safe", () => {
    const detailTarget = buildSourceDetailReturnTarget(
      "source-1",
      "/sources?status=failed&q=ssrf",
    );
    assert.equal(
      detailTarget,
      "/sources/source-1?returnTo=%2Fsources%3Fstatus%3Dfailed%26q%3Dssrf",
    );
    assert.equal(sanitizeSourceDetailReturnTarget(detailTarget), detailTarget);
    assert.equal(
      withSourceDetailReturnTarget("/notes/note-1", detailTarget ?? ""),
      "/notes/note-1?returnTo=%2Fsources%2Fsource-1%3FreturnTo%3D%252Fsources%253Fstatus%253Dfailed%2526q%253Dssrf",
    );
    assert.equal(sanitizeSourceDetailReturnTarget("https://evil.example/sources/1"), null);
  });
});
