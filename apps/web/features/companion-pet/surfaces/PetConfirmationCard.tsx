"use client";

import { useEffect, useRef, useState } from "react";
import { usePetRuntime } from "../runtime/PetRuntimeProvider";
import { PetIcon } from "./PetIcon";
import { decideLearningProposal } from "../learning-actions";
import { createCompanionChatClient } from "../conversation/companion-chat-client";
import { usePetBridgeContext } from "@/features/companion-bridge/usePetBridgeContext";

const UUID_V1 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function PetConfirmationCard() {
  const { state, dispatch } = usePetRuntime();
  // 方案 16 §18：LearningRun 工具成功后 resultRef=runId，经 Bridge V2
  // dispatchMainCommand 打开主窗口 Player（浏览器无 bridge 时 fail closed）。
  const petBridge = usePetBridgeContext();
  const dialogRef = useRef<HTMLElement>(null);
  const actionWatchAbortRef = useRef<AbortController | null>(null);
  const dismissTimerRef = useRef<number | null>(null);
  // F18（round4）：卸载守卫——await 后 setState/dispatch 前检查，
  // 避免 in-flight 返回后卸载才落地而开新 SSE / setState。
  const mountedRef = useRef(true);
  const decisionAttemptRef = useRef<{
    proposalId: string;
    decision: "confirm" | "reject";
    idempotencyKey: string;
  } | null>(null);
  const [decisionState, setDecisionState] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [statusMessage, setStatusMessage] = useState("");
  // §14.3 command 回执：等待主窗口真实回执（completed/failed/rejected）。
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const proposalIdForEffect = state.bubble.kind === "confirmation" ? state.bubble.proposalId : null;

  useEffect(() => {
    if (state.bubble.kind === "confirmation") dialogRef.current?.focus();
  }, [state.bubble.kind]);

  useEffect(() => {
    setDecisionState("idle");
    setStatusMessage("");
    setPendingCommandId(null);
    actionWatchAbortRef.current?.abort();
    actionWatchAbortRef.current = null;
    decisionAttemptRef.current = null;
    // B5 fix：新 proposal 替换时清掉旧确认卡的 700ms dismiss 定时器，
    // 避免旧 timer 在新卡片上 dispatch bubble.dismissed 误隐藏。
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, [proposalIdForEffect]);

  useEffect(() => () => {
    mountedRef.current = false;
    actionWatchAbortRef.current?.abort();
    actionWatchAbortRef.current = null;
    // B5 fix：卸载时清理 dismiss 定时器，组件卸载后不得再 dispatch。
    if (dismissTimerRef.current !== null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  // §14.3：command 回执消费——导航失败（rejected/failed）给用户明确反馈；
  // 成功（completed）清除等待态。回执按 commandId 匹配（Pet 发起时记录）。
  useEffect(() => {
    if (!pendingCommandId || !petBridge.uiEvent) return;
    const event = petBridge.uiEvent;
    if (event.commandId !== pendingCommandId) return;
    if (event.type === "command.failed" || event.type === "command.rejected") {
      setPendingCommandId(null);
      setDecisionState("error");
      setStatusMessage("页面打开失败，学习状态没有改变");
    } else if (event.type === "command.completed") {
      setPendingCommandId(null);
    }
  }, [petBridge.uiEvent, pendingCommandId]);

  if (state.bubble.kind !== "confirmation") return null;

  const proposalId = state.bubble.proposalId;
  const realProposal = UUID_V1.test(proposalId);
  const watchAction = (actionRunId: string, conversationId: string, after: number) => {
    const userId = state.context.userId;
    const workspaceId = state.context.workspaceId;
    if (!userId || !workspaceId) return;
    actionWatchAbortRef.current?.abort();
    const controller = new AbortController();
    actionWatchAbortRef.current = controller;
    const client = createCompanionChatClient({ userId, workspaceId });
    client.streamEvents({
      conversationId,
      after,
      runId: actionRunId,
      generation: 0,
      includeActionEvents: true,
      signal: controller.signal,
      onDispatch: (event) => {
        if (event.actionRunId !== actionRunId) return;
        if (event.type === "action.completed" && event.safeSummary) {
          dispatch({
            type: "action.completed",
            actionRunId,
            resultRef: event.resultRef ?? null,
            route: event.route ?? null,
            safeSummary: event.safeSummary,
            seq: event.seq,
          });
        } else if (event.type === "action.failed" && event.code) {
          dispatch({
            type: "action.failed",
            actionRunId,
            code: event.code,
            recoverable: event.recoverable ?? false,
            seq: event.seq,
          });
        } else {
          return;
        }
        controller.abort();
        if (actionWatchAbortRef.current === controller) actionWatchAbortRef.current = null;
      },
      onError: (_kind, exhausted) => {
        // M11（审计修复）：此前无 onError——重试耗尽后静默，卡片停在
        // "已提交"，action.completed/failed 永不派发。exhausted（网络/重试
        // 耗尽）时用本地 state 呈现错误：这是 watcher 连接失败而非服务端
        // action 终态事件，不能走 reducer 的 action.failed（seq 事件门控，
        // seq=0 会被 latestEventSeq 过滤）。服务端 action 结果仍由完整对话
        // 页的 durable snapshot 恢复。
        if (!exhausted || actionWatchAbortRef.current !== controller) return;
        actionWatchAbortRef.current = null;
        controller.abort();
        setDecisionState("error");
        setStatusMessage("连接中断，未收到学习动作结果——可稍后在完整对话页查看。");
      },
    });
  };

  const submitDecision = async (decision: "confirm" | "reject") => {
    if (!realProposal) {
      dispatch({ type: "bubble.dismissed" });
      return;
    }
    setDecisionState("submitting");
    setStatusMessage(decision === "confirm" ? "正在提交…" : "正在取消…");
    const attempt = decisionAttemptRef.current?.proposalId === proposalId
      && decisionAttemptRef.current.decision === decision
      ? decisionAttemptRef.current
      : {
          proposalId,
          decision,
          idempotencyKey: crypto.randomUUID(),
        };
    decisionAttemptRef.current = attempt;
    try {
      const response = await decideLearningProposal({
        proposalId,
        decision,
        idempotencyKey: attempt.idempotencyKey,
      });
      // F18：await 后卸载守卫——不得在卸载后 setState 或开新的 SSE（watchAction）。
      if (!mountedRef.current) return;
      decisionAttemptRef.current = null;
      if (response.route) {
        // §14.4/§18：导航统一走 Bridge V2。focus/restore 类工具回执用页内命令
        // （graph.focus / graph.restore，不整页刷新）；其余用 open_route。
        const route = response.route;
        if (route.kind === "star_map" && route.restoreRun) {
          const result = await petBridge.dispatchInPageCommand({ kind: "graph.restore", runId: route.restoreRun });
          if (!mountedRef.current) return;
          if (result.accepted && result.commandId) setPendingCommandId(result.commandId);
        } else if (route.kind === "star_map" && route.keyPointId && route.lens) {
          const result = await petBridge.dispatchInPageCommand({ kind: "graph.focus", keyPointId: route.keyPointId, lens: route.lens });
          if (!mountedRef.current) return;
          if (result.accepted && result.commandId) setPendingCommandId(result.commandId);
        } else {
          const result = await petBridge.dispatchOpenRoute(route);
          if (!mountedRef.current) return;
          if (result.accepted && result.commandId) setPendingCommandId(result.commandId);
        }
      } else if (
        response.status === "succeeded" &&
        response.resultRef &&
        UUID_V1.test(response.resultRef)
      ) {
        // LearningRun 工具：resultRef=runId → Bridge V2 打开主窗口 Player。
        const result = await petBridge.dispatchOpenRoute({ kind: "learning_run", runId: response.resultRef });
        if (!mountedRef.current) return;
        if (result.accepted && result.commandId) setPendingCommandId(result.commandId);
      }
      if (
        decision === "confirm" &&
        response.actionRunId &&
        state.context.conversationId &&
        (response.status === "accepted" || response.status === "executing")
      ) {
        // F18：watchAction 会新建 SSE——卸载后不得再开。
        if (!mountedRef.current) return;
        watchAction(response.actionRunId, state.context.conversationId, state.context.latestEventSeq);
      }
      if (!mountedRef.current) return;
      if (decision === "reject" || response.status === "succeeded") {
        setDecisionState("done");
        setStatusMessage(decision === "reject" ? "已取消" : "已完成");
        if (dismissTimerRef.current !== null) window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = window.setTimeout(() => {
          dismissTimerRef.current = null;
          // F18：定时器回调也查 mounted，卸载后不再 dispatch。
          if (mountedRef.current) dispatch({ type: "bubble.dismissed" });
        }, 700);
      } else if (response.status === "accepted" || response.status === "executing") {
        setDecisionState("done");
        setStatusMessage("已提交，等待学习动作完成…");
      } else {
        setDecisionState("error");
        setStatusMessage("动作未完成，请稍后重试");
      }
    } catch {
      if (!mountedRef.current) return;
      setDecisionState("error");
      setStatusMessage("操作失败，学习状态没有改变");
    }
  };

  return (
    <section
      ref={dialogRef}
      className="pet-confirmation-card"
      data-pet-region="bubble"
      role="dialog"
      aria-modal="false"
      aria-labelledby="pet-confirmation-title"
      data-confirmation="card"
      tabIndex={-1}
    >
      <header className="pet-confirmation-header">
        <span className="pet-confirmation-emblem"><PetIcon name="study" /></span>
        <span>
          <small>需要你的确认</small>
          <strong id="pet-confirmation-title">{state.bubble.actionName}</strong>
        </span>
      </header>

      <div className="pet-confirmation-body">
        <div className="pet-confirmation-detail">
          <span>目标</span>
          <strong>{state.bubble.target}</strong>
        </div>
        <div className="pet-confirmation-detail">
          <span>会发生什么</span>
          <p>{state.bubble.impact}</p>
        </div>
        <p className="pet-confirmation-note"><PetIcon name="shield" />
          {decisionState === "done" ? "已提交，等待学习动作完成。" : "未确认前不会修改学习状态。"}
        </p>
      </div>

      <footer className="pet-confirmation-actions">
        <button
          type="button"
          className="pet-secondary-action"
          disabled={decisionState === "submitting" || decisionState === "done"}
          onClick={() => void submitDecision("reject")}
        >
          取消
        </button>
        <button
          type="button"
          className="pet-primary-action"
          disabled={!realProposal || decisionState === "submitting" || decisionState === "done"}
          title={!realProposal ? "演示确认卡不可执行" : undefined}
          onClick={() => void submitDecision("confirm")}
        >
          确认开始
          <PetIcon name="chevron" />
        </button>
      </footer>
      {statusMessage ? <p className="pet-confirmation-status" role="status" aria-live="polite">{statusMessage}</p> : null}
    </section>
  );
}
