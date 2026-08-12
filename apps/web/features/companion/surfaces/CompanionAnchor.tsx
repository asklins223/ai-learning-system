"use client";

import { forwardRef, useId } from "react";
import { CompanionAvatar } from "@/components/learning-companion/CompanionAvatar";

export const CompanionAnchor = forwardRef<HTMLButtonElement, { onSummon: () => void }>(
  function CompanionAnchor({ onSummon }, ref) {
    const anchorId = useId();
    return (
      <div
        data-ui="companion-v2-anchor"
        className="fixed right-3 bottom-[calc(var(--mobile-nav-inset)+12px)] z-10 sm:right-5 sm:bottom-5"
      >
        <button
          id={anchorId}
          ref={ref}
          type="button"
          onClick={onSummon}
          aria-label="召唤学习伴星"
          className="flex min-h-12 min-w-12 items-center justify-center rounded-full border border-border bg-surface px-2 shadow-sm transition hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          <CompanionAvatar
            state="dormant"
            size={40}
            showLabel={false}
            ariaLabel="学习伴星"
            className="pointer-events-none"
          />
        </button>
      </div>
    );
  },
);
