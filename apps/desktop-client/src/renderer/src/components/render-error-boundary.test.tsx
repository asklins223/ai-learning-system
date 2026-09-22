// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderErrorBoundary } from "./RenderErrorBoundary";

/**
 * 兜底层的存在理由只有一个：渲染期抛错不能再变成一片黑。所以这里断言的是
 * "整棵树还活着"——文案、原始错误、以及两条出路（重试 / 重新载入）。
 * 真实故障形状取自 2026-09-20 的伴星中心黑屏：一个 hook 在缺少 Provider 时抛错。
 */

function Bomb({ explode }: { readonly explode: boolean }) {
  if (explode) throw new Error("useCompanionChat must be used inside CompanionChatProvider");
  return <p>页面正文</p>;
}

beforeEach(() => {
  // React 会把捕获到的错误原样打到控制台（这是期望行为），测试里不重复刷屏。
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a render crash becomes a readable page", () => {
  it("keeps the app mounted and names the region that failed", () => {
    render(
      <RenderErrorBoundary label="伴星中心">
        <Bomb explode />
      </RenderErrorBoundary>,
    );

    const paper = screen.getByRole("alert");
    expect(paper.textContent).toContain("伴星中心没能打开");
    expect(paper.textContent).toContain("学习空间的其他部分仍然可用");
    // 原始信息原样呈现，用户能把它抄给开发者，不用去翻控制台。
    expect(paper.textContent).toContain("useCompanionChat must be used inside CompanionChatProvider");
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /重新载入应用/ })).toBeTruthy();
  });

  it("remounts the failed subtree on 重试 so a transient crash recovers in place", () => {
    // 抛错开关留在外部、重试前才关掉：组件在**同一轮**的每个渲染阶段都抛错，
    // React 才会把状态交给边界并让这张纸留在屏幕上（只抛一次的话它自己就恢复了）。
    let explode = true;
    function Flaky() {
      if (explode) throw new Error("首次渲染失败");
      return <p>页面正文</p>;
    }

    render(
      <RenderErrorBoundary label="这个页面">
        <Flaky />
      </RenderErrorBoundary>,
    );
    expect(screen.queryByText("页面正文")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("这个页面没能打开");

    explode = false;
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));

    expect(screen.getByText("页面正文")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a full-page fallback for the shell, where there is no page body left", () => {
    render(
      <RenderErrorBoundary label="理解书房" shell>
        <Bomb explode />
      </RenderErrorBoundary>,
    );

    expect(document.querySelector(".render-error-boundary--shell")).not.toBeNull();
    const paper = screen.getByRole("alert");
    expect(paper.textContent).toContain("理解书房没能打开");
    // 整页失守时版心已经不存在了，重载应用是最后一条出路，必须给出来。
    expect(screen.getByRole("button", { name: /重新载入应用/ })).toBeTruthy();
  });
});
