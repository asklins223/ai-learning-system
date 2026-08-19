import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchReturnTarget,
  sanitizeSearchReturnTarget,
  withSearchReturnTarget,
} from "../search-return";

describe("search return navigation", () => {
  it("builds a canonical search target", () => {
    assert.equal(
      buildSearchReturnTarget("  attention mechanism  ", "note"),
      "/search?q=attention+mechanism&type=note",
    );
    assert.equal(buildSearchReturnTarget("smoke", "all"), "/search?q=smoke");
  });

  it("accepts only canonical search return targets", () => {
    assert.equal(
      sanitizeSearchReturnTarget("/search?q=softmax&type=source&ignored=1"),
      "/search?q=softmax&type=source",
    );
    assert.equal(sanitizeSearchReturnTarget("/search?type=note"), null);
    assert.equal(sanitizeSearchReturnTarget("/notes?q=softmax"), null);
    assert.equal(sanitizeSearchReturnTarget("//evil.example/search?q=softmax"), null);
    assert.equal(sanitizeSearchReturnTarget("javascript:alert(1)"), null);
  });

  it("keeps long Chinese and emoji queries navigable after URL encoding", () => {
    const chineseTarget = buildSearchReturnTarget("中".repeat(200), "objective");
    const emojiTarget = buildSearchReturnTarget("😀".repeat(100), "note");
    assert.equal(sanitizeSearchReturnTarget(chineseTarget), chineseTarget);
    assert.equal(sanitizeSearchReturnTarget(emojiTarget), emojiTarget);
    assert.ok(withSearchReturnTarget("/learning-cards/card-1", chineseTarget));
    assert.ok(withSearchReturnTarget("/notes/note-1", emojiTarget));
  });

  it("decorates only supported internal detail destinations", () => {
    const returnTo = "/search?q=softmax&type=note";
    assert.equal(
      withSearchReturnTarget("/notes/note-1", returnTo),
      "/notes/note-1?returnTo=%2Fsearch%3Fq%3Dsoftmax%26type%3Dnote",
    );
    assert.equal(withSearchReturnTarget("/settings", returnTo), null);
    assert.equal(withSearchReturnTarget("https://evil.example/notes/1", returnTo), null);
  });
});
