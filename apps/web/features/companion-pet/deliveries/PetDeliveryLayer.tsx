"use client";

import { useEffect } from "react";

/**
 * Pet 窗口 delivery 展示层（文档 16 §14.3）：订阅 inbox → lease → 气泡。
 * 与 Journey 卡片互斥展示（同一时刻最多一个可见 cue，§10.2）。
 */

import { DeliveryBubble } from "./DeliveryBubble";
import { useDeliveryInbox } from "./useDeliveryInbox";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";

export interface PetDeliveryLayerProps {
  enabled: boolean;
  /** journey 卡片可见时抑制 delivery（避免两个 cue 同时出现）。 */
  journeyVisible: boolean;
  /** §10.2：delta 回执 notice 显示期间抑制 delivery（同一时刻一个 cue）。 */
  suppressed?: boolean;
  /** 显示状态变化（§9.3 v2Signals.deliveryVisible 真实反映）。 */
  onVisibleChange?: (visible: boolean) => void;
  onOpenRun?: (runId: string) => void;
  onOpenConversation?: () => void;
}

export function PetDeliveryLayer({
  enabled,
  journeyVisible,
  suppressed = false,
  onVisibleChange,
  onOpenRun,
  onOpenConversation,
}: PetDeliveryLayerProps) {
  const inbox = useDeliveryInbox(enabled);
  // §20.2 Gate"正式输入/录音期间 0 主动提示"：Pet 本地录音/转写/播报期间
  // 不显示 delivery（聆听/思考/说话都是用户正在与伴星交互的敏感窗口）。
  const { state } = usePetRuntime();
  const voiceBusy =
    state.voice.kind === "requesting_permission" ||
    state.voice.kind === "listening" ||
    state.voice.kind === "finalizing" ||
    state.voice.kind === "transcribing" ||
    state.voice.kind === "speaking";
  const display = inbox.display;
  const showing = !journeyVisible && !suppressed && !voiceBusy && display.kind === "showing";
  // §9.3：真实显示状态上报（V2 投影 cue_visible 信号）；卸载时复位。
  useEffect(() => {
    onVisibleChange?.(showing);
    return () => onVisibleChange?.(false);
  }, [showing, onVisibleChange]);
  if (!showing) return null;
  return (
    <DeliveryBubble
      delivery={display.delivery}
      onOpenRun={onOpenRun}
      onOpenConversation={onOpenConversation}
      onDismiss={() => void inbox.dismiss()}
      // §10.2 snooze：稍后提醒 30 分钟（服务端 snoozedUntil，不消费 delivery）。
      onSnooze={() => void inbox.dismiss(30)}
      onActed={() => void inbox.acted()}
    />
  );
}
