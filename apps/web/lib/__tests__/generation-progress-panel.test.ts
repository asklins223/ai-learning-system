/**
 * C1: 生成阶段流式展示 — 前端进度面板契约测试
 *
 * 计划 §2.6 验收标准：
 * "Web 组件测试 + 生成过程 E2E 断言阶段流转与覆盖率展示；旧字段不读的 lint 约束。"
 *
 * 此测试使用静态源码分析验证：
 * 1. 四阶段步骤条（PREPARE → AGENT_RUN → VERIFY → PUBLISH）在 shellStage 可用时渲染
 * 2. 覆盖率百分比与单位进度展示
 * 3. 不读取已废弃的旧计数器字段
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
const stylesSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../app/styles/note-editor.css"),
  "utf8",
);

describe("C1: 生成阶段流式展示 — 四阶段步骤条", () => {
  it("GenerationOverlay 在 shellStage 可用时渲染四阶段步骤条", () => {
    // 检测 shellStage 存在性
    assert.ok(overlaySource.includes("hasShellStage"), "应检测 shellStage 是否可用");
    // 四阶段步骤条 class
    assert.ok(
      overlaySource.includes("ne-generation-steps--four"),
      "应使用 ne-generation-steps--four class 展示四阶段",
    );
    // 四个阶段的标题
    assert.ok(overlaySource.includes("准备素材"), "步骤1: 准备素材");
    assert.ok(overlaySource.includes("提炼卡片"), "步骤2: 提炼卡片");
    assert.ok(overlaySource.includes("引用校验"), "步骤3: 引用校验");
    assert.ok(overlaySource.includes("发布卡组"), "步骤4: 发布卡组");
  });

  it("四阶段步骤条使用 shellStage 映射步骤状态", () => {
    assert.ok(
      overlaySource.includes("shellStageStepStates"),
      "应使用 shellStageStepStates 函数映射步骤状态",
    );
    // shellStageStepStates 实现在 note-editor-utils.ts（Phase B/C 阶段轨道共用），
    // 检查四个 shellStage 值的映射
    const utilsSource = readSubFile("note-editor-utils.ts");
    assert.ok(utilsSource.includes('"preparing"'));
    assert.ok(utilsSource.includes('"generating"'));
    assert.ok(utilsSource.includes('"checking"'));
    assert.ok(utilsSource.includes('"publishing"'));
  });

  it("shellStage 不可用时回退到原有三步骤展示", () => {
    // 重构后 saving 握手期独立分支；shellStage 可用时用四阶段，否则回退三步骤
    assert.ok(
      overlaySource.includes("hasShellStage && stepStates"),
      "shellStage 可用时使用四阶段，否则回退",
    );
    // 回退到三步骤
    assert.ok(overlaySource.includes("保存版本"), "回退步骤1: 保存版本");
    assert.ok(overlaySource.includes("准备材料"), "回退步骤2: 准备材料");
  });

  it("CSS 支持四列网格布局", () => {
    assert.ok(
      stylesSource.includes("ne-generation-steps--four"),
      "CSS 应有四阶段步骤条样式",
    );
    assert.ok(
      stylesSource.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"),
      "四阶段步骤条应使用 4 列网格",
    );
  });
});

describe("C1: 覆盖率与单位进度展示", () => {
  it("GenerationOverlay 展示覆盖率百分比和单位进度", () => {
    // 覆盖率区域
    assert.ok(
      overlaySource.includes("ne-generation-coverage"),
      "应有覆盖率展示区域",
    );
    // 文本覆盖率
    assert.ok(
      overlaySource.includes("sourceCoverageBps"),
      "应读取 sourceCoverageBps",
    );
    assert.ok(
      overlaySource.includes("sourceUnitsCompleted"),
      "应读取 sourceUnitsCompleted",
    );
    assert.ok(
      overlaySource.includes("sourceUnitsTotal"),
      "应读取 sourceUnitsTotal",
    );
    // 图片覆盖率
    assert.ok(
      overlaySource.includes("imageCoverageBps"),
      "应读取 imageCoverageBps",
    );
    assert.ok(
      overlaySource.includes("imagesCompleted"),
      "应读取 imagesCompleted",
    );
    assert.ok(
      overlaySource.includes("imagesTotal"),
      "应读取 imagesTotal",
    );
  });

  it("覆盖率使用 measuredCoverageLabel 工具函数格式化", () => {
    assert.ok(
      overlaySource.includes("measuredCoverageLabel"),
      "应使用 measuredCoverageLabel 格式化覆盖率展示",
    );
  });

  it("CSS 有覆盖率展示样式", () => {
    assert.match(
      stylesSource,
      /\.ne-generation-coverage\s*\{/,
      "CSS 应有覆盖率区域样式",
    );
    assert.ok(
      stylesSource.includes(".ne-generation-coverage-bar"),
      "CSS 应有覆盖率进度条样式",
    );
    assert.ok(
      stylesSource.includes(".ne-generation-coverage-fill"),
      "CSS 应有覆盖率填充样式",
    );
  });
});

describe("C1: 不读取已废弃的旧字段", () => {
  it("不读取 service.ts:276-279 注释中标记的旧计数器字段", () => {
    // 旧字段名（已在 service.ts 中标记为不再写入）
    // 这些字段不应出现在 GenerationOverlay 中
    assert.ok(
      !overlaySource.includes("oldCompleted"),
      "不应读取旧字段 oldCompleted",
    );
    assert.ok(
      !overlaySource.includes("oldTotal"),
      "不应读取旧字段 oldTotal",
    );
    // 进度唯一来源是 coverageReport（六层账本），通过 coverage 字段读取
    // 不应直接读取 stage 或 status 来推断进度
    assert.ok(
      !overlaySource.includes("deprecatedProgress"),
      "不应读取已废弃的 deprecatedProgress",
    );
  });
});

describe("C1: 进度文案统一格式化（percent 不泄漏英文 unit）", () => {
  it("Overlay 与 Panel 通过 generationProgressLabel 格式化进度", () => {
    const panelSource = readSubFile("GenerationPanel.tsx");
    const utilsSource = readSubFile("note-editor-utils.ts");
    assert.ok(
      overlaySource.includes("generationProgressLabel"),
      "Overlay 应使用 generationProgressLabel 格式化进度文案",
    );
    assert.ok(
      panelSource.includes("generationProgressLabel"),
      "Panel 应使用 generationProgressLabel 格式化进度文案",
    );
    assert.ok(
      utilsSource.includes("generationProgressLabel"),
      "utils 应导出 generationProgressLabel 工具函数",
    );
  });

  it("不把原始 unit 字段直接拼进组件文案", () => {
    const panelSource = readSubFile("GenerationPanel.tsx");
    assert.ok(
      !overlaySource.includes("progress.unit"),
      "Overlay 不应直接读取 progress.unit",
    );
    assert.ok(
      !panelSource.includes("progress.unit"),
      "Panel 不应直接读取 progress.unit",
    );
  });

  it("四阶段视图下总进度条与覆盖率条同源，不重复渲染", () => {
    // 总进度(explicitDecisionCoverage)与文本覆盖率同源；
    // 总进度条只在无四阶段或无覆盖率时渲染，避免出现两根同数值进度条。
    assert.ok(
      overlaySource.includes("!hasShellStage || !hasCoverage"),
      "Overlay 总进度条应与四阶段视图互斥",
    );
  });
});
