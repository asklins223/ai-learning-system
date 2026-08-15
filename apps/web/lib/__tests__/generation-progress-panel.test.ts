/**
 * 学习卡生成工作台 UI 契约。
 *
 * 当前服务端仍是 legacy direct-publish 链路，因此这里特别保护：
 * - 只展示真实 shellStage 与来源版本；
 * - 不展示合成百分比、ETA、候选数量或覆盖率；
 * - Agent 活动只是按需展开的诊断信息；
 * - 用户可最小化并恢复，不会中断后台任务。
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
const phaseRailSource = readSubFile("GenerationPhaseRail.tsx");
const panelSource = readSubFile("GenerationPanel.tsx");
const fabSource = readSubFile("GenerationProgressFab.tsx");
const stylesSource = readFileSync(
  resolve((import.meta.dirname ?? __dirname), "../../app/styles/note-editor.css"),
  "utf8",
);

describe("生成工作台：真实阶段与来源", () => {
  it("阶段轨道从 shellStage/stage 做有限映射", () => {
    assert.ok(phaseRailSource.includes("run.shellStage ?? run.stage"));
    assert.ok(phaseRailSource.includes("shellStageStepStates(stage)"));
    assert.ok(phaseRailSource.includes('"preparing"'));
    assert.ok(phaseRailSource.includes('"generating"'));
    assert.ok(phaseRailSource.includes('"checking"'));
    assert.ok(phaseRailSource.includes('"publishing"'));
  });

  it("用户态四阶段不伪装成 Candidate Review", () => {
    assert.ok(phaseRailSource.includes('name: "理解素材"'));
    assert.ok(phaseRailSource.includes('name: "设计提问"'));
    assert.ok(phaseRailSource.includes('name: "核对依据"'));
    assert.ok(phaseRailSource.includes('name: "发布结果"'));
    assert.ok(!phaseRailSource.includes("候选已就绪"));
    assert.ok(!overlaySource.includes("启用候选"));
  });

  it("Overlay 与抽屉都呈现精确来源版本", () => {
    assert.ok(overlaySource.includes("run.sourceSnapshot.versionNo"));
    assert.ok(panelSource.includes("generationRun?.sourceSnapshot.versionNo"));
    assert.ok(overlaySource.includes("generationPhasePosition(run)"));
  });
});

describe("生成工作台：不展示无法支撑的进度与质量代理指标", () => {
  it("Overlay 不渲染合成百分比或 ETA", () => {
    assert.ok(!overlaySource.includes("measuredGenerationPercent"));
    assert.ok(!overlaySource.includes("advanceEta"));
    assert.ok(!overlaySource.includes('role="progressbar"'));
    assert.ok(!overlaySource.includes("预计剩余"));
  });

  it("Overlay 与抽屉不读取候选计数或覆盖率百分比", () => {
    for (const source of [overlaySource, panelSource]) {
      assert.ok(!source.includes("candidates.extracted"));
      assert.ok(!source.includes("candidates.eligible"));
      assert.ok(!source.includes("sourceCoverageBps"));
      assert.ok(!source.includes("imageCoverageBps"));
    }
  });

  it("终态措辞对应 legacy 已发布/部分结果", () => {
    assert.ok(overlaySource.includes("学习卡已经发布"));
    assert.ok(overlaySource.includes("只保留了可确认的部分"));
    assert.ok(overlaySource.includes('run.status === "succeeded"'));
    assert.ok(overlaySource.includes('run.status === "partial_ready"'));
  });
});

describe("生成工作台：详情按需、可最小化恢复", () => {
  it("安全活动记录默认收起并受功能开关控制", () => {
    assert.ok(overlaySource.includes("showActivityPanel = activityEnabled"));
    assert.ok(overlaySource.includes("showActivityPanel && detailsOpen"));
    assert.ok(overlaySource.includes('aria-expanded={detailsOpen}'));
    assert.ok(overlaySource.includes("只展示阶段、状态与计数，不展示模型内部推理"));
  });

  it("关闭按钮和主按钮明确表达最小化", () => {
    assert.ok(overlaySource.includes("最小化生成进度"));
    assert.ok(overlaySource.includes("最小化，继续编辑"));
    assert.ok(overlaySource.includes("最小化不会中断生成"));
  });

  it("最小化后提供独立恢复入口", () => {
    assert.ok(fabSource.includes("if (!show) return null;"));
    assert.ok(fabSource.includes("恢复学习卡生成进度"));
    assert.ok(fabSource.includes("学习卡生成中"));
    assert.match(stylesSource, /\.generation-progress-fab\s*\{/);
  });

  it("工作台有桌面、移动端和 reduced-motion 适配", () => {
    assert.match(stylesSource, /\.lcg-dialog\.ne-generation-dialog\s*\{/);
    assert.match(stylesSource, /@media \(max-width: 760px\)/);
    assert.match(stylesSource, /@media \(max-width: 520px\)/);
    assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe("生成工作台：废弃字段红线", () => {
  it("不读取旧计数器或 raw payload", () => {
    assert.ok(!overlaySource.includes("oldCompleted"));
    assert.ok(!overlaySource.includes("oldTotal"));
    assert.ok(!overlaySource.includes("deprecatedProgress"));
    assert.ok(!overlaySource.includes("safePayload"));
  });
});
