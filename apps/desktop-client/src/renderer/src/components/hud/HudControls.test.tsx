// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HudPicker, HudSegmented, HudSlider, HudSwitch } from "./HudControls";

/**
 * The settings centre draws its own controls, so the browser no longer supplies
 * the semantics for free. These tests hold the contract that makes them behave
 * like the widgets they replace: the ARIA state, the keyboard path, and the
 * clamping that a native input would have done.
 */

afterEach(cleanup);

describe("HudSwitch", () => {
  it("reports its state as a switch and toggles once per activation", () => {
    const onChange = vi.fn();
    render(<HudSwitch checked={false} onChange={onChange} label="伴星与环境音" />);

    const control = screen.getByRole("switch", { name: "伴星与环境音" });
    expect(control.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(<HudSwitch checked={false} onChange={onChange} label="伴星与环境音" disabled />);

    fireEvent.click(screen.getByRole("switch", { name: "伴星与环境音" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("HudSegmented", () => {
  const options = [["full", "完整"], ["lite", "轻量"], ["off", "关闭"]] as const;

  it("exposes one checked radio per option and selects on click", () => {
    const onChange = vi.fn();
    render(<HudSegmented label="动效等级" value="full" options={options} onChange={onChange} />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: "轻量" }));
    expect(onChange).toHaveBeenCalledWith("lite");
  });

  it("moves the selection with the arrow keys and wraps at both ends", () => {
    const onChange = vi.fn();
    render(<HudSegmented label="动效等级" value="full" options={options} onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "完整" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("off");

    fireEvent.keyDown(screen.getByRole("radio", { name: "完整" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("lite");
  });

  it("keeps the sliding plate on the active index", () => {
    render(<HudSegmented label="动效等级" value="lite" options={options} onChange={() => {}} />);

    const group = screen.getByRole("radiogroup", { name: "动效等级" });
    expect(group.style.getPropertyValue("--hud-seg-index")).toBe("1");
    expect(group.style.getPropertyValue("--hud-seg-count")).toBe("3");
  });
});

describe("HudPicker", () => {
  const options = [
    ["a", "Personal Beta", "Owner · 个人空间 · 当前"],
    ["b", "海岸研究室", "Member · 协作空间"],
  ] as const;

  it("opens a drawn listbox instead of a native select", () => {
    render(<HudPicker label="进入的空间" value="a" options={options} onChange={() => {}} />);

    const trigger = screen.getByRole("button", { name: /进入的空间/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "进入的空间" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("selects an option and returns focus to the trigger", async () => {
    const onChange = vi.fn();
    render(<HudPicker label="进入的空间" value="a" options={options} onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: /进入的空间/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /海岸研究室/ }));

    expect(onChange).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("moves the highlight with the arrow keys and commits with Enter", () => {
    const onChange = vi.fn();
    render(<HudPicker label="进入的空间" value="a" options={options} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /进入的空间/ }));
    const list = screen.getByRole("listbox", { name: "进入的空间" });

    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("closes on Escape without changing the value", async () => {
    const onChange = vi.fn();
    render(<HudPicker label="进入的空间" value="a" options={options} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /进入的空间/ }));
    fireEvent.keyDown(screen.getByRole("listbox", { name: "进入的空间" }), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("marks the option that matches the current value", () => {
    render(<HudPicker label="进入的空间" value="b" options={options} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /进入的空间/ }));

    const selected = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("海岸研究室");
  });
});

describe("HudSlider", () => {
  const base = { min: 0.6, max: 1.4, step: 0.05, label: "伴星大小", format: (value: number) => `${Math.round(value * 100)}%` };

  it("announces the value as a slider with a spoken form", () => {
    render(<HudSlider {...base} value={1} onChange={() => {}} />);

    const slider = screen.getByRole("slider", { name: "伴星大小" });
    expect(slider.getAttribute("aria-valuenow")).toBe("1");
    expect(slider.getAttribute("aria-valuetext")).toBe("100%");
    expect(slider.getAttribute("aria-valuemin")).toBe("0.6");
    expect(slider.getAttribute("aria-valuemax")).toBe("1.4");
  });

  it("steps with the arrow keys and pages five steps at a time", () => {
    const onChange = vi.fn();
    render(<HudSlider {...base} value={1} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "伴星大小" });

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(1.05);

    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(0.95);

    fireEvent.keyDown(slider, { key: "PageUp" });
    expect(onChange).toHaveBeenLastCalledWith(1.25);
  });

  it("clamps at both ends instead of running past them", () => {
    const onChange = vi.fn();
    render(<HudSlider {...base} value={1.4} onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole("slider", { name: "伴星大小" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(1.4);

    fireEvent.keyDown(screen.getByRole("slider", { name: "伴星大小" }), { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(0.6);
  });

  it("snaps a pointer position onto the step grid", () => {
    const onChange = vi.fn();
    render(<HudSlider {...base} value={1} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "伴星大小" });
    // jsdom has no layout, so the track is given the geometry a browser would.
    slider.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 26, right: 200, bottom: 26, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty(slider, "setPointerCapture", { value: () => {}, configurable: true });
    Object.defineProperty(slider, "hasPointerCapture", { value: () => false, configurable: true });

    // jsdom ships no PointerEvent, so the event is built from a MouseEvent, which
    // still carries the clientX the handler reads.
    fireEvent(slider, new MouseEvent("pointerdown", { clientX: 150, bubbles: true }));
    // 150 / 200 across 0.6–1.4 is 1.2, which is already on the 0.05 grid.
    expect(onChange).toHaveBeenLastCalledWith(1.2);

    fireEvent(slider, new MouseEvent("pointerdown", { clientX: 63, bubbles: true }));
    // 0.6 + 0.315 * 0.8 = 0.852, which must land on the nearest 0.05.
    expect(onChange).toHaveBeenLastCalledWith(0.85);
  });
});
