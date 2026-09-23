// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionAgentRouteEventV1 } from "@ailearn/shared/companion-chat-desktop-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { RoomIntent } from "./room-machine";
import { useRoomStore } from "./room-store";
import {
  applyRouteToRoom,
  desktopRouteFromAgentRoute,
  navChipsStillOutsideMessages,
  readCompleteCompanionHistory,
  type CompanionNavChip,
} from "./companion-chat-session";

describe("完整历史搜索池", () => {
  it("翻过 1200 条旧上限直到开头，仍能找到最早的消息", async () => {
    const pages: number[] = [];
    const older = await readCompleteCompanionHistory(1351, async (beforeSeq) => {
      pages.push(beforeSeq);
      const first = Math.max(1, beforeSeq - 100);
      return {
        items: Array.from({ length: beforeSeq - first }, (_, index) => ({ seq: first + index, id: String(first + index) }) as CompanionMessageV1),
        oldestSeq: first,
        hasMore: first > 1,
      };
    });
    expect(pages.length).toBeGreaterThan(12);
    expect(older?.[0]?.seq).toBe(1);
    expect(older?.at(-1)?.seq).toBe(1350);
  });

  it("中途读取失败或游标停住，都不返回会造成假“没有找到”的部分结果", async () => {
    let calls = 0;
    const failed = await readCompleteCompanionHistory(400, async (beforeSeq) => {
      calls += 1;
      if (calls === 2) return null;
      return { items: [{ seq: 399 } as CompanionMessageV1], oldestSeq: beforeSeq - 1, hasMore: true };
    });
    expect(failed).toBeNull();
    const stalled = await readCompleteCompanionHistory(400, async (beforeSeq) => ({
      items: [{ seq: 399 } as CompanionMessageV1], oldestSeq: beforeSeq, hasMore: true,
    }));
    expect(stalled).toBeNull();
  });
});

const NOTE_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";

function chip(summary: string, route: CompanionNavChip["route"]): CompanionNavChip {
  return { id: `${summary}-1`, summary, route };
}

function messageWithNav(label: string, route: unknown): CompanionMessageV1 {
  return {
    blocks: [
      { type: "text", text: "带你去看。" },
      { type: "nav", label, route },
    ],
  } as CompanionMessageV1;
}

describe("navChipsStillOutsideMessages（§4.8：消息里的落点取代游离 chip）", () => {
  it("同一条落点已经进了消息，chip 行不再重复出现", () => {
    const messages = [messageWithNav("打开那篇笔记", { kind: "note", noteId: NOTE_ID })];
    const chips = [chip("打开那篇笔记", { kind: "note.detail", noteId: NOTE_ID })];
    expect(navChipsStillOutsideMessages(chips, messages)).toEqual([]);
  });

  it("桌面端没有等价形态的落点也不重复（消息里已留一行字，chip 只会再说一遍）", () => {
    const messages = [messageWithNav("去今日", { kind: "today" })];
    expect(navChipsStillOutsideMessages([chip("去今日", null)], messages)).toEqual([]);
  });

  it("消息里还没有的落点留着：确认后直接给出的落点、以及正在跑的这一轮", () => {
    const messages = [messageWithNav("打开那篇笔记", { kind: "note", noteId: NOTE_ID })];
    const kept = chip("去星图", { kind: "understanding.graph" });
    expect(navChipsStillOutsideMessages([kept], messages)).toEqual([kept]);
  });

  it("一条 nav 块都没有时不改变 chip 行（历史消息不受这条规则影响）", () => {
    const chips = [chip("去复习", { kind: "review.queue" })];
    expect(navChipsStillOutsideMessages(chips, [])).toEqual(chips);
    expect(navChipsStillOutsideMessages(chips, [
      { blocks: [{ type: "text", text: "只有正文" }] },
    ] as CompanionMessageV1[])).toEqual(chips);
  });
});

/**
 * 她带我去哪儿：每种**能映射出来**的落点都必须真的切页。
 *
 * 判据来源是 `desktopRouteFromAgentRoute` —— 它能产出下面这九种 `DesktopRouteV1`，
 * 而「前往」按钮与 `autoExecute` 都走 `applyRouteToRoom`。这里按这张表逐个过：
 * 少一次 `invoke` 就是一次空转（两条 IPC 都成功、无报错、页面纹丝不动）。
 * 2026-09-22 实测 `learningRun.detail` 正是这样：它只 `setActiveRunId`，而页面切换的
 * 唯一开关是 `invoke`；仓库里另外 7 处开同一页的入口全都成对写。
 * 表是从函数里现读的，所以以后新增一种可映射落点却没写落点，这条会直接少一条断言 ——
 * 因此另有一条"表必须覆盖映射函数的全部 kind"的自检。
 */
describe("applyRouteToRoom（每种可映射落点都必须真正换页）", () => {
  const MAPPED_ROUTES = [
    { kind: "room.home" },
    { kind: "review.queue" },
    { kind: "understanding.graph" },
    { kind: "source.library" },
    { kind: "source.detail", sourceId: NOTE_ID },
    { kind: "note.detail", noteId: NOTE_ID },
    { kind: "learningRun.detail", runId: NOTE_ID },
    { kind: "objective.detail", objectiveId: NOTE_ID },
    { kind: "companion.center", tab: "dialogue" },
  ] as const satisfies readonly DesktopRouteV1[];

  const invokePage = async (route: DesktopRouteV1) => {
    const store = useRoomStore;
    const original = store.getState().invoke;
    const intents: string[] = [];
    store.setState({ invoke: (intent: RoomIntent) => { intents.push(intent); } });
    try {
      const applied = await applyRouteToRoom(route);
      return { applied, intents };
    } finally {
      store.setState({ invoke: original });
    }
  };

  for (const route of MAPPED_ROUTES) {
    it(`${route.kind}：换页请求真的发出去了`, async () => {
      const { applied, intents } = await invokePage(route);
      expect(applied).toBe(true);
      expect(intents.length).toBeGreaterThan(0);
    });
  }

  it("九种可映射落点与映射函数的产出一一对应（新增 kind 却没写落点时这条会红）", async () => {
    const agentRoutes: CompanionAgentRouteEventV1["route"][] = [
      { kind: "home" }, { kind: "review" }, { kind: "star_map" }, { kind: "learning_run", runId: NOTE_ID },
      { kind: "note", noteId: NOTE_ID }, { kind: "source", sourceId: NOTE_ID }, { kind: "source" },
      { kind: "card", cardId: NOTE_ID, objectiveId: NOTE_ID }, { kind: "conversation" },
    ];
    const produced = agentRoutes.map((route) => desktopRouteFromAgentRoute(route)?.kind);
    expect(produced.filter((kind) => kind !== undefined).length).toBe(agentRoutes.length);
    expect(new Set(produced)).toEqual(new Set(MAPPED_ROUTES.map((route) => route.kind)));
  });

  it("桌面端没有等价页面的落点如实返回 false，不假装跳过了", async () => {
    const { applied } = await invokePage({ kind: "note.library" } as DesktopRouteV1);
    expect(applied).toBe(false);
  });
});
