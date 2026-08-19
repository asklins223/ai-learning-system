import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTodayReturnTarget,
  sanitizeTodayReturnTarget,
  withTodayReturnTarget,
} from "../today-return";

describe("today return navigation", () => {
  it("builds a canonical daily trace target", () => {
    assert.equal(
      buildTodayReturnTarget("  attention mechanism  ", "note"),
      "/today?q=attention+mechanism&type=note",
    );
    assert.equal(buildTodayReturnTarget("", "all"), "/today");
  });

  it("accepts only controlled daily trace return targets", () => {
    assert.equal(
      sanitizeTodayReturnTarget("/today?q=softmax&type=source&ignored=1"),
      "/today?q=softmax&type=source",
    );
    assert.equal(sanitizeTodayReturnTarget("/today?type=unknown"), null);
    assert.equal(sanitizeTodayReturnTarget("/search?q=softmax"), null);
    assert.equal(sanitizeTodayReturnTarget("//evil.example/today"), null);
    assert.equal(sanitizeTodayReturnTarget("javascript:alert(1)"), null);
  });

  it("normalizes long Unicode queries without breaking navigation", () => {
    const target = buildTodayReturnTarget("中".repeat(200), "note");
    assert.equal(sanitizeTodayReturnTarget(target), target);
    assert.ok(withTodayReturnTarget("/notes/note-1", target));
  });

  it("decorates only note, learning-card, and source detail destinations", () => {
    const returnTo = "/today?q=softmax&type=note";
    assert.equal(
      withTodayReturnTarget("/learning-cards/card-1", returnTo),
      "/learning-cards/card-1?returnTo=%2Ftoday%3Fq%3Dsoftmax%26type%3Dnote",
    );
    assert.equal(
      withTodayReturnTarget("/notes/note-1", "/today"),
      "/notes/note-1?returnTo=%2Ftoday",
    );
    assert.equal(
      withTodayReturnTarget("/sources/source-1", "/today?type=source"),
      "/sources/source-1?returnTo=%2Ftoday%3Ftype%3Dsource",
    );
    assert.equal(withTodayReturnTarget("/settings", returnTo), null);
    assert.equal(withTodayReturnTarget("https://evil.example/learning-cards/1", returnTo), null);
  });
});
