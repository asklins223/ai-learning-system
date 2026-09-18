import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { HUD_PAGES, type HudPageId } from "./hud-pages";

/**
 * The shared V3.1 page shell: the mint heading chip and the "return to study"
 * pill that every business page wears, wrapping one page body inside the
 * mockup's `main.content` region.
 */
export function HudPage({
  page,
  children,
  wide = false,
}: {
  readonly page: HudPageId;
  readonly children: ReactNode;
  /** LearningRun pages keep a full-width paper and hide the companion. */
  readonly wide?: boolean;
}) {
  const definition = HUD_PAGES[page];
  return (
    <>
      <div className="task-title">
        <h1>{definition.title}</h1>
        <p>{definition.subtitle}</p>
      </div>
      <main className={`content${wide || definition.wide ? " full" : ""}`}>{children}</main>
    </>
  );
}

/** Layout-neutral loading / empty / failure paper shared by every page body. */
/**
 * The bottom-left pill. It always goes up one level in the page hierarchy, so
 * its label names the parent: a page opened from the directory rail returns to
 * the study room, a page opened from a list returns to that list.
 *
 * It carries `data-surface-initial-focus` because it *is* the close control of
 * every HUD page, and it renders outside the task surface — the surface's own
 * query cannot reach it, so a page opened from the rail used to leave focus on
 * the rail chip instead of entering the page.
 */
export function HudReturn({ label, onReturn }: { readonly label: string; readonly onReturn: () => void }) {
  return (
    <button
      type="button"
      className="return-home"
      onClick={onReturn}
      aria-label={`返回${label}`}
      data-surface-initial-focus="true"
    >
      <i aria-hidden="true"><ArrowLeft size={16} strokeWidth={2.2} /></i>
      <span>{label}</span>
    </button>
  );
}
