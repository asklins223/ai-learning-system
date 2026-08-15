"use client";

/**
 * Pet 窗口 Bridge V2 消费（文档 16 §14.2/§14.4）。
 *
 * - 订阅 Main 页面 context（onPageContext）→ 缓存最新上下文（供后续 turn）；
 * - dispatchMainCommand：Pet 发起导航（open_route，V2 路由经 broker 转发主窗口）。
 * 浏览器（无 preload）fail closed。
 */

import { useCallback, useEffect, useState } from "react";
import type {
  AllowedMainRouteV2,
  InPageCommandEnvelopeV2,
  MainUiEventV2,
  NavigationCommandEnvelopeV2,
  PetMainCommandV2,
} from "@ailearn/shared";
import { isPetBridge, type PetBridgePageContext } from "./bridge-global";

export interface UsePetBridgeResult {
  bridgeAvailable: boolean;
  /** 主窗口最近一次发布的页面上下文（revoke 后为 null）。 */
  pageContext: PetBridgePageContext | null;
  /** 主窗口最近一次 UI 事件（§14.3：page.ready / graph.delta_applied 等）。 */
  uiEvent: MainUiEventV2 | null;
  /** 打开主窗口路由（V2 合同；broker 校验 sender 后转发；commandId 供回执匹配）。 */
  dispatchOpenRoute(route: AllowedMainRouteV2): Promise<{ accepted: boolean; commandId: string | null }>;
  /** 页内命令（§14.4：graph.focus / graph.restore 等；必须携带当前 pageInstance
   *  revision 供 freshness 校验；无有效 page context → fail closed）。 */
  dispatchInPageCommand(
    command: Exclude<PetMainCommandV2, { kind: "open_route" }>,
  ): Promise<{ accepted: boolean; commandId: string | null }>;
}

export function usePetBridgeContext(): UsePetBridgeResult {
  const [pageContext, setPageContext] = useState<PetBridgePageContext | null>(null);
  const [uiEvent, setUiEvent] = useState<MainUiEventV2 | null>(null);
  const [bridgeAvailable, setBridgeAvailable] = useState(false);

  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isPetBridge(bridge)) return;
    setBridgeAvailable(true);
    const offContext = bridge.onPageContext((ctx) => {
      setPageContext(ctx.revoked ? null : ctx);
    });
    const offUiEvent = bridge.onUiEvent((event) => {
      // §14.3：UI 事件（page.ready / graph.delta_applied 等）→ 最近事件缓存，
      // 消费方（delta 回执表达等）按需读取；command 回执暂无需表达。
      setUiEvent(event as MainUiEventV2 | null);
    });
    return () => {
      offContext();
      offUiEvent();
    };
  }, []);

  const dispatchInPageCommand = useCallback(async (
    command: Exclude<PetMainCommandV2, { kind: "open_route" }>,
  ): Promise<{ accepted: boolean; commandId: string | null }> => {
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isPetBridge(bridge) || !pageContext) {
      // 无有效 page context（未发布/已 revoke）：freshness 无法满足，fail closed。
      return { accepted: false, commandId: null };
    }
    const envelope: InPageCommandEnvelopeV2 = {
      version: 2,
      scope: "in_page",
      commandId: crypto.randomUUID(),
      targetPageInstanceId: pageContext.pageInstanceId,
      expectedContextRevision: pageContext.revision,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      command,
    };
    try {
      const result = await bridge.dispatchMainCommand(envelope);
      return { accepted: result.accepted, commandId: envelope.commandId };
    } catch {
      return { accepted: false, commandId: null };
    }
  }, [pageContext]);

  const dispatchOpenRoute = useCallback(async (route: AllowedMainRouteV2): Promise<{
    accepted: boolean;
    commandId: string | null;
  }> => {
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isPetBridge(bridge)) return { accepted: false, commandId: null };
    const envelope: NavigationCommandEnvelopeV2 = {
      version: 2,
      scope: "navigation",
      commandId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      command: { kind: "open_route", route },
    };
    try {
      const result = await bridge.dispatchMainCommand(envelope);
      return { accepted: result.accepted, commandId: envelope.commandId };
    } catch {
      return { accepted: false, commandId: null };
    }
  }, []);

  return { bridgeAvailable, pageContext, uiEvent, dispatchOpenRoute, dispatchInPageCommand };
}
