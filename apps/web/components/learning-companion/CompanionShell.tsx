"use client";

/**
 * 伴星壳聚合组件（阶段 05-5 + 07-4 接线层）。
 *
 * 把三个纯 UI 组件聚合为可挂载到 AppShell 的伴星壳：
 * - `QuietAnchor`：安静锚点（右下安全边缘召唤入口，不 idle 动画/不闪烁/不发声）；
 * - `CompanionSidePanel`：侧板/移动端底部面板（可收起、关闭后焦点恢复）；
 * - `CompanionAvatar`：角色头像（按真实系统事件驱动，dormant 静态）。
 *
 * 接线语义（§5.4.2/§5.4.4/§5.5）：
 * - 控制快照来自 `DEFAULT_COMPANION_CONTROL_SNAPSHOT`（接线者可替换为服务端
 *   `/me/companion` 读取的存在感/控制状态；temporary_hidden/global_off 时
 *   组件立即返回 null）；
 * - quiet 未召唤时不挂载 observer/完整 context，仅保留召唤入口；
 * - 面板内容经 `children` 注入（本聚合不直接调用服务端）。
 */

import { useState } from "react";
import {
  DEFAULT_COMPANION_CONTROL_SNAPSHOT,
  isSnapshotHidden,
  type CompanionControlStateSnapshot,
} from "@/lib/learning-companion/companion-control-state";
import { QuietAnchor } from "./QuietAnchor";
import { CompanionSidePanel } from "./CompanionSidePanel";
import { CompanionAvatar } from "./CompanionAvatar";
import type { CompanionVisualStateV1, CompanionSystemEvent } from "@/lib/learning-companion/companion-visual-state";

export interface CompanionShellProps {
  /** 存在感/控制状态快照；缺省为默认（quiet）。 */
  controlSnapshot?: CompanionControlStateSnapshot;
  /** 当前角色视觉状态（由上层按真实系统事件权威映射驱动）。 */
  visualState?: CompanionVisualStateV1;
  /** 触发该视觉状态的真实系统事件（防御性：动画只表达已发生状态）。 */
  systemEvent?: CompanionSystemEvent;
  /** prefers-reduced-motion: reduce 或 animation_off。 */
  prefersReducedMotion?: boolean;
  /** 面板内容（如当前上下文/建议原因/动作；经父组件注入）。 */
  panelContent?: React.ReactNode;
  /** 面板标题。 */
  panelTitle?: string;
  /** 覆盖锚点定位类。 */
  anchorClassName?: string;
}

/** 默认系统事件（dormant 状态不依赖事件触发）。 */
const DEFAULT_COMPANION_SYSTEM_EVENT: CompanionSystemEvent = { kind: "session_idle" };

export function CompanionShell({
  controlSnapshot = DEFAULT_COMPANION_CONTROL_SNAPSHOT,
  visualState = "dormant",
  systemEvent = DEFAULT_COMPANION_SYSTEM_EVENT,
  prefersReducedMotion = false,
  panelContent,
  panelTitle = "伴星",
  anchorClassName,
}: CompanionShellProps) {
  const [open, setOpen] = useState(false);

  // temporary_hidden / global_off：立即停渲染（不等待网络，§5.5）。
  if (isSnapshotHidden(controlSnapshot)) {
    return null;
  }

  const handleSummon = () => {
    // 用户显式召唤：此调用后才允许挂载 observer / 构造短 TTL context（§5.4.4）。
    setOpen(true);
  };

  return (
    <>
      <QuietAnchor
        controlSnapshot={controlSnapshot}
        onSummon={handleSummon}
        className={anchorClassName}
      />
      <CompanionAvatar
        state={visualState}
        systemEvent={systemEvent}
        prefersReducedMotion={prefersReducedMotion}
        quiet={!controlSnapshot.temporaryHidden && !controlSnapshot.globalOff}
        hidden={false}
        size={40}
        showLabel={false}
        ariaLabel="伴星导航员"
        className="companion-shell-avatar"
      />
      <CompanionSidePanel open={open} onClose={() => setOpen(false)} title={panelTitle}>
        {panelContent}
      </CompanionSidePanel>
    </>
  );
}
