import { test } from "node:test";
import assert from "node:assert/strict";
import { buildToolRequestEventRows } from "../agent/tools/executor.ts";
import type { ToolExecutionContext } from "../agent/tools/executor.ts";
import { BudgetTracker } from "../agent/budget.ts";
import { CoverageLedger } from "../agent/coverage-ledger.ts";
import { CandidateLedger } from "../agent/candidate-ledger.ts";
import { computeArgsHash } from "../agent/tool-registry.ts";

function ctx(): ToolExecutionContext {
  return {
    runId: "run-1",
    workspaceId: "ws-1",
    noteVersionId: "nv-1",
    noteId: "note-1",
    agentUnitId: "unit-1",
    turnNo: 2,
    role: "generation_supervisor",
    budgetTracker: new BudgetTracker(),
    coverageLedger: new CoverageLedger(),
    candidateLedger: new CandidateLedger(),
    requestedBy: "user-1",
  };
}

test("review bug: 批量路径用校验后参数(default 填充)计算 hash,与 executeToolCall 一致", () => {
  // search_related_evidence 的 schema 有 topK 默认 10(schemas.ts)
  const rows = buildToolRequestEventRows(
    [{ id: "c1", name: "search_related_evidence", arguments: { query: "过拟合" } }],
    ctx(),
  );
  assert.equal(rows.length, 1, "合法参数生成 1 行");
  // 原始参数无 topK;校验后 topK=10 → inputHash 基于填充后参数
  const expectedHash = computeArgsHash({ query: "过拟合", topK: 10 });
  assert.equal(rows[0]?.inputHash, expectedHash, "hash 必须基于校验后参数(default 填充)");
  assert.notEqual(rows[0]?.inputHash, computeArgsHash({ query: "过拟合" }), "与原始参数 hash 不同(证明用填充后)");
  assert.ok(rows[0]?.eventKey.startsWith("tool_request:"), "事件键前缀");
});

test("review bug: 非法参数被批量预检跳过(与 executeToolCall 一致)", () => {
  const rows = buildToolRequestEventRows(
    [{ id: "c1", name: "search_related_evidence", arguments: { topK: 9999 } }], // topK 超 max 50
    ctx(),
  );
  assert.equal(rows.length, 0, "schema 校验失败不生成事件行");
});

test("review bug: 权限拒绝的工具被跳过", () => {
  // generation_supervisor 不允许 submit_deck_draft(那是 deck_composer 的工具)
  const rows = buildToolRequestEventRows(
    [{ id: "c1", name: "submit_deck_draft", arguments: {} }],
    ctx(),
  );
  assert.equal(rows.length, 0, "权限拒绝不生成事件行");
});
