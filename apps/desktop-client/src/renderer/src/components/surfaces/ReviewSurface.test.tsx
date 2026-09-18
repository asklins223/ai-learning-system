// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "../../app/room-store";
import { ReviewSurface } from "./ReviewSurface";
import type { ReviewItem } from "./review-deck";

/**
 * Page 15 reads its whole reason slip out of the queue, so the wiring between
 * the queue and the deck is where a wrong slip or a wrong target hides. These
 * tests hold the two that a pure-function test cannot see: which card a stop in
 * 「后续顺序」 selects, and what the slip says when there is no card at all.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 阅读位置现在活在 store 里（surface 每次导航都会被重挂载），所以一个用例
  // 结束时留下的位置会被下一个用例当成自己的起点。
  useRoomStore.setState({ reviewQueueResume: null });
});

function item(reviewId: string, objectiveId: string, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    version: 2,
    reviewId,
    scheduleId: `${reviewId}-schedule`,
    objectiveId,
    scheduleGeneration: 1,
    dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    startability: { kind: "ready" },
    ...overrides,
  };
}

function objectiveSurface(objectiveId: string, label: string) {
  return {
    objectiveId,
    content: { conceptLabel: label, publicSummary: `${label}的公开摘要`, sourceLabel: null },
    sources: { primaryNote: null },
  };
}

type QueuePage = { version: 2; items: ReviewItem[]; total?: number; nextCursor: string | null };

/**
 * `objective.get` answers for the labels the deck asks for; an id left out of
 * `labels` is rejected, which is the read failure the label fallback covers.
 * `queuePages` (when given) is answered page by page, so a test can watch the
 * queue shrink after a defer.
 */
function stubGateway(
  items: readonly ReviewItem[],
  labels: Record<string, string>,
  queueFailure = false,
  options: {
    readonly queuePages?: readonly QueuePage[];
    /** 用真实游标语义回答翻页：cursor 是已返回条数，nextCursor 指向下一页。 */
    readonly pagedItems?: readonly ReviewItem[];
    readonly pageSize?: number;
    readonly defer?: (input: { meta: unknown; request: { scheduleId: string; scheduleGeneration: number; deferredUntil: string; reasonCode: string } }) => Promise<unknown>;
  } = {},
) {
  const queueResult = queueFailure
    ? { ok: false as const, error: { code: "api_unavailable" as const, safeMessageKey: "error.api_unavailable", retry: "user_action" as const } }
    : { ok: true as const, workspaceEpoch: 1, data: { version: 2 as const, items: [...items], total: items.length, nextCursor: null } };

  const gateway = {
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "workspace-1" } },
      })),
    },
    review: {
      getQueue: vi.fn(async (input?: { cursor?: string; limit?: number }) => {
        if (options.pagedItems) {
          const all = options.pagedItems;
          const size = options.pageSize ?? 20;
          const start = input?.cursor ? Number(input.cursor) : 0;
          const page = all.slice(start, start + size);
          const next = start + size < all.length ? String(start + size) : null;
          return {
            ok: true as const,
            workspaceEpoch: 1,
            data: { version: 2 as const, items: [...page], total: all.length, nextCursor: next },
          };
        }
        if (!options.queuePages) return queueResult;
        const page = options.queuePages[Math.min(gateway.review.getQueue.mock.calls.length - 1, options.queuePages.length - 1)];
        return { ok: true as const, workspaceEpoch: 1, data: { total: page.items.length, ...page } };
      }),
      defer: vi.fn(options.defer ?? (async (input: { request: { scheduleId: string; scheduleGeneration: number } }) => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          version: 2 as const,
          scheduleId: input.request.scheduleId,
          scheduleGeneration: input.request.scheduleGeneration,
          userDeferredUntil: new Date(Date.now() + 86_400_000).toISOString(),
          officialNextReviewAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      }))),
    },
    objective: {
      get: vi.fn(async ({ objectiveId }: { objectiveId: string }) => {
        const label = labels[objectiveId];
        if (!label) throw new Error("objective read failed");
        return { ok: true as const, data: objectiveSurface(objectiveId, label) };
      }),
    },
    learningRun: { start: vi.fn() },
  };

  window.ailearn = gateway as unknown as typeof window.ailearn;
  return gateway;
}

const THREE = [
  item("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "objective-a"),
  item("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "objective-b"),
  item("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "objective-c"),
];
const THREE_LABELS = { "objective-b": "间隔效应", "objective-c": "认知负荷" };

describe("ReviewSurface · 后续顺序", () => {
  it("selects the card its label names, not the card that happens to sit at that index", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    // objective-a publishes no label, so 间隔效应 is the second queue item — the
    // step the old wiring paired with the first labelled stop.
    const stop = await screen.findByRole("button", { name: "滑到「间隔效应」" });
    fireEvent.click(stop);

    await waitFor(() => {
      expect(screen.getByRole("group", { name: "复习队列卡叠" }).getAttribute("data-review-id"))
        .toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    });
  });
});

describe("ReviewSurface · deck stepping", () => {
  it("steps the loaded window with the pointer and stops at both ends", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));

    expect((screen.getByRole("button", { name: "上一张到期项" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "下一张到期项" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect((screen.getByRole("button", { name: "上一张到期项" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    expect((screen.getByRole("button", { name: "下一张到期项" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "上一张到期项" }));
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  });

  it("steps the deck with the arrow keys and stops at the front", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    // 队首往回按：什么也不该发生，也不该把焦点丢给别的控件。
    fireEvent.keyDown(deck, { key: "ArrowLeft" });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId);

    fireEvent.keyDown(deck, { key: "ArrowRight" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));

    fireEvent.keyDown(deck, { key: "ArrowLeft" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));
  });

  it("counts a held arrow key once instead of once per repeat", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    // 系统按住不放会以约 30 次/秒重复派发 keydown；只有第一次算一次移动。
    fireEvent.keyDown(deck, { key: "ArrowRight" });
    for (let repeat = 0; repeat < 8; repeat += 1) {
      fireEvent.keyDown(deck, { key: "ArrowRight", repeat: true });
    }

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId);
  });

  it("reads the next page when the arrow key runs off the loaded tail", async () => {
    const items = manyItems(25);
    const gateway = stubGateway([], {}, false, { pagedItems: items, pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[0].reviewId));

    for (let step = 0; step < 19; step += 1) {
      fireEvent.keyDown(deck, { key: "ArrowRight" });
    }
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[19].reviewId));

    fireEvent.keyDown(deck, { key: "ArrowRight" });

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[20].reviewId));
    expect(gateway.review.getQueue.mock.calls.length).toBe(2);
  });

  it("offers no stepping controls when the window holds one card", async () => {
    stubGateway([THREE[0]], {});
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));

    expect(screen.queryByRole("button", { name: "上一张到期项" })).toBeNull();
    expect(screen.queryByRole("button", { name: "下一张到期项" })).toBeNull();
  });
});

describe("ReviewSurface · 牌堆", () => {
  /**
   * 一次横向手势。jsdom 没有 PointerEvent，也不认 fireEvent.pointerDown 的坐标，
   * 所以这里直接派发同名的 MouseEvent —— React 按事件名接，clientX 是真的。
   */
  function movePointer(deck: HTMLElement, type: string, clientX: number) {
    fireEvent(deck, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 200 }));
  }

  function drag(deck: HTMLElement, dx: number, moves = 6) {
    movePointer(deck, "pointerdown", 400);
    for (let step = 1; step <= moves; step += 1) movePointer(deck, "pointermove", 400 + (dx * step) / moves);
    movePointer(deck, "pointerup", 400 + dx);
  }

  it("stacks the loaded window by depth and exposes only the top card", async () => {
    stubGateway(manyItems(6), Object.fromEntries(manyItems(6).map((entry, index) => [entry.objectiveId, `目标 ${index + 1}`])));
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000001-1111-4111-8111-111111111111"));

    const cards = deck.querySelectorAll(".deck-card");
    expect(cards).toHaveLength(6);
    // 一张在最上面，其余按深度码在下面：位置由 data-depth 决定。
    expect(deck.querySelectorAll('.deck-card[data-depth="0"]')).toHaveLength(1);
    expect([...cards].map((card) => card.getAttribute("data-depth")))
      .toEqual(["0", "1", "2", "3", "4", "5"]);
    // 只有最上面那张能被读到：重复的标题与 id 会把读屏用户带进第二次朗读。
    expect(deck.querySelectorAll(".deck-card.front")).toHaveLength(1);
    expect(cards[0].getAttribute("aria-hidden")).toBeNull();
    expect(cards[1].getAttribute("aria-hidden")).toBe("true");
    expect(within(deck as HTMLElement).getAllByRole("heading", { level: 2 })).toHaveLength(1);
  });

  it("keeps the previous card in the window so a draw back has a card to return", async () => {
    stubGateway(manyItems(20), {});
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000001-1111-4111-8111-111111111111"));

    fireEvent.keyDown(deck, { key: "ArrowRight" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000002-1111-4111-8111-111111111111"));

    // 抽走的那张还在场（depth -1），只是位姿是"已经抽出去"的那一档。
    const drawn = deck.querySelector('.deck-card[data-depth="-1"]');
    expect(drawn).not.toBeNull();
    expect(drawn?.getAttribute("data-drawn")).toBe("true");
    expect(drawn?.getAttribute("aria-hidden")).toBe("true");
  });

  it("draws the next card when the top one is dragged off the pile", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    drag(deck, -220);

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
    expect(deck.getAttribute("data-deck-dragging")).toBeNull();
  });

  it("puts the card back on the pile when the drag was only a tap", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    fireEvent(deck, new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 400, clientY: 200 }));
    fireEvent(deck, new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 402, clientY: 200 }));
    fireEvent(deck, new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 402, clientY: 200 }));

    // 按在牌上抖一下算点击，不算抽牌。
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId);
    expect(deck.getAttribute("data-deck-dragging")).toBeNull();
  });

  it("puts the card back when the drag stops short of the draw threshold", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    // 40% 牌宽（jsdom 里用兜底牌宽 520 → 208px）之外才算抽出去，这里只拖 80px，
    // 而且拖得慢（每次移动 20px / 60ms = 0.33px/ms，够不上甩牌的 0.35）。
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    movePointer(deck, "pointerdown", 400);
    for (let step = 1; step <= 4; step += 1) {
      clock += 60;
      movePointer(deck, "pointermove", 400 - step * 20);
    }
    movePointer(deck, "pointerup", 320);

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId);
  });

  it("brings a card peeking under the pile forward when the reader clicks it", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    fireEvent.click(deck.querySelector('.deck-card[data-depth="1"]') as HTMLElement);

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
  });

  it("does not treat the tail of a drag as a click on the card underneath", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    const underneath = deck.querySelector('.deck-card[data-depth="1"]') as HTMLElement;
    drag(deck, -220, 4);
    // 拖拽之后浏览器会在这张牌上补一次 click：它属于手势，不该再抽一张。
    fireEvent.click(underneath);

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId);
  });

  it("reads the next page when the pile is drawn past its last loaded card", async () => {
    const items = manyItems(25);
    stubGateway([], {}, false, { pagedItems: items, pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[0].reviewId));

    for (let step = 0; step < 19; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    }
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[19].reviewId));

    drag(deck, -260, 3);

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[20].reviewId));
    expect(screen.getByText(/已载入 25 \/ 25 项/)).toBeTruthy();
  });

  /**
   * 阻尼问的是"松手会不会前进"，不是"下面有没有已经载入的牌"。已载入的末尾但
   * 服务端还有下一页时，松手会顺势读进来再抽走 —— 那一路就该 1:1 跟手，否则
   * 读者会先感到一段莫名的阻尼（拖不动、像被截住）。
   */
  it("follows the pointer at the loaded tail while the server still has more", async () => {
    const items = manyItems(25);
    stubGateway([], {}, false, { pagedItems: items, pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[0].reviewId));

    for (let step = 0; step < 19; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    }
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[19].reviewId));

    movePointer(deck, "pointerdown", 400);
    movePointer(deck, "pointermove", 360);

    // 40px 就是 40px：末尾这一张是"还能往前走"的，不该被压成 40 × 0.35。
    expect(deck.style.getPropertyValue("--deck-drag-x")).toBe("-40px");
    movePointer(deck, "pointerup", 360);
  });

  it("will not draw past the top of the queue", async () => {
    stubGateway([], {}, false, { pagedItems: manyItems(6), pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000001-1111-4111-8111-111111111111"));

    // 队首往回拖：牌堆上面没有牌了，牌自己滑回堆上。
    drag(deck, 260);

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(deck.getAttribute("data-review-id")).toBe("00000001-1111-4111-8111-111111111111");
  });

  it("draws back the card that was drawn away", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    drag(deck, -220);
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));

    drag(deck, 220);
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));
  });

  /**
   * 手势的收束口挂在 window 上，而不是只挂在卡叠自己身上：抬手落在卡叠外面时，
   * pointerup 的目标是别的元素，卡叠根本不在传播路径上。只等卡叠那一个事件，
   * 卡就会停在半路继续跟着手 —— 读者松手了它不放（"粘手"）。
   */
  it("ends the drag when the pointer comes up outside the card stack", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    movePointer(deck, "pointerdown", 400);
    for (let step = 1; step <= 4; step += 1) movePointer(deck, "pointermove", 400 - step * 55);
    // 抬手落在理由条那一边：事件不经过卡叠。
    fireEvent(document.querySelector(".queue-reason") as HTMLElement, new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 180, clientY: 200 }));

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
    expect(deck.getAttribute("data-deck-dragging")).toBeNull();
  });

  it("puts the card back and stops following the pointer when the gesture is cancelled", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    movePointer(deck, "pointerdown", 400);
    for (let step = 1; step <= 4; step += 1) movePointer(deck, "pointermove", 400 - step * 55);
    expect(deck.getAttribute("data-deck-dragging")).toBe("true");

    // 浏览器撤销这次指针（原生拖拽、系统手势）：撤销不是"抽走"。
    fireEvent(window, new MouseEvent("pointercancel", { bubbles: true, cancelable: true, button: 0, clientX: 180, clientY: 200 }));

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(deck.getAttribute("data-deck-dragging")).toBeNull();
    expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId);
  });

  it("stops following the pointer when the window loses focus mid-drag", async () => {
    stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    movePointer(deck, "pointerdown", 400);
    for (let step = 1; step <= 4; step += 1) movePointer(deck, "pointermove", 400 - step * 55);
    expect(deck.getAttribute("data-deck-dragging")).toBe("true");

    fireEvent(window, new Event("blur"));

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(deck.getAttribute("data-deck-dragging")).toBeNull();
    expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId);
  });
});

describe("ReviewSurface · card state", () => {
  it("names a blocked card's own state on the card", async () => {
    stubGateway(
      [item("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "objective-a", { startability: { kind: "blocked", reason: "cooldown" } })],
      { "objective-a": "反馈设计" },
    );
    render(<ReviewSurface />);

    // 先等卡面本身：紧凑索引里也会写「冷却中」，所以状态文案不能再用来判断
    // 卡叠已经渲染完成。
    expect(await screen.findByRole("button", { name: /刷新开始条件/ })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "复习队列卡叠" })).getByText("冷却中")).toBeTruthy();
  });

  it("says the label is unreadable instead of claiming the read is still running", async () => {
    stubGateway(THREE, {});
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    // 邻居卡也写着同一句话（它们同样读不到标签），所以只断言正面那张。
    await waitFor(() => expect(deck.querySelector(".deck-card.front h2")?.textContent)
      .toBe("这张卡的理解目标暂时读不到标签"));
    expect(within(deck as HTMLElement).queryByText("正在读取这张卡的问题…")).toBeNull();
  });
});

describe("ReviewSurface · slip with no card", () => {
  it("never reports a failed read as an empty day", async () => {
    stubGateway([], {}, true);
    render(<ReviewSurface />);

    expect(await screen.findByText("这一页没有读到真实的到期队列，因此不给理由。")).toBeTruthy();
    expect(screen.queryByText("今天没有到期项，理由条也随之留空。")).toBeNull();
  });

  it("still reports a genuinely empty queue as an empty day", async () => {
    stubGateway([], {});
    render(<ReviewSurface />);

    expect(await screen.findByText("今天没有到期项，理由条也随之留空。")).toBeTruthy();
  });
});

describe("ReviewSurface · 稍后提醒", () => {
  it("disables the whole action row while a request is in flight", async () => {
    stubGateway(THREE, THREE_LABELS, false, {
      // A defer that never settles holds the busy flag for observation.
      defer: () => new Promise(() => {}),
    });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "正在延后…" })).toBeTruthy());

    expect((screen.getByRole("button", { name: /开始复习/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "查看来源" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("defers the front card, refetches the queue, and says the due date did not move", async () => {
    const gateway = stubGateway(THREE, THREE_LABELS, false, {
      queuePages: [
        { version: 2, items: [THREE[0], THREE[1]], nextCursor: null },
        { version: 2, items: [THREE[1]], nextCursor: null },
      ],
    });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));

    await waitFor(() => expect(gateway.review.defer).toHaveBeenCalledTimes(1));
    const deferRequest = gateway.review.defer.mock.calls[0][0].request;
    expect(deferRequest.scheduleId).toBe(THREE[0].scheduleId);
    expect(deferRequest.scheduleGeneration).toBe(1);
    expect(deferRequest.reasonCode).toBe("user_requested");
    expect(new Date(deferRequest.deferredUntil).valueOf()).toBeGreaterThan(Date.now());

    await waitFor(() => expect(gateway.review.getQueue.mock.calls.length).toBe(2));
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
    expect(await screen.findByText("已把这张卡推迟到明天再提醒；它的到期时间没有变。")).toBeTruthy();
  });

  it("treats a stale defer as a queue refresh instead of a dead end", async () => {
    const gateway = stubGateway(THREE, THREE_LABELS, false, {
      queuePages: [
        { version: 2, items: [THREE[0], THREE[1]], nextCursor: null },
        { version: 2, items: [THREE[1]], nextCursor: null },
      ],
      defer: async () => ({
        ok: false as const,
        error: { code: "conflict" as const, safeMessageKey: "error.conflict", retry: "user_action" as const },
      }),
    });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));

    expect(await screen.findByText("这张卡的状态刚发生过变化，队列已按服务端现状刷新。")).toBeTruthy();
    await waitFor(() => expect(gateway.review.getQueue.mock.calls.length).toBe(2));
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[1].reviewId));
  });

  it("keeps the card in the queue when the defer does not reach the server", async () => {
    const gateway = stubGateway(THREE, THREE_LABELS, false, {
      defer: async () => ({
        ok: false as const,
        error: { code: "api_unavailable" as const, safeMessageKey: "error.api_unavailable", retry: "user_action" as const },
      }),
    });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId));

    fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));

    expect(await screen.findByText("延后没有送达服务端，这张卡仍在队列里。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试延后" })).toBeTruthy();
    // No refetch: the queue the user sees is still the one that holds this card.
    expect(gateway.review.getQueue.mock.calls.length).toBe(1);
    expect(deck.getAttribute("data-review-id")).toBe(THREE[0].reviewId);
  });

  it("silently refetches the queue when the window becomes visible again", async () => {
    const gateway = stubGateway(THREE, THREE_LABELS);
    render(<ReviewSurface />);

    await screen.findByRole("group", { name: "复习队列卡叠" });
    expect(gateway.review.getQueue).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(gateway.review.getQueue).toHaveBeenCalledTimes(2));
  });
});

/**
 * 队列长了以后页面要回答的三个问题：翻页会不会把读者弹回队首、到底了还能不能
 * 往前走、离开页面再回来还在不在原来的位置。三者都只靠「读数 + 位置」实现，
 * 所以游标由 stub 按真实语义（cursor = 已返回条数）发放。
 */
function manyItems(count: number): ReviewItem[] {
  return Array.from({ length: count }, (_, index) => item(
    `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    `objective-${index + 1}`,
  ));
}

describe("ReviewSurface · 多数据场景", () => {
  it("keeps the loaded pages and the selected card when the window regains focus", async () => {
    const items = manyItems(45);
    const gateway = stubGateway([], {}, false, { pagedItems: items, pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[0].reviewId));

    fireEvent.click(screen.getByRole("button", { name: "继续读取更多到期项" }));
    await waitFor(() => expect(screen.getByText(/已载入 40 \/ 45 项/)).toBeTruthy());

    // 走到第二页里的第 25 张。
    for (let step = 0; step < 24; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    }
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[24].reviewId));

    window.dispatchEvent(new Event("focus"));

    // 静默重读跟着选中位置走：读者脚下的第 25 张还在，翻过的页也还在。
    await waitFor(() => expect(screen.getByText(/已载入 40 \/ 45 项/)).toBeTruthy());
    expect(deck.getAttribute("data-review-id")).toBe(items[24].reviewId);
    expect(gateway.review.getQueue.mock.calls.length).toBeGreaterThan(2);
  });

  it("reads the next page instead of dead-ending on the last loaded card", async () => {
    const items = manyItems(25);
    const gateway = stubGateway([], {}, false, { pagedItems: items, pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[0].reviewId));

    // 第一页的最后一张：这里旧实现会把「下一张」变成死按钮。
    for (let step = 0; step < 19; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    }
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[19].reviewId));

    fireEvent.click(screen.getByRole("button", { name: "读取下一张到期项" }));

    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe(items[20].reviewId));
    expect(gateway.review.getQueue.mock.calls.length).toBe(2);
  });

  it("counts the position against the server total, not the loaded page", async () => {
    stubGateway([], {}, false, { pagedItems: manyItems(137), pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    // 位置行读正面那张的 meta；sr-only 的 live region 会重复同一句话给读屏用户。
    await waitFor(() => expect(deck.querySelector(".deck-card.front .meta")?.textContent)
      .toContain("第 1 张 / 共 137 张"));
    expect(screen.getByText(/已载入 20 \/ 137 项/)).toBeTruthy();
  });

  it("shows the reader's position and how much of the queue is loaded", async () => {
    stubGateway([], {}, false, { pagedItems: manyItems(137), pageSize: 20 });
    render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000001-1111-4111-8111-111111111111"));

    // 进度条按"整条队列"给比例，不是按已载入的那 20 张：第 1 张就该是一点点。
    const bar = deck.querySelector(".deck-progress__bar") as HTMLElement;
    const loaded = deck.querySelector(".deck-progress__loaded") as HTMLElement;
    expect(bar.style.transform).toBe(`scaleX(${1 / 137})`);
    expect(loaded.style.transform).toBe(`scaleX(${20 / 137})`);
  });

  it("restores the reading position after the surface is remounted", async () => {
    stubGateway([], {}, false, { pagedItems: manyItems(25), pageSize: 20 });
    const first = render(<ReviewSurface />);

    const deck = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000001-1111-4111-8111-111111111111"));
    fireEvent.click(screen.getByRole("button", { name: "继续读取更多到期项" }));
    await waitFor(() => expect(screen.getByText(/已载入 25 \/ 25 项/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    fireEvent.click(screen.getByRole("button", { name: "下一张到期项" }));
    await waitFor(() => expect(deck.getAttribute("data-review-id")).toBe("00000003-1111-4111-8111-111111111111"));

    first.unmount();
    render(<ReviewSurface />);

    const restored = await screen.findByRole("group", { name: "复习队列卡叠" });
    await waitFor(() => expect(restored.getAttribute("data-review-id")).toBe("00000003-1111-4111-8111-111111111111"));
  });
});
