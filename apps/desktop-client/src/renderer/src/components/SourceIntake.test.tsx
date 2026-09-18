// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardLinkPrompt, GlobalDropOverlay } from "./SourceIntake";
import { SOURCE_CAPTURED_EVENT, type SourceCapturedDetail } from "../app/source-intake";
import { useRoomStore } from "../app/room-store";

/**
 * 跨页面收录的合同：
 * - 弹窗确认后走 source.create（url 原样），成功广播收录事件，不强制跳页面；
 * - 没有采集权限时主键禁用并说清原因，不发请求；
 * - 全局拖入文本文件自动收进来源库，报告里点名每份的去向。
 */

const TEST_URL = "https://example.com/deep-dive";

function stubDialog() {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  if (typeof proto.showModal === "function") {
    vi.spyOn(proto, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
  } else {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof proto.close === "function") {
    vi.spyOn(proto, "close").mockImplementation(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  } else {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
}

function stubGateway(options: { capture?: "allowed" | "denied"; createTitle?: string } = {}) {
  const calls = { create: [] as unknown[] };
  const gateway = {
    capabilities: {
      get: async () => ({
        ok: true,
        data: { actionCapabilities: { "source.create": options.capture ?? "allowed" } },
      }),
    },
    source: {
      create: async (input: unknown) => {
        calls.create.push(input);
        return {
          ok: true,
          data: { source: { id: "source-1", title: options.createTitle ?? "深潜" } },
        };
      },
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return calls;
}

beforeEach(() => {
  stubDialog();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ surface: null });
});

describe("ClipboardLinkPrompt", () => {
  it("确认后用原链接创建来源并广播，留在原地不跳页", async () => {
    const calls = stubGateway();
    const seen: boolean[] = [];
    const captured: SourceCapturedDetail[] = [];
    const onCaptured = (event: Event) => captured.push((event as CustomEvent<SourceCapturedDetail>).detail);
    window.addEventListener(SOURCE_CAPTURED_EVENT, onCaptured);
    try {
      render(<ClipboardLinkPrompt url={TEST_URL} onClose={(value) => seen.push(value)} />);
      const primary = await screen.findByRole("button", { name: "开始解析" });
      expect(primary).toBeTruthy();
      fireEvent.click(primary);
      await screen.findByText("已经收下啦");
      expect(calls.create).toHaveLength(1);
      expect(calls.create[0]).toMatchObject({ request: { url: TEST_URL } });
      expect(captured).toEqual([{ sourceId: "source-1", title: "深潜" }]);
      // 成功态不强制导航：用户点"好"才关，之前一直在原页面。
      expect(useRoomStore.getState().surface).toBeNull();
      expect(seen).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "好" }));
      expect(seen).toEqual([true]);
    } finally {
      window.removeEventListener(SOURCE_CAPTURED_EVENT, onCaptured);
    }
  });

  it("没有采集权限时主键禁用并说清原因", async () => {
    const calls = stubGateway({ capture: "denied" });
    render(<ClipboardLinkPrompt url={TEST_URL} onClose={() => undefined} />);
    await screen.findByText("只有工作区所有者可以采集来源，这条链接先不收。");
    expect((screen.getByRole("button", { name: "开始解析" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.create).toHaveLength(0);
  });
});

describe("GlobalDropOverlay", () => {
  it("拖入文本文件自动收进来源库并点名报告", async () => {
    const calls = stubGateway({ createTitle: "拖入的笔记" });
    render(<GlobalDropOverlay />);
    const file = new File(["# 拖入的正文"], "note.md", { type: "text/markdown" });
    // jsdom 的 File 没有可用的 text()，桩掉实例方法；读失败分支由组件内的
    // try/catch 覆盖，这里只验证"读出 → 创建 → 报告"的 happy path。
    Object.defineProperty(file, "text", { value: async () => "# 拖入的正文" });
    const transfer = {
      files: [file],
      types: ["Files"],
      getData: () => "",
      dropEffect: "none" as const,
    };
    fireEvent.dragEnter(document.body, { dataTransfer: transfer });
    expect(await screen.findByText("松开，收进来源库")).toBeTruthy();
    fireEvent.drop(document.body, { dataTransfer: transfer });
    await screen.findByText("收好了");
    expect(screen.getByText("note.md")).toBeTruthy();
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]).toMatchObject({ request: { content: "# 拖入的正文", title: "note" } });
    fireEvent.click(screen.getByRole("button", { name: /去来源库看看/ }));
    expect(useRoomStore.getState().surface).toBe("source-library");
  });

  it("不支持的文件点名说清，不发请求", async () => {
    const calls = stubGateway();
    render(<GlobalDropOverlay />);
    const file = new File(["%PDF"], "deck.pdf", { type: "application/pdf" });
    const transfer = {
      files: [file],
      types: ["Files"],
      getData: () => "",
      dropEffect: "none" as const,
    };
    fireEvent.dragEnter(document.body, { dataTransfer: transfer });
    expect(await screen.findByText("松开，收进来源库")).toBeTruthy();
    fireEvent.drop(document.body, { dataTransfer: transfer });
    await screen.findByText("这次没收进来");
    expect(screen.getByText("deck.pdf")).toBeTruthy();
    expect(calls.create).toHaveLength(0);
  });
});
