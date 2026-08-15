"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Icon } from "@/components/ui/icons";
import type { GenerationControlsDraftV2 } from "../contracts/ui-contracts";

type SourceScopeV2 = GenerationControlsDraftV2["sourceScope"];

interface ScopeOption {
  value: SourceScopeV2;
  label: string;
  description: string;
}

export interface CustomScopePickerProps {
  value: SourceScopeV2;
  selectionAvailable: boolean;
  disabled?: boolean;
  onChange: (value: SourceScopeV2) => void;
}

const BASE_OPTIONS: ScopeOption[] = [
  { value: "section", label: "当前章节", description: "只分析光标所在章节" },
  { value: "whole_note", label: "整篇笔记", description: "分析这份笔记的全部内容" },
];

export function CustomScopePicker({
  value,
  selectionAvailable,
  disabled = false,
  onChange,
}: CustomScopePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const options: ScopeOption[] = selectionAvailable
    ? [
      { value: "selection", label: "当前选区", description: "只分析已经选择的内容" },
      ...BASE_OPTIONS,
    ]
    : BASE_OPTIONS;
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selectedOption = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) return;

    function closeWhenClickingOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () => document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => listboxRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function openPicker(index = selectedIndex) {
    if (disabled) return;
    setActiveIndex(index);
    setOpen(true);
  }

  function closePicker({ restoreFocus = false } = {}) {
    setOpen(false);
    if (restoreFocus) {
      // F15（round4）：直接同步 focus，替代 rAF——rAF 由事件 handler 排出且
      // 无卸载 cancel，卸载/重开后是孤儿回调；同步 focus 在关闭流程内完成。
      triggerRef.current?.focus();
    }
  }

  function selectOption(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closePicker({ restoreFocus: true });
  }

  function moveActive(delta: -1 | 1) {
    setActiveIndex((current) => {
      const next = current + delta;
      if (next < 0) return options.length - 1;
      if (next >= options.length) return 0;
      return next;
    });
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      openPicker(selectedIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openPicker(selectedIndex);
    } else if (event.key === "Home") {
      event.preventDefault();
      openPicker(0);
    } else if (event.key === "End") {
      event.preventDefault();
      openPicker(options.length - 1);
    }
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectOption(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        closePicker({ restoreFocus: true });
        break;
      case "Tab":
        closePicker();
        break;
    }
  }

  return (
    <div className="card-v2-scope-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="card-v2-scope-picker__trigger"
        aria-label={`来源范围：${selectedOption.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => (open ? closePicker() : openPicker())}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedOption.label}</span>
        <Icon.Chevron aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={listboxRef}
          id={listboxId}
          className="card-v2-scope-picker__listbox"
          role="listbox"
          tabIndex={-1}
          aria-label="来源范围"
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          onKeyDown={handleListboxKeyDown}
        >
          {options.map((option, index) => (
            <button
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="card-v2-scope-picker__option"
              data-active={index === activeIndex || undefined}
              key={option.value}
              onClick={() => selectOption(index)}
              onPointerMove={() => setActiveIndex(index)}
            >
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <Icon.Check aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
