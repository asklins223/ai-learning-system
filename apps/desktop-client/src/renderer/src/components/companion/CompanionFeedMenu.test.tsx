// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionFeedMenu } from "./CompanionFeedMenu";
import {
  COMPANION_FEED_MAX_CHARS,
  subscribeCompanionFeed,
} from "./companion-feed";

beforeEach(() => {
  document.body.insertAdjacentHTML("beforeend", '<div class="companion-hud"></div>');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** 让 `window.getSelection()` 报告一段选区（jsdom 里没法真选）。 */
function selectText(text: string): void {
  vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => text } as Selection);
}

/**
 * 返回"这次右键有没有被我们接管"。
 *
 * 不用 `fireEvent.contextMenu(...).defaultPrevented`：RTL 的 `fireEvent` 返回的是
 * 「事件未被取消」这个布尔，读它身上的 `defaultPrevented` 只会拿到 `undefined`，
 * 看起来像"组件没反应"，其实是我读错了探针自己的返回值。
 */
function rightClick(target: HTMLElement = document.body): boolean {
  const event = new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 220, clientY: 260,
  });
  // 必须包在 `act` 里：裸 `dispatchEvent` 不会冲 React 的更新队列，
  // 组件的 `setMenu` 停在待办里，测试就会看到"菜单没出现"的假失败。
  act(() => {
    target.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

describe("CompanionFeedMenu（划选投喂的右键浮层）", () => {
  it("没有选区时不接管右键：系统菜单照旧，也不长出浮层", () => {
    selectText("   ");
    render(<CompanionFeedMenu />);

    expect(rightClick()).toBe(false);
    expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull();
  });

  it("有选区时接管，点「丢给伴星」把内容送到事件总线上", () => {
    selectText("这一段是笔记里的原文");
    const fed: string[] = [];
    let opened = 0;
    // 用消费端那个订阅口而不是裸 addEventListener：它才返回退订函数，
    // 而且顺带验了"投喂 + 开抽屉"两个事件是成对发的（只收到一个就是总线断了）。
    const off = subscribeCompanionFeed({
      onFeed: (selection) => { fed.push(selection.text); },
      onOpenChat: () => { opened += 1; },
    });
    render(<CompanionFeedMenu />);

    expect(rightClick()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /丢给伴星/ }));
    expect(fed).toEqual(["这一段是笔记里的原文"]);
    expect(opened).toBe(1);
    off();
  });

  it("计数按「用户选了多少」说，超上限时明说只送前一段", () => {
    const long = "字".repeat(COMPANION_FEED_MAX_CHARS + 500);
    selectText(long);
    render(<CompanionFeedMenu />);
    rightClick();

    const count = screen.getByText(`已选 ${long.length} 字，只送前 ${COMPANION_FEED_MAX_CHARS} 字`);
    expect(count).toBeTruthy();
    // 反面对照：以前的写法只存截断后的文本，读数永远是"正好装满"。
    expect(screen.queryByText(`${COMPANION_FEED_MAX_CHARS}/${COMPANION_FEED_MAX_CHARS}`)).toBeNull();
  });

  it("没超上限时计数是普通的 x/2000，不吓唬人", () => {
    selectText("短句");
    render(<CompanionFeedMenu />);
    rightClick();
    expect(screen.getByText(`2/${COMPANION_FEED_MAX_CHARS}`)).toBeTruthy();
  });

  it("Esc 能把浮层收掉（鼠标打开的东西也该有不碰鼠标就关掉的出口）", async () => {
    selectText("要投喂的一段");
    render(<CompanionFeedMenu />);
    rightClick();
    expect(screen.getByRole("group", { name: "划选文本操作" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull());
  });

  it("编辑器保留原生右键，伴星缺席时不接管选区", () => {
    selectText("笔记原文");
    render(<CompanionFeedMenu />);
    const editor = document.createElement("textarea");
    document.body.append(editor);
    expect(rightClick(editor)).toBe(false);
    document.querySelector(".companion-hud")?.remove();
    expect(rightClick()).toBe(false);
    expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull();
  });

  it("采集栏的文字拖放归采集栏；空白处的文字拖放只投喂一次", () => {
    const fed: string[] = [];
    const off = subscribeCompanionFeed({ onFeed: (selection) => fed.push(selection.text), onOpenChat: () => undefined });
    render(<CompanionFeedMenu />);
    const slot = document.createElement("div");
    slot.className = "capture-strip";
    document.body.append(slot);
    const drop = (target: HTMLElement, claimed = false) => {
      const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { getData: () => "拖入的一段话" } });
      if (claimed) event.preventDefault();
      act(() => { target.dispatchEvent(event); });
      return event;
    };
    expect(drop(slot).defaultPrevented).toBe(false);
    expect(drop(document.body, true).defaultPrevented).toBe(true);
    expect(fed).toEqual([]);
    expect(drop(document.body).defaultPrevented).toBe(true);
    expect(fed).toEqual(["拖入的一段话"]);
    off();
  });

  it("右键浮层保留复制出口，复制完整选区而不是投喂用的截断文本", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const selected = "内容".repeat(COMPANION_FEED_MAX_CHARS);
    selectText(selected);
    render(<CompanionFeedMenu />);
    rightClick();
    fireEvent.click(screen.getByRole("button", { name: "复制选中内容" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(selected));
    await waitFor(() => expect(screen.queryByRole("group", { name: "划选文本操作" })).toBeNull());
  });
});
