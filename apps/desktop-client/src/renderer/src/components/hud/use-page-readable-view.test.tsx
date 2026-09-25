// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { useRoomStore } from "../../app/room-store";
import { usePageReadableView } from "./use-page-readable-view";

/**
 * `usePageReadableView` 自己那条"按内容留住身份"的规矩（39d W2-7 加在设置中心那一页上）。
 *
 * 要挡的事故：调用方每次渲染都交一个新对象（内容相同），effect 就每次都重跑，
 * 于是 `retract`→`publish` 成对地翻槽位；会话侧 `companion-chat-session.tsx:581`
 * 订阅的就是这一格，它会把每一次翻转都当成一次新的桥推送。
 * store 那层的短路认得出内容没变，但认不出"调用方这边白折腾了一趟"。
 */
function Probe({ view }: { readonly view: PageReadableV1 }) {
  usePageReadableView(view);
  return null;
}

function view(title: string): PageReadableV1 {
  return { pageId: "settings", title, statusLine: "正在读取设置", items: [{ ordinal: 1, label: "一行" }] };
}

type Slot = { readonly token: string; readonly view: PageReadableV1 } | null;

let flips: Slot[] = [];

beforeEach(() => {
  flips = [];
  useRoomStore.setState({ pageReadableView: null });
});

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("可读视图按内容留住身份（W2-7）", () => {
  it("内容相同的一次重渲染，不该把槽位翻成 null 再填回来", () => {
    const { rerender } = render(<Probe view={view("设置中心")} />);
    const published = useRoomStore.getState().pageReadableView;
    expect(published?.view.title).toBe("设置中心");

    const unsubscribe = useRoomStore.subscribe((state) => flips.push(state.pageReadableView));
    // 新对象、同内容：这是"调用方没 memo"的那一种渲染。
    rerender(<Probe view={{ ...view("设置中心") }} />);
    unsubscribe();

    expect(flips, `这一趟重渲染翻了 ${flips.filter((entry) => entry === null).length} 次槽位`).toEqual([]);
    expect(useRoomStore.getState().pageReadableView?.view).toBe(published?.view);
  });

  it("内容真的变了才重发：同一格不许留着上一轮的读数", () => {
    const { rerender } = render(<Probe view={view("设置中心")} />);
    const before = useRoomStore.getState().pageReadableView;

    rerender(<Probe view={view("账户与空间")} />);
    const after = useRoomStore.getState().pageReadableView;

    expect(after).not.toBe(before);
    expect(after?.view.title).toBe("账户与空间");
    // token 不变：换内容是同一格在更新，不是另一屏接管。
    expect(after?.token).toBe(before?.token);
    cleanup();
  });

  it("正控制：不做内容比对时，第一趟重渲染就会翻槽位", () => {
    // 这条自证用的是**手写**的 effect 形状（去掉那层比对），不依赖真实实现以后会不会改。
    const token = crypto.randomUUID();
    const first = view("设置中心");
    useRoomStore.getState().publishPageReadableView(token, first);
    const flipsWhileUnstabilised: Slot[] = [];
    const unsubscribe = useRoomStore.subscribe((state) => flipsWhileUnstabilised.push(state.pageReadableView));
    useRoomStore.getState().retractPageReadableView(token);
    useRoomStore.getState().publishPageReadableView(token, { ...first });
    unsubscribe();

    expect(flipsWhileUnstabilised).toEqual([null, expect.objectContaining({ view: first })]);
  });
});
