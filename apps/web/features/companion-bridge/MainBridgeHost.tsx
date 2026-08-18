"use client";

/**
 * Main 窗口 Bridge V2 命令宿主（文档 16 §14.4）。
 *
 * 挂在全局布局：订阅 Pet 发出的表面命令并执行导航/回执。
 * - navigation（open_route）：路由映射 → router.push → report completed；
 * - in_page（graph.*）：带参导航到星图页（broker 已校验 freshness）；
 * - focus_ui_target：当前不支持 → report rejected。
 * 浏览器（无 preload）fail closed，零副作用。
 */

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import type {
  AllowedMainRouteV2,
  InPageCommandEnvelopeV2,
  MainCommandResultV2,
  NavigationCommandEnvelopeV2,
  PetMainCommandV2,
} from "@ailearn/shared";
import { isMainBridge } from "./bridge-global";

export function routePath(route: AllowedMainRouteV2): string {
  switch (route.kind) {
    case "home": return "/";
    case "today": return "/today";
    case "source": return route.sourceId ? `/sources/${encodeURIComponent(route.sourceId)}` : "/sources";
    case "note": return `/notes/${encodeURIComponent(route.noteId)}`;
    case "card_set": return "/cards"; // V2：无卡组概念，回学习目标库（/cards 已是 ObjectiveLibrary）
    case "card": return `/learning-cards/${encodeURIComponent(route.cardId)}`; // V2 学习卡详情
    case "review": return route.scheduleId ? `/review?scheduleId=${encodeURIComponent(route.scheduleId)}` : "/review";
    case "star_map":
      // §18.1：restore_graph_viewport（restoreRun）优先；focus_graph_node 带 lens。
      if (route.restoreRun) return `/graph?restoreRun=${encodeURIComponent(route.restoreRun)}`;
      if (route.keyPointId) {
        const lensParam = route.lens ? `&lens=${encodeURIComponent(route.lens)}` : "";
        return `/graph?keyPointId=${encodeURIComponent(route.keyPointId)}${lensParam}`;
      }
      return "/graph";
    case "learning_run": return `/learning-runs/${encodeURIComponent(route.runId)}`;
    case "conversation":
      // open_conversation_history 带 assistantSessionId 时定位到该会话。
      return route.assistantSessionId
        ? `/companion/conversations?conversationId=${encodeURIComponent(route.assistantSessionId)}`
        : "/companion/conversations";
    case "settings": return "/settings";
    default: return "/";
  }
}

export function inPageCommandPath(command: Exclude<PetMainCommandV2, { kind: "open_route" }>): string | null {
  switch (command.kind) {
    case "focus_ui_target": return null; // 当前无 UI target 实现
    case "graph.focus":
      return `/graph?keyPointId=${encodeURIComponent(command.keyPointId)}${command.lens ? `&lens=${command.lens}` : ""}`;
    case "graph.present_route":
      return `/graph?routePlanId=${encodeURIComponent(command.routePlanId)}&routeRevision=${encodeURIComponent(command.revision)}`;
    case "graph.advance_route":
      return `/graph?routePlanId=${encodeURIComponent(command.routePlanId)}&routeOrdinal=${command.ordinal}`;
    case "graph.restore":
      return `/graph?restoreRun=${encodeURIComponent(command.runId)}`;
    case "graph.reveal_delta":
      return `/graph?changeSetId=${encodeURIComponent(command.changeSetId)}`;
    default:
      return null;
  }
}

export function MainBridgeHost(): null {
  const router = useRouter();

  const report = useCallback((result: MainCommandResultV2) => {
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isMainBridge(bridge)) return;
    void bridge.reportMainCommandResult(result).catch(() => {});
  }, []);

  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isMainBridge(bridge)) return;

    const handleNavigation = (envelope: NavigationCommandEnvelopeV2): void => {
      report({
        version: 2,
        commandId: envelope.commandId,
        status: "accepted",
        resultRefs: [],
        occurredAt: new Date().toISOString(),
      });
      router.push(routePath(envelope.command.route));
      report({
        version: 2,
        commandId: envelope.commandId,
        status: "completed",
        resultRefs: [],
        occurredAt: new Date().toISOString(),
      });
    };

    const handleInPage = (envelope: InPageCommandEnvelopeV2): void => {
      const path = inPageCommandPath(envelope.command);
      if (path === null) {
        report({
          version: 2,
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "unsupported_route",
          resultRefs: [],
          occurredAt: new Date().toISOString(),
        });
        return;
      }
      report({
        version: 2,
        commandId: envelope.commandId,
        status: "accepted",
        resultRefs: [],
        occurredAt: new Date().toISOString(),
      });
      router.push(path);
      report({
        version: 2,
        commandId: envelope.commandId,
        status: "completed",
        resultRefs: [],
        occurredAt: new Date().toISOString(),
      });
    };

    return bridge.onMainCommand((command) => {
      if (command.scope === "navigation") handleNavigation(command);
      else handleInPage(command);
    });
  }, [router, report]);

  return null;
}
