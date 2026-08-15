/**
 * LearningRunLivePlayer：统一 Player 的生产数据容器（P3 接线）。
 *
 * 桥接 useLearningRun（wire API）与 LearningRunPlayer（UI 合同）：
 * - 快照：adaptRunToUi 映射（label 文案由适配层派生）；
 * - 意图：planUiIntent 映射为 wire 动作/提交，revision CAS 由 hook 负责；
 * - 草稿：draft 变更经 hook 保存（CAS expectedDraftRevision）；
 * - 返回：returnTarget 由服务端 contract 决定（客户端不自行推断返回语义）。
 *
 * 与 demo 的 LearningRunRedrawLab 共存：本组件是唯一生产入口；demo lab
 * 继续使用 fixture（development-only）。
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CreateLearningRunRequestV1, LearningRunPublicV1 as WireRunV1 } from "@ailearn/shared";
import { ApiError } from "@/lib/api";
import { Icon } from "@/components/ui/icons";
import { LiquidOrb } from "@/components/liquid-orb/LiquidOrb";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { LearningRunPlayer } from "./player/LearningRunPlayer";
import { adaptDraftToWire, adaptRunToUi, adaptWireDraftToUi, planUiIntent } from "./ui-adapter";
import { useLearningRun } from "./api/useLearningRun";
import type { LearningRunUiIntentV1, LearningTaskDraftV1 as UiDraftV1 } from "./contracts";

export interface LearningRunLivePlayerProps {
  /** 已存在的 Run（[runId] 路由）。 */
  runId?: string;
  /** 创建请求（new 路由：创建后 redirect 到 [runId]）。 */
  create?: CreateLearningRunRequestV1;
  /** 返回路径（进入前由入口页提供；服务端 returnTarget 为首选）。 */
  fallbackReturnTo?: string;
}

export function LearningRunLivePlayer({ runId, create, fallbackReturnTo }: LearningRunLivePlayerProps) {
  const router = useRouter();
  const hook = useLearningRun();
  const [drafts, setDrafts] = useState<Record<string, UiDraftV1>>({});
  const bootstrappedRef = useRef(false);
  const lastDraftSavedRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(true);

  // 卸载清理：置 mounted 守卫 + 统一清理全部防抖草稿 timer，杜绝卸载后
  // 800ms timer 仍对已停止轮询的 run 发起草稿保存（F#1）。
  useEffect(() => {
    const draftTimers = draftTimerRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of draftTimers.values()) {
        clearTimeout(timer);
      }
      draftTimers.clear();
    };
  }, []);

  // 首次挂载：加载或创建。
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    if (runId) {
      void hook.load(runId);
    } else if (create) {
      void hook.create(create).then((created) => {
        // 幂等重放返回终态 Run（同一天已完成/checkpoint 结束）——自动以新键
        // 再创建一轮（新一轮学习不复用旧 Run）。
        const terminal = ["completed", "cancelled", "stale"].includes(created.phase);
        const checkpointClosed = created.phase === "checkpoint"
          && created.checkpoint?.kind !== "partial";
        const navigateToRun = (runId: string) => {
          // 创建成功立即硬导航:new 页与 [runId] 页是不同页面实例,任何
          // 在 redirect 前发生的输入/草稿都会在页面切换时被丢弃;软导航
          // 的延迟窗口正是"首次输入丢失"的根因。硬导航无中间态。
          window.location.replace(`/learning-runs/${encodeURIComponent(runId)}`);
        };
        if (terminal || checkpointClosed) {
          void hook.create({
            ...create,
            clientRequestId: `${create.clientRequestId}:retry-${Date.now()}`,
            idempotencyKey: `${create.idempotencyKey}:retry-${Date.now()}`,
          }).then((fresh) => {
            navigateToRun(fresh.runId);
          }).catch(() => {
            navigateToRun(created.runId);
          });
          return;
        }
        navigateToRun(created.runId);
      }).catch(() => {});
    }
  }, [hook, create, runId, router]);

  // 草稿恢复：activeTask 出现时读取服务端草稿（wire → UI 形状映射）。
  useEffect(() => {
    const snapshot = hook.snapshot;
    const task = snapshot?.activeTask;
    if (!snapshot || !task || !runId) return;
    void (async () => {
      try {
        const { api } = await import("@/lib/api");
        const draft = await api.getLearningRunDraft(snapshot.runId, task.taskId);
        if (draft && draft.payload) {
          const uiDraft = adaptWireDraftToUi(draft.payload);
          if (!uiDraft) return;
          if (!mountedRef.current) return;
          setDrafts((prev) => {
            // 用户已开始输入时不覆盖本地草稿（恢复只在首次出现时生效）。
            if (prev[task.taskId]) return prev;
            return { ...prev, [task.taskId]: uiDraft };
          });
        }
      } catch {
        // 无草稿或不可用：忽略（恢复是 best effort）。
      }
    })();
  }, [hook.snapshot?.runId, hook.snapshot?.activeTask?.taskId, runId]);

  const wireSnapshot: WireRunV1 | null = hook.snapshot;

  // P5（文档 16 §14.2）：Player 页发布 bounded context——正式作答期间
  // sensitivity=formal_assessment + interactionState=formal_answer，桌宠
  // 侧据此抑制知识提示（§9.5 双重门禁的 renderer 侧一半）。
  const resolvedRunId = runId ?? wireSnapshot?.runId ?? null;
  const activeTaskId = wireSnapshot?.activeTask?.taskId ?? null;
  useMainPageContext(useMemo(() => {
    if (!resolvedRunId) return null;
    const phase = wireSnapshot?.phase;
    const interactionState = phase === "active"
      ? "formal_answer"
      : phase === "preparing" || phase === "assessing" || phase === "committing"
        ? "processing"
        : "idle";
    return {
      routeRef: { kind: "learning_run", runId: resolvedRunId },
      pageKind: "learning_run",
      entityRefs: activeTaskId
        ? [
            { kind: "learning_run", runId: resolvedRunId },
            { kind: "learning_task", runId: resolvedRunId, taskId: activeTaskId },
          ]
        : [{ kind: "learning_run", runId: resolvedRunId }],
      interactionState,
      capabilityHints: [],
      sensitivity: "formal_assessment",
    };
  }, [resolvedRunId, activeTaskId, wireSnapshot?.phase]));

  const handleIntent = useCallback((intent: LearningRunUiIntentV1) => {
    if (!wireSnapshot) return;
    const plan = planUiIntent(wireSnapshot, intent);
    switch (plan.kind) {
      case "action":
        void hook.dispatchAction(plan.action);
        return;
      case "submit": {
        const taskId = wireSnapshot.activeTask?.taskId;
        if (taskId) void hook.submit(taskId, plan.request);
        return;
      }
      case "navigate_back": {
        // §13.1 返回持久语义：优先服务端 returnTarget（刷新/直链后仍能
        // 返回真实来源），fallbackReturnTo 只作为入口页提供的兜底。
        // §15.5：星图返回带 changeSetId（一次性显影注释，graph 页消费）。
        const target = wireSnapshot.returnTarget;
        let returnTo: string | null = null;
        if (target?.kind === "card") returnTo = `/cards/${target.cardId}`;
        else if (target?.kind === "review") returnTo = "/review";
        else if (target?.kind === "star_map") {
          const changeSetId = wireSnapshot.result?.projection?.changeSetId;
          const params = new URLSearchParams();
          if (changeSetId) params.set("changeSetId", changeSetId);
          // §15.6：携带 runId 供 graph 页按 runId 恢复设备本地视口快照。
          params.set("restoreRun", wireSnapshot.runId);
          returnTo = `/graph?${params.toString()}`;
        } else if (target?.kind === "today") returnTo = "/today";
        else if (target?.kind === "onboarding") returnTo = "/";
        router.push(returnTo ?? fallbackReturnTo ?? "/");
        return;
      }
      case "none":
        return;
    }
  }, [hook, wireSnapshot, router, fallbackReturnTo]);

  // 草稿保存：防抖 + 串行队列，避免每次击键并发 PUT 触发服务端 CAS 冲突
  // （stale_draft_revision）。队列保证任意时刻只有一个保存在途，保存完成后
  // 若有更新内容再发最新一版；expectedDraftRevision 始终用服务端返回值同步。
  // 任务离开 active（评估/结算）后服务端拒绝草稿写入（409），此时放弃
  // 重试——回答已锁定，草稿不再有意义，也不制造 409 风暴。
  const draftTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const draftPendingRef = useRef<Map<string, UiDraftV1>>(new Map());
  const draftInflightRef = useRef<Set<string>>(new Set());

  const flushDraft = useCallback((taskId: string) => {
    if (!mountedRef.current) {
      // 组件已卸载：不发起草稿保存，丢弃 pending。
      draftPendingRef.current.delete(taskId);
      return;
    }
    if (draftInflightRef.current.has(taskId)) return;
    const snapshot = hook.snapshot;
    const task = snapshot?.activeTask;
    if (!snapshot || !task || task.taskId !== taskId) {
      // 任务已不存在：丢弃 pending，不重试。
      draftPendingRef.current.delete(taskId);
      return;
    }
    if (snapshot.phase !== "active") {
      // 回答已锁定（评估/结算/结束）：草稿不再可写，静默丢弃。
      draftPendingRef.current.delete(taskId);
      return;
    }
    const pending = draftPendingRef.current.get(taskId);
    if (!pending) return;
    const wireDraft = adaptDraftToWire(pending);
    if (!wireDraft) {
      draftPendingRef.current.delete(taskId);
      return;
    }
    draftPendingRef.current.delete(taskId);
    draftInflightRef.current.add(taskId);
    const expected = lastDraftSavedRef.current.get(taskId) ?? null;
    void hook.saveDraft(taskId, {
      variantId: task.activeVariant.variantId,
      variantRevision: task.activeVariant.revision,
      taskRevision: task.revision,
      expectedDraftRevision: expected,
      payload: wireDraft.payload,
      rendererState: { kind: "text", selectionStart: 0, selectionEnd: 0 },
    }).then((savedRevision) => {
      if (savedRevision !== null) {
        lastDraftSavedRef.current.set(taskId, savedRevision);
      }
    }).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // CAS/任务修订冲突：任务状态已变化，放弃本版本（不无限重试）。
        return;
      }
      // 其它失败：保持 pending 供下次重试（网络抖动等可恢复错误）。
      if (!draftPendingRef.current.has(taskId)) {
        draftPendingRef.current.set(taskId, pending);
      }
    }).finally(() => {
      draftInflightRef.current.delete(taskId);
      if (draftPendingRef.current.has(taskId)) {
        flushDraft(taskId);
      }
    });
  }, [hook]);

  const handleDraftChange = useCallback((taskId: string, draft: UiDraftV1) => {
    setDrafts((prev) => ({ ...prev, [taskId]: draft }));
    draftPendingRef.current.set(taskId, draft);
    const existingTimer = draftTimerRef.current.get(taskId);
    if (existingTimer) clearTimeout(existingTimer);
    // 800ms 防抖：停顿后才保存，快速连续输入只落最新版本。
    draftTimerRef.current.set(taskId, setTimeout(() => {
      draftTimerRef.current.delete(taskId);
      flushDraft(taskId);
    }, 800));
  }, [flushDraft]);

  const uiSnapshot = useMemo(
    () => (wireSnapshot ? adaptRunToUi(wireSnapshot) : null),
    [wireSnapshot],
  );

  if (hook.status === "idle" || hook.status === "loading") {
    return (
      <section className="learning-run-player learning-run-player--loading" role="status" aria-live="polite">
        {/* 2026-08-15（等待界面补全）：此前只有一行裸文字。用液态玻璃球
            （待命蓝滴，低幅）撑起等待视觉，与语音岛/语音题共用同一组件。 */}
        <div className="learning-run-state-card is-preparing">
          <LiquidOrb
            preset="drop"
            tone="running"
            intensity={0.55}
            size={88}
            radius={0.78}
            label="正在准备"
          />
          <span className="learning-run-state-eyebrow">正在准备</span>
          <h1>正在准备本轮学习…</h1>
          <p>正在核对目标、复习授权和可用的作答方式。完成后会自动进入本轮第一个动作，你可以随时离开，不会创建空白学习记录。</p>
          <div className="learning-run-preparing-lines" aria-hidden="true"><i /><i /><i /></div>
        </div>
      </section>
    );
  }
  if (hook.status === "error" || !uiSnapshot) {
    return (
      <section className="learning-run-player learning-run-player--error" role="alert">
        <div className="learning-run-state-card is-danger">
          <span className="learning-run-state-card__icon" aria-hidden="true"><Icon.AlertCircle /></span>
          <span className="learning-run-state-eyebrow">本轮学习不可用</span>
          <h1>这次学习没有准备好</h1>
          <p>{hook.error ?? "本轮学习不可用"}</p>
          <div className="learning-run-state-card__actions">
            <button className="learning-run-button is-secondary" type="button" onClick={() => router.push(fallbackReturnTo ?? "/")}>
              返回
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <LearningRunPlayer
      run={uiSnapshot}
      onIntent={handleIntent}
      drafts={drafts}
      onDraftChange={handleDraftChange}
    />
  );
}
