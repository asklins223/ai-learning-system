import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMemoryScope } from "./companion-context-orchestrator.ts";

test("学习任务类页面（card/learning_run/review）推导为 task scope", () => {
  assert.equal(deriveMemoryScope({ pageKind: "card" }), "task");
  assert.equal(deriveMemoryScope({ pageKind: "learning_run" }), "task");
  assert.equal(deriveMemoryScope({ pageKind: "review" }), "task");
});

test("非学习页面推导为 workspace scope", () => {
  assert.equal(deriveMemoryScope({ pageKind: "today" }), "workspace");
  assert.equal(deriveMemoryScope({ pageKind: "note" }), "workspace");
  assert.equal(deriveMemoryScope({ pageKind: "settings" }), "workspace");
  assert.equal(deriveMemoryScope(null), "workspace");
  assert.equal(deriveMemoryScope(undefined), "workspace");
  assert.equal(deriveMemoryScope({}), "workspace");
});

test("兼容 JSON 字符串与 { context: {...} } 包裹形态", () => {
  assert.equal(deriveMemoryScope(JSON.stringify({ pageKind: "learning_run" })), "task");
  assert.equal(deriveMemoryScope({ context: { pageKind: "card" } }), "task");
  assert.equal(deriveMemoryScope(JSON.stringify({ context: { pageKind: "today" } })), "workspace");
  assert.equal(deriveMemoryScope("not-json{{"), "workspace");
});
