import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const editorSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../components/NoteEditor.tsx"),
  "utf8",
);
const editorStyles = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../app/styles/note-editor.css"),
  "utf8",
);
const apiSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../api.ts"),
  "utf8",
);

describe("strict/partial card generation UI contract", () => {
  it("supports retrying a strict failure and explicitly confirming image exclusions", () => {
    assert.ok(apiSource.includes('| "partial_ready"'));
    assert.ok(apiSource.includes("retryCardGenerationRun"));
    assert.ok(apiSource.includes("/card-generation-runs/${id}/retry"));
    assert.ok(apiSource.includes("continueCardGenerationRunWithExclusions"));
    assert.ok(apiSource.includes("/card-generation-runs/${id}/continue-with-exclusions"));
    assert.ok(editorSource.includes("getFailedGenerationImages"));
    assert.ok(editorSource.includes("api.retryCardGenerationRun"));
    assert.ok(editorSource.includes("api.continueCardGenerationRunWithExclusions"));
    assert.ok(editorSource.includes("重试失败检查点"));
    assert.ok(editorSource.includes("确认排除并继续"));
    assert.ok(editorSource.includes("未得到你的明确确认前，失败图片不会被自动排除"));
  });

  it("switches to the derived run and treats partial_ready as terminal", () => {
    const activeStatuses = editorSource.slice(
      editorSource.indexOf("const ACTIVE_GENERATION_RUN_STATUSES"),
      editorSource.indexOf("]);", editorSource.indexOf("const ACTIVE_GENERATION_RUN_STATUSES")),
    );
    assert.ok(editorSource.includes('if (run.status === "partial_ready")'));
    assert.ok(editorSource.includes('setGenState("partial-ready")'));
    assert.ok(!activeStatuses.includes('"partial_ready"'));
    assert.ok(editorSource.includes("setGenerationRunId(accepted.runId)"));
    assert.ok(editorSource.includes("pollGenerationRun(accepted.runId, pollToken)"));
    assert.ok(editorSource.includes("部分结果不会替换已有完整学习卡"));
    assert.ok(editorSource.includes("图片（实际覆盖）"));
    assert.ok(editorSource.includes("查看部分结果"));
    assert.ok(editorSource.includes("不会进入验证或复习流程"));
    assert.match(editorStyles, /data-generation-state="partial"/);
    assert.match(editorStyles, /\.note-editor-generation-actions\s*\{/);
    assert.match(editorStyles, /\.note-editor-generation-partial\s*\{/);
  });
});
