"use client";

/**
 * Durable delivery 展示气泡（文档 16 §14.3）。
 * 同一时刻最多一条；支持查看/关闭；system_event 携带 runId 时提供真实跳转
 * （经 Bridge V2 dispatchMainCommand 打开主窗口 Run 页）。
 */

import { useMemo } from "react";
import {
  deliveryRunRef,
  deliverySummary,
  type AssistantDeliveryV2,
} from "./delivery-client";
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
