// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type {
  ActivityAnomalyV1,
  ActivityEventV1,
  TodayActivityV1,
} from "@ailearn/shared/activity-surface-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../app/room-store";
import { StudySurface } from "./StudySurface";

/**
 * 这一页的缺陷几乎都在**分支**里，而不是纯函数里：
 *
 * - 只有异常的那一支把 detail 丢了（而它恰好是真实数据最常命中的分支）；
 * - 重复异常逐条渲染成一堵分不清的墙；
 * - 跳转目标为空时给了按钮，等于给读者一条死路。
 *
 * 纯函数层（today-log.test.ts）测不到这些，所以这里把四个渲染分支钉住。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";

function session(): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "44444444-4444-4444-8444-444444444444", email: "reader@example.com" },
    workspace: {
      version: 1,
      workspaceId: "55555555-5555-4555-8555-555555555555",
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
    requestId: "today-test",
    correlationId: "today-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function event(overrides: Partial<ActivityEventV1> = {}): ActivityEventV1 {
  return {
    id: "note.created:n1",
    at: new Date(2026, 8, 18, 9, 5).toISOString(),
    kind: "note",
    verb: "note.created",
    title: "牛顿第二定律",
    detail: null,
    target: { kind: "note", id: NOTE_ID, noteVersionId: null },
    ...overrides,
  };
}

function anomaly(overrides: Partial<ActivityAnomalyV1> = {}): ActivityAnomalyV1 {
  return {
    id: "anomaly.card_generation:r1",
    kind: "card_generation",
    status: "needs_attention",
    title: "《无标题笔记》的卡片生成",
    detail: "服务端要求你先判断，再继续这次生成",
    occurredAt: new Date(2026, 8, 18, 10, 0).toISOString(),
    target: { kind: "card_generation", id: RUN_ID, noteVersionId: null },
    ...overrides,
  };
}

function activity(overrides: Partial<TodayActivityV1> = {}): TodayActivityV1 {
  return {
    day: "2026-09-18",
    windowStart: new Date(2026, 8, 18, 0, 0).toISOString(),
    windowEnd: new Date(2026, 8, 19, 0, 0).toISOString(),
    generatedAt: new Date(2026, 8, 18, 12, 0).toISOString(),
    events: [],
    anomalies: [],
    truncated: false,
    anomaliesTruncated: false,
    ...overrides,
  };
}

function installApi(result: GatewayResultV1<TodayActivityV1> | Error) {
  const getToday = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      auth: { getState: vi.fn(async () => ok(session())) },
      activity: { getToday },
    },
  });
  return { getToday };
}

/** 「处理这 N 件」靠 scrollIntoView 把读者送到分诊区；这里换成本地 spy 才断言得到。 */
function mockScroll(): { readonly scrollIntoView: ReturnType<typeof vi.fn> } {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  return { scrollIntoView };
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  useRoomStore.setState({ hudPage: "home" });
  vi.restoreAllMocks();
});

describe("today log surface", () => {
  it("answers 'how was today' before showing any list", async () => {
    installApi(ok(activity()));
    render(<StudySurface />);
    // 整天空：判断条说一句话，操作区就地给出口 —— 不再是一张和判断条重复的空态纸。
    expect(await screen.findByText("今天还没有留下记录")).toBeTruthy();
    expect(screen.getByText("今天还没有正向操作")).toBeTruthy();
    expect(screen.getByRole("button", { name: "写笔记" })).toBeTruthy();
    // 0 和 0 不摆成数字：空的一天不给 metrics。
    expect(document.querySelector(".day-verdict__metrics")).toBeNull();
  });

  it("leads with the numbers and only offers the triage jump when something is stuck", async () => {
    const { scrollIntoView } = mockScroll();
    installApi(ok(activity({ events: [event()], anomalies: [anomaly()] })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByText("有事务停在半路，处理完就能继续推进")).toBeTruthy());
    // 数字是判断条的主语，逐格取；"待处理"在判断条与分诊标题里都出现，按 data-metric 定位。
    const metricValue = (key: string) =>
      document.querySelector(`.day-verdict__metric[data-metric="${key}"] dd`)?.textContent;
    expect(metricValue("events")).toBe("1");
    expect(metricValue("pending")).toBe("1");
    // 只有一个时刻就不画区间
    expect(metricValue("span")).toBe("09:05");

    const jump = screen.getByRole("button", { name: /处理这 1 件/ });
    jump.click();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("hides the triage jump when nothing is stuck", async () => {
    installApi(ok(activity({ events: [event()] })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByText("今天的操作都推进得顺利")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /处理这/ })).toBeNull();
  });

  it("shows the failure state and never fabricates local rows", async () => {
    installApi(new Error("gateway down"));
    render(<StudySurface />);
    expect(await screen.findByText("今天的操作日志暂时不可用")).toBeTruthy();
    expect(screen.queryByText("今天还没有留下记录")).toBeNull();
  });

  it("renders anomaly detail in the anomalies-only branch", async () => {
    // 回归：这一支以前复制粘贴自日志分支，把 detail 漏掉了。
    installApi(ok(activity({ anomalies: [anomaly()] })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByText(/的卡片生成/)).toBeTruthy());
    expect(screen.getByText(/服务端要求你先判断/)).toBeTruthy();
    // 只有异常、没有正向操作的那一天必须给出口，不能只给一句散文描述。
    expect(screen.getByText("今天还没有正向操作")).toBeTruthy();
    expect(screen.getByRole("button", { name: "收录来源" })).toBeTruthy();
  });

  it("collapses repeats of the same anomaly and shows how many", async () => {
    installApi(ok(activity({
      anomalies: [
        anomaly(),
        anomaly({ id: "anomaly.card_generation:r2" }),
        anomaly({ id: "anomaly.card_generation:r3" }),
      ],
    })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByText("同一件事 ×3")).toBeTruthy());
    expect(screen.getByText("3 件 · 归并为 1 类")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /去处理/ })).toHaveLength(1);
  });

  it("says the shared step once instead of once per card", async () => {
    installApi(ok(activity({
      anomalies: [
        anomaly(),
        anomaly({ id: "anomaly.card_generation:r2", title: "《间隔重复》的卡片生成" }),
      ],
    })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByText("《间隔重复》的卡片生成")).toBeTruthy());
    // 两组同一句话：组头说一次，两张卡里不再各复读一遍。
    expect(screen.getAllByText(/服务端要求你先判断/)).toHaveLength(1);
  });

  it("collapses the triage past three piles and expands on demand", async () => {
    installApi(ok(activity({
      anomalies: [
        anomaly({ id: "g1", title: "《甲》的卡片生成" }),
        anomaly({ id: "g2", title: "《乙》的卡片生成", detail: "证据对不上" }),
        anomaly({ id: "g3", title: "《丙》的卡片生成", detail: "等待确认" }),
        anomaly({ id: "g4", title: "《丁》的卡片生成", detail: "重试中" }),
      ],
    })));
    render(<StudySurface />);
    const more = await screen.findByRole("button", { name: "还有 1 类待处理" });
    expect(screen.queryByText("《丁》的卡片生成")).toBeNull();
    more.click();
    expect(await screen.findByText("《丁》的卡片生成")).toBeTruthy();
    expect(screen.getByRole("button", { name: "只留最厚的三类" })).toBeTruthy();
  });

  it("gives every jump button a distinct accessible name", async () => {
    installApi(ok(activity({
      events: [
        event(),
        event({ id: "source.created:s1", kind: "source", verb: "source.created", title: "间隔重复论文", target: { kind: "source", id: SOURCE_ID, noteVersionId: null } }),
      ],
    })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByRole("button", { name: "查看 新建笔记 牛顿第二定律" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "查看 收录来源 间隔重复论文" })).toBeTruthy();
  });

  it("renders no jump button when the server could not resolve a target", async () => {
    installApi(ok(activity({ anomalies: [anomaly({ kind: "job", status: "failed", target: null })] })));
    render(<StudySurface />);
    await waitFor(() => expect(screen.getByText(/^失败/)).toBeTruthy());
    // 不给死路，也不装作有地方可去。
    expect(screen.queryByRole("button", { name: /去处理/ })).toBeNull();
    expect(screen.getByText(/没能定位到现场/)).toBeTruthy();
  });

  it("renders a machine-readable timestamp on every log row", async () => {
    installApi(ok(activity({ events: [event()] })));
    render(<StudySurface />);
    const list = await screen.findByRole("list", { name: "今日操作日志" });
    const stamp = within(list).getByText("09:05");
    expect(stamp.getAttribute("datetime")).toBe(new Date(2026, 8, 18, 9, 5).toISOString());
  });
});
