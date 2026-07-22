"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ReviewAttemptHistoryItem } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import {
  formatRelativeTime,
  formatScheduleChange,
  getOutcomeMeta,
  getReasonCodeLabel,
  getAnswerTypeLabel,
  getUnderstandingEffectLabel,
} from "@/lib/review-attempt-format";

interface ReviewAttemptHistoryProps {
  reviewScheduleId: string | null;
  cardTitle?: string;
}

type HistoryLoadState =
  | {
      scheduleId: string;
      status: "loading";
      items: null;
      truncated: false;
    }
  | {
      scheduleId: string;
      status: "ready";
      items: ReviewAttemptHistoryItem[];
      truncated: boolean;
    }
  | {
      scheduleId: string;
      status: "error";
      items: null;
      truncated: false;
    };

export function ReviewAttemptHistory({
  reviewScheduleId,
  cardTitle,
}: ReviewAttemptHistoryProps) {
  const [loadState, setLoadState] = useState<HistoryLoadState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const requestIdRef = useRef(0);

  const loadHistory = useCallback(async (scheduleId: string) => {
    const requestId = ++requestIdRef.current;
    setLoadState({
      scheduleId,
      status: "loading",
      items: null,
      truncated: false,
    });
    try {
      const result = await api.listReviewAttemptHistory({
        reviewScheduleId: scheduleId,
        limit: 20,
      });
      if (requestId !== requestIdRef.current) return;
      setLoadState({
        scheduleId,
        status: "ready",
        items: result.items,
        truncated: result.nextCursor !== null,
      });
    } catch {
      if (requestId !== requestIdRef.current) return;
      setLoadState({
        scheduleId,
        status: "error",
        items: null,
        truncated: false,
      });
    }
  }, []);

  useEffect(() => {
    requestIdRef.current += 1;
    setLoadState(null);
  }, [reviewScheduleId]);

  useEffect(() => {
    if (!reviewScheduleId || !expanded) return;
    void loadHistory(reviewScheduleId);
  }, [reviewScheduleId, expanded, loadHistory]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  if (!reviewScheduleId) return null;

  const currentLoadState =
    loadState?.scheduleId === reviewScheduleId ? loadState : null;
  const history = currentLoadState?.status === "ready" ? currentLoadState.items : null;
  const loading = currentLoadState?.status === "loading";
  const error = currentLoadState?.status === "error";
  const itemCount = history?.length ?? 0;

  return (
    <section
      className="review-attempt-history"
      data-ui="review-attempt-history"
      data-expanded={expanded ? "true" : "false"}
      aria-labelledby="review-attempt-history-title"
    >
      <button
        type="button"
        className="review-attempt-history-toggle"
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
        aria-controls="review-attempt-history-body"
      >
        <span className="review-attempt-history-toggle-copy">
          <strong id="review-attempt-history-title">复习轨迹</strong>
          <small>查看每一轮如何改变复习安排</small>
        </span>
        <span className="review-attempt-history-toggle-count">
          {loading ? "读取中" : history ? `${itemCount} 条记录` : "最近 20 条"}
        </span>
        <span
          className="review-attempt-history-chevron"
          data-expanded={expanded ? "true" : "false"}
          aria-hidden="true"
        >
          <Icon.Chevron />
        </span>
      </button>

      {expanded && (
        <div id="review-attempt-history-body" className="review-attempt-history-body">
          {loading ? (
            <div className="review-attempt-history-loading" aria-busy="true">
              <span className="review-attempt-history-spinner" aria-hidden="true" />
              <span>正在读取复习轨迹…</span>
            </div>
          ) : error ? (
            <div className="review-attempt-history-error" role="alert">
              <Icon.Warn aria-hidden="true" />
              <span>复习轨迹暂时无法读取</span>
              <button type="button" onClick={() => void loadHistory(reviewScheduleId)}>
                重试
              </button>
            </div>
          ) : !history || history.length === 0 ? (
            <div className="review-attempt-history-empty">
              <strong>从这一轮开始留下轨迹</strong>
              <p>
                {cardTitle
                  ? `「${cardTitle}」还没有复习记录。完成后，这里会说明结果与下一次安排。`
                  : "还没有复习记录。完成后，这里会说明结果与下一次安排。"}
              </p>
            </div>
          ) : (
            <>
              <ol className="review-attempt-history-list" aria-label="最近 20 条复习记录">
                {history.map((item, index) => {
                  const outcome = item.outcome
                    ? getOutcomeMeta(item.outcome) ?? {
                        label: item.outcome,
                        tone: "muted" as const,
                      }
                    : null;
                  const reasonLabel = getReasonCodeLabel(item.scheduleReasonCode);
                  const answerTypeLabel = getAnswerTypeLabel(item.answerType);
                  const understandingEffectLabel = getUnderstandingEffectLabel(
                    item.understandingEffect,
                  );
                  const scheduleChange = formatScheduleChange(
                    item.scheduleBeforeIntervalDays,
                    item.scheduleAfterIntervalDays,
                  );
                  const isInProgress = item.status === "started" && !item.completedAt;

                  return (
                    <li
                      key={item.id}
                      className={`review-attempt-history-item tone-${outcome?.tone ?? "muted"}`}
                    >
                      <span className="review-attempt-history-marker" aria-hidden="true" />
                      <article className="review-attempt-history-entry">
                        <header className="review-attempt-history-item-header">
                          <div className="review-attempt-history-result">
                            <span className="review-attempt-history-item-index">
                              第 {history.length - index} 轮
                            </span>
                            {outcome && (
                              <span
                                className={`review-attempt-history-item-outcome tone-${outcome.tone}`}
                              >
                                {outcome.label}
                              </span>
                            )}
                            {isInProgress && (
                              <span className="review-attempt-history-item-status">尚未完成</span>
                            )}
                          </div>
                          <time
                            dateTime={item.completedAt ?? item.startedAt}
                            suppressHydrationWarning
                            className="review-attempt-history-item-time"
                          >
                            {formatRelativeTime(item.completedAt ?? item.startedAt)}
                          </time>
                        </header>

                        <div className="review-attempt-history-summary">
                          <strong>
                            {isInProgress
                              ? "等待提交本轮回想"
                              : reasonLabel ?? "复习安排已更新"}
                          </strong>
                          {!isInProgress && <span>{scheduleChange}</span>}
                        </div>

                        <dl className="review-attempt-history-item-body">
                          {answerTypeLabel && (
                            <div className="review-attempt-history-row">
                              <dt>方式</dt>
                              <dd>{answerTypeLabel}</dd>
                            </div>
                          )}
                          {item.confidence !== null && (
                            <div className="review-attempt-history-row">
                              <dt>置信度</dt>
                              <dd>{item.confidence}%</dd>
                            </div>
                          )}
                          {item.skipReason && (
                            <div className="review-attempt-history-row">
                              <dt>处理</dt>
                              <dd>{item.skipReason === "later" ? "稍后再看" : item.skipReason}</dd>
                            </div>
                          )}
                          {understandingEffectLabel && (
                            <div className="review-attempt-history-row">
                              <dt>理解状态</dt>
                              <dd>{understandingEffectLabel}</dd>
                            </div>
                          )}
                          {item.nextReviewAt && (
                            <div className="review-attempt-history-row">
                              <dt>下次复习</dt>
                              <dd>
                                <time dateTime={item.nextReviewAt} suppressHydrationWarning>
                                  {formatRelativeTime(item.nextReviewAt)}
                                </time>
                              </dd>
                            </div>
                          )}
                        </dl>
                      </article>
                    </li>
                  );
                })}
              </ol>
              {currentLoadState?.status === "ready" && currentLoadState.truncated && (
                <p className="review-attempt-history-limit-note">当前只展示最近 20 条记录。</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
