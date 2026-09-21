// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanionSelect } from "./companion-select";

afterEach(cleanup);

describe("CompanionSelect", () => {
  it("moves focus into the listbox and commits the active option from the keyboard", () => {
    const onChange = vi.fn();
    render(
      <CompanionSelect
        ariaLabel="记忆状态"
        value="all"
        options={[
          { value: "all", label: "全部状态" },
          { value: "pinned", label: "已固定" },
        ]}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "记忆状态" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const listbox = screen.getByRole("listbox", { name: "记忆状态" });
    expect(document.activeElement).toBe(listbox);
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("pinned");
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses with Escape and restores trigger focus", () => {
    render(
      <CompanionSelect
        ariaLabel="记忆状态"
        value="all"
        options={[{ value: "all", label: "全部状态" }]}
        onChange={() => undefined}
      />,
    );
    const trigger = screen.getByRole("button", { name: "记忆状态" });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "记忆状态" });
    fireEvent.keyDown(listbox, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "记忆状态" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
