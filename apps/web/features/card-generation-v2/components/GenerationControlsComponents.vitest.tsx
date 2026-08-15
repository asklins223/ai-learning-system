import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CardLimitStepper } from "./CardLimitStepper";
import { CustomScopePicker } from "./CustomScopePicker";

describe("Card V2 custom generation controls", () => {
  it("selects a source scope with listbox keyboard navigation", () => {
    const onChange = vi.fn();
    render(
      <CustomScopePicker
        value="section"
        selectionAvailable
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "来源范围：当前章节" }));
    const listbox = screen.getByRole("listbox", { name: "来源范围" });
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("whole_note");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the scope picker with Escape and an outside pointer press", () => {
    render(
      <CustomScopePicker
        value="whole_note"
        selectionAvailable={false}
        onChange={() => undefined}
      />,
    );

    const trigger = screen.getByRole("button", { name: "来源范围：整篇笔记" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves between intelligent quantity and the policy-bounded numeric range", () => {
    function StepperHarness() {
      const [value, setValue] = useState<number | null>(null);
      return <CardLimitStepper value={value} max={12} onChange={setValue} />;
    }

    render(<StepperHarness />);
    const spinbutton = screen.getByRole("spinbutton", { name: "卡片数量上限" });

    expect(spinbutton.getAttribute("aria-valuenow")).toBe("0");
    expect(spinbutton.getAttribute("aria-valuetext")).toBe("智能数量，无手动上限");

    fireEvent.keyDown(spinbutton, { key: "ArrowUp" });
    expect(spinbutton.getAttribute("aria-valuenow")).toBe("1");

    fireEvent.keyDown(spinbutton, { key: "ArrowDown" });
    expect(spinbutton.getAttribute("aria-valuenow")).toBe("0");

    fireEvent.keyDown(spinbutton, { key: "End" });
    expect(spinbutton.getAttribute("aria-valuenow")).toBe("12");
    expect(
      screen.getByRole("button", { name: "增加最多生成数量" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("never exposes selection when the editor has no valid selection", () => {
    const onChange = vi.fn();
    render(
      <CustomScopePicker
        value="section"
        selectionAvailable={false}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "来源范围：当前章节" }));
    expect(screen.queryByRole("option", { name: /当前选区/ })).toBeNull();
  });
});
