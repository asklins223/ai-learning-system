"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { companionClient } from "../api/companion-client";
import { companionReducer } from "./companion-reducer";
import { createInitialSurfaceState, pageHelpModel } from "./surface-model";
import { CompanionAnchor } from "../surfaces/CompanionAnchor";
import { CompanionPanel } from "../surfaces/CompanionPanel";

export interface CompanionRuntimeProviderProps {
  pageKind?: string;
}

export function CompanionRuntimeProvider({ pageKind = "workspace" }: CompanionRuntimeProviderProps) {
  const [state, dispatch] = useReducer(companionReducer, createInitialSurfaceState(pageKind));
  const [overviewLoaded, setOverviewLoaded] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const firstRenderRef = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    void companionClient.getOverview(controller.signal)
      .then((overview) => {
        setOverviewLoaded(true);
        dispatch({ type: "hydrate", hidden: !overview.account.globalEnabled, pageKind });
      })
      .catch((err) => {
        // 主动 abort（pageKind 切换/卸载）→ 静默返回，不处理迟到结果。
        if (controller.signal.aborted) return;
        // 接口降级时无法确认账号 globalEnabled：按 global_off 契约保守隐藏
        //（fail-closed——绝不能把未授权表面渲染成召唤入口），不保留 anchor。
        setOverviewLoaded(true);
        dispatch({ type: "hydrate", hidden: true, pageKind });
        void err;
      });
    return () => controller.abort();
  }, [pageKind]);

  // pageKind 切换时收起面板；跳过首次渲染（初始 state 已是 anchor，
  // mount 时再 dispatch 一次 close_panel 是冗余渲染）。
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    dispatch({ type: "close_panel", pageKind });
  }, [pageKind]);

  const model = useMemo(() => pageHelpModel(pageKind), [pageKind]);
  const summon = useCallback(() => {
    // returnFocusId 取真实 anchor id（useId 生成，页面级唯一），不依赖硬编码 id。
    dispatch({ type: "summon", model, returnFocusId: anchorRef.current?.id ?? undefined });
  }, [model]);
  const close = useCallback(() => {
    dispatch({ type: "close_panel", pageKind });
    window.requestAnimationFrame(() => anchorRef.current?.focus({ preventScroll: true }));
  }, [pageKind]);

  if (!overviewLoaded || state.kind === "hidden") return null;
  if (state.kind === "panel") {
    return (
      <CompanionPanel
        model={state.model}
        onClose={close}
        onAction={() => close()}
      />
    );
  }
  return <CompanionAnchor ref={anchorRef} onSummon={summon} />;
}
