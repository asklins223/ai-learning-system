/**
 * LiquidOrb 组件渲染测试（vitest + jsdom）。
 *
 * jsdom 无 navigator.gpu → 组件必须静默回退 CSS 兜底（不抛错、不挂起），
 * 且渲染 data-liquid-orb="fallback" 标记；自定义 fallback 内容原样保留。
 * WebGPU 路径的真实验证见独立 headless Chromium smoke（组件外）。
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LiquidOrb } from "./LiquidOrb";

describe("LiquidOrb（无 WebGPU 环境）", () => {
  it("回退模式渲染 data 标记与默认兜底圆点", () => {
    const { container } = render(<LiquidOrb preset="siri" tone="running" size={44} />);
    const host = container.querySelector("[data-liquid-orb]");
    expect(host?.getAttribute("data-liquid-orb")).toBe("fallback");
    expect(host?.getAttribute("data-liquid-orb-preset")).toBe("siri");
    expect(host?.querySelector(".liquid-orb-dot")).not.toBeNull();
    // canvas 与兜底同框，canvas 隐藏
    expect(container.querySelector("canvas.liquid-orb-canvas")?.hasAttribute("hidden")).toBe(true);
  });

  it("接受自定义 fallback 内容（旧 CSS 视觉沿用）", () => {
    const { container } = render(
      <LiquidOrb
        preset="voice"
        className="pet-voice-liquid-orb"
        fallback={
          <span className="pet-voice-orb" aria-hidden="true">
            <span className="pet-voice-bars"><i /><i /></span>
          </span>
        }
      />,
    );
    expect(container.querySelector(".pet-voice-liquid-orb")).not.toBeNull();
    expect(container.querySelector(".pet-voice-orb .pet-voice-bars")).not.toBeNull();
  });

  it("提供 label 时挂 role=img 与 aria-label，canvas 装饰性隐藏", () => {
    const { container } = render(<LiquidOrb preset="siri" label="正在听你说" />);
    const host = container.querySelector("[role='img']");
    expect(host?.getAttribute("aria-label")).toBe("正在听你说");
    expect(container.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("透传 style 尺寸", () => {
    const { container } = render(<LiquidOrb preset="drop" size={170} />);
    const host = container.querySelector(".liquid-orb") as HTMLElement;
    expect(host.style.width).toBe("170px");
    expect(host.style.height).toBe("170px");
  });
});
