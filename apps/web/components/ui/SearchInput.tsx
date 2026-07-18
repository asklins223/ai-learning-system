import { InputHTMLAttributes, useRef } from "react";
import { Icon } from "./icons";

/**
 * SearchInput — 规范 §9.7 统一搜索输入。
 *
 * - 真实 input，不是视觉容器。
 * - 清空按钮有 aria-label。
 * - 300ms debounce 由页面 container 控制，组件只负责输入和清空。
 */
export function SearchInput({
  value,
  onChange,
  onClear,
  placeholder = "搜索…",
  className = "",
  autoFocus = false,
  ...props
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "autoFocus">) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = () => {
    onClear();
    inputRef.current?.focus();
  };

  return (
    <div className={`search-input-wrap ${className}`}>
      <Icon.Search className="h-4 w-4 text-muted" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="search-input"
        {...props}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          onClick={handleClear}
          aria-label="清空搜索"
        >
          <Icon.X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
