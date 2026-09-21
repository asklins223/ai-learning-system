import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";

export type CompanionSelectOption<T extends string = string> = {
  readonly value: T;
  readonly label: string;
};

/**
 * Compact, themeable select used on the companion glass surfaces.
 *
 * The listbox itself owns keyboard focus while open. This keeps Arrow/Home/End
 * navigation, Escape dismissal and focus restoration in one predictable path,
 * instead of leaving focus on the trigger while rendering an inert menu.
 */
export function CompanionSelect<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  paper = false,
}: {
  readonly ariaLabel: string;
  readonly value: T;
  readonly options: ReadonlyArray<CompanionSelectOption<T>>;
  readonly onChange: (value: T) => void;
  readonly paper?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [flipUp, setFlipUp] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const optionIdPrefix = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) listboxRef.current?.focus();
  }, [open]);

  const openMenu = (initialIndex = selectedIndex) => {
    setActiveIndex(initialIndex);
    const root = rootRef.current;
    if (root) {
      const trigger = root.getBoundingClientRect();
      const scroller = root.closest(".companion-tab-panel");
      const bounds = scroller?.getBoundingClientRect();
      const spaceBelow = (bounds ? bounds.bottom : window.innerHeight) - trigger.bottom;
      const spaceAbove = trigger.top - (bounds ? bounds.top : 0);
      setFlipUp(spaceBelow < 264 && spaceAbove > spaceBelow);
    }
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    closeMenu(true);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu(selectedIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(selectedIndex);
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1 + options.length) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex >= 0 ? activeIndex : selectedIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };

  const activeOptionId = activeIndex >= 0 ? `${optionIdPrefix}-option-${activeIndex}` : undefined;

  return (
    <div
      ref={rootRef}
      className={`companion-select${paper ? " is-paper" : ""}`}
      data-open={open ? "true" : undefined}
      data-flip={flipUp && open ? "up" : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="companion-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{selected?.label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={listboxRef}
          className="companion-select__menu"
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={activeOptionId}
          tabIndex={0}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${optionIdPrefix}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={`companion-select__option${index === activeIndex ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
              onPointerEnter={() => setActiveIndex(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => commit(index)}
            >
              {option.value === value ? <Check size={13} aria-hidden="true" /> : <i aria-hidden="true" />}
              <span>{option.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
