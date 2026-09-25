// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataPanel, PersonaPanel } from "./companion-center-panels";
import {
  companionPersonaV1Schema,
  type CompanionMemoryItemV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「人格」「数据与隐私」两块登记给伴星读的是什么（39d W2-7 的最后两块）。
 *
 * 两块的共同点：**只登记屏上此刻列出的那些操作**，`state` 一律是"这一行属于哪一段"。
 * 数据那一格还多一条：开发诊断段只在 DEV 构建渲染，不是给用户读的事实，一条都不进载荷。
 */

const noop = () => undefined;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function preset(id: string, name: string, style: string) {
  return {
    presetId: id,
    name,
    personalityTags: ["稳"],
    speakingStyle: style,
    examples: [{ text: "先把结论说清，再给理由。" }],
    activeness: "moderate",
    boundaries: { allowPlayful: false, allowNudgeLearning: true, allowVoiceTags: false },
  };
}

function persona(presetId: string | null = "p-1") {
  return companionPersonaV1Schema.parse({
    version: 1,
    profile: {
      id: "55555555-5555-4555-8555-555555555555",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      presetId,
      name: "小满",
      personalityTags: ["稳"],
      speakingStyle: "先给结论。",
      examples: [{ text: "先把结论说清，再给理由。" }],
      activeness: "quiet",
      boundaries: { allowPlayful: true, allowNudgeLearning: true, allowVoiceTags: false },
      revision: 3,
      familiarity: 0.4,
      interactionCount: 12,
      lastActiveAt: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    },
    presets: [preset("p-1", "沉稳", "先给结论再给理由"), preset("p-2", "轻快", "短，带一点玩笑")],
    activePreset: null,
  });
}

function memory(id: number, conflictGroup: string | null): CompanionMemoryItemV1 {
  return {
    version: 1,
    memoryItemId: `66666666-6666-4666-8666-00000000000${id}`,
    kind: "preference",
    content: `第 ${id} 条互相冲突的记忆`,
    sourceEventId: null,
    sourceSessionId: null,
    userStated: true,
    userConfirmed: true,
    candidate: false,
    importance: 0.5,
    confidence: 0.9,
    scope: "workspace",
    pinned: false,
    archived: false,
    dismissedAt: null,
    conflictGroup,
    embeddingStatus: "ready",
    sourceType: "confirmed",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  } as CompanionMemoryItemV1;
}

type PersonaProps = Parameters<typeof PersonaPanel>[0];
type DataProps = Parameters<typeof DataPanel>[0];

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function sectionTitles(scope: string): (string | null)[] {
  return [...document.querySelectorAll(scope)].map((node) => node.textContent);
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 人格：登记的预设与边界就是屏上那两列", () => {
  function renderPersona(props: Partial<PersonaProps> = {}) {
    const base: PersonaProps = {
      section: { ok: true, value: persona() },
      persona: persona(),
      busy: null,
      error: null,
      notice: null,
      onPreset: noop,
      onActiveness: noop,
      onBoundary: noop,
      onReset: noop,
      onRename: noop,
      onRetry: noop,
    };
    render(<PersonaPanel {...base} {...props} />);
  }

  it("预设与边界逐行与 DOM 相同，`state` 是那两段的段名", () => {
    renderPersona();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    const presetNames = sectionTitles(".companion-choice-grid strong");
    const boundaryNames = sectionTitles(".companion-boundaries strong");
    expect(presetNames.length).toBeGreaterThan(1);
    expect(boundaryNames.length).toBeGreaterThan(1);
    expect(view.items?.map((entry) => entry.label)).toEqual([...presetNames, ...boundaryNames]);
    expect(view.items?.map((entry) => entry.state)).toEqual([
      ...presetNames.map(() => "人格外观"),
      ...boundaryNames.map(() => "边界"),
    ]);
    // 段名不许是自己拼的：与屏上两个 `<h4>` 逐字比。
    expect(sectionTitles(".companion-persona-groups h4")).toContain("人格外观");
    expect(view.items?.[0].state).toBe(sectionTitles(".companion-persona-groups h4")[1]);
  });

  it("当前预设与活跃度这两个选中项进 filters，字面取自屏上选中的那颗按钮", () => {
    renderPersona();
    const view = publishedView()!;
    const selectedPreset = document.querySelector(".companion-choice-grid button.is-selected strong")?.textContent;
    const selectedActiveness = document.querySelector(".companion-segmented button.is-selected")?.textContent;
    expect(view.filters?.find((entry) => entry.label === "当前预设")?.value).toBe(selectedPreset);
    expect(view.filters?.find((entry) => entry.label === "活跃度")?.value).toBe(selectedActiveness);
  });

  it("档案读不到：只发那句状态与原因，不发任何一项", () => {
    renderPersona({ section: { ok: false, message: "档案服务不可用" }, persona: null });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".companion-section-state strong")?.textContent);
    expect(view.notice).toBe(`${view.statusLine}：档案服务不可用`);
    expect(view.items).toBeUndefined();
    expect(view.filters).toBeUndefined();
  });
});

describe("伴星中心 · 数据与隐私：登记屏上列出的操作，开发诊断不算", () => {
  function renderData(props: Partial<DataProps> = {}) {
    const base: DataProps = {
      busy: null,
      error: null,
      notice: null,
      dangerConfirm: null,
      conflictItems: null,
      onDangerConfirm: noop,
      onConflicts: noop,
      onResolveConflict: noop,
      onRebuild: noop,
      onExport: noop,
      onDanger: noop,
      diagnostics: { mapVersion: 2, memoryCount: 7, historyCount: 3 },
    };
    render(<DataPanel {...base} {...props} />);
  }

  it("三段的操作逐行与 DOM 相同，段名取自那三个 `<h4>`", () => {
    renderData();
    const view = publishedView()!;
    const sections = sectionTitles(".companion-data-groups h4");
    const screenRows = [...document.querySelectorAll(".companion-data-actions strong")].map((node) => node.textContent);
    expect(screenRows.length).toBe(8);
    expect(view.items?.map((entry) => entry.label)).toEqual(screenRows);
    // 开发诊断段（只在 DEV 渲染）里也有 `<h4>`，但它不在登记的两段里。
    expect(sections).toContain("开发诊断");
    expect(view.items?.every((entry) => entry.state !== "开发诊断")).toBe(true);
    expect(view.items?.[0].state).toBe(sections[0]);
    expect(view.items?.[7].state).toBe("清除数据");
  });

  it("冲突检查那句计数：没查过与查出 2 条，两种屏上写法都逐字", () => {
    renderData();
    expect(publishedView()!.metrics?.[0].value).toBe(document.querySelector(".companion-data-actions small")?.textContent);
    expect(publishedView()!.metrics?.[0].value).toBe("按需检查待处理的冲突");

    cleanup();
    useRoomStore.setState({ pageReadableView: null });
    renderData({ conflictItems: [memory(1, "c-1"), memory(2, "c-1")] });
    const view = publishedView()!;
    expect(view.metrics?.[0].value).toBe("发现 2 条冲突记录");
    // 冲突一摊开就是屏上看得见的内容：分组提示与两条正文都该登记得到。
    const group = document.querySelector(".companion-conflict-group")!;
    expect(group.querySelector("strong")?.textContent).toBe("选择要保留的记忆");
    expect(view.items?.map((entry) => entry.label)).toContain("选择要保留的记忆");
    expect(view.items?.map((entry) => entry.label)).toContain("第 1 条互相冲突的记忆");
    expect(view.items?.map((entry) => entry.label)).toContain("第 2 条互相冲突的记忆");
  });

  it("回执与报错才有 statusLine；都没有时不硬造一句", () => {
    renderData();
    expect(publishedView()!.statusLine).toBeUndefined();
    cleanup();
    useRoomStore.setState({ pageReadableView: null });
    renderData({ error: "导出没有成功" });
    expect(publishedView()!.statusLine).toBe(document.querySelector(".companion-error")?.textContent);
  });
});
