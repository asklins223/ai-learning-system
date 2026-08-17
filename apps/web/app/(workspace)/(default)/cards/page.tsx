/**
 * Plan 23 FE-13：学习目标库切流——页面只消费 V3 Objective list。
 *
 * 原页面（V1/V2 union merge、CardListItem 有损转换、schemaJson.title 兜底）由
 * ObjectiveLibrary 替换；正式读取全部走 /v2/learning-objectives（§2.4/§6）。
 */
"use client";

import "@/app/styles/cards-list.css";
import "@/app/styles/workspace-headers.css";
import "@/app/styles/objective-system.css";
import "@/app/styles/objective-library.css";
import { PageHeader } from "@/components/layout/PageHeader";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { ObjectiveLibrary } from "@/features/learning-objective/ObjectiveLibrary";
// §14.2：cards 页发布 bounded context（Pet 主动策略门禁）。
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import type { JSX } from "react";

export default function CardsIndex(): JSX.Element {
  useMainPageContext({
    routeRef: { kind: "home" },
    pageKind: "card",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  });

  return (
    <div className="cards-page">
      <PageHeader
        className="workspace-page-header"
        kicker="学习卡库"
        title="学习目标"
        subtitle="以学习目标为入口查看概念、来源、状态与下一步；答案会留到真正开始学习之后。"
        actions={[<ThemeToggle key="theme" className="workspace-header-theme-toggle" />]}
      />
      <ObjectiveLibrary />
    </div>
  );
}
