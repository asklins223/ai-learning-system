"use client";

/**
 * 任务 05-5：安静锚点（§5.4.2 / 冻结记录 01-8 §7）。
 *
 * 全局呈现形态之一：静态中性图标/小立绘固定于应用导航区或内容安全边缘，
 * **只提供召唤入口**。
 *
 * 静默约束（冻结记录 01-8 §7 / §5.4.2 / §5.5）：
 * - 不播放 idle 动画、不闪烁、不发声、不显示未读红点 —— 本组件不渲染任何
 *   badge/气泡/动画类；立绘是静态 SVG（无 @keyframes、无循环过渡）；
 * - `quiet` 未召唤时锚点保留（召唤入口），但绝不进入 idle 动画；
 * - `temporary_hidden` / `global_off` 时**立即**返回 null（不渲染任何内容，
 *   UI 不等待网络才隐藏），只留设置/帮助/全局命令恢复入口。
 *
 * 不阻塞页面主内容（验收「全站锚点不阻塞主内容」）：
 * - 默认固定在右下安全边缘的小按钮（44px 以上触控目标），z-index 低、
 *   不覆盖导航区与内容主操作；可用 `className` 覆盖为导航区内嵌定位；
 * - 普通 button 语义：键盘可到达、不劫持 Tab 序、不自动聚焦、非模态。
 */

import { isSnapshotHidden } from "@/lib/learning-companion/companion-control-state";
import type { CompanionControlStateSnapshot } from "@/lib/learning-companion/companion-control-state";

export interface QuietAnchorProps {
  controlSnapshot: CompanionControlStateSnapshot;
  /** 用户点击锚点 → 显式召唤（quiet 下此调用后才允许挂载 observer/构造短 TTL context） */
  onSummon: () => void;
  ariaLabel?: string;
  /** 覆盖默认固定定位类（桌面导航区/内容安全边缘；默认右下安全边缘） */
  className?: string;
}

/**
 * 静态中性小立绘（年轻星际导航员头像：圆脸 + 闭合眼 + 中性嘴 + 发光星纹 + 彗尾）。
 * 纯静态 SVG：无动画、无呼吸/闪烁、无粒子。reduced-motion 天然兼容。
 */
function AnchorPortrait() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="block"
    >
      {/* 围巾式彗尾 */}
      <path
        d="M4 21c4 2 8 1.5 10 2.5s6 0 10-2.5"
        opacity="0.55"
      />
      {/* 脸 */}
      <circle cx="14" cy="11.5" r="6.5" />
      {/* 安静闭合眼 */}
      <path d="M11 11l1.4 1.4M15.6 12.4 17 11" />
      {/* 中性嘴 */}
      <path d="M12 15.5h4" />
      {/* 发光星纹（静态） */}
      <path
        d="M14 6.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

export function QuietAnchor({
  controlSnapshot,
  onSummon,
  ariaLabel = "召唤学习伴星",
  className,
}: QuietAnchorProps) {
  // temporary_hidden/global_off：立即停渲染（不等待网络，§5.5）
  if (isSnapshotHidden(controlSnapshot)) return null;

  return (
    <div
      data-ui="lc-quiet-anchor"
      className={
        className ??
        "fixed right-3 bottom-3 z-10 flex items-center justify-center"
      }
    >
      <button
        type="button"
        onClick={onSummon}
        aria-label={ariaLabel}
        title={ariaLabel}
        className="flex size-12 items-center justify-center rounded-full border border-border bg-surface text-ink shadow-sm transition-colors hover:bg-surface-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      >
        <AnchorPortrait />
      </button>
    </div>
  );
}
