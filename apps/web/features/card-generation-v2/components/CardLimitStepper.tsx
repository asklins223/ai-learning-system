"use client";

import { useId, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/icons";

export interface CardLimitStepperProps {
  value: number | null;
  min?: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}

export function CardLimitStepper({
  value,
  min = 1,
  max,
  disabled = false,
  onChange,
}: CardLimitStepperProps) {
  const labelId = useId();
  const valueText = value === null ? "智能数量，无手动上限" : `最多 ${value} 张`;

  function decrease() {
    if (disabled || value === null) return;
    onChange(value <= min ? null : value - 1);
  }

  function increase() {
    if (disabled || value === max) return;
    onChange(value === null ? min : Math.min(max, value + 1));
  }

  function handleValueKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "PageDown":
        event.preventDefault();
        decrease();
        break;
      case "ArrowUp":
      case "PageUp":
        event.preventDefault();
        increase();
        break;
      case "Home":
        event.preventDefault();
        if (!disabled) onChange(null);
        break;
      case "End":
        event.preventDefault();
        if (!disabled) onChange(max);
        break;
    }
  }

  return (
    <div
      className="card-v2-limit-stepper"
      role="group"
      aria-labelledby={labelId}
      data-disabled={disabled || undefined}
    >
      <span id={labelId} className="card-v2-limit-stepper__label">
        卡片数量上限
      </span>
      <button
        type="button"
        className="card-v2-limit-stepper__button"
        aria-label={value === min ? "恢复智能数量" : "减少最多生成数量"}
        disabled={disabled || value === null}
        onClick={decrease}
      >
        <span aria-hidden="true">−</span>
      </button>
      <span
        className="card-v2-limit-stepper__value"
        role="spinbutton"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-disabled={disabled}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value ?? 0}
        aria-valuetext={valueText}
        aria-live="polite"
        aria-atomic="true"
        onKeyDown={handleValueKeyDown}
      >
        <strong>{value ?? "智能"}</strong>
        {value !== null && <small>张</small>}
      </span>
      <button
        type="button"
        className="card-v2-limit-stepper__button"
        aria-label="增加最多生成数量"
        disabled={disabled || value === max}
        onClick={increase}
      >
        <Icon.Plus aria-hidden="true" />
      </button>
    </div>
  );
}
