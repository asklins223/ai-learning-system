/**
 * B1 前端契约测试（计划 §2.4 验收）：
 * "前端按钮与提示的组件测试"
 *
 * 此测试使用静态源码分析验证：
 * 1. GenerationOverlay 在 reused=true 时展示"内容未变"提示
 * 2. 提供"强制重新生成"按钮入口
 * 3. useGenerationActions 处理 accepted.reused 并提供 forceRegenerate 函数
 * 4. NoteEditor 传递 reused 和 onForceRegenerate props
 * 5. CSS 有复用提示样式
 * 6. api.ts 支持 force 参数
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const noteEditorDir = resolve(
  (import.meta.dirname ?? __dirname),
  "../../components/note-editor",
);
function readSubFile(name: string): string {
  return readFileSync(resolve(noteEditorDir, name), "utf8");
}

const overlaySource = readSubFile("GenerationOverlay.tsx");
const actionsSource = readSubFile("useGenerationActions.ts");
const noteEditorSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../components/NoteEditor.tsx"),
  "utf8",
);
const apiSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../api.ts"),
  "utf8",
);
const stylesSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../app/styles/note-editor.css"),
  "utf8",
);

describe("B1 前端契约：GenerationOverlay 复用提示", () => {
  it("GenerationOverlay 接受 reused prop", () => {
    assert.ok(
      overlaySource.includes("reused?: boolean"),
      "GenerationOverlayProps 应包含 reused?: boolean",
    );
  });

  it("GenerationOverlay 接受 onForceRegenerate prop", () => {
    assert.ok(
      overlaySource.includes("onForceRegenerate?: () => void"),
      "GenerationOverlayProps 应包含 onForceRegenerate?: () => void",
    );
  });

  it("reused=true 时展示\"内容未变，已复用上次结果\"提示", () => {
    assert.ok(
      overlaySource.includes("内容未变，已复用上次结果"),
      "GenerationOverlay 应包含复用提示文本",
    );
  });

  it("reused=true 时提供\"强制重新生成\"按钮", () => {
    assert.ok(
      overlaySource.includes("强制重新生成"),
      "GenerationOverlay 应包含强制重新生成按钮",
    );
    assert.ok(
      overlaySource.includes("ne-generation-force-regenerate"),
      "应有 force-regenerate CSS class",
    );
  });

  it("reused=true 时提供\"查看已有结果\"按钮", () => {
    assert.ok(
      overlaySource.includes("查看已有结果"),
      "GenerationOverlay 应包含查看已有结果按钮",
    );
  });
});

describe("B1 前端契约：useGenerationActions 复用处理", () => {
  it("generateCard 检查 accepted.reused 并设置复用状态", () => {
    assert.ok(
      actionsSource.includes("accepted.reused"),
      "generateCard 应检查 accepted.reused",
    );
    assert.ok(
      actionsSource.includes("setGenerationReused(true)"),
      "reused=true 时应调用 setGenerationReused(true)",
    );
  });

  it("reused 时不启动轮询（run 已终态）", () => {
    // 在 reused 分支内不应调用 pollGenerationRun
    const reusedBlock = actionsSource.split("if (accepted.reused)")[1]?.split("return;")[0];
    assert.ok(reusedBlock, "应有 accepted.reused 检查分支");
    assert.ok(
      !reusedBlock.includes("pollGenerationRun"),
      "reused 分支不应调用 pollGenerationRun",
    );
  });

  it("提供 forceRegenerate 函数", () => {
    assert.ok(
      actionsSource.includes("async function forceRegenerate"),
      "应定义 forceRegenerate 函数",
    );
    assert.ok(
      actionsSource.includes("force: true"),
      "forceRegenerate 应以 force: true 调用 api.createCardGenerationRun",
    );
  });

  it("forceRegenerate 在返回值中导出", () => {
    assert.ok(
      actionsSource.includes("forceRegenerate,"),
      "forceRegenerate 应在返回值中导出",
    );
  });
});

describe("B1 前端契约：NoteEditor 集成", () => {
  it("NoteEditor 有 generationReused 状态", () => {
    assert.ok(
      noteEditorSource.includes("generationReused"),
      "NoteEditor 应有 generationReused 状态",
    );
    assert.ok(
      noteEditorSource.includes("setGenerationReused"),
      "NoteEditor 应有 setGenerationReused 设置器",
    );
  });

  it("NoteEditor 将 reused 传递给 GenerationOverlay", () => {
    assert.ok(
      noteEditorSource.includes("reused={generationReused}"),
      "NoteEditor 应将 reused={generationReused} 传给 GenerationOverlay",
    );
  });

  it("NoteEditor 将 onForceRegenerate 传递给 GenerationOverlay", () => {
    assert.ok(
      noteEditorSource.includes("onForceRegenerate={forceRegenerate}"),
      "NoteEditor 应将 onForceRegenerate={forceRegenerate} 传给 GenerationOverlay",
    );
  });

  it("generationOverlayVisible 包含 generationReused 条件", () => {
    assert.ok(
      noteEditorSource.includes("|| generationReused)"),
      "generationOverlayVisible 应包含 generationReused 条件",
    );
  });
});

describe("B1 前端契约：API 客户端", () => {
  it("api.ts 的 createCardGenerationRun 支持 force 参数", () => {
    assert.ok(
      apiSource.includes("force?: boolean"),
      "api.ts 的 createCardGenerationRun 应支持 force?: boolean 参数",
    );
  });
});

describe("B1 前端契约：CSS 样式", () => {
  it("有复用提示容器样式", () => {
    assert.ok(
      stylesSource.includes(".ne-generation-reused"),
      "CSS 应有 .ne-generation-reused 样式",
    );
  });

  it("有强制重新生成按钮样式", () => {
    assert.ok(
      stylesSource.includes(".ne-generation-force-regenerate"),
      "CSS 应有 .ne-generation-force-regenerate 样式",
    );
  });

  it("有复用提示文本样式", () => {
    assert.ok(
      stylesSource.includes(".ne-generation-reused-text"),
      "CSS 应有 .ne-generation-reused-text 样式",
    );
  });
});
