/**
 * vitest 基建首个渲染测试（2026-08-12）。
 *
 * 验证 jsdom 渲染链：ThemeProvider 挂载 → 上下文读 theme → toggle 切换 →
 * localStorage 持久化。这是组件渲染测试基建的冒烟——后续组件行为回归
 * （rAF 清理、缓存广播、订阅解绑等）按同模式扩展。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { ThemeProvider, useTheme } from "../../components/ThemeProvider";

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" data-testid="theme-probe" onClick={() => toggleTheme({ x: 10, y: 10 })}>
      主题:{theme}
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("ThemeProvider 渲染", () => {
  it("挂载后默认 day,data-theme 同步到 html", () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme-probe").textContent).toContain("day");
    // mounted 后 data-theme 由 effect 设置
    expect(document.documentElement.getAttribute("data-theme")).toBe("day");
  });

  it("toggle 切换到 night 并持久化到 localStorage", () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByTestId("theme-probe"));
    expect(screen.getByTestId("theme-probe").textContent).toContain("night");
    expect(window.localStorage.getItem("ailearn.theme")).toBe("night");
  });

  it("localStorage 已有 night 时初始即为 night", () => {
    window.localStorage.setItem("ailearn.theme", "night");
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("theme-probe").textContent).toContain("night");
  });
});
