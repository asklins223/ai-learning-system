"use client";

/**
 * v0.6 Question-first Validation Focus Session Component (计划 §9.2, §9.3)
 *
 * Implements the trusted mastery closed-loop UI:
 * - Independent Focus page (no card title/claim/quote/evidence visible during answering)
 * - Question-first answering with draft autosave
 * - Source reveal with assistance tracking (irreversible)
 * - Result reveal via explicit action
 * - All submission states: preparing → ready → answering → evaluating → completed/stale/blocked
 *
 * Security invariants (计划 §10.4):
 * - unassisted_answering phase shows NO hidden structural fields
 * - All API responses use Cache-Control: private, no-store (server-side)
 * - Draft revision CAS prevents silent overwrite
 * - Assistance is irreversible once recorded
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type StartSessionResult,
  type GetSessionResult,
  type RevealResultData,
} from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { Icon } from "@/components/ui/icons";
import { SessionProgressStage } from "@/components/validation/SessionProgressStage";
import { isQuestionFirstUIEnabled } from "@/lib/feature-flags";
import {
  clearActionKey,
  getOrCreateActionKey,
} from "@/lib/validation-action-keys";

// ─── Constants ──────────────────────────────────────────────────────────

const ANSWER_LIMIT = 10_000;
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 80; // ~2 minutes
const DRAFT_DEBOUNCE_MS = 2000;

const TYPE_LABELS: Record<string, string> = {
  explain: "解释",
  example: "举例",
  apply: "应用",
};

// ─── Types ──────────────────────────────────────────────────────────────

type Phase =
  | "eligibility-check"
  | "question_preparing"
  | "question_retryable"
  | "question_blocked"
  | "answering"
  | "evaluation_pending"
  | "evaluation_retryable"
  | "result_pending_reveal"
  | "completed"
  | "stale"
  | "abandoned"
  | "error";

interface FocusState {
  phase: Phase;
  terminalStatus?: "stale";
  submissionId?: string;
  question?: { questionId: string; questionType: string; question: string; keyPointOrdinal?: number };
  draftRevision: number;
  draftAnswer: string;
  selfConfidence: 1 | 2 | 3 | null;
  assistanceLevel: string;
  jobId?: string;
  error?: string;
  result?: RevealResultData;
  sourceAvailable?: boolean;
  unassistedEligibleAt?: string;
  blockedReason?: string;
}

type ActionName =
  | "start"
  | "draft-reload"
  | "submit"
  | "unable"
  | "source"
  | "result"
  | "retry-question"
  | "retry-evaluation"
  | "abandon";

type DraftSaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict";

interface DraftSnapshot {
  answer: string;
  confidence: 1 | 2 | 3 | null;
  idempotencyKey?: string;
}

function clearActionKeyOnDefinitiveFailure(
  store: Map<string, string>,
  slot: string,
  error: unknown,
): void {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    clearActionKey(store, slot);
  }
}

/**
 * 这些错误码意味着"本地视图已经落后于服务端真实状态"（题目过期转 stale、
 * 已完成、状态迁移非法、任务不可重试等）。此时仅提示文案没有意义——用户
 * 每次重试都会得到同样的错误。应当用 restoreSession 收敛到服务端状态。
 * 注意：draft_conflict / idempotency_key_reused 不在此列——草稿冲突有专门的
 * 覆盖/重载 UI，自动恢复会覆盖用户未保存的本地输入。
 */
function shouldResyncSession(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "draft_conflict" || error.code === "idempotency_key_reused") return false;
  return (
    error.code === "question_expired"
    || error.code === "already_completed"
    || error.code === "invalid_state_transition"
    || error.code === "not_retryable"
    || error.code === "submission_locked"
  );
}

function getValidationActionErrorMessage(action: ActionName, error?: unknown): string {
  if (error instanceof ApiError && error.code === "question_expired") {
    return "题目或原文内容已发生变化，本轮验证已失效，正在为你刷新会话状态。";
  }
  if (error instanceof ApiError && error.status === 409) {
    return "会话状态已在其他页面发生变化，请重新载入后再试。";
  }

  switch (action) {
    case "start":
      return "暂时无法开始验证，请检查网络后重试。";
    case "draft-reload":
      return "暂时无法重新载入草稿，请检查网络后重试。";
    case "submit":
      return "回答暂时没有提交成功，内容仍保留在本页，请重试。";
    case "unable":
      return "暂时无法结束本轮，草稿仍保留在本页，请重试。";
    case "source":
      return "暂时无法记录原文查看状态，请检查网络后重试。";
    case "result":
      return "暂时无法获取验证结果，请检查网络后重试。";
    case "retry-question":
      return "题目仍未准备好，请稍后再次重试。";
    case "retry-evaluation":
      return "评估仍未完成，请稍后再次重试。";
    case "abandon":
      return "暂时无法放弃本轮，请检查网络后重试。";
  }
}

// ─── Component ──────────────────────────────────────────────────────────

export function ValidationFocus({
  cardId,
  keyPointId,
  reviewScheduleId,
  onExit,
  exitHref,
  exitLabel = "返回学习卡",
}: {
  cardId: string;
  keyPointId?: string;
  /** v0.6 review context (计划 §8.3): when provided, starts a review-context session */
  reviewScheduleId?: string;
  onExit?: () => void;
  exitHref: string;
  exitLabel?: string;
}) {
  const [state, setState] = useState<FocusState>({
    phase: "eligibility-check",
    draftRevision: 0,
    draftAnswer: "",
    selfConfidence: null,
    assistanceLevel: "none",
  });

  const mountedRef = useRef(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionKeysRef = useRef(new Map<string, string>());
  const answerRef = useRef<string>("");
  const revisionRef = useRef<number>(0);
  const phaseRef = useRef<Phase>("eligibility-check");
  const submissionIdRef = useRef<string | undefined>(undefined);
  const pendingDraftRef = useRef<DraftSnapshot | null>(null);
  const draftSavePromiseRef = useRef<Promise<void> | null>(null);
  const draftConflictRef = useRef(false);
  const actionLockRef = useRef<ActionName | null>(null);
  const allowUnloadRef = useRef(false);
  const [draftSaveStatus, setDraftSaveStatus] = useState<DraftSaveStatus>("saved");
  const [pendingAction, setPendingAction] = useState<ActionName | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, []);

  // Keep refs in sync
  useEffect(() => {
    answerRef.current = state.draftAnswer;
  }, [state.draftAnswer]);

  useEffect(() => {
    revisionRef.current = state.draftRevision;
  }, [state.draftRevision]);

  useEffect(() => {
    phaseRef.current = state.phase;
    submissionIdRef.current = state.submissionId;
  }, [state.phase, state.submissionId]);

  const acquireActionLock = useCallback((action: ActionName) => {
    if (actionLockRef.current) return false;
    actionLockRef.current = action;
    setPendingAction(action);
    return true;
  }, []);

  const releaseActionLock = useCallback((action: ActionName) => {
    if (actionLockRef.current !== action) return;
    actionLockRef.current = null;
    if (mountedRef.current) setPendingAction(null);
  }, []);

  // ─── Job polling ──────────────────────────────────────────────────────

  const pollJobStatus = useCallback((
    jobId: string,
    kind: "question" | "evaluation",
    submissionId: string,
  ) => {
    let attempts = 0;

    const poll = async () => {
      if (!mountedRef.current || attempts >= POLL_MAX_ATTEMPTS) {
        if (mountedRef.current) {
          setState((prev) => ({
            ...prev,
            phase: kind === "question" ? "question_retryable" : "evaluation_retryable",
            error: `${kind === "question" ? "出题" : "评估"}超时，请重试`,
          }));
        }
        return;
      }

      attempts += 1;
      try {
        const job = await api.getJob(jobId);
        if (!mountedRef.current) return;

        if (job.status === "succeeded") {
          const session: GetSessionResult = await api.getValidationSession(submissionId);
          if (!mountedRef.current) return;

          const newPhase = mapSessionToPhase(session);
          setState((prev) => ({
            ...prev,
            phase: newPhase,
            terminalStatus: session.status === "stale" ? "stale" : undefined,
            submissionId: session.submissionId,
            question: session.question,
            draftRevision: session.draftRevision,
            draftAnswer: session.draftAnswer ?? prev.draftAnswer,
            selfConfidence:
              session.selfConfidence === 1 || session.selfConfidence === 2 || session.selfConfidence === 3
                ? session.selfConfidence
                : prev.selfConfidence,
            assistanceLevel: session.assistanceLevel,
            sourceAvailable: session.sourceAvailable,
            jobId: session.jobId ?? prev.jobId,
            blockedReason:
              session.status === "question_blocked" ? "unsafe_fallback" : undefined,
            error: undefined,
          }));

          // The job row can become visible a fraction before the session transaction.
          // Keep the same bounded poll alive until the session leaves its pending phase.
          if (newPhase === "question_preparing" || newPhase === "evaluation_pending") {
            pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
          }
          return;
        }

        if (job.status === "failed" || job.status === "dead") {
          // The session row is authoritative. A terminal job may have moved
          // the session to retryable, blocked, stale, or completed; exposing
          // `lastError` both leaks service details and can offer an invalid
          // retry action for a non-retryable state.
          try {
            const session: GetSessionResult = await api.getValidationSession(submissionId);
            if (!mountedRef.current) return;
            const newPhase = mapSessionToPhase(session);
            setState((prev) => ({
              ...prev,
              phase: newPhase,
              terminalStatus: session.status === "stale" ? "stale" : undefined,
              submissionId: session.submissionId,
              question: session.question,
              draftRevision: session.draftRevision,
              draftAnswer: session.draftAnswer ?? prev.draftAnswer,
              selfConfidence:
                session.selfConfidence === 1 || session.selfConfidence === 2 || session.selfConfidence === 3
                  ? session.selfConfidence
                  : prev.selfConfidence,
              assistanceLevel: session.assistanceLevel,
              sourceAvailable: session.sourceAvailable,
              jobId: session.jobId ?? prev.jobId,
              blockedReason:
                session.status === "question_blocked" ? "unsafe_fallback" : undefined,
              error:
                newPhase === "question_retryable"
                  ? "题目暂时没有准备好，请重试。"
                  : newPhase === "evaluation_retryable"
                    ? "评估暂时中断，请重试。"
                    : undefined,
            }));

            if (newPhase === "question_preparing" || newPhase === "evaluation_pending") {
              pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
            }
          } catch {
            setState((prev) => ({
              ...prev,
              phase: kind === "question" ? "question_retryable" : "evaluation_retryable",
              error: `${kind === "question" ? "题目" : "评估"}暂时没有准备好，请重试。`,
            }));
          }
          return;
        }

        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!mountedRef.current) return;
        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    };

    void poll();
  }, []);

  const restoreSession = useCallback(async (submissionId: string) => {
    const session: GetSessionResult = await api.getValidationSession(submissionId);
    if (!mountedRef.current) return;

    let restoredPhase = mapSessionToPhase(session);
    if (restoredPhase === "answering" && !session.question) {
      throw new Error("恢复的验证会话缺少题目信息");
    }
    if (restoredPhase === "question_preparing" && !session.jobId) {
      restoredPhase = "question_retryable";
    } else if (restoredPhase === "evaluation_pending" && !session.jobId) {
      restoredPhase = "evaluation_retryable";
    }

    pendingDraftRef.current = null;
    draftConflictRef.current = false;
    setDraftSaveStatus("saved");

    setState((prev) => ({
      ...prev,
      phase: restoredPhase,
      terminalStatus: session.status === "stale" ? "stale" : undefined,
      submissionId: session.submissionId,
      question: session.question,
      draftRevision: session.draftRevision,
      draftAnswer: session.draftAnswer ?? "",
      selfConfidence:
        session.selfConfidence === 1 || session.selfConfidence === 2 || session.selfConfidence === 3
          ? session.selfConfidence
          : null,
      assistanceLevel: session.assistanceLevel,
      sourceAvailable: session.sourceAvailable,
      jobId: session.jobId ?? undefined,
      blockedReason:
        session.status === "question_blocked" ? "unsafe_fallback" : undefined,
      error:
        restoredPhase === "error"
          ? "会话状态暂时无法恢复"
          : session.status === "question_preparing" && !session.jobId
            ? "出题任务未成功建立，请重试"
            : session.status === "evaluation_pending" && !session.jobId
              ? "评估任务未成功建立，请重试"
              : undefined,
    }));

    if (restoredPhase === "question_preparing" && session.jobId) {
      pollJobStatus(session.jobId, "question", submissionId);
    } else if (restoredPhase === "evaluation_pending" && session.jobId) {
      pollJobStatus(session.jobId, "evaluation", submissionId);
    }
  }, [pollJobStatus]);

  // ─── Session start ────────────────────────────────────────────────────

  const startSession = useCallback(async () => {
    if (!isQuestionFirstUIEnabled()) {
      setState((prev) => ({
        ...prev,
        phase: "question_blocked",
        blockedReason: "feature_disabled",
        error: undefined,
      }));
      return;
    }
    if (!acquireActionLock("start")) return;
    setState((prev) => ({ ...prev, phase: "eligibility-check", error: undefined }));
    const actionSlot = `start:${cardId}:${keyPointId ?? ""}:${reviewScheduleId ?? ""}`;
    const idempotencyKey = getOrCreateActionKey(
      actionKeysRef.current,
      actionSlot,
      `ui-start-${cardId}`,
    );

    try {
      const result: StartSessionResult = await api.startValidationSession(cardId, {
        keyPointId,
        idempotencyKey,
        context: reviewScheduleId ? "review" : undefined,
        reviewScheduleId,
      });
      clearActionKey(actionKeysRef.current, actionSlot);

      if (!mountedRef.current) return;

      if (result.status === "blocked") {
        setState((prev) => ({
          ...prev,
          phase: "question_blocked",
          blockedReason: result.reason ?? "blocked",
          unassistedEligibleAt: result.unassistedEligibleAt,
          error: undefined,
        }));
        return;
      }

      if (result.submissionId) {
        await restoreSession(result.submissionId);
        return;
      }

      // Unexpected response
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: "服务器返回了未预期的响应",
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      const errorData = err instanceof ApiError ? err.data : undefined;
      const errorCode = err instanceof ApiError
        ? err.code ?? (typeof errorData?.error === "string" ? errorData.error : undefined)
        : undefined;
      if (errorCode === "assistance_cooldown") {
        setState((prev) => ({
          ...prev,
          phase: "question_blocked",
          blockedReason: "assistance_cooldown",
          unassistedEligibleAt:
            typeof errorData?.unassistedEligibleAt === "string"
              ? errorData.unassistedEligibleAt
              : undefined,
          error: undefined,
        }));
        return;
      }
      if (errorCode === "no_hard_evidence") {
        setState((prev) => ({
          ...prev,
          phase: "question_blocked",
          blockedReason: "no_hard_evidence",
          error: undefined,
        }));
        return;
      }
      if (errorCode === "no_key_point") {
        setState((prev) => ({
          ...prev,
          phase: "question_blocked",
          blockedReason: "no_key_point",
          error: undefined,
        }));
        return;
      }
      if (errorCode === "unsafe_question") {
        setState((prev) => ({
          ...prev,
          phase: "question_blocked",
          blockedReason: "unsafe_fallback",
          error: undefined,
        }));
        return;
      }
      setState((prev) => ({
        ...prev,
        phase: "error",
        error: getValidationActionErrorMessage("start", err),
      }));
    } finally {
      releaseActionLock("start");
    }
  }, [acquireActionLock, cardId, keyPointId, releaseActionLock, restoreSession, reviewScheduleId]);

  // ─── Draft autosave ───────────────────────────────────────────────────

  const flushDraft = useCallback((): Promise<void> => {
    if (draftConflictRef.current) return Promise.resolve();
    if (draftSavePromiseRef.current) return draftSavePromiseRef.current;
    const sid = submissionIdRef.current;
    if (!sid || phaseRef.current !== "answering" || !pendingDraftRef.current) {
      return Promise.resolve();
    }

    if (mountedRef.current) setDraftSaveStatus("saving");

    const savePromise = (async () => {
      let saveFailed = false;
      let conflictDetected = false;
      try {
        while (phaseRef.current === "answering" && pendingDraftRef.current) {
          const snapshot = pendingDraftRef.current;
          pendingDraftRef.current = null;
          const idempotencyKey = snapshot.idempotencyKey
            ?? `ui-draft-${sid}-${crypto.randomUUID()}`;
          snapshot.idempotencyKey = idempotencyKey;

          try {
            const result = await api.draftValidationAnswer(sid, {
              answer: snapshot.answer,
              selfConfidence: snapshot.confidence ?? undefined,
              baseRevision: revisionRef.current,
              idempotencyKey,
            });
            revisionRef.current = result.revision;
            if (mountedRef.current) {
              setState((prev) => ({ ...prev, draftRevision: result.revision }));
            }
          } catch (error) {
            if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
              snapshot.idempotencyKey = undefined;
            }
            if (error instanceof ApiError && error.status === 409) {
              try {
                const session = await api.getValidationSession(sid);
                revisionRef.current = session.draftRevision;
                if (mountedRef.current) {
                  setState((prev) => ({ ...prev, draftRevision: session.draftRevision }));
                }
              } catch {
                // Keep the local snapshot and require an explicit user choice.
              }
              pendingDraftRef.current ??= snapshot;
              draftConflictRef.current = true;
              conflictDetected = true;
              break;
            }

            pendingDraftRef.current ??= snapshot;
            saveFailed = true;
            break;
          }
        }
      } finally {
        draftSavePromiseRef.current = null;
        if (mountedRef.current) {
          setDraftSaveStatus(
            conflictDetected
              ? "conflict"
              : saveFailed
                ? "error"
                : pendingDraftRef.current
                  ? "unsaved"
                  : "saved",
          );
        }
      }
    })();

    draftSavePromiseRef.current = savePromise;
    return savePromise;
  }, []);

  const scheduleDraftSave = useCallback(
    (answer: string, confidence: 1 | 2 | 3 | null) => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      pendingDraftRef.current = { answer, confidence };
      if (draftConflictRef.current) {
        setDraftSaveStatus("conflict");
        return;
      }
      setDraftSaveStatus("unsaved");
      draftTimerRef.current = setTimeout(() => {
        void flushDraft();
      }, DRAFT_DEBOUNCE_MS);
    },
    [flushDraft],
  );

  const handleOverwriteDraft = useCallback(() => {
    draftConflictRef.current = false;
    setDraftSaveStatus("unsaved");
    void flushDraft();
  }, [flushDraft]);

  const handleReloadDraft = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid || !acquireActionLock("draft-reload")) return;
    try {
      const session = await api.getValidationSession(sid);
      if (!mountedRef.current) return;
      if (mapStatusToPhase(session.status) !== "answering" || !session.question) {
        // 会话已被另一页面推进（例如已提交/已失效）：留在死题面上并把责任
        // 推给网络只会误导用户，直接收敛到服务端真实状态。
        await restoreSession(sid);
        return;
      }
      const restoredConfidence =
        session.selfConfidence === 1 || session.selfConfidence === 2 || session.selfConfidence === 3
          ? session.selfConfidence
          : null;
      pendingDraftRef.current = null;
      draftConflictRef.current = false;
      revisionRef.current = session.draftRevision;
      setDraftSaveStatus("saved");
      setState((prev) => ({
        ...prev,
        draftRevision: session.draftRevision,
        draftAnswer: session.draftAnswer ?? "",
        selfConfidence: restoredConfidence,
        error: undefined,
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      setDraftSaveStatus("conflict");
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("draft-reload", error),
      }));
    } finally {
      releaseActionLock("draft-reload");
    }
  }, [acquireActionLock, releaseActionLock, restoreSession, state.submissionId]);

  // ─── Submit answer ────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid || !state.draftAnswer.trim()) return;
    if (draftConflictRef.current) {
      setState((prev) => ({ ...prev, error: "请先处理另一页面产生的草稿冲突，再提交回答。" }));
      return;
    }
    if (!acquireActionLock("submit")) return;

    try {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      await flushDraft();
      if (draftConflictRef.current || pendingDraftRef.current) {
        setState((prev) => ({
          ...prev,
          error: "草稿尚未安全保存。请先处理冲突或重试保存，再提交回答。",
        }));
        return;
      }

      const actionSlot = `submit:${sid}:${revisionRef.current}`;
      const idempotencyKey = getOrCreateActionKey(
        actionKeysRef.current,
        actionSlot,
        `ui-submit-${sid}`,
      );
      // 用 answerRef（与 flushDraft 持久化的内容同源）而不是闭包里的
      // state.draftAnswer：点击提交到禁用重渲染之间的最后一次键入会先被
      // flushDraft 存为草稿，闭包值则是旧的——两者不一致时评估的答案会比
      // 已保存草稿旧。
      const result = await api.submitValidationAnswer(sid, {
        answer: answerRef.current.trim(),
        selfConfidence: state.selfConfidence ?? undefined,
        baseRevision: revisionRef.current,
        idempotencyKey,
      });
      clearActionKey(actionKeysRef.current, actionSlot);

      if (!mountedRef.current) return;

      pendingDraftRef.current = null;
      setDraftSaveStatus("saved");
      setState((prev) => ({
        ...prev,
        phase: "evaluation_pending",
        jobId: result.jobId,
        error: undefined,
      }));

      pollJobStatus(result.jobId, "evaluation", sid);
    } catch (err) {
      if (!mountedRef.current) return;
      const actionSlot = `submit:${sid}:${revisionRef.current}`;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("submit", err),
      }));
      // 服务端已把会话转入其他状态（例如题目过期 → stale 终态）：本地重试
      // 只会重复同一个错误，改为拉取会话真实状态收敛。
      if (shouldResyncSession(err)) {
        void restoreSession(sid).catch(() => {});
      }
    } finally {
      releaseActionLock("submit");
    }
  }, [acquireActionLock, flushDraft, pollJobStatus, releaseActionLock, restoreSession, state.submissionId, state.draftAnswer, state.selfConfidence]);

  // ─── Unable to answer ─────────────────────────────────────────────────

  const handleUnable = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid) return;
    if (draftConflictRef.current) {
      setState((prev) => ({ ...prev, error: "请先处理另一页面产生的草稿冲突。" }));
      return;
    }
    if (!acquireActionLock("unable")) return;

    try {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      await flushDraft();
      if (draftConflictRef.current || pendingDraftRef.current) {
        setState((prev) => ({
          ...prev,
          error: "草稿尚未安全保存。请先处理冲突或重试保存，再结束本轮。",
        }));
        return;
      }

      const actionSlot = `unable:${sid}:${revisionRef.current}`;
      const idempotencyKey = getOrCreateActionKey(
        actionKeysRef.current,
        actionSlot,
        `ui-unable-${sid}`,
      );
      await api.unableValidationAnswer(sid, {
        baseRevision: revisionRef.current,
        idempotencyKey,
      });
      clearActionKey(actionKeysRef.current, actionSlot);

      if (!mountedRef.current) return;
      pendingDraftRef.current = null;
      setDraftSaveStatus("saved");
      setState((prev) => ({ ...prev, phase: "result_pending_reveal", error: undefined }));
    } catch (err) {
      if (!mountedRef.current) return;
      const actionSlot = `unable:${sid}:${revisionRef.current}`;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("unable", err),
      }));
      if (shouldResyncSession(err)) {
        void restoreSession(sid).catch(() => {});
      }
    } finally {
      releaseActionLock("unable");
    }
  }, [acquireActionLock, flushDraft, releaseActionLock, restoreSession, state.submissionId]);

  // ─── Reveal source (with assistance confirmation) ─────────────────────

  const [showSourceConfirm, setShowSourceConfirm] = useState(false);

  const handleRevealSource = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid) return;
    if (!acquireActionLock("source")) return;
    setShowSourceConfirm(false);

    const sourceWindow = window.open("about:blank", "_blank");
    if (sourceWindow) {
      sourceWindow.opener = null;
      sourceWindow.document.title = "正在打开学习卡原文…";
    }

    try {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      await flushDraft();
      if (pendingDraftRef.current) {
        sourceWindow?.close();
        setState((prev) => ({
          ...prev,
          error: "最新草稿尚未保存，请先重试保存后再查看原文。",
        }));
        return;
      }

      const actionSlot = `source:${sid}`;
      const idempotencyKey = getOrCreateActionKey(
        actionKeysRef.current,
        actionSlot,
        `ui-reveal-src-${sid}`,
      );
      const result = await api.revealValidationSource(sid, { idempotencyKey });
      clearActionKey(actionKeysRef.current, actionSlot);
      if (!mountedRef.current) return;

      setState((prev) => ({
        ...prev,
        assistanceLevel: result.assistanceLevel,
        sourceAvailable: result.sourceAvailable,
        error: undefined,
      }));
      if (!result.sourceAvailable) {
        sourceWindow?.close();
        setState((prev) => ({ ...prev, error: "原文暂时不可用" }));
        return;
      }

      const sourceHref = `/cards/${cardId}`;
      if (sourceWindow) {
        sourceWindow.location.replace(sourceHref);
      } else {
        allowUnloadRef.current = true;
        window.location.assign(sourceHref);
      }
    } catch (err) {
      sourceWindow?.close();
      if (!mountedRef.current) return;
      const actionSlot = `source:${sid}`;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("source", err),
      }));
      if (shouldResyncSession(err)) {
        void restoreSession(sid).catch(() => {});
      }
    } finally {
      releaseActionLock("source");
    }
  }, [acquireActionLock, cardId, flushDraft, releaseActionLock, restoreSession, state.submissionId]);

  // ─── Reveal result ────────────────────────────────────────────────────

  const handleRevealResult = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid) return;
    if (!acquireActionLock("result")) return;

    const actionSlot = `result:${sid}`;
    const idempotencyKey = getOrCreateActionKey(
      actionKeysRef.current,
      actionSlot,
      `ui-reveal-result-${sid}`,
    );

    try {
      const result = await api.revealValidationResult(sid, { idempotencyKey });
      clearActionKey(actionKeysRef.current, actionSlot);
      if (!mountedRef.current) return;

      setState((prev) => ({
        ...prev,
        phase: prev.terminalStatus === "stale" ? "stale" : "completed",
        result,
        error: undefined,
      }));
    } catch (err) {
      if (!mountedRef.current) return;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("result", err),
      }));
      if (shouldResyncSession(err)) {
        void restoreSession(sid).catch(() => {});
      }
    } finally {
      releaseActionLock("result");
    }
  }, [acquireActionLock, releaseActionLock, restoreSession, state.submissionId]);

  // ─── Retry question ───────────────────────────────────────────────────

  const handleRetryQuestion = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid) return;
    if (!acquireActionLock("retry-question")) return;
    setState((prev) => ({ ...prev, error: undefined }));

    const actionSlot = `retry-question:${sid}`;
    const idempotencyKey = getOrCreateActionKey(
      actionKeysRef.current,
      actionSlot,
      `ui-retry-q-${sid}`,
    );

    try {
      const result = await api.retryValidationQuestion(sid, { idempotencyKey });
      clearActionKey(actionKeysRef.current, actionSlot);
      if (!mountedRef.current) return;

      setState((prev) => ({
        ...prev,
        phase: "question_preparing",
        jobId: result.jobId,
        error: undefined,
      }));
      pollJobStatus(result.jobId, "question", sid);
    } catch (err) {
      if (!mountedRef.current) return;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("retry-question", err),
      }));
      if (shouldResyncSession(err)) {
        void restoreSession(sid).catch(() => {});
      }
    } finally {
      releaseActionLock("retry-question");
    }
  }, [acquireActionLock, pollJobStatus, releaseActionLock, restoreSession, state.submissionId]);

  // ─── Retry evaluation ─────────────────────────────────────────────────

  const handleRetryEvaluation = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid) return;
    if (!acquireActionLock("retry-evaluation")) return;
    setState((prev) => ({ ...prev, error: undefined }));

    const actionSlot = `retry-evaluation:${sid}`;
    const idempotencyKey = getOrCreateActionKey(
      actionKeysRef.current,
      actionSlot,
      `ui-retry-eval-${sid}`,
    );

    try {
      const result = await api.retryValidationEvaluation(sid, { idempotencyKey });
      clearActionKey(actionKeysRef.current, actionSlot);
      if (!mountedRef.current) return;

      setState((prev) => ({
        ...prev,
        phase: "evaluation_pending",
        jobId: result.jobId,
        error: undefined,
      }));
      pollJobStatus(result.jobId, "evaluation", sid);
    } catch (err) {
      if (!mountedRef.current) return;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("retry-evaluation", err),
      }));
      if (shouldResyncSession(err)) {
        void restoreSession(sid).catch(() => {});
      }
    } finally {
      releaseActionLock("retry-evaluation");
    }
  }, [acquireActionLock, pollJobStatus, releaseActionLock, restoreSession, state.submissionId]);

  // ─── Abandon ──────────────────────────────────────────────────────────

  const handleAbandon = useCallback(async () => {
    const sid = state.submissionId;
    if (!sid) return;
    if (!acquireActionLock("abandon")) return;

    const actionSlot = `abandon:${sid}`;
    const idempotencyKey = getOrCreateActionKey(
      actionKeysRef.current,
      actionSlot,
      `ui-abandon-${sid}`,
    );

    try {
      await api.abandonValidationSession(sid, { idempotencyKey });
      clearActionKey(actionKeysRef.current, actionSlot);
      if (!mountedRef.current) return;
      pendingDraftRef.current = null;
      draftConflictRef.current = false;
      setDraftSaveStatus("saved");
      setState((prev) => ({ ...prev, phase: "abandoned", error: undefined }));
    } catch (err) {
      if (!mountedRef.current) return;
      clearActionKeyOnDefinitiveFailure(actionKeysRef.current, actionSlot, err);
      setState((prev) => ({
        ...prev,
        error: getValidationActionErrorMessage("abandon", err),
      }));
    } finally {
      releaseActionLock("abandon");
    }
  }, [acquireActionLock, releaseActionLock, state.submissionId]);

  // ─── Keyboard shortcut: Cmd/Ctrl+Enter to submit ──────────────────────

  useEffect(() => {
    if (state.phase !== "answering" || showSourceConfirm || pendingAction) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void handleSubmit();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [state.phase, showSourceConfirm, pendingAction, handleSubmit]);

  // ─── Auto-start on mount ──────────────────────────────────────────────

  useEffect(() => {
    void startSession();
  }, [startSession]);

  useEffect(() => {
    if (draftSaveStatus === "saved") return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (allowUnloadRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [draftSaveStatus]);

  useEffect(() => {
    const flushOnHistoryNavigation = () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      void flushDraft();
    };
    window.addEventListener("popstate", flushOnHistoryNavigation, { capture: true });
    return () => window.removeEventListener("popstate", flushOnHistoryNavigation, { capture: true });
  }, [flushDraft]);

  const handleSafeExit = useCallback(async () => {
    if (actionLockRef.current) return;
    if (phaseRef.current === "answering") {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      await flushDraft();
      if (pendingDraftRef.current) {
        setDraftSaveStatus("error");
        setState((prev) => ({
          ...prev,
          error: "最新草稿尚未保存。请重试保存，或使用“放弃本轮”退出。",
        }));
        return;
      }
    }
    if (onExit) onExit();
    else {
      allowUnloadRef.current = true;
      window.location.assign(exitHref);
    }
  }, [exitHref, flushDraft, onExit]);

  // ─── Render ───────────────────────────────────────────────────────────

  const sessionKind = reviewScheduleId ? "review" : "validation";
  const inlineError =
    state.phase === "answering" || state.phase === "result_pending_reveal"
      ? state.error
      : undefined;

  return (
    <div
      className="validation-focus"
      data-phase={state.phase}
      data-context={sessionKind}
    >
      <FocusSessionHeader
        exitHref={exitHref}
        exitLabel={exitLabel}
        onExit={handleSafeExit}
        statusLabel={getPhaseLabel(state.phase)}
        statusTone={getPhaseTone(state.phase)}
        sessionKind={sessionKind}
      />

      <div className="validation-focus-body">
        <div className="validation-focus-body-inner">
          {inlineError && (
            <div className="validation-focus-error" role="alert">
              <Icon.AlertCircle aria-hidden="true" />
              <span>{inlineError}</span>
            </div>
          )}

          {(state.phase === "eligibility-check" || state.phase === "question_preparing") && (
            <SessionProgressStage
              sessionKind={sessionKind}
              stage={state.phase === "eligibility-check" ? "eligibility" : "question"}
            />
          )}

          {state.phase === "question_retryable" && (
            <RetryView
              title="题目暂时没有准备好"
              detail={state.error ?? "你的学习进度没有受到影响，可以立即重试，或稍后再回来。"}
              onRetry={handleRetryQuestion}
              onExit={handleSafeExit}
              exitHref={exitHref}
              exitLabel={exitLabel}
              busy={pendingAction !== null}
            />
          )}

          {state.phase === "question_blocked" && (
            <BlockedView
              reason={state.blockedReason}
              unassistedEligibleAt={state.unassistedEligibleAt}
              exitHref={exitHref}
              exitLabel={exitLabel}
              onExit={handleSafeExit}
            />
          )}

          {state.phase === "evaluation_pending" && (
            <SessionProgressStage sessionKind={sessionKind} stage="evaluation" />
          )}

          {state.phase === "evaluation_retryable" && (
            <RetryView
              title="评估暂时中断"
              detail={state.error ?? "你的最终答案已经保存，不会丢失。可以重新发起评估。"}
              onRetry={handleRetryEvaluation}
              onExit={handleSafeExit}
              exitHref={exitHref}
              exitLabel={exitLabel}
              retryLabel="重试评估"
              busy={pendingAction !== null}
            />
          )}

          {state.phase === "result_pending_reveal" && (
            <ResultPendingReveal onReveal={handleRevealResult} busy={pendingAction !== null} />
          )}

          {(state.phase === "completed" || state.phase === "stale") && state.result && (
            <ResultView
              result={state.result}
              isStale={state.phase === "stale"}
              assistanceLevel={state.assistanceLevel}
              exitHref={exitHref}
              exitLabel={exitLabel}
              onExit={handleSafeExit}
            />
          )}

          {state.phase === "stale" && !state.result && (
            <StateView
              eyebrow="本轮已失效"
              title="题目或原文已发生变化"
              detail="本轮验证在提交前已失效，不会影响你的理解状态。你可以返回后重新发起验证。"
              exitHref={exitHref}
              exitLabel={exitLabel}
              onExit={handleSafeExit}
              icon="warning"
            />
          )}

          {state.phase === "abandoned" && (
            <StateView
              eyebrow="本轮已结束"
              title="已放弃本轮验证"
              detail="草稿不会影响理解状态。你可以返回后重新开始。"
              exitHref={exitHref}
              exitLabel={exitLabel}
              onExit={handleSafeExit}
              icon="close"
            />
          )}

          {state.phase === "error" && (
            <RetryView
              title="验证暂时没有开始"
              detail={state.error ?? "会话状态暂时无法恢复，本次不会改动你的理解状态。"}
              onRetry={startSession}
              exitHref={exitHref}
              exitLabel={exitLabel}
              onExit={handleSafeExit}
              retryLabel="重新开始"
              busy={pendingAction !== null}
            />
          )}

          {/* Answering phase — the core question-first UI */}
          {state.phase === "answering" && state.question && (
            <AnsweringView
              question={state.question}
              draftAnswer={state.draftAnswer}
              selfConfidence={state.selfConfidence}
              assistanceLevel={state.assistanceLevel}
              sourceAvailable={state.sourceAvailable === true}
              draftSaveStatus={draftSaveStatus}
              pendingAction={pendingAction}
              onAnswerChange={(answer, confidence) => {
                setState((prev) => ({
                  ...prev,
                  draftAnswer: answer,
                  selfConfidence: confidence,
                }));
                scheduleDraftSave(answer, confidence);
              }}
              onSubmit={handleSubmit}
              onUnable={handleUnable}
              onRevealSourceRequest={() => setShowSourceConfirm(true)}
              onOpenSource={handleRevealSource}
              onRetryDraft={() => void flushDraft()}
              onOverwriteDraft={handleOverwriteDraft}
              onReloadDraft={handleReloadDraft}
              onAbandon={handleAbandon}
            />
          )}
        </div>
      </div>

      {/* Shared ConfirmDialog owns the accessible role="dialog" and aria-modal contract. */}
      <ConfirmDialog
        open={showSourceConfirm}
        title="查看原文将转为辅助练习"
        message="查看后，本轮仍可获得反馈，但不会提升理解状态；下一次独立验证最早可在 24 小时后开始。此操作不可撤销。"
        confirmLabel="确认查看原文"
        cancelLabel="继续独立作答"
        variant="default"
        onConfirm={handleRevealSource}
        onCancel={() => setShowSourceConfirm(false)}
      />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

export function FocusSessionHeader({
  exitHref,
  exitLabel,
  onExit,
  statusLabel,
  statusTone,
  sessionKind,
}: {
  exitHref: string;
  exitLabel: string;
  onExit?: () => void;
  statusLabel: string;
  statusTone: StatusTone;
  sessionKind: "review" | "validation";
}) {
  return (
    <header className="validation-focus-header">
      <div className="validation-focus-header-inner">
        <a
          href={exitHref}
          className="validation-focus-back"
          aria-label={exitLabel}
          onClick={(e) => {
            if (onExit) {
              e.preventDefault();
              onExit();
            }
          }}
        >
          <Icon.Arrow className="validation-focus-back-icon" aria-hidden="true" />
          <span>{exitLabel}</span>
        </a>

        <div className="validation-focus-brand" aria-label={sessionKind === "review" ? "复习回合" : "理解验证"}>
          <span className="validation-focus-brand-copy">
            <small>{sessionKind === "review" ? "间隔复习" : "学习卡"}</small>
            <strong>{sessionKind === "review" ? "复习回合" : "理解验证"}</strong>
          </span>
        </div>

        <div className="validation-focus-header-tools">
          <span className="validation-focus-status" role="status" aria-label={`当前状态：${statusLabel}`}>
            <StatusChip tone={statusTone} size="sm" dot>{statusLabel}</StatusChip>
          </span>
          <ThemeToggle className="validation-focus-theme-toggle" size="sm" />
        </div>
      </div>
    </header>
  );
}

function StateView({
  eyebrow,
  label,
  title,
  detail,
  exitHref,
  exitLabel,
  onExit,
  icon,
}: {
  eyebrow?: string;
  label?: string;
  title?: string;
  detail?: string;
  exitHref?: string;
  exitLabel?: string;
  onExit?: () => void;
  icon?: "warning" | "close";
}) {
  return (
    <div className="validation-focus-state">
      {icon && (
        <span className={`validation-focus-state-symbol validation-focus-state-symbol--${icon}`} aria-hidden="true">
          {icon === "warning" ? <Icon.Warn /> : <Icon.Close />}
        </span>
      )}
      {eyebrow && <span className="validation-focus-state-eyebrow">{eyebrow}</span>}
      {title ? (
        <h1 className="validation-focus-state-title">{title}</h1>
      ) : label ? (
        <h1 className="validation-focus-state-title">{label}</h1>
      ) : null}
      {title && label && <span className="validation-focus-state-label">{label}</span>}
      {detail && <p className="validation-focus-state-detail">{detail}</p>}
      {exitHref && (
        <a
          href={exitHref}
          className="validation-focus-btn validation-focus-btn--secondary validation-focus-state-exit"
          onClick={(e) => {
            if (onExit) {
              e.preventDefault();
              onExit();
            }
          }}
        >
          {exitLabel}
        </a>
      )}
    </div>
  );
}

function RetryView({
  title,
  detail,
  onRetry,
  onExit,
  exitHref,
  exitLabel,
  retryLabel = "重试出题",
  busy = false,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
  onExit?: () => void;
  exitHref: string;
  exitLabel: string;
  retryLabel?: string;
  busy?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <div className="validation-focus-state" role="alert" aria-live="assertive">
      <span className="validation-focus-state-symbol validation-focus-state-symbol--retry" aria-hidden="true">
        <Icon.Refresh />
      </span>
      <span className="validation-focus-state-eyebrow">稍等一下</span>
      <h1 ref={titleRef} className="validation-focus-state-title" tabIndex={-1}>{title}</h1>
      <p className="validation-focus-state-detail">{detail}</p>
      <div className="validation-focus-state-actions">
        <button type="button" className="validation-focus-btn validation-focus-btn--primary" onClick={onRetry} disabled={busy}>
          <Icon.Refresh aria-hidden="true" />
          {busy ? "正在重试…" : retryLabel}
        </button>
        <a
          href={exitHref}
          className="validation-focus-btn validation-focus-btn--ghost"
          onClick={(e) => {
            if (onExit) {
              e.preventDefault();
              onExit();
            }
          }}
        >
          {exitLabel}
        </a>
      </div>
    </div>
  );
}

function BlockedView({
  reason,
  unassistedEligibleAt,
  exitHref,
  exitLabel,
  onExit,
}: {
  reason?: string;
  unassistedEligibleAt?: string;
  exitHref: string;
  exitLabel: string;
  onExit?: () => void;
}) {
  const title = reason === "no_hard_evidence" ? "尚无硬证据" : reason === "no_key_point" ? "尚无可复习的要点" : reason === "assistance_cooldown" ? "冷却中" : reason === "not_yet_due" ? "尚未到期" : reason === "feature_disabled" ? "验证功能已暂时关闭" : "题目暂不可用";
  const detail =
    reason === "no_hard_evidence"
      ? "这个要点还没有硬证据，无法进行可信验证。请先在卡片详情页核对证据。"
      : reason === "no_key_point"
        ? "这张学习卡还没有可用于独立验证的理解要点。请先补充或重新生成学习卡，再回来复习。"
      : reason === "assistance_cooldown"
        ? "你最近查看过原文或结果，需要等待冷却结束后才能进行独立验证。"
        : reason === "not_yet_due"
          ? "这条复习任务尚未到期，请等到计划时间后再来复习。"
          : reason === "feature_disabled"
            ? "当前版本已关闭问题优先验证入口。你仍可安全查看学习卡内容。"
          : reason === "unsafe_fallback"
            ? "题目生成的安全检查未通过，暂无法提供可信验证。"
            : "当前无法开始验证，请稍后重试。";

  return (
    <div className="validation-focus-blocked">
      <span className="validation-focus-blocked-icon" aria-hidden="true">
        {reason === "unsafe_fallback" ? <Icon.Warn /> : <Icon.Lock />}
      </span>
      <span className="validation-focus-state-eyebrow">当前无法开始</span>
      <h1 className="validation-focus-blocked-title">{title}</h1>
      <p className="validation-focus-blocked-detail">{detail}</p>
      {unassistedEligibleAt && (
        <p className="validation-focus-blocked-eligible">
          下一次可独立验证时间：{formatDateTime(unassistedEligibleAt)}
        </p>
      )}
      <a
        href={exitHref}
        className="validation-focus-btn validation-focus-btn--secondary validation-focus-state-exit"
        onClick={(e) => {
          if (onExit) {
            e.preventDefault();
            onExit();
          }
        }}
      >
        {exitLabel}
      </a>
    </div>
  );
}

function ResultPendingReveal({ onReveal, busy }: { onReveal: () => void; busy: boolean }) {
  // 无障碍：长评估等待后的关键转场——把焦点移到标题并触发读屏播报，
  // 与 RetryView/ResultView/AnsweringView 的标题聚焦行为保持一致。
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <div className="validation-focus-state" role="status">
      <span className="validation-focus-state-symbol validation-focus-state-symbol--complete" aria-hidden="true">
        <Icon.Check />
      </span>
      <span className="validation-focus-state-eyebrow">评估已经完成</span>
      <h1 className="validation-focus-state-title" tabIndex={-1} ref={headingRef}>结果准备好了</h1>
      <p className="validation-focus-state-detail">由你决定何时揭示结果。查看后会展示逐项判断与关键证据。</p>
      <button type="button" className="validation-focus-btn validation-focus-btn--primary validation-focus-state-exit" onClick={onReveal} disabled={busy}>
        {busy ? "正在获取结果…" : "揭示验证结果"}
        <Icon.Arrow aria-hidden="true" />
      </button>
    </div>
  );
}

function AnsweringView({
  question,
  draftAnswer,
  selfConfidence,
  assistanceLevel,
  sourceAvailable,
  draftSaveStatus,
  pendingAction,
  onAnswerChange,
  onSubmit,
  onUnable,
  onRevealSourceRequest,
  onOpenSource,
  onRetryDraft,
  onOverwriteDraft,
  onReloadDraft,
  onAbandon,
}: {
  question: { questionId: string; questionType: string; question: string; keyPointOrdinal?: number };
  draftAnswer: string;
  selfConfidence: 1 | 2 | 3 | null;
  assistanceLevel: string;
  sourceAvailable: boolean;
  draftSaveStatus: DraftSaveStatus;
  pendingAction: ActionName | null;
  onAnswerChange: (answer: string, confidence: 1 | 2 | 3 | null) => void;
  onSubmit: () => void;
  onUnable: () => void;
  onRevealSourceRequest: () => void;
  onOpenSource: () => void;
  onRetryDraft: () => void;
  onOverwriteDraft: () => void;
  onReloadDraft: () => void;
  onAbandon: () => void;
}) {
  const isAssisted = assistanceLevel !== "none";
  const actionsDisabled = pendingAction !== null;
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const confidenceOptions = [
    { value: 1, label: "不确定", detail: "仍在推理" },
    { value: 2, label: "较确定", detail: "能说明原因" },
    { value: 3, label: "很确定", detail: "可以举例" },
  ] as const;

  const handleConfidenceKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % confidenceOptions.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + confidenceOptions.length) % confidenceOptions.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = confidenceOptions.length - 1;
    }

    if (nextIndex === undefined) return;
    event.preventDefault();
    onAnswerChange(draftAnswer, confidenceOptions[nextIndex].value);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [nextIndex]?.focus();
  };

  useEffect(() => {
    questionHeadingRef.current?.focus();
  }, [question.questionId]);

  return (
    <div className="validation-focus-answering">
      <section className="validation-focus-question-section">
        <div className="validation-focus-question-meta">
          <span className="validation-focus-question-tags">
            {question.questionType && (
              <StatusChip tone="evidence" size="sm">
                {TYPE_LABELS[question.questionType] ?? question.questionType}
              </StatusChip>
            )}
            {question.keyPointOrdinal != null && (
              <StatusChip tone="neutral" size="sm">要点 {question.keyPointOrdinal + 1}</StatusChip>
            )}
          </span>
          <span className="validation-focus-question-privacy">
            <Icon.Lock aria-hidden="true" />
            内容已隐藏
          </span>
        </div>
        <h1
          ref={questionHeadingRef}
          className="validation-focus-question-text"
          tabIndex={-1}
        >
          {question.question}
        </h1>
        <p className="validation-focus-question-hint">
          <Icon.Sparkle aria-hidden="true" />
          请用自己的话说明，不需要追求标准答案。
        </p>
      </section>

      {isAssisted && (
        <div className="validation-focus-assistance-banner" role="status">
          <Icon.Warn aria-hidden="true" />
          <span>
            <strong>已转为辅助练习</strong>
            你已查看原文，本轮仍可获得反馈，但不会提升理解状态。
            {sourceAvailable && (
              <button
                type="button"
                className="validation-focus-assistance-source"
                onClick={onOpenSource}
                disabled={actionsDisabled}
              >
                {pendingAction === "source" ? "正在刷新访问记录…" : "在新窗口打开学习卡原文"}
                <Icon.Open aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      )}

      <div className="validation-focus-answer-field">
        <div className="validation-focus-answer-heading">
          <label className="validation-focus-answer-label" htmlFor="vf-answer">
            写下你的理解
          </label>
          {draftSaveStatus === "conflict" ? (
            <span className="validation-focus-answer-save validation-focus-answer-save--conflict" role="status">
              <Icon.Warn aria-hidden="true" />
              发现另一页面的草稿
            </span>
          ) : draftSaveStatus === "error" ? (
            <button
              type="button"
              className="validation-focus-answer-save validation-focus-answer-save--error"
              onClick={onRetryDraft}
              disabled={actionsDisabled}
            >
              <Icon.Refresh aria-hidden="true" />
              保存失败，点此重试
            </button>
          ) : (
            <span className="validation-focus-answer-save" data-status={draftSaveStatus} role="status">
              <i aria-hidden="true" />
              {draftSaveStatus === "saving"
                ? "正在保存草稿"
                : draftSaveStatus === "unsaved"
                  ? "等待自动保存"
                  : "草稿已保存"}
            </span>
          )}
        </div>
        {draftSaveStatus === "conflict" && (
          <div className="validation-focus-draft-conflict" role="alert">
            <span>另一页面刚刚保存了不同内容。请选择要保留的版本，系统不会自动覆盖。</span>
            <span className="validation-focus-draft-conflict-actions">
              <button type="button" onClick={onOverwriteDraft} disabled={actionsDisabled}>
                保留本页并覆盖
              </button>
              <button type="button" onClick={onReloadDraft} disabled={actionsDisabled}>
                载入另一页面草稿
              </button>
            </span>
          </div>
        )}
        <textarea
          id="vf-answer"
          className="validation-focus-textarea"
          value={draftAnswer}
          onChange={(e) => onAnswerChange(e.target.value, selfConfidence)}
          placeholder="先写下你能想起的关键概念，再补充原因、步骤或例子…"
          rows={6}
          maxLength={ANSWER_LIMIT}
          aria-describedby="vf-count"
          disabled={actionsDisabled}
        />
        <div className="validation-focus-answer-meta">
          <span id="vf-count">已输入 {draftAnswer.length} 字</span>
          <span className="validation-focus-shortcut">
            <kbd>⌘ / Ctrl</kbd>
            <span>+</span>
            <kbd>Enter</kbd>
            <span>提交</span>
          </span>
        </div>
      </div>

      <div className="validation-focus-confidence">
        <div className="validation-focus-confidence-heading">
          <span className="validation-focus-confidence-label">你对这次回答有多确定？</span>
          <span className="validation-focus-confidence-optional">可选，不影响评估结果</span>
        </div>
        <div className="validation-focus-confidence-group" role="radiogroup" aria-label="自信度">
          {confidenceOptions.map((opt, index) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selfConfidence === opt.value}
              tabIndex={selfConfidence === opt.value || (selfConfidence == null && index === 0) ? 0 : -1}
              className={`validation-focus-confidence-option${selfConfidence === opt.value ? " is-selected" : ""}`}
              onClick={() => onAnswerChange(draftAnswer, opt.value)}
              onKeyDown={(event) => handleConfidenceKeyDown(event, index)}
              disabled={actionsDisabled}
            >
              <span className="validation-focus-confidence-dot" aria-hidden="true" />
              <span>
                <strong>{opt.label}</strong>
                <small>{opt.detail}</small>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="validation-focus-secondary-actions" aria-label="其他操作">
        <button
          type="button"
          className="validation-focus-btn validation-focus-btn--ghost"
          onClick={isAssisted && sourceAvailable ? onOpenSource : onRevealSourceRequest}
          disabled={actionsDisabled}
        >
          <Icon.Eye aria-hidden="true" />
          {pendingAction === "source" ? "正在打开…" : "查看原文"}
        </button>
        <button
          type="button"
          className="validation-focus-btn validation-focus-btn--ghost validation-focus-btn--abandon"
          onClick={onAbandon}
          disabled={actionsDisabled}
        >
          <Icon.Close aria-hidden="true" />
          {pendingAction === "abandon" ? "正在放弃…" : "放弃本轮"}
        </button>
      </div>

      <div className="validation-focus-actions">
        <div className="validation-focus-actions-row">
          <button
            type="button"
            className="validation-focus-btn validation-focus-btn--secondary"
            onClick={onUnable}
            disabled={actionsDisabled}
          >
            {pendingAction === "unable" ? "正在结束…" : "暂时想不起来"}
          </button>
          <button
            type="button"
            className="validation-focus-btn validation-focus-btn--primary"
            onClick={onSubmit}
            disabled={!draftAnswer.trim() || actionsDisabled}
          >
            <Icon.Sparkle aria-hidden="true" />
            {pendingAction === "submit" ? "正在提交…" : "提交回答"}
            <Icon.Arrow aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultView({
  result,
  isStale,
  assistanceLevel,
  exitHref,
  exitLabel,
  onExit,
}: {
  result: RevealResultData;
  isStale: boolean;
  assistanceLevel: string;
  exitHref: string;
  exitLabel: string;
  onExit?: () => void;
}) {
  const meta = getOutcomeMeta(result.outcome);
  const isAssisted = assistanceLevel !== "none";
  const feedbackCopy = getFeedbackCopy(result.feedback, meta.fallback);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    resultHeadingRef.current?.focus();
  }, [result.outcome]);

  return (
    <div className="validation-focus-result">
      <div className={`validation-focus-result-header validation-focus-result-header--${meta.tone}`}>
        <span className="validation-focus-result-mark" aria-hidden="true">
          {meta.tone === "positive" ? <Icon.Check /> : meta.tone === "negative" ? <Icon.Warn /> : <Icon.Target />}
        </span>
        <span className="validation-focus-result-eyebrow">本轮验证结果</span>
        <h1
          ref={resultHeadingRef}
          className={`validation-focus-result-outcome validation-focus-result-outcome--${meta.tone}`}
          tabIndex={-1}
        >
          {meta.label}
        </h1>
        <p className="validation-focus-result-summary">
          {isStale
            ? "本次验证因来源变化已过期，结果仅作历史参考。"
            : isAssisted
              ? `${meta.fallback} 本轮因查看原文，理解状态不变。`
              : feedbackCopy}
        </p>
      </div>

      <div className="validation-focus-result-grid">
        <section className="validation-focus-result-section validation-focus-result-section--answer">
          <div className="validation-focus-result-section-heading">
            <span className="validation-focus-result-section-icon" aria-hidden="true"><Icon.Pencil /></span>
            <h2 className="validation-focus-result-section-title">我的回答</h2>
          </div>
          <p className="validation-focus-result-answer">{result.userAnswer || "（未提交文字回答）"}</p>
        </section>

        {result.rubricItems.length > 0 && (
          <section className="validation-focus-result-section validation-focus-result-section--rubric">
            <div className="validation-focus-result-section-heading">
              <span className="validation-focus-result-section-icon" aria-hidden="true"><Icon.Target /></span>
              <h2 className="validation-focus-result-section-title">逐项评估</h2>
            </div>
            <ul className="validation-focus-rubric-list">
              {result.rubricItems.map((item, i) => (
                <li key={i} className="validation-focus-rubric-item">
                  <span className="validation-focus-rubric-index" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="validation-focus-rubric-copy">
                  <StatusChip tone={getVerdictTone(item.verdict)} size="sm" dot>
                    {VERDICT_LABELS[item.verdict] ?? item.verdict}
                  </StatusChip>
                    <span className="validation-focus-rubric-criterion">{item.criterion}</span>
                    {item.rationale && (
                      <span className="validation-focus-rubric-rationale">{item.rationale}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {result.evidenceRefs.length > 0 && (
          <section className="validation-focus-result-section validation-focus-result-section--evidence">
            <div className="validation-focus-result-section-heading">
              <span className="validation-focus-result-section-icon" aria-hidden="true"><Icon.QuoteMark /></span>
              <h2 className="validation-focus-result-section-title">关键证据</h2>
            </div>
            <div className="validation-focus-evidence-list">
              {result.evidenceRefs.map((ref, i) => (
                <blockquote key={i} className="validation-focus-evidence-quote">
                  {ref.quoteText || "暂无可引用的原文证据"}
                </blockquote>
              ))}
            </div>
          </section>
        )}

        <section className="validation-focus-result-section validation-focus-result-section--impact">
          <div className="validation-focus-result-section-heading">
            <span className="validation-focus-result-section-icon" aria-hidden="true"><Icon.Timeline /></span>
            <h2 className="validation-focus-result-section-title">接下来</h2>
          </div>
          <p className="validation-focus-result-schedule">
            {isAssisted
              ? "本轮因查看原文，理解状态不变。"
              : isStale
                ? "因来源变化，本轮未影响理解状态。"
                : meta.scheduleCopy}
          </p>
          {isAssisted && (
            <p className="validation-focus-result-reason">
              下一次独立验证最早可在 24 小时后开始。
            </p>
          )}
        </section>
      </div>

      <div className="validation-focus-result-actions">
        <a
          href={exitHref}
          className="validation-focus-btn validation-focus-btn--primary"
          onClick={(e) => {
            if (onExit) {
              e.preventDefault();
              onExit();
            }
          }}
        >
          {exitLabel}
          <Icon.Arrow aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * 会话级 phase 映射：在 mapStatusToPhase 基础上处理 "stale 但没有可揭示结果"
 * 的终态——提交前就失效的 submission 没有 validationEventId，reveal-result
 * 必然 404，映射到 result_pending_reveal 会让用户陷入永远失败的"查看结果"
 * 死循环。此时直接进入无结果的 stale 终态视图。
 */
function mapSessionToPhase(session: GetSessionResult): Phase {
  if (session.status === "stale" && !session.resultAvailable) return "stale";
  return mapStatusToPhase(session.status);
}

function mapStatusToPhase(status: string): Phase {
  switch (status) {
    case "question_preparing": return "question_preparing";
    case "ready":
    case "answer_saved": return "answering";
    case "evaluation_pending": return "evaluation_pending";
    case "question_retryable": return "question_retryable";
    case "evaluation_retryable": return "evaluation_retryable";
    case "question_blocked": return "question_blocked";
    case "completed": return "result_pending_reveal";
    case "stale": return "result_pending_reveal";
    case "abandoned": return "abandoned";
    default: return "error";
  }
}

function getPhaseLabel(phase: Phase): string {
  switch (phase) {
    case "eligibility-check":
    case "question_preparing":
      return "准备中";
    case "answering":
      return "作答中";
    case "evaluation_pending":
      return "评估中";
    case "result_pending_reveal":
      return "待揭示";
    case "completed":
      return "已完成";
    case "stale":
      return "仅作参考";
    case "question_retryable":
    case "evaluation_retryable":
      return "可重试";
    case "question_blocked":
      return "暂不可用";
    case "abandoned":
      return "已结束";
    default:
      return "需要处理";
  }
}

function getPhaseTone(phase: Phase): StatusTone {
  switch (phase) {
    case "eligibility-check":
    case "question_preparing":
    case "evaluation_pending":
      return "running";
    case "answering":
    case "result_pending_reveal":
      return "evidence";
    case "completed":
      return "success";
    case "question_retryable":
    case "evaluation_retryable":
    case "question_blocked":
    case "stale":
      return "warning";
    case "abandoned":
      return "muted";
    default:
      return "danger";
  }
}

function getVerdictTone(verdict: string): StatusTone {
  switch (verdict) {
    case "covered":
      return "success";
    case "partial":
      return "warning";
    case "missing":
    case "contradicted":
      return "danger";
    default:
      return "muted";
  }
}

function getOutcomeMeta(outcome: string): {
  label: string;
  tone: "positive" | "caution" | "negative" | "neutral";
  fallback: string;
  scheduleCopy: string;
} {
  switch (outcome) {
    case "preliminary_understanding":
      return {
        label: "已基本掌握",
        tone: "positive",
        fallback: "本次回答已体现对关键概念的初步理解。",
        scheduleCopy: "理解状态已提升，下一次复习将按新间隔安排。",
      };
    case "unclear_expression":
      return {
        label: "还差一点",
        tone: "caution",
        fallback: "部分表述还不够明确，建议结合原文证据再说明一次。",
        scheduleCopy: "理解状态暂未提升，请继续练习。",
      };
    case "misunderstanding":
      return {
        label: "存在理解偏差",
        tone: "negative",
        fallback: "回答中存在需要纠正的理解，请先回看关键证据。",
        scheduleCopy: "理解状态未提升，建议尽快复习相关内容。",
      };
    default:
      return {
        label: "暂无法判断",
        tone: "neutral",
        fallback: "现有回答不足以完成判断，可以补充细节后重试。",
        scheduleCopy: "理解状态不变。",
      };
  }
}

function getFeedbackCopy(
  feedback: RevealResultData["feedback"],
  fallback: string,
): string {
  if (typeof feedback === "string") return feedback.trim() || fallback;
  if (feedback && typeof feedback.feedback === "string") {
    return feedback.feedback.trim() || fallback;
  }
  return fallback;
}

const VERDICT_LABELS: Record<string, string> = {
  covered: "已覆盖",
  partial: "部分覆盖",
  missing: "未覆盖",
  contradicted: "存在矛盾",
  not_assessable: "无法判断",
};

function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
