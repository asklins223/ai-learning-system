"use client";

/**
 * Pet 窗口 delta 回执表达（文档 16 §11.4 第 9 步）。
 *
 * 主窗口星图显影完成后经 broker 发 `graph.delta_applied`（safeRefs 带
 * change_set ref）；本组件查询服务端 delta（一次）并按真实 change kind 表达：
 * - canonical      → 短庆祝（"星图已更新"）；
 * - practice_only  → 明示练习已记录、未形成正式变化（§15.5 零正式点亮）；
 * - 查询失败       → 中性说明（不庆祝、不编造）。
 *
 * 一次性提示（6s 自动消失）；journey 卡片可见时隐藏（§10.2 同一时刻一个 cue，
 * 与 PetDeliveryLayer 同层互斥由父级布局控制）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import type { MainUiEventV2 } from "@ailearn/shared";

export interface DeltaReceiptNoticeProps {
  /** 主窗口最近一次 UI 事件（usePetBridgeContext.uiEvent）。 */
  uiEvent: MainUiEventV2 | null;
  /** journey 卡片可见时抑制（与主动 cue 互斥）。 */
  journeyVisible: boolean;
  /** 显示状态变化（§10.2 同一时刻一个 cue：父级据此抑制 delivery）。 */
  onVisibleChange?: (visible: boolean) => void;
}

type NoticeKind = "canonical" | "practice_only" | "neutral";

const NOTICE_TEXT: Record<NoticeKind, string> = {
  canonical: "星图已更新：本次学习形成了正式变化",
  practice_only: "练习已记录，未形成正式变化",
  neutral: "本次学习已结束",
};

export function DeltaReceiptNotice({ uiEvent, journeyVisible, onVisibleChange }: DeltaReceiptNoticeProps) {
  const { state } = usePetRuntime();
  // §10.2 同一时刻一个 cue：Pet 本地录音/播报期间不显示回执（与 delivery 同规则）。
  const voiceBusy =
    state.voice.kind === "requesting_permission" ||
    state.voice.kind === "listening" ||
    state.voice.kind === "finalizing" ||
    state.voice.kind === "transcribing" ||
    state.voice.kind === "speaking";
  const [notice, setNotice] = useState<NoticeKind | null>(null);
  const [visible, setVisible] = useState(false);
  const lastEventIdRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const show = useCallback((kind: NoticeKind) => {
    setNotice(kind);
    setVisible(true);
    onVisibleChange?.(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setVisible(false);
      onVisibleChange?.(false);
    }, 6_000);
  }, [onVisibleChange]);

  // 卸载/重渲染清理：离开时通知父级不可见。
  useEffect(() => () => {
    onVisibleChange?.(false);
  }, [onVisibleChange]);

  useEffect(() => {
    if (journeyVisible) return;
    if (!uiEvent || uiEvent.type !== "graph.delta_applied") return;
    if (lastEventIdRef.current === uiEvent.eventId) return; // 同事件只表达一次
    lastEventIdRef.current = uiEvent.eventId;
    const changeSetRef = (uiEvent.safeRefs ?? []).find((ref) => ref.kind === "change_set") as
      | { kind: "change_set"; changeSetId: string }
      | undefined;
    if (!changeSetRef) {
      show("neutral");
      return;
    }
    // 一次真实查询：按 change kind 表达（§11.4 变化规则）。
    let cancelled = false;
    void api.getProjectionDelta(changeSetRef.changeSetId)
      .then((raw) => {
        if (cancelled) return;
        const kind = (raw as { kind?: string } | null)?.kind;
        if (kind === "canonical") show("canonical");
        else if (kind === "practice_only") show("practice_only");
        else show("neutral");
      })
      .catch(() => {
        if (!cancelled) show("neutral");
      });
    return () => {
      cancelled = true;
    };
  }, [uiEvent, journeyVisible, show]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  if (!visible || !notice || voiceBusy) return null;
  return (
    <div className="pet-delta-notice" role="status" aria-live="polite">
      <p className="pet-delta-notice-text">{NOTICE_TEXT[notice]}</p>
    </div>
  );
}
