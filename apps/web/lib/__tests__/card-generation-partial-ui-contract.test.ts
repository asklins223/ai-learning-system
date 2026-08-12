
// ⚠️ 静态源码契约快照（非行为测试）：断言的是源码文本特征，重构改名/换实现方式
// 会误报，行为回归由 e2e/人工验证覆盖。2026-08-11 测试质量审计标注。

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
// ARCH-04 拆分：共享类型已从 api.ts 迁移到 api-types.ts（api.ts 仅做 re-export）。
// 状态枚举断言需读取 api-types.ts。
const apiTypesSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../api-types.ts"),
  "utf8",
);

// PERF-04 拆分：生成逻辑已提取到 note-editor/ 目录下的多个模块。
// 测试需要检查所有拆分后的文件。
const noteEditorDir = resolve((import.meta.dirname ?? __dirname), "../../components/note-editor");
function readSubFile(name: string): string {
  return readFileSync(resolve(noteEditorDir, name), "utf8");
}
const useGenerationActionsSource = readSubFile("useGenerationActions.ts");
const generationFailureDialogSource = readSubFile("GenerationFailureDialog.tsx");
const generationPanelSource = readSubFile("GenerationPanel.tsx");
const confirmDialogsSource = readSubFile("ConfirmDialogs.tsx");
const noteEditorUtilsSource = readSubFile("note-editor-utils.ts");
const noteEditorTypesSource = readSubFile("note-editor-types.ts");

// 合并所有源码
const allSources = [
  editorSource,
  useGenerationActionsSource,
  generationFailureDialogSource,
  generationPanelSource,
  confirmDialogsSource,
  noteEditorUtilsSource,
  noteEditorTypesSource,
].join("\n");

describe("strict/partial card generation UI contract", () => {
  it("routes structured AI consent failures to the real settings section", () => {
    assert.ok(generationFailureDialogSource.includes('generationRun.error?.code === "ai_consent_required"'));
    assert.ok(generationFailureDialogSource.includes('warning.details?.reason === "ai_consent_required"'));
    assert.ok(generationFailureDialogSource.includes('href="/settings#model"'));
    assert.ok(generationFailureDialogSource.includes("{requiresAIConsent && ("));
  });

  it("supports retrying a strict failure", () => {
    assert.ok(apiTypesSource.includes('| "partial_ready"'));
    assert.ok(apiSource.includes("retryCardGenerationRun"));
    assert.ok(apiSource.includes("/card-generation-runs/${id}/retry"));
    assert.ok(allSources.includes("getFailedGenerationUnits"));
    assert.ok(allSources.includes("api.retryCardGenerationRun"));
    assert.ok(allSources.includes("重试失败检查点"));
  });

  it("switches to the derived run and treats partial_ready as terminal", () => {
    const activeStatuses = noteEditorTypesSource.slice(
      noteEditorTypesSource.indexOf("const ACTIVE_GENERATION_RUN_STATUSES"),
      noteEditorTypesSource.indexOf("]);", noteEditorTypesSource.indexOf("const ACTIVE_GENERATION_RUN_STATUSES")),
    );
    assert.ok(allSources.includes('if (run.status === "partial_ready")'));
    assert.ok(allSources.includes('setGenState("partial-ready")'));
    assert.ok(!activeStatuses.includes('"partial_ready"'));
    assert.ok(allSources.includes("setGenerationRunId(accepted.runId)"));
    assert.ok(allSources.includes("pollGenerationRun(accepted.runId, pollToken)"));
    assert.ok(allSources.includes("部分结果不会替换已有完整学习卡"));
    assert.ok(allSources.includes("图片（实际覆盖）"));
    assert.ok(allSources.includes("查看部分结果"));
    assert.ok(allSources.includes("不会进入验证或复习流程"));
    assert.match(editorStyles, /data-generation-state="partial"/);
    assert.match(editorStyles, /\.note-editor-generation-actions\s*\{/);
    assert.match(editorStyles, /\.note-editor-generation-partial\s*\{/);
  });
});
