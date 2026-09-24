// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";
import { CompanionChatProvider } from "./companion-chat-session";
import { useRoomStore } from "./room-store";

/**
 * 页面可读视图 → bridge context 的那一段（doc 37 根因第 2 条）。
 *
 * 事故形状：`generating` 这一页在合同的 5 个 pageKind 里根本没有对应项，渲染层
 * 于是连"我在哪页"都不发；更关键的是**推送的 memo 依赖里只有 id 类字段**，
 * 所以"已写出 3/4"变成"4/4"根本不会触发第二次 publish。
 * 前者靠 `bridgePageContext` 的用例钉，后者只能靠真的挂一次 Provider 来钉——
 * 因此这里挂的是 Provider 本体，不是它里面某个纯函数。
 */

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

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
    version: 1, ok: true, data,
    requestId: "bridge-view-test",
    correlationId: "bridge-view-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function viewWith(detail: string): PageReadableV1 {
  return {
    pageId: "card_generation_progress",
    title: "把《IndexTTS 2.5》整理成学习卡",
    metrics: [{ label: "进度", value: detail }],
    items: [{ ordinal: 1, label: "提取线索" }],
  };
}

let setContext: ReturnType<typeof vi.fn>;
let clearContext: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setContext = vi.fn(async () => ok({ enabled: true, published: true, snapshot: null }));
  clearContext = vi.fn(async () => ok({ enabled: true, published: false, snapshot: null }));
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      auth: { getState: vi.fn(async () => ok(session())) },
      companion: {
        bridge: { setContext, clearContext },
        chat: {
          listConversations: vi.fn(async () => ok({ items: [], total: 0 })),
          listMessages: vi.fn(async () => ok({ items: [], total: 0 })),
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ hudPage: "home", pageReadableView: null });
});

function publishedPages(): Array<Record<string, unknown>> {
  return setContext.mock.calls.map((call) => (call[0] as { page: Record<string, unknown> }).page);
}

describe("可读视图跟着屏幕一起进 bridge context", () => {
  it("生成中这一页带着视图发布（此前这一页连 pageKind 都不发）", async () => {
    useRoomStore.setState({
      hudPage: "generating",
      activeNoteRef: { noteId: "33333333-3333-4333-8333-333333333333", noteVersionId: null },
      pageReadableView: { token: "t-1", view: viewWith("已写出 3 / 4 张候选") },
    });
    render(<CompanionChatProvider><span /></CompanionChatProvider>);

    await waitFor(() => expect(setContext).toHaveBeenCalled());
    const page = publishedPages().at(-1)!;
    expect(page.readableView).toEqual(viewWith("已写出 3 / 4 张候选"));
    // 生成中这一页在 interactionState 上一直是 processing——它此前只是没人读。
    expect(page.interactionState).toBe("processing");
  });

  it("计数器从 3/4 走到 4/4 会再发一次 publish（memo 依赖漏掉视图就是这里红）", async () => {
    useRoomStore.setState({
      hudPage: "generating",
      activeNoteRef: { noteId: "33333333-3333-4333-8333-333333333333", noteVersionId: null },
      pageReadableView: { token: "t-1", view: viewWith("已写出 3 / 4 张候选") },
    });
    const { rerender } = render(<CompanionChatProvider><span /></CompanionChatProvider>);
    await waitFor(() => expect(setContext).toHaveBeenCalledTimes(1));

    // 只改视图里的数字，页面 id / run id 一个都不动。
    useRoomStore.setState({ pageReadableView: { token: "t-1", view: viewWith("已写出 4 / 4 张候选") } });
    rerender(<CompanionChatProvider><span /></CompanionChatProvider>);

    await waitFor(() => expect(setContext).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect((publishedPages().at(-1)!.readableView as PageReadableV1).metrics?.[0].value)
      .toBe("已写出 4 / 4 张候选");
  });

  it("凭证页不带上任何可读内容", async () => {
    useRoomStore.setState({
      hudPage: "login",
      pageReadableView: { token: "t-1", view: viewWith("已写出 3 / 4 张候选") },
    });
    render(<CompanionChatProvider><span /></CompanionChatProvider>);

    await waitFor(() => expect(setContext).toHaveBeenCalled());
    const page = publishedPages().at(-1)!;
    expect(page.sensitivity).toBe("credential_surface");
    expect(page.readableView).toBeUndefined();
  });
});
