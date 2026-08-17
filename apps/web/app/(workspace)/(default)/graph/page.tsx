/**
 * Plan 23 TP-11..TP-18：理解星图切流——Objective-native V3 视图。
 * 原页面（Card/key_point 双实体 + alias 补丁）由 UnderstandingGraphV3 替换。
 */
"use client";

import "@/app/styles/workspace-headers.css";
import "@/app/styles/objective-system.css";
import "@/app/styles/understanding-graph-v3.css";
import { PageHeader } from "@/components/layout/PageHeader";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { UnderstandingGraphV3 } from "@/features/understanding/UnderstandingGraphV3";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import type { JSX } from "react";

export default function GraphPage(): JSX.Element {
  useMainPageContext({
    routeRef: { kind: "home" },
    pageKind: "other",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  });

  return (
    <div className="graph-v3-page">
      <PageHeader
        className="workspace-page-header"
        kicker="理解星图"
        title="知识从哪来、如何关联"
        subtitle="来源 → 笔记 → 学习目标 ← 证据；个人状态只来自可信学习记录。"
        actions={[<ThemeToggle key="theme" className="workspace-header-theme-toggle" />]}
      />
      <UnderstandingGraphV3 />
    </div>
  );
}
