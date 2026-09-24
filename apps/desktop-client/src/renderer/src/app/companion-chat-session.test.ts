// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionAgentRouteEventV1 } from "@ailearn/shared/companion-chat-desktop-contracts";
import type { DesktopRouteV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { allowedMainRouteV2Schema } from "@ailearn/shared/companion-bridge-contracts";
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

  it("消息里已经落了同一个落点，chip 换个说法也不重复（判据是路由不是文案）", () => {
    const messages = [messageWithNav("去今日", { kind: "today" })];
    expect(navChipsStillOutsideMessages([chip("今日学习在这儿", { kind: "room.today" })], messages)).toEqual([]);
  });

  it("只有回执文字、没有落点的 chip 不被消息里的路由吃掉（它俩不是同一件事）", () => {
    const messages = [messageWithNav("去今日", { kind: "today" })];
    const pending = chip("第四张卡在写", null);
    expect(navChipsStillOutsideMessages([pending], messages)).toEqual([pending]);
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
 *
 * 2026-09-24 判据改成从 `allowedMainRouteV2Schema` 现读。此前这里是一份**手抄的九条**，
 * 而 `today`/`settings` 恰好不在抄来的清单里——那份手抄把"新增 kind 却没写落点会红"
 * 这句话兑成了空话：白名单加 kinds、映射表漏分支、测试全绿，用户那边是她说"到今日了"
 * 而那颗按钮根本不渲染。现在每一条路由都由白名单喂进来，漏一个 case 就红一条。
 */
describe("applyRouteToRoom（白名单里每种路由都必须真正换页）", () => {
  // 带必填 id 的 kind 补一个能过 zod 的最小形状；这里要量的是"有没有落点"，不是 id 归属。
  const agentRoutes = allowedMainRouteV2Schema.options.map((option) => {
    const route: Record<string, unknown> = { kind: option.shape.kind.value };
    for (const [field, schema] of Object.entries(option.shape)) {
      if (field === "kind" || schema.isOptional()) continue;
      route[field] = NOTE_ID;
    }
    return route as CompanionAgentRouteEventV1["route"];
  });

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

  it("正控制：白名单确实读到了这十三个 kind（读空了整个循环就是空跑）", () => {
    expect(agentRoutes.map((route) => route.kind).sort()).toEqual([
      "card", "conversation", "home", "learning_run", "note", "note_library", "objective_library",
      "review", "search", "settings", "source", "star_map", "today",
    ]);
  });

  for (const agentRoute of agentRoutes) {
    it(`${agentRoute.kind}：映射得出落点，且换页请求真的发出去了`, async () => {
      const target = desktopRouteFromAgentRoute(agentRoute);
      expect(target, "服务端发得出的路由，客户端不能映射成 null").not.toBeNull();
      const { applied, intents } = await invokePage(target as DesktopRouteV1);
      expect(applied).toBe(true);
      expect(intents.length).toBeGreaterThan(0);
    });
  }

  it("桌面端确实没有等价页面的落点如实返回 false，不假装跳过了", async () => {
    const { applied } = await invokePage({ kind: "companion.drawer", focus: "voice" });
    expect(applied).toBe(false);
  });
});
