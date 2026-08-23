"use client";

/**
 * Durable delivery 展示气泡（文档 16 §14.3 + 22 方案记忆候选确认）。
 * 同一时刻最多一条；支持查看/关闭；system_event 携带 runId 时提供真实跳转
 * （经 Bridge V2 dispatchMainCommand 打开主窗口 Run 页）。
 * memory_candidate 渲染记忆确认卡：确认 / 纠正 / 忽略；
 * 纠正使用气泡内联编辑（§14.1），不再使用原生 window.prompt。
 */

import { useEffect, useMemo, useRef, useState } from "react";
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

const MEMORY_CORRECT_MAX = 200;

export function DeliveryBubble({ delivery, onOpenRun, onOpenConversation, onDismiss, onSnooze, onActed }: DeliveryBubbleProps) {
  const summary = useMemo(() => deliverySummary(delivery), [delivery]);
  const runId = useMemo(() => deliveryRunRef(delivery), [delivery]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // §14.1 记忆纠正：气泡内联编辑态（替代原生 window.prompt——无法样式化、
  // 阻塞主线程且读屏不友好）。
  const [correcting, setCorrecting] = useState(false);
  const [correctText, setCorrectText] = useState("");
  const correctInputRef = useRef<HTMLTextAreaElement | null>(null);

  const memoryId = delivery.kind === "memory_candidate"
    && delivery.payloadRef.kind === "memory_item"
    ? delivery.payloadRef.memoryItemId
    : null;
  const memoryPreview = delivery.kind === "memory_candidate"
    && delivery.payloadRef.kind === "memory_item"
    ? delivery.payloadRef.contentPreview
    : undefined;

  useEffect(() => {
    if (correcting) correctInputRef.current?.focus();
  }, [correcting]);

  const startCorrect = () => {
    setError(null);
    setCorrectText("");
    setCorrecting(true);
  };

  const cancelCorrect = () => {
    setCorrecting(false);
    setCorrectText("");
    setError(null);
  };

  const submitCorrect = async () => {
    if (!memoryId) return;
    const content = correctText.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await api.correctCompanionMemory(memoryId, content.slice(0, MEMORY_CORRECT_MAX));
      onActed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const actMemory = async (action: "confirm" | "dismiss") => {
    if (!memoryId) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "confirm") {
        await api.confirmCompanionMemory(memoryId);
      } else {
        await api.dismissCompanionMemory(memoryId);
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
        {correcting ? (
          <div className="pet-delivery-correct">
            <label className="pet-delivery-correct-label" htmlFor="pet-memory-correct-input">
              纠正这条记忆（≤{MEMORY_CORRECT_MAX} 字）：
            </label>
            {memoryPreview && (
              <p className="pet-delivery-correct-original">原记忆：{memoryPreview}</p>
            )}
            <textarea
              id="pet-memory-correct-input"
              ref={correctInputRef}
              className="pet-delivery-correct-input"
              value={correctText}
              maxLength={MEMORY_CORRECT_MAX}
              rows={3}
              placeholder={memoryPreview ? `我希望改成：${memoryPreview}` : "我希望改成："}
              onChange={(e) => setCorrectText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") cancelCorrect();
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitCorrect();
              }}
            />
            {error && <p className="pet-delivery-error">{error}</p>}
            <div className="pet-delivery-actions">
              <button
                type="button"
                className="pet-delivery-action"
                disabled={busy || !correctText.trim()}
                onClick={() => void submitCorrect()}
              >
                提交纠正
              </button>
              <button type="button" className="pet-delivery-link" disabled={busy} onClick={cancelCorrect}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="pet-delivery-body">{summary.body}</p>
            {error && <p className="pet-delivery-error">{error}</p>}
            <div className="pet-delivery-actions">
              <button type="button" className="pet-delivery-action" disabled={busy} onClick={() => void actMemory("confirm")}>
                确认
              </button>
              <button type="button" className="pet-delivery-link" disabled={busy} onClick={startCorrect}>
                纠正
              </button>
              <button type="button" className="pet-delivery-link" disabled={busy} onClick={() => void actMemory("dismiss")}>
                忽略
              </button>
            </div>
          </>
        )}
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
