// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  CompanionDailyMonthV1,
  CompanionDailySummaryV1,
  CompanionHistoryItemV1,
  CompanionMemoryItemV1,
  CompanionMemoryStarMapV2,
  CompanionPersonaV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanionChatProvider,
  useCompanionChat,
  type CompanionUiMode,
} from "../../app/companion-chat-session";
import { useRoomStore } from "../../app/room-store";
import { CompanionCenterSurface } from "./companion-center-surface";

/**
 * 伴星中心与伴星叠加层是**兄弟节点**：一个在任务面里，一个挂在 App 外壳。
 * 两者共用同一条会话，所以 `CompanionChatProvider` 必须挂在两棵子树之上——
 * 曾经它只包住叠加层，surface 里的 `useCompanionChat()` 便在渲染时抛错，
 * 而应用没有 ErrorBoundary，点「伴星中心」= 整页黑屏。
 *
 * 这里的用例因此按真实外壳的形状渲染：Provider 在外，surface 在内。
 * 「继续交流」必须落到**同一条**会话上（叠加层的交互台读的就是它），
 * 所以断言读的是 Provider 的 mode，而不是 surface 自己的局部状态。
 */

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-09-19T08:00:00.000Z";

function session(): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "55555555-5555-4555-8555-555555555555", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: WORKSPACE_ID,
      name: "理解空间",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch: 7,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  };
}

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "companion-center-test",
    correlationId: "companion-center-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function memoryItem(): CompanionMemoryItemV1 {
  return {
    memoryItemId: MEMORY_ID,
    kind: "preference",
    content: "我更喜欢从例子开始理解概念",
    sourceEventId: null,
    sourceSessionId: null,
    userStated: true,
    userConfirmed: true,
    candidate: false,
    importance: 0.9,
    confidence: 1,
    scope: "workspace",
    pinned: true,
    archived: false,
    dismissedAt: null,
    conflictGroup: null,
    embeddingStatus: "ready",
    sourceType: "confirmed",
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function secondMemoryItem(): CompanionMemoryItemV1 {
  return {
    ...memoryItem(),
    memoryItemId: "66666666-6666-4666-8666-666666666666",
    kind: "goal",
    content: "这个月完成力学复习",
    pinned: false,
  };
}

function starMap(): CompanionMemoryStarMapV2 {
  return {
    version: 2,
    nodes: [{
      memoryId: MEMORY_ID,
      kind: "preference",
      content: "我更喜欢从例子开始理解概念",
      state: "pinned",
      importance: 0.9,
      updatedAt: UPDATED_AT,
      entityLinks: [{
        entityType: "note",
        entityId: NOTE_ID,
        label: "牛顿第二定律笔记",
        target: { kind: "note", noteId: NOTE_ID },
        orphaned: false,
      }],
    }],
    cursor: null,
  };
}

function persona(): CompanionPersonaV1 {
  return { version: 1, profile: null, presets: [], activePreset: null };
}

/** 日记页要能渲染出日期导航，前提是这一天的记录读得回来（默认 mock 是「读不到」）。 */
function dailySummary(overrides: Partial<CompanionDailySummaryV1> = {}): CompanionDailySummaryV1 {
  return {
    version: 1,
    date: "2026-09-20",
    status: "generated",
    generatedAt: "2026-09-20T16:00:00.000Z",
    failureReason: null,
    blocks: [{ type: "text", text: "晚上十点他说想慢慢来，我就把复习那件事咽回去了。" }],
    memory: null,
    ...overrides,
  };
}

/**
 * 一份带「失效关联」的星图：正常实体与失效实体各一个，记忆节点一个。
 * 失效那条的 label 就是服务端那句「关联内容已不存在」——B4 之前它被当成一条
 * 正常记录平铺在索引第二位，读起来像一条真记录。
 */
function starMapWithOrphan(): CompanionMemoryStarMapV2 {
  return {
    version: 2,
    nodes: [{
      memoryId: MEMORY_ID,
      kind: "preference",
      content: "我更喜欢从例子开始理解概念",
      state: "pinned",
      importance: 0.9,
      updatedAt: UPDATED_AT,
      entityLinks: [
        { entityType: "note", entityId: NOTE_ID, label: "牛顿第二定律笔记", target: { kind: "note", noteId: NOTE_ID }, orphaned: false },
        { entityType: "source", entityId: "77777777-7777-4777-8777-777777777777", label: "关联内容已不存在", target: null, orphaned: true },
      ],
    }],
    cursor: null,
  };
}

function historyItem(): CompanionHistoryItemV1 {
  return {
    version: 1,
    messageId: MESSAGE_ID,
    role: "assistant",
    kind: "text",
    blocks: [{ type: "text", text: "可以先从这道例题入手。" }],
    runId: null,
    createdAt: UPDATED_AT,
    editedAt: null,
  };
}

function installApi() {
  const api = {
    auth: { getState: vi.fn(async () => ok(session())) },
    companion: {
      bridge: {
        setContext: vi.fn(async () => ok({ version: 1, ok: true })),
        clearContext: vi.fn(async () => ok({ version: 1, ok: true })),
      },
      memory: {
        starMap: vi.fn(async () => ok(starMap())),
        list: vi.fn(async () => ok({ version: 2, items: [memoryItem()] })),
        create: vi.fn(async (): Promise<GatewayResultV1<CompanionMemoryItemV1>> => ok(memoryItem())),
      },
      persona: { get: vi.fn(async () => ok(persona())) },
      history: { list: vi.fn(async () => ok({ version: 1, items: [historyItem()], nextCursor: null })) },
      learningContext: { get: vi.fn(async () => { throw new Error("learning context unavailable"); }) },
      journey: { bootstrap: vi.fn(async () => { throw new Error("journey unavailable"); }) },
      activity: { timeline: vi.fn(async () => { throw new Error("activity unavailable"); }) },
      // 默认是"读不到"，各用例再 mockResolvedValue 成自己的形状。
      // 这里必须把返回类型标出来：不标的话 `async () => { throw }` 推成
      // `Promise<never>`，第一个 mockResolvedValue 就把 mock 钉死在那个对象上。
      daily: {
        // 参数也要标出来：不标的话 `calls` 推成空元组，用例里读 `calls.at(-1)[0].date`
        // 是类型错误——而 vitest 只剥类型不做检查，这条会一路绿到 typecheck。
        get: vi.fn(async (
          _request: { readonly meta: unknown; readonly date?: string },
        ): Promise<GatewayResultV1<CompanionDailySummaryV1>> => {
          throw new Error("daily unavailable");
        }),
        month: vi.fn(async (
          _request: { readonly meta: unknown; readonly month: string },
        ): Promise<GatewayResultV1<CompanionDailyMonthV1>> => {
          throw new Error("daily month unavailable");
        }),
      },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ version: 1, subscriptionId: "subscription-1" })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ok({ version: 1, ok: true })),
    },
  };
  Object.defineProperty(window, "ailearn", { configurable: true, value: api });
  return api;
}

/** 外壳里同一条会话的读数：叠加层的交互台读的就是它。 */
let shellMode: CompanionUiMode | null = null;
function ShellSessionProbe() {
  shellMode = useCompanionChat().mode;
  return null;
}

beforeEach(() => {
  shellMode = null;
  // jsdom 没有这两个浏览器接口，而星图画布组件在挂载时会用到它们。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(window, "ResizeObserver");
  Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  // 房间 store 是模块级单例，测试文件之间共用。
  useRoomStore.setState({ hudPage: "home", surface: null, companionCenterTarget: null });
  vi.restoreAllMocks();
});

function renderCompanionCenter() {
  // 与 App 同形：Provider 在两者之上，叠加层（探针）与任务面 surface 是兄弟。
  render(
    <CompanionChatProvider>
      <ShellSessionProbe />
      <CompanionCenterSurface />
    </CompanionChatProvider>,
  );
}

describe("the companion center reads the shell's companion session", () => {
  it("renders the persisted memory graph instead of throwing on an unprovided context", async () => {
    installApi();
    renderCompanionCenter();

    // 记忆列表与星图索引都必须来自服务端确认的记录（候选不进图，见 universe 用例）。
    // 同一条记忆会同时出现在左侧列表和右侧星图索引里，所以这里读的是集合。
    expect((await screen.findAllByText("我更喜欢从例子开始理解概念")).length).toBeGreaterThan(0);
    const index = screen.getByRole("listbox", { name: "星图等价节点索引" });
    expect(index.textContent).toContain("牛顿第二定律笔记");
    expect(screen.queryByText("伴星中心暂时不可用")).toBeNull();
  });

  it("opens the same conversation the companion overlay renders", async () => {
    installApi();
    renderCompanionCenter();

    fireEvent.click(await screen.findByRole("tab", { name: "对话" }, { timeout: 5000 }));
    fireEvent.click(await screen.findByRole("button", { name: /继续交流/ }));

    expect(shellMode).toBe("conversation");
    // 服务端确认的对话记录按全局时间排在同一页上。
    await screen.findByText("可以先从这道例题入手。");
  });

  it("scopes destructive confirmation to the selected memory", async () => {
    const api = installApi();
    api.companion.memory.list.mockResolvedValue(ok({ version: 2, items: [memoryItem(), secondMemoryItem()] }));
    renderCompanionCenter();

    const first = await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ });
    fireEvent.click(first);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("button", { name: "确认删除" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /这个月完成力学复习/ }));
    expect(screen.queryByRole("button", { name: "确认删除" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
  });

  /**
   * 日记页（用户 2026-09-21 的裁决：「这跟系统统计数据有什么区别？」）。
   * 旧实现把 12 个计数拼成一句"…的学习小结：新增学习卡 4 张；…"再挂一张数字表；
   * 现在这一页只有她自己写的那段话，所以这两条用例守的是"数字不许回来"。
   */
  it("renders the diary as her own prose, with no statistics table", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok<CompanionDailySummaryV1>({
      version: 1,
      date: "2026-09-20",
      status: "generated",
      generatedAt: "2026-09-20T16:00:00.000Z",
      failureReason: null,
      blocks: [{ type: "text", text: "晚上十点他说想慢慢来，我就把复习那件事咽回去了。" }],
      memory: { memoryItemId: MEMORY_ID, candidate: true },
    }));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));

    const prose = await screen.findByText(/晚上十点他说想慢慢来/);
    expect(prose.tagName).toBe("P");
    // 正文里不许有阿拉伯数字——那正是"这跟系统统计数据有什么区别"的形状。
    expect(prose.textContent).not.toMatch(/\d/);
    const card = prose.closest("article");
    expect(card?.querySelectorAll("dl")).toHaveLength(0);
    expect(card?.textContent).not.toMatch(/新建笔记|生成学习卡|发起后台任务|到访页面|你说的话|伴星回复|学习小结/);

    fireEvent.click(screen.getByRole("button", { name: "查看关联记忆" }));
    expect(screen.getByRole("tab", { name: "记忆" }).getAttribute("aria-selected")).toBe("true");
  });

  /**
   * 她自己摆进来的图与原文，按她给的顺序出现在正文里。
   *
   * jsdom 取不到图片字节（没有真实的 source.getImage 通道），所以这里断言的是
   * **位置与图注**——图那一格无论显示成图还是显示成"图片取不回来（图注）"，
   * 都占在她放它的那个位置上。真的显示出来没有，走 CDP 在运行中的界面里看。
   */
  it("places her embedded image and quote where she put them, not all at the end", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok<CompanionDailySummaryV1>({
      version: 1,
      date: "2026-09-20",
      status: "generated",
      generatedAt: "2026-09-20T16:00:00.000Z",
      failureReason: null,
      blocks: [
        { type: "text", text: "下午那张图我看了很久。" },
        { type: "image", url: "/api/uploads/notes/alpha.png", label: "《IndexTTS》· 第 1 张", alt: "声码器流程图" },
        { type: "text", text: "原文里那句话我一直记着。" },
        { type: "quote", label: "《IndexTTS》里写着", text: "降低语义 Codec 帧率之后，音质几乎没掉。" },
      ],
      memory: null,
    }));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));

    const first = await screen.findByText(/下午那张图我看了很久/);
    const card = first.closest("article");
    const order = [...(card?.children ?? [])].map((node) => node.textContent ?? "");
    expect(order[0]).toContain("下午那张图我看了很久");
    expect(order[1]).toContain("《IndexTTS》· 第 1 张");
    expect(order[2]).toContain("原文里那句话我一直记着");
    expect(order[3]).toContain("降低语义 Codec 帧率之后");
    // 引用块用的是记录页那个组件：长原文自己会量高折叠，这里不重复实现。
    expect(card?.querySelector("figure.companion-record__quote")).toBeTruthy();
    expect(screen.queryByText(/查看关联记忆/)).toBeNull();
  });

  it.each([
    ["consent_required", /「允许发送到外部模型服务」没有开启/],
    ["model_unavailable", /她试了几次没写出来/],
    ["diary_output_invalid", /还是在报数/],
    // 这次改动之前写下的失败行没有成因这一列。
    [null, /不会用推测内容填充这一天/],
  ] as const)("names why she could not write the day (%s) instead of promising a retry on read", async (reason, expected) => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok<CompanionDailySummaryV1>({
      version: 1,
      date: "2026-09-20",
      status: "failed",
      generatedAt: "2026-09-20T16:00:00.000Z",
      failureReason: reason,
      blocks: [],
      memory: null,
    }));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));

    await screen.findByText("这一天她没能写下来");
    expect(screen.getByText(expected)).toBeTruthy();
    // 读取不会触发重新生成，旧文案那句"可稍后重试"是假承诺；正文也不许出现在失败态里。
    expect(screen.queryByText(/可稍后重试/)).toBeNull();
    expect(screen.queryByText(/晚上十点/)).toBeNull();
  });

  /**
   * B4（评审 §6 从 B3 接的一条）：气泡里的空白节奏。
   *
   * 实测那条回复是单个 `<p>`、6 个 `\n`、225px 高——`pre-wrap` 把模型写的每个
   * 换行都排成一行，段中就出现三行高的空档。切段只认「两个及以上连续换行」，
   * 段内的单个换行是作者自己的换行，必须原样留着。
   */
  it("splits a bubble into paragraphs at blank runs but keeps single line breaks", async () => {
    const api = installApi();
    api.companion.history.list.mockResolvedValue(ok({
      version: 1,
      items: [{ ...historyItem(), blocks: [{ type: "text", text: "本周累计 154 分钟。\n\n\n你说得对，刚才那几个数是凭印象说的。\n现在去查真实数据。" }] }],
      nextCursor: null,
    }));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "对话" }));

    const article = await screen.findByText("本周累计 154 分钟。");
    const paragraphs = [...article.closest("article")!.querySelectorAll("p")];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("本周累计 154 分钟。");
    // 第二个换行没被吞掉：它仍然在同一段里。
    expect(paragraphs[1].textContent).toBe("你说得对，刚才那几个数是凭印象说的。\n现在去查真实数据。");
  });

  /**
   * 月历上的「她写过哪几天」。标记来自新的月度读接口；读不到时必须说出来，
   * 不能让「没有点」被读成「这个月她什么都没写」——那是两条不同的事实。
   */
  it("marks the days she actually wrote, and says so when the marks cannot be read", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    api.companion.daily.month.mockResolvedValue(ok({
      version: 1,
      month: "2026-09",
      days: [
        { date: "2026-09-18", status: "generated" },
        { date: "2026-09-19", status: "failed" },
      ],
    }));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));
    fireEvent.click(await screen.findByRole("button", { name: /^选择日记日期/ }));

    const written = await screen.findByRole("button", { name: "18 日，她写过" });
    expect(written.querySelector(".companion-record__calendar-mark")?.getAttribute("data-status")).toBe("generated");
    expect(screen.getByRole("button", { name: "19 日，她没写成" }).querySelector(".companion-record__calendar-mark")?.getAttribute("data-status")).toBe("failed");
    // 没写过的那一天照样可点：点开是「这一天还没有日记」，那是一个诚实的答案。
    expect(screen.getByRole("button", { name: "15" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText(/这次没读出来/)).toBeNull();
  });

  it("admits when the month marks could not be read instead of showing an empty calendar", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));
    fireEvent.click(await screen.findByRole("button", { name: /^选择日记日期/ }));

    // 默认 mock 就是「读不到」——这正是要披露的那种情况。
    await screen.findByText(/这个月她写过哪几天，这次没读出来/);
    expect(document.querySelectorAll(".companion-record__calendar-mark")).toHaveLength(0);
  });

  /**
   * B4（评审 P12）记忆卡模板。
   *
   * jsdom 不加载样式表，所以这里守的是**DOM 顺序与信息归并**：正文是卡片的第一个
   * 子元素、元信息收成一行。高度与「一屏几张」只能在真机量，走
   * apps/desktop-client/scripts/tmp-cc-b4.mjs。
   */
  it("leads the memory card with its text and collapses meta into one line", async () => {
    installApi();
    renderCompanionCenter();

    const card = await screen.findByRole("button", { name: /我更喜欢从例子开始理解概念/ });
    const body = card.querySelector("strong");
    expect(body?.textContent).toBe("我更喜欢从例子开始理解概念");
    expect(card.firstElementChild).toBe(body);

    const meta = card.querySelector("span");
    expect(meta?.textContent).toContain("偏好");
    expect(meta?.textContent).toContain("已固定");
    // 类型、状态、时间全在这一行里：旧的独立标签位与日期行都要消失，否则还是三层抢同级。
    expect(card.querySelectorAll("b")).toHaveLength(0);
    expect(card.querySelectorAll("small")).toHaveLength(0);
    // 状态用色点表达，但文字留着——颜色不能是唯一载体。
    expect(meta?.querySelector("i.is-pinned")).not.toBeNull();
  });

  /**
   * B4（评审 P13）星图右栏：48 条同一个长相的平铺列表改成按时间/类型分组，
   * 失效关联单独成组，行内图标换成与图例同源的颜色点。
   */
  it("groups the star-map index by time and type, with dead links in their own group", async () => {
    const api = installApi();
    api.companion.memory.starMap.mockResolvedValue(ok(starMapWithOrphan()));
    renderCompanionCenter();

    const index = await screen.findByRole("listbox", { name: "星图等价节点索引" });
    const rows = [...index.querySelectorAll('button[role="option"]')];
    expect(rows).toHaveLength(3);

    const groups = [...index.children];
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.getAttribute("role")).toBe("group");
      const title = group.querySelector("h4");
      expect(title).not.toBeNull();
      expect(group.getAttribute("aria-labelledby")).toBe(title?.id);
      expect(group.querySelectorAll('button[role="option"]').length).toBeGreaterThan(0);
    }
    // 每一行都在某个分组里，没有游离的平铺行。
    expect(rows.filter((row) => row.closest("div[role='group']") === null)).toHaveLength(0);

    const dead = rows.find((row) => row.textContent?.includes("关联内容已不存在"));
    const alive = rows.find((row) => row.textContent?.includes("牛顿第二定律笔记"));
    expect(dead?.getAttribute("data-state")).toBe("orphaned");
    expect(dead?.parentElement).not.toBe(alive?.parentElement);
    expect(dead?.parentElement?.querySelector("h4")?.textContent).toContain("失效");

    // 颜色点取代了 <CircleDot>，颜色由 data-role/data-state 决定，与图例同源。
    expect(rows[0].querySelector("svg")).toBeNull();
    expect(rows[0].querySelector("i")).not.toBeNull();
  });

  /**
   * 日记的日期筛选（2026-09-22 用户指定：「换成历史纪录那里的那种日期面板，
   * 平时缩放起来，用户点击才展开，页面上保留前一天后一天的切换按钮」）。
   */
  it("keeps the diary calendar collapsed until the date pill is clicked", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));

    const trigger = await screen.findByRole("button", { name: /^选择日记日期/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".companion-record__calendar")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "选择日期" })).toBeTruthy();
    // 翻页不进口历：前一天 / 后一天仍然摆在页面上。
    expect(screen.getByRole("button", { name: "前一天" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "后一天" })).toBeTruthy();
  });

  it("reaches a day the five-button strip could never offer, then folds itself away", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));
    const callsBefore = api.companion.daily.get.mock.calls.length;
    fireEvent.click(await screen.findByRole("button", { name: /^选择日记日期/ }));

    const calendar = screen.getByRole("group", { name: "选择日期" });
    // 旧的日期条只给 anchor 往回 5 天；9 月 1 日从来点不到。
    const first = [...calendar.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.firstChild?.textContent === "1");
    expect(first).toBeTruthy();
    expect(first?.disabled).toBe(false);
    fireEvent.click(first!);

    // 取数前要先 await 会话（readAuthenticatedSession），所以这里必须等一拍；
    // 同步断言会读到「还没发出去」的调用表。
    await waitFor(() => expect(api.companion.daily.get.mock.calls.at(-1)?.[0].date).toBe("2026-09-01"));
    expect(api.companion.daily.get.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(document.querySelector(".companion-record__calendar")).toBeNull();
  });

  /**
   * Escape 的分工：伴星中心整页不是 dialog，App 上挂着全局 Escape = 回书桌
   * （`App.tsx` 里 `shouldIgnoreGlobalShortcut` 认 `defaultPrevented`）。
   * 日历开着时按 Escape 只准收日历，所以处理器必须声明这次按键被吃掉。
   */
  it("claims the Escape key so closing the calendar does not leave the centre", async () => {
    const api = installApi();
    api.companion.daily.get.mockResolvedValue(ok(dailySummary()));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "日记" }));
    fireEvent.click(await screen.findByRole("button", { name: /^选择日记日期/ }));
    expect(document.querySelector(".companion-record__calendar")).toBeTruthy();

    // fireEvent 会把更新包进 act，并且「preventDefault 被调用过」时返回 false。
    expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
    expect(document.querySelector(".companion-record__calendar")).toBeNull();
  });

  /**
   * B6（评审 P18）：进行中要有看得见的反馈。以前点下去只有一行字变成「正在保存…」，
   * 界面像没反应。`data-busy` 只挂在**自己知道在忙**的那颗按钮上。
   */
  it("puts the spinner on the button that is actually working, not on the whole row", async () => {
    const api = installApi();
    api.companion.memory.create.mockImplementation(() => new Promise(() => undefined));
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "记忆" }));
    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));
    fireEvent.change(screen.getByLabelText("新记忆内容"), { target: { value: "我习惯先看例子" } });

    const save = screen.getByRole("button", { name: "保存记忆" });
    fireEvent.click(save);

    await waitFor(() => expect(save.getAttribute("data-busy")).toBe("true"));
    expect(document.querySelectorAll('.companion-inline-form button[data-busy="true"]')).toHaveLength(1);
  });

  /**
   * B6（评审 P17）：换页以前是硬切。入场动画挂在面板上，而 React 默认**复用**同一个
   * DOM 节点（只改 id），动画就不会重放——所以面板必须按页签换身份。
   * 这条钉的是那个 `key`，不是 CSS。
   */
  it("hands the stage panel to a fresh node when the tab changes, so the entrance replays", async () => {
    installApi();
    renderCompanionCenter();
    fireEvent.click(await screen.findByRole("tab", { name: "对话" }));
    const first = document.querySelector(".companion-stage .companion-tab-panel");
    expect(first).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "动态" }));
    await screen.findByRole("heading", { name: "动态", level: 3 });
    const second = document.querySelector(".companion-stage .companion-tab-panel");
    expect(second).not.toBe(first);
  });
});

