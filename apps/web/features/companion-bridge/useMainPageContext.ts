"use client";

/**
 * Main 窗口 Bridge V2 页面上下文发布（文档 16 §14.2/§14.6）。
 *
 * 页面挂载后调用：publish → broker 注册 + 推给 Pet；每 10 秒续租；
 * 内容变化重新 publish（旧 context 立即 revoke 语义由 broker 覆盖实现）；
 * 卸载 revoke。浏览器（无 preload）fail closed。
 *
 * 额外职责（文档 16 §14.3/§11.4）：
 * - publish 成功后发射一次 `page.ready` UI 事件（回执链路起点）；
 * - 返回 `publishUiEvent`：页面在显影/选择等时刻发射 UI 事件
 *   （如 graph 页 delta 显影后发 `graph.delta_applied`，Pet 据此表达结果）。
 *
 * input 用 JSON 序列化作为 effect 依赖：引用变化不触发，字段变化才重新发布。
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EntityRefV2, MainPageContextInputV2, MainUiEventV2 } from "@ailearn/shared";
import { isMainBridge } from "./bridge-global";

const RENEW_INTERVAL_MS = 10_000;

export interface MainPageContextBridge {
  /** 发射 UI 事件（§14.3）；未发布成功（无 pageInstance/revision）或浏览器无 bridge → false。 */
  publishUiEvent(
    type: MainUiEventV2["type"],
    safeRefs?: EntityRefV2[],
    commandId?: string,
  ): Promise<boolean>;
}

export function useMainPageContext(input: MainPageContextInputV2 | null): MainPageContextBridge {
  // F16（round4）：JSON 序列化用 useMemo——input 引用稳定时（调用方已 useMemo /
  // 稳定对象）避免每渲染重跑 stringify（大 structure input 在动画密集页是浪费）。
  // input 每次新建对象时仍会重算（无可避免），但至少对引用稳定的调用方省掉成本。
  const inputKey = useMemo(() => (input === null ? null : JSON.stringify(input)), [input]);
  const inputRef = useRef<MainPageContextInputV2 | null>(input);
  // 最近一次成功 publish 的 broker 侧定位（UI 事件 freshness 校验用）。
  const pageRef = useRef<{ pageInstanceId: string; contextRevision: string } | null>(null);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    if (inputKey === null) return;
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isMainBridge(bridge)) return;
    let cancelled = false;
    let contextId: string | null = null;
    let revision = "";
    let pageInstanceId = "";
    let readySent = false;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;

    const publish = async (): Promise<void> => {
      const current = inputRef.current;
      if (!current || cancelled) return;
      try {
        const result = await bridge.publishPageContext(current);
        if (cancelled || !result.accepted) return;
        contextId = result.contextId ?? null;
        revision = result.revision ?? "";
        pageInstanceId = result.pageInstanceId ?? "";
        if (pageInstanceId) {
          pageRef.current = { pageInstanceId, contextRevision: revision };
        }
        // §14.3：发布成功即页面就绪回执（Pet 侧可据此恢复附着）。
        if (!readySent && pageInstanceId && revision) {
          readySent = true;
          void bridge.publishUiEvent({
            pageInstanceId,
            contextRevision: revision,
            type: "page.ready",
            safeRefs: [],
          }).catch(() => {});
        }
        scheduleRenew();
      } catch {
        // broker 不可达/窗口销毁：静默 fail closed，下次输入变化重试。
      }
    };

    const scheduleRenew = (): void => {
      if (renewTimer !== null) clearTimeout(renewTimer);
      renewTimer = setTimeout(() => {
        renewTimer = null;
        if (!contextId || cancelled) return;
        void bridge.renewPageContext({ contextId, expectedRevision: revision })
          .then((result) => {
            if (cancelled) return;
            if (result.accepted) {
              revision = result.revision ?? revision;
              if (pageInstanceId) {
                pageRef.current = { pageInstanceId, contextRevision: revision };
              }
              scheduleRenew();
            } else {
              // stale/expired：重新发布（broker 以新 pageInstance 覆盖旧记录）。
              void publish();
            }
          })
          .catch(() => {
            if (!cancelled) scheduleRenew(); // 瞬时失败：下一周期再试
          });
      }, RENEW_INTERVAL_MS);
    };

    void publish();
    return () => {
      cancelled = true;
      if (renewTimer !== null) clearTimeout(renewTimer);
      if (contextId) {
        void bridge.revokePageContext({ contextId, expectedRevision: revision }).catch(() => {});
      }
    };
    // inputKey 变化（route/entity/interaction 等字段）→ 重新 publish。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey]);

  const publishUiEvent = useCallback(async (
    type: MainUiEventV2["type"],
    safeRefs?: EntityRefV2[],
    commandId?: string,
  ): Promise<boolean> => {
    const bridge = typeof window !== "undefined" ? window.companionBridge : undefined;
    if (!isMainBridge(bridge)) return false;
    const page = pageRef.current;
    if (!page) return false; // 尚未发布成功：无合法 pageInstance，拒绝发射。
    try {
      const result = await bridge.publishUiEvent({
        pageInstanceId: page.pageInstanceId,
        contextRevision: page.contextRevision,
        type,
        safeRefs: safeRefs ?? [],
        commandId,
      });
      return result.accepted;
    } catch {
      return false;
    }
  }, []);

  return useMemo(() => ({ publishUiEvent }), [publishUiEvent]);
}
