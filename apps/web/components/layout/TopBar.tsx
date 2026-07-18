"use client";

import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

/**
 * TopBar — focus 模式顶部栏。
 *
 * 低高度、低噪音。包含返回入口、页面上下文和主题切换。
 * 参见：UI-REFACTOR-AI-IMPLEMENTATION-SPEC.md §7.4
 */
export function TopBar() {
  const router = useRouter();

  return (
    <div className="topbar" data-ui="focus-bar">
      <button
        type="button"
        className="topbar-back"
        onClick={() => router.back()}
        aria-label="返回"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        <span>返回</span>
      </button>

      <div className="topbar-actions">
        <ThemeToggle className="topbar-theme-toggle" />
      </div>
    </div>
  );
}
