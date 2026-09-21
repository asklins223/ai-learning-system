// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageGalleryLightbox, useImageLightbox, ZoomableReadingImage } from "./image-viewer";

afterEach(cleanup);

describe("ZoomableReadingImage · 点击放大", () => {
  it("点击图片进入灯箱，Esc 或点击遮罩退出", () => {
    render(<ZoomableReadingImage src="blob:mock" alt="实验装置" />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByAltText("实验装置"));
    const dialog = screen.getByRole("dialog", { name: "实验装置（放大查看，Esc 关闭）" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("blob:mock");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByAltText("实验装置"));
    fireEvent.click(screen.getByRole("dialog"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("灯箱 portal 到 body：祖先带 transform/animation 时 fixed 只会铺满那个祖先", () => {
    render(
      <div className="drawer-like" style={{ animation: "x 1s both" }}>
        <ZoomableReadingImage src="blob:mock" alt="实验装置" />
      </div>,
    );
    fireEvent.click(screen.getByAltText("实验装置"));
    const lightbox = document.querySelector(".image-lightbox")!;
    expect(lightbox.parentElement).toBe(document.body);
    // 非伴星的使用方不该带上这个标记（标记是给存在层的归属判定用的）。
    expect(lightbox.hasAttribute("data-companion-owned")).toBe(false);
  });

  it("onError 只在声明可重试时透传（blob 失效兜底）", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ZoomableReadingImage src="blob:x" alt="图" onRetry={onRetry} />);
    fireEvent.error(screen.getByAltText("图"));
    expect(onRetry).not.toHaveBeenCalled();

    rerender(<ZoomableReadingImage src="blob:x" alt="图" retryable onRetry={onRetry} />);
    fireEvent.error(screen.getByAltText("图"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("受控模式：开关上交页面级画廊，组件自身不渲染灯箱", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ZoomableReadingImage src="blob:mock" alt="装置图" open={false} onOpenChange={onOpenChange} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByAltText("装置图"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // 打开请求已上交，本体也不再自渲染遮罩（页面级画廊负责展示）。
    expect(screen.queryByRole("dialog")).toBeNull();

    rerender(
      <ZoomableReadingImage src="blob:mock" alt="装置图" open onOpenChange={onOpenChange} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useImageLightbox · 画廊开关状态", () => {
  function Harness({ count, onState }: { count: number; onState: (s: ReturnType<typeof useImageLightbox>) => void }) {
    onState(useImageLightbox(count));
    return null;
  }

  it("openAt 收敛越界，close 关闭，count 为 0 时不打开", () => {
    let state!: ReturnType<typeof useImageLightbox>;
    const onState = (s: ReturnType<typeof useImageLightbox>) => { state = s; };
    const { rerender } = render(<Harness count={3} onState={onState} />);
    expect(state.isOpen).toBe(false);

    act(() => state.openAt(2));
    expect(state.openIndex).toBe(2);
    act(() => state.openAt(99));
    expect(state.openIndex).toBe(2);
    act(() => state.openAt(-5));
    expect(state.openIndex).toBe(0);

    act(() => state.close());
    expect(state.isOpen).toBe(false);

    rerender(<Harness count={0} onState={onState} />);
    act(() => state.openAt(0));
    expect(state.isOpen).toBe(false);
  });
});

describe("ImageGalleryLightbox · 通用画廊", () => {
  it("internal 图：计数、箭头与键盘循环切换、关闭按钮退出", () => {
    const onIndexChange = vi.fn();
    const onClose = vi.fn();
    render(
      <ImageGalleryLightbox
        images={[
          { kind: "internal", url: "/api/uploads/ws/note/a.png", alt: "架构图" },
          { kind: "internal", url: "/api/uploads/ws/note/b.png", alt: "数据图" },
          { kind: "internal", url: "https://example.com/c.png", alt: "外链图" },
        ]}
        index={0}
        onClose={onClose}
        onIndexChange={onIndexChange}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "架构图（放大预览 1/3，Esc 关闭）" });
    expect(dialog.querySelector("figcaption")?.textContent).toContain("1 / 3");

    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(1);

    // 从第 1 张向左循环回最后一张。
    fireEvent.click(screen.getByRole("button", { name: "上一张" }));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("resolved 图：已解析地址直接交给 img，不走访取字节", () => {
    render(
      <ImageGalleryLightbox
        images={[
          { kind: "resolved", src: "blob:aaa", alt: "甲图" },
          { kind: "resolved", src: "blob:bbb", alt: "乙图" },
        ]}
        index={1}
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "乙图（放大预览 2/2，Esc 关闭）" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("blob:bbb");
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });

  it("触摸滑动切换：左滑下一张、右滑上一张，误触不翻页", () => {
    const onIndexChange = vi.fn();
    render(
      <ImageGalleryLightbox
        images={[
          { kind: "resolved", src: "blob:a", alt: "甲" },
          { kind: "resolved", src: "blob:b", alt: "乙" },
          { kind: "resolved", src: "blob:c", alt: "丙" },
        ]}
        index={0}
        onClose={vi.fn()}
        onIndexChange={onIndexChange}
      />,
    );
    const dialog = screen.getByRole("dialog");

    const touch = (startX: number, endX: number) => {
      fireEvent.touchStart(dialog, { touches: [{ clientX: startX }] });
      fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: endX }] });
    };

    touch(260, 120);
    expect(onIndexChange).toHaveBeenLastCalledWith(1);

    touch(120, 260);
    expect(onIndexChange).toHaveBeenLastCalledWith(2);

    touch(200, 220);
    expect(onIndexChange).toHaveBeenCalledTimes(2);
  });

  it("variant=\"card\"：遮罩带卡片形态类，圆角交给宿主卡片", () => {
    render(
      <ImageGalleryLightbox
        images={[{ kind: "resolved", src: "blob:a", alt: "甲" }]}
        index={0}
        variant="card"
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog").className).toBe("image-lightbox image-lightbox--card");
  });

  it("点箭头不触发遮罩关闭；单张不出现切换箭头与计数", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ImageGalleryLightbox
        images={[
          { kind: "resolved", src: "blob:a", alt: "甲" },
          { kind: "resolved", src: "blob:b", alt: "乙" },
        ]}
        index={1}
        onClose={onClose}
        onIndexChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "下一张" }));
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <ImageGalleryLightbox
        images={[{ kind: "resolved", src: "blob:a", alt: "甲" }]}
        index={0}
        onClose={onClose}
        onIndexChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "下一张" })).toBeNull();
    expect(screen.queryByRole("button", { name: "上一张" })).toBeNull();
    expect(screen.queryByText("1 / 1")).toBeNull();
  });
});
