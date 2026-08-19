/**
 * Phase B/C：Agent 活动流 UI 契约（静态源码分析 + 类型契约）。
 *
 * 红线（设计 §3.1）：
 * - 不暴露 raw conversation / chain-of-thought；活动流只展示
 *   safePayload 里的计数/ID/状态，绝不渲染模型原文。
 * - flag 关闭（fail-closed）时控制台不渲染，生成进度展示回到现状。
 *
 * 可访问性（§4.3/§6.4）：
 * - 活动流容器 role="log" + aria-live="polite"。
 *
 * 2026-08-11 测试质量修复：纯函数映射断言已移除（agent-event-text.test.ts
 * 覆盖真实映射）；新增类型契约断言（组件 props 暴露 safePayload 时编译期失败）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { GenerationOverlayProps } from "../../components/note-editor/GenerationOverlay";

// 类型契约（编译期验证）：GenerationOverlay 不应暴露原始载荷 prop——
// 红线破坏时（props 出现 safePayload/rawPayload/payload 键）OverlayRawKey
// 非 never，AssertNoRawPayloadKey 变 never，赋值 `= true` 编译失败。
// 注意不能写 `undefined as never`（never 可赋给任意类型，断言会永远通过）。
type OverlayRawKey = Extract<keyof GenerationOverlayProps, "safePayload" | "rawPayload" | "payload">;
type AssertNoRawPayloadKey = OverlayRawKey extends never ? true : never;
const _assertNoRawPayloadKey: AssertNoRawPayloadKey = true;
export { _assertNoRawPayloadKey };

const noteEditorDir = resolve(
  (import.meta.dirname ?? __dirname),
  "../../components/note-editor",
);
function readNoteEditorFile(name: string): string {
  return readFileSync(resolve(noteEditorDir, name), "utf8");
}

const streamSource = readNoteEditorFile("AgentStreamList.tsx");
const fabSource = readNoteEditorFile("GenerationProgressFab.tsx");
const overlaySource = readNoteEditorFile("GenerationOverlay.tsx");

describe("红线：不渲染 raw safePayload 字符串值", () => {
  it("GenerationOverlay 完全不引用 safePayload", () => {
    assert.ok(
      !overlaySource.includes("safePayload"),
      "Overlay 不应直接读取 safePayload（只消费 run 视图聚合字段）",
    );
  });

  it("活动流行文案来自 agentEventRowText 映射，不直接渲染 payload", () => {
    // 2026-08-11：纯函数映射断言已由 agent-event-text.test.ts 的真实实现
    // 测试覆盖（含模板文案）；此处仅保留"组件不直接读 payload"红线。
    assert.ok(
      !streamSource.includes("event.safePayload"),
      "组件不应把 safePayload 直接渲染为文本",
    );
  });
});

describe("可访问性：role=log + aria-live", () => {
  it("活动流展开列表使用 role='log'", () => {
    assert.ok(
      streamSource.includes('role="log"'),
      "活动流容器应使用 role='log'",
    );
  });

  it("活动流展开列表使用 aria-live='polite'", () => {
    assert.ok(
      streamSource.includes('aria-live="polite"'),
      "新行应以不打断朗读的方式插入",
    );
  });

  it("折叠按钮带 aria-expanded", () => {
    assert.ok(
      streamSource.includes('aria-expanded'),
      "折叠/展开按钮应带 aria-expanded",
    );
  });
});

describe("fail-closed：flag 关闭时不渲染活动流", () => {
  it("GenerationProgressFab 在 !show 时返回 null", () => {
    assert.ok(
      fabSource.includes("if (!show) return null;"),
      "flag 关闭（show=false）时悬浮按钮应整体不渲染（fail-closed）",
    );
  });

  it("GenerationOverlay 的活动流面板受 activityEnabled 门控", () => {
    assert.ok(
      overlaySource.includes("showActivityPanel = activityEnabled"),
      "Overlay 内活动流面板应受特性开关门控",
    );
    assert.ok(
      overlaySource.includes("lcg-details-shell"),
      "Overlay 应含按需展开的处理详情结构",
    );
  });

  it("NoteEditor 的活动流相关渲染受特性开关门控", () => {
    const editorSource = readFileSync(
      resolve((import.meta.dirname ?? __dirname), "../../components/NoteEditor.tsx"),
      "utf8",
    );
    assert.ok(
      editorSource.includes("AGENT_ACTIVITY_STREAM_ENABLED"),
      "弹窗/FAB 渲染应引用特性开关常量",
    );
  });
});

describe("事件流展示契约", () => {
  it("活动流行以 eventKey 为 React key（幂等去重）", () => {
    assert.ok(
      streamSource.includes("key={event.eventKey}"),
      "行 key 应使用事件唯一键",
    );
  });

  it("截断提示复用'仅展示最近 X 条'模式", () => {
    assert.ok(
      streamSource.includes("当前只展示最近"),
      "超过上限时应显示截断提示",
    );
  });
});
