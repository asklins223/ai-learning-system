// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceShareButton, noteShareScopeLabel } from "./space-share-control";

afterEach(() => {
  cleanup();
});

function renderButton(overrides: Partial<React.ComponentProps<typeof SpaceShareButton>> = {}) {
  const onShare = vi.fn(async () => undefined);
  const props = {
    shareScope: "private" as const,
    canShare: true,
    isPersonal: false,
    onShare,
    ...overrides,
  };
  render(<SpaceShareButton {...props} />);
  return { onShare, props };
}

describe("SpaceShareButton · 笔记归属那一个动作", () => {
  it("个人空间里整个控件不出现（没有人可共享）", () => {
    const shown = render(
      <SpaceShareButton shareScope="private" canShare isPersonal={false} onShare={async () => undefined} />,
    );
    expect(shown.container.textContent).toContain("共享给空间");
    const hidden = render(
      <SpaceShareButton shareScope="private" canShare isPersonal onShare={async () => undefined} />,
    );
    expect(hidden.container.textContent).toBe("");
  });

  it("不是作者时说清为什么不能点，并且点了没有任何动作", async () => {
    const { onShare } = renderButton({ canShare: false });
    const button = screen.getByRole("button", { name: "共享给空间" }) as HTMLButtonElement;
    // 本仓不装 jest-dom，所以直接看 DOM 属性。
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("只有写下这篇的人");
    fireEvent.click(button);
    await waitFor(() => expect(onShare).not.toHaveBeenCalled());
  });

  it("共享这一步先把「别人会读到」说出来，确认之后才提交", async () => {
    const { onShare } = renderButton();
    fireEvent.click(screen.getByRole("button", { name: "共享给空间" }));
    // 点了就直接改归属是不行的：这是一次外发，必须在"放入"这一步明示。
    expect(onShare).not.toHaveBeenCalled();
    expect(screen.getByText("共享后，这个空间的成员都能读到这篇正文。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认共享给空间" }));
    await waitFor(() => expect(onShare).toHaveBeenCalledWith("shared"));
  });

  it("已共享的那篇动作是取消共享，并且说明已生成的卡不受影响", async () => {
    const { onShare } = renderButton({ shareScope: "shared" });
    fireEvent.click(screen.getByRole("button", { name: "取消共享" }));
    expect(screen.getByText(/已经按它生成过的学习卡不受影响/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认取消共享" }));
    await waitFor(() => expect(onShare).toHaveBeenCalledWith("private"));
  });

  it("两态文案：仅自己可见 / 已共享给空间（不叫「个人笔记」）", () => {
    expect(noteShareScopeLabel("private")).toBe("仅自己可见");
    expect(noteShareScopeLabel("shared")).toBe("已共享给空间");
  });
});
