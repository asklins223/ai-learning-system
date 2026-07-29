"use client";

/**
 * v0.6 Review Focus Route (计划 §9.4)
 *
 * Loads only sanitized review metadata before handing the session to the
 * shared question-first experience. No card title, claim, quote, or source
 * content is requested while the learner is answering.
 */

import "@/app/styles/validation-focus.css";
import "@/app/styles/review-v06.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { FocusSessionHeader, ValidationFocus } from "@/components/ValidationFocus";
import { Icon } from "@/components/ui/icons";
import { api, ApiError, type SanitizedReviewMeta } from "@/lib/api";
import { isQuestionFirstUIEnabled } from "@/lib/feature-flags";

export default function ReviewFocusPage() {
  const params = useParams<{ scheduleId: string }>();
  const router = useRouter();
  const scheduleId = params.scheduleId;
  const questionFirstEnabled = isQuestionFirstUIEnabled();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<SanitizedReviewMeta | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadMeta = useCallback(async () => {
    if (!scheduleId || !questionFirstEnabled) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getReviewFocusMeta(scheduleId);
      if (!mountedRef.current) return;

      if (result.status !== "pending") {
        setMeta(null);
        setError("这条复习已经完成，或不再需要处理。");
        setLoading(false);
        return;
      }

      setMeta(result);
      setLoading(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setMeta(null);
      // 404（被删除/已完成被取代/不属于当前用户的 schedule）不是网络问题，
      // 提示"检查网络后重试"只会引导用户做无效重试。
      if (err instanceof ApiError && err.status === 404) {
        setError("这条复习不存在，或已经完成、不再需要处理。");
      } else {
        setError("暂时无法加载这条复习，请检查网络后重试。");
      }
      setLoading(false);
    }
  }, [questionFirstEnabled, scheduleId]);

  useEffect(() => {
    if (!questionFirstEnabled) return;
    void loadMeta();
  }, [loadMeta, questionFirstEnabled]);

  if (!questionFirstEnabled) {
    return <ReviewFocusGate mode="disabled" />;
  }

  if (loading) {
    return <ReviewFocusGate mode="loading" />;
  }

  if (error || !meta) {
    return (
      <ReviewFocusGate
        mode="error"
        error={error ?? "这条复习暂时不可用。"}
        onRetry={() => void loadMeta()}
      />
    );
  }

  return (
    <ValidationFocus
      cardId={meta.cardId}
      keyPointId={meta.keyPointId ?? undefined}
      reviewScheduleId={scheduleId}
      exitHref="/review"
      exitLabel="返回复习队列"
      onExit={() => router.push("/review")}
    />
  );
}

function ReviewFocusGate({
  mode,
  error,
  onRetry,
}: {
  mode: "loading" | "error" | "disabled";
  error?: string;
  onRetry?: () => void;
}) {
  const isLoading = mode === "loading";
  const isDisabled = mode === "disabled";

  return (
    <div className="validation-focus" data-phase={isLoading ? "eligibility-check" : isDisabled ? "question_blocked" : "error"} data-context="review">
      <FocusSessionHeader
        exitHref="/review"
        exitLabel="返回复习队列"
        statusLabel={isLoading ? "准备中" : isDisabled ? "已暂停" : "需要处理"}
        statusTone={isLoading ? "running" : isDisabled ? "warning" : "danger"}
        sessionKind="review"
      />

      <div className="validation-focus-body">
        <div className="validation-focus-body-inner">
          {isLoading ? (
            <section
              className="validation-focus-route-loading review-focus-route-loading"
              role="status"
              aria-live="polite"
              aria-busy="true"
              aria-labelledby="review-focus-route-loading-title"
            >
              <span className="review-focus-route-loading-icon" aria-hidden="true">
                <Icon.Review />
              </span>
              <div className="review-focus-route-loading-copy">
                <span className="validation-focus-state-eyebrow">间隔复习</span>
                <h1 id="review-focus-route-loading-title">正在打开这轮复习</h1>
                <p>正在确认到期任务，学习卡内容仍保持隐藏。</p>
              </div>
              <span className="review-focus-route-loading-track" aria-hidden="true">
                <i />
              </span>
            </section>
          ) : isDisabled ? (
            <div className="validation-focus-blocked">
              <span className="validation-focus-blocked-icon" aria-hidden="true"><Icon.Lock /></span>
              <span className="validation-focus-state-eyebrow">安全回滚模式</span>
              <h1 className="validation-focus-blocked-title">复习会话已暂时关闭</h1>
              <p className="validation-focus-blocked-detail">当前版本不会启动问题优先验证。你的学习进度不会受到影响。</p>
              <Link href="/cards" className="validation-focus-btn validation-focus-btn--secondary validation-focus-state-exit">
                返回学习卡
              </Link>
            </div>
          ) : (
            <div className="validation-focus-state">
              <span className="validation-focus-state-symbol validation-focus-state-symbol--warning" aria-hidden="true">
                <Icon.AlertCircle />
              </span>
              <span className="validation-focus-state-eyebrow">这轮复习没有开始</span>
              <h1 className="validation-focus-state-title">暂时无法打开</h1>
              <p className="validation-focus-state-detail" role="alert">{error}</p>
              <div className="validation-focus-state-actions">
                <button type="button" className="validation-focus-btn validation-focus-btn--primary" onClick={onRetry}>
                  <Icon.Refresh aria-hidden="true" />
                  重新加载
                </button>
                <Link href="/review" className="validation-focus-btn validation-focus-btn--secondary">
                  返回队列
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
