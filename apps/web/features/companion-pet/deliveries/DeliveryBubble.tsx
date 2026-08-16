"use client";

/**
 * Durable delivery 展示气泡（文档 16 §14.3 + 22 方案记忆候选确认）。
 * 同一时刻最多一条；支持查看/关闭；system_event 携带 runId 时提供真实跳转
 * （经 Bridge V2 dispatchMainCommand 打开主窗口 Run 页）。
 * memory_candidate 渲染记忆确认卡：确认 / 纠正 / 忽略。
 */

import { useMemo, useState } from "react";
import {
  deliveryRunRef,
  deliverySummary,
  type AssistantDeliveryV2,
} from "./delivery-client";
import { api } from "@/lib/api";
import "./delivery-bubble.css";

export interface DeliveryBubbleProps {
  delivery: AssistantDeliveryV2;
  onOpenRun?: (runId: string) => void;
  onOpenConversation?: () => void;
  onDismiss: () => void;
  /** §10.2 snooze：稍后提醒（服务端 snoozedUntil 展示层）。 */
  onSnooze?: () => void;
  onActed: () => void;
}

export function DeliveryBubble({ delivery, onOpenRun, onOpenConversation, onDismiss, onSnooze, onActed }: DeliveryBubbleProps) {
  const summary = useMemo(() => deliverySummary(delivery), [delivery]);
  const runId = useMemo(() => deliveryRunRef(delivery), [delivery]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const memoryId = delivery.kind === "memory_candidate"
    && delivery.payloadRef.kind === "memory_item"
    ? delivery.payloadRef.memoryItemId
    : null;

  const actMemory = async (action: "confirm" | "dismiss" | "correct") => {
    if (!memoryId) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "confirm") {
        await api.confirmCompanionMemory(memoryId);
      } else if (action === "dismiss") {
        await api.dismissCompanionMemory(memoryId);
      } else {
        const content = window.prompt("纠正为：");
        if (!content?.trim()) {
          setBusy(false);
          return;
        }
        await api.correctCompanionMemory(memoryId, content.trim());
      }
      onActed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (memoryId) {
    return (
      <div className="pet-delivery-bubble" role="status" aria-live="polite">
        <p className="pet-delivery-title">{summary.title}</p>
        <p className="pet-delivery-body">{summary.body}</p>
        {error && <p className="pet-delivery-error">{error}</p>}
        <div className="pet-delivery-actions">
          <button type="button" className="pet-delivery-action" disabled={busy} onClick={() => void actMemory("confirm")}>
            确认
          </button>
          <button type="button" className="pet-delivery-link" disabled={busy} onClick={() => void actMemory("correct")}>
            纠正
          </button>
          <button type="button" className="pet-delivery-link" disabled={busy} onClick={() => void actMemory("dismiss")}>
            忽略
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pet-delivery-bubble" role="status" aria-live="polite">
      <p className="pet-delivery-title">{summary.title}</p>
      <p className="pet-delivery-body">{summary.body}</p>
      <div className="pet-delivery-actions">
        {runId ? (
          <button
            type="button"
            className="pet-delivery-action"
            onClick={() => {
              onOpenRun?.(runId);
              onActed();
            }}
          >
            查看结果
          </button>
        ) : (
          <button
            type="button"
            className="pet-delivery-action"
            onClick={() => {
              onOpenConversation?.();
              onActed();
            }}
          >
            打开对话
          </button>
        )}
        {onSnooze ? (
          <button type="button" className="pet-delivery-link" onClick={onSnooze}>
            稍后提醒
          </button>
        ) : null}
        <button type="button" className="pet-delivery-link" onClick={onDismiss}>
          知道了
        </button>
      </div>
    </div>
  );
}
