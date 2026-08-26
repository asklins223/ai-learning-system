import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import type {
  CardActivationReceiptDesktopV1,
  CardGenerationCandidateV1,
  CardGenerationRunSnapshotV1,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../app/room-store";
import { createCommandId, createRequestMeta, gatewayErrorMessage, unwrapGatewayResult } from "../app/desktop-client";

const runStatusLabels: Record<string, string> = {
  queued: "排队中",
  source_sealing: "正在封存来源",
  planning: "正在规划候选",
  authoring: "正在编写候选",
  checking: "正在做质量检查",
  review_ready: "等待审核",
  no_cards_recommended: "没有推荐候选",
  needs_attention: "需要处理",
  activating: "正在提交激活",
  activated: "已收到激活结果",
  closed_without_activation: "已结束，未激活",
  failed: "生成失败",
  cancelled: "已取消",
  stale: "来源已过期",
};

const reviewStageStatuses = new Set([
  "review_ready",
  "no_cards_recommended",
  "needs_attention",
  "activating",
  "activated",
  "closed_without_activation",
]);

function statusLabel(status: string): string {
  return runStatusLabels[status] ?? "服务端处理中";
}

const recoveryReasonLabels: Record<string, string> = {
  provider_unavailable: "生成服务暂时不可用",
  quality_gate_failed: "候选没有通过质量检查",
  source_outdated: "生成来源已经过期",
  run_failed: "这次生成任务已经失败",
  attention_required: "服务端需要进一步处理",
  unknown: "服务端暂时无法说明这次生成状态",
};

function recoveryReasonLabel(reasonCode: string): string {
  return recoveryReasonLabels[reasonCode] ?? "服务端需要进一步处理";
}

function candidateDecisionLabel(candidate: CardGenerationCandidateV1): string {
  if (candidate.qualityState === "failed") return "质量检查未通过";
  if (candidate.qualityState === "checking" || candidate.qualityState === "authored") return "服务端仍在检查";
  if (candidate.reviewDecision === "reject") return "已拒绝";
  if (candidate.publishState === "activated") return "已激活";
  if (candidate.publishState === "activation_failed") return "激活未确认";
  if (candidate.publishState === "superseded" || candidate.publishState === "expired") return "已失效";
  return "待审核";
}

function isActivatableCandidate(candidate: CardGenerationCandidateV1): candidate is CardGenerationCandidateV1 & { candidateEvidenceBindingPlanHash: string } {
  return candidate.reviewDecision === "keep"
    && candidate.publishState === "unpublished"
    && candidate.candidateEvidenceBindingPlanHash !== null;
}

function GenerationPanelHeader() {
  const invoke = useRoomStore((state) => state.invoke);
  return (
    <header className="task-surface__header task-artifact task-artifact--header">
      <div>
        <h2>整理学习卡</h2>
        <p>服务端 Card Generation · 先审核公开候选，再决定是否激活</p>
      </div>
      <button className="surface-close" type="button" onClick={() => invoke("home")} aria-label="关闭学习卡生成并返回房间">
        <ArrowLeft size={17} aria-hidden="true" />
        <span>返回书房</span>
      </button>
    </header>
  );
}

export function CardGenerationSurface() {
  const runId = useRoomStore((state) => state.activeCardGenerationRunId);
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const [run, setRun] = useState<CardGenerationRunSnapshotV1 | null>(null);
  const [candidates, setCandidates] = useState<CardGenerationCandidateV1[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [receipt, setReceipt] = useState<CardActivationReceiptDesktopV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const epochRef = useRef<number | undefined>(undefined);

  const load = useCallback(async (showLoading = false) => {
    if (!runId || !window.ailearn) {
      setLoading(false);
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const runResponse = await window.ailearn.note.cardGeneration.getRun({
        meta: createRequestMeta(epochRef.current),
        runId,
      });
      if (runResponse.workspaceEpoch) epochRef.current = runResponse.workspaceEpoch;
      const nextRun = unwrapGatewayResult(runResponse);
      setRun(nextRun);

      if (reviewStageStatuses.has(nextRun.status)) {
        const candidateResponse = await window.ailearn.note.cardGeneration.getCandidates({
          meta: createRequestMeta(epochRef.current),
          runId,
        });
        if (candidateResponse.workspaceEpoch) epochRef.current = candidateResponse.workspaceEpoch;
        setCandidates(unwrapGatewayResult(candidateResponse).candidates);
      } else {
        setCandidates([]);
      }
      setFailure(null);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setRun(null);
    setCandidates([]);
    setSelectedIds(new Set());
    setReceipt(null);
    setFailure(null);
    void load(true);
  }, [load]);

  useEffect(() => {
    if (!runId || !window.ailearn) return;
    let disposed = false;
    let subscriptionId: string | null = null;
    let unsubscribeEvent: (() => void) | undefined;

    const subscribe = async () => {
      try {
        const response = await window.ailearn.subscriptions.subscribe({
          meta: createRequestMeta(epochRef.current),
          topic: { kind: "cardGeneration", runId },
        });
        if (disposed) return;
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        unsubscribeEvent = window.ailearn.subscriptions.onEvent(subscriptionId, () => {
          void load(false);
        });
      } catch {
        // The visible refresh action remains available when streaming is not
        // enabled; lack of a stream is not evidence that the run is empty.
      }
    };

    void subscribe();
    return () => {
      disposed = true;
      unsubscribeEvent?.();
      if (subscriptionId) {
        void window.ailearn.subscriptions.unsubscribe({
          meta: createRequestMeta(epochRef.current),
          subscriptionId,
        });
      }
    };
  }, [load, runId]);

  const review = async (candidate: CardGenerationCandidateV1, decision: "keep" | "reject") => {
    if (!run || !window.ailearn || busyAction) return;
    const actionKey = `${candidate.candidateId}:${decision}`;
    setBusyAction(actionKey);
    setFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.review({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId(`card-generation-${decision}`),
        runId: run.runId,
        request: {
          version: 2,
          runId: run.runId,
          expectedReviewDraftRevision: run.reviewDraftRevision,
          action: decision === "keep"
            ? {
                type: "keep",
                candidateId: candidate.candidateId,
                expectedRevision: candidate.revision,
                expectedRevisionHash: candidate.candidateRevisionHash,
              }
            : {
                type: "reject",
                candidateId: candidate.candidateId,
                expectedRevision: candidate.revision,
                expectedRevisionHash: candidate.candidateRevisionHash,
                reasonCode: "not_useful",
              },
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await load(false);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSelection = (candidate: CardGenerationCandidateV1) => {
    if (!isActivatableCandidate(candidate)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidate.candidateId)) next.delete(candidate.candidateId);
      else next.add(candidate.candidateId);
      return next;
    });
  };

  const activate = async () => {
    if (!run || !window.ailearn || busyAction) return;
    const selectedCandidates = candidates.filter(
      (candidate): candidate is CardGenerationCandidateV1 & { candidateEvidenceBindingPlanHash: string } =>
        selectedIds.has(candidate.candidateId) && isActivatableCandidate(candidate),
    );
    if (selectedCandidates.length === 0) return;
    setBusyAction("activate");
    setFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.activate({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-activate"),
        runId: run.runId,
        request: {
          version: 1,
          runId: run.runId,
          selectedCandidates: selectedCandidates.map((candidate) => ({
            candidateRevisionId: candidate.candidateRevisionId,
            candidateId: candidate.candidateId,
            revision: candidate.revision,
            revisionHash: candidate.candidateRevisionHash,
            candidateEvidenceBindingPlanHash: candidate.candidateEvidenceBindingPlanHash,
            intent: { kind: "create_new" },
          })),
          existingLifecycleActions: [],
          expectedReviewDraftRevision: run.reviewDraftRevision,
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      const nextReceipt = unwrapGatewayResult(response);
      setReceipt(nextReceipt);
      setSelectedIds(new Set());
      await load(false);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const cancel = async () => {
    if (!run || !window.ailearn || busyAction) return;
    setBusyAction("cancel");
    setFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.cancel({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-cancel"),
        runId: run.runId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await load(false);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const close = async () => {
    if (!run || !window.ailearn || busyAction) return;
    setBusyAction("close");
    setFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.close({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-close"),
        runId: run.runId,
        expectedReviewDraftRevision: run.reviewDraftRevision,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await load(false);
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const selectedCount = [...selectedIds].filter((candidateId) => candidates.some((candidate) => candidate.candidateId === candidateId && candidate.reviewDecision === "keep")).length;

  return (
    <>
      <GenerationPanelHeader />
      <div className="card-generation-surface task-artifact task-artifact--card-generation">
        {loading ? (
          <div className="card-generation-state" role="status"><LoaderCircle className="run-spinner" size={26} aria-hidden="true" /><strong>正在读取生成任务…</strong><p>只从服务端同步 run 和公开候选，不在本机推断结果。</p></div>
        ) : null}
        {!loading && failure ? (
          <div className="card-generation-state card-generation-state--error" role="alert">
            <CircleAlert size={26} aria-hidden="true" /><strong>无法确认这条生成任务</strong><p>{failure}</p>
            <button type="button" className="surface-primary" onClick={() => void load(true)}><RefreshCw size={15} aria-hidden="true" />重新同步</button>
          </div>
        ) : null}
        {!loading && !failure && !run ? (
          <div className="card-generation-state"><Sparkles size={26} aria-hidden="true" /><strong>还没有可恢复的生成任务</strong><p>请从已同步的真实笔记提交整篇笔记生成请求。</p></div>
        ) : null}
        {!loading && !failure && run ? (
          <>
            <div className="card-generation-meta">
              <span><i className="run-phase__dot" aria-hidden="true" />{statusLabel(run.status)}</span>
              <small>run {run.runId.slice(0, 8)} · 审核版本 {run.reviewDraftRevision}</small>
              <button type="button" className="run-icon-button" onClick={() => void load(true)} aria-label="重新读取生成任务"><RefreshCw size={15} aria-hidden="true" /></button>
            </div>
            <div className="card-generation-intro">
              <div><span>整篇笔记</span><strong>{run.sourceOutdated ? "来源版本已经变化" : "来源版本已封存"}</strong></div>
              <p>{run.sourceOutdated ? "这次生成基于旧版本；请回研究册重新同步后再决定是否继续。" : "候选只展示公开问题与目标。答案、评分依据和证据闭包仍由服务端控制。"}</p>
            </div>
            {run.recovery ? <div className="card-generation-recovery" role="status">
              <strong>{recoveryReasonLabel(run.recovery.publicReasonCode)}</strong>
              <p>{run.recovery.retryability === "resync_required" ? "先重新读取服务端状态；桌面不会重试同一生成任务，也不会把失败当成成功。" : "后续动作只使用服务端明确签发的恢复合同。"}</p>
              <div className="surface-action-pair">
                {run.recovery.allowedActions.map((action) => {
                  if (action.kind === "refresh_status") {
                    return <button key={action.kind} type="button" className="surface-secondary" disabled={busyAction !== null} onClick={() => void load(true)}><RefreshCw size={14} aria-hidden="true" />重新检查</button>;
                  }
                  if (action.kind === "return_note" || action.kind === "open_latest_note") {
                    return <button key={action.kind} type="button" className="surface-primary" onClick={() => { setActiveNoteRef(action.sourceRef); invoke("open-notebook"); }}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button>;
                  }
                  return null;
                })}
              </div>
            </div> : null}
            {run.status === "no_cards_recommended" ? <div className="card-generation-empty"><Check size={22} aria-hidden="true" /><strong>服务端没有推荐可复习候选</strong><p>这是一种有效终态，不需要在本机补造学习卡。</p></div> : null}
            {!reviewStageStatuses.has(run.status) && !run.recovery ? <div className="card-generation-state card-generation-state--inline" role="status"><LoaderCircle className="run-spinner" size={20} aria-hidden="true" /><strong>{statusLabel(run.status)}</strong><p>生成服务仍在处理；收到事件后会重新读取。</p></div> : null}
            {reviewStageStatuses.has(run.status) && candidates.length > 0 ? (
              <div className="card-generation-list" aria-label="服务端公开学习卡候选">
                {candidates.map((candidate) => {
                  // The API accepts candidate actions only after the run-level
                  // state reaches review_ready. A needs_attention run may
                  // already contain one passed candidate while another bounded
                  // repair is still in flight; keep the public candidate
                  // context visible, but fail closed on review/activation
                  // controls until the run-level contract is ready.
                  const reviewReady = run.status === "review_ready";
                  const canSelect = reviewReady && isActivatableCandidate(candidate);
                  const selected = selectedIds.has(candidate.candidateId);
                  return (
                    <article className={`card-generation-candidate${selected ? " card-generation-candidate--selected" : ""}`} key={candidate.candidateRevisionId}>
                      <div className="card-generation-candidate__topline">
                        <span>{candidate.recommendation.recommended ? "服务端推荐" : "可审核候选"}</span>
                        <small>{candidate.strategy} · 约 {candidate.estimatedReviewSeconds} 秒</small>
                      </div>
                      <h3>{candidate.objective.statement}</h3>
                      <p>{candidate.front.prompt}</p>
                      <div className="card-generation-candidate__summary"><strong>{candidate.objective.publicSummary}</strong><span>{candidate.objective.knowledgeForm}</span></div>
                      <div className="card-generation-candidate__actions">
                        {canSelect ? <label className="card-generation-select"><input type="checkbox" checked={selected} onChange={() => toggleSelection(candidate)} />选择激活</label> : <span className="card-generation-decision">{candidateDecisionLabel(candidate)}</span>}
                        {reviewReady && candidate.reviewDecision === "undecided" && candidate.isReviewReady && candidate.candidateEvidenceBindingPlanHash !== null ? <>
                          <button type="button" className="surface-secondary" disabled={busyAction !== null} onClick={() => void review(candidate, "reject")}><X size={14} aria-hidden="true" />拒绝</button>
                          <button type="button" className="surface-primary" disabled={busyAction !== null} onClick={() => void review(candidate, "keep")}><Check size={14} aria-hidden="true" />保留</button>
                        </> : null}
                        {busyAction?.startsWith(`${candidate.candidateId}:`) ? <small role="status">正在提交…</small> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}
            {run.status === "review_ready" && candidates.length === 0 ? <div className="card-generation-empty"><CircleAlert size={22} aria-hidden="true" /><strong>服务端没有返回可审核候选</strong><p>这不是本机的空数据；请重新同步或等待服务端状态变化。</p></div> : null}
            {receipt ? <div className="card-generation-receipt" role="status"><Check size={18} aria-hidden="true" /><span><strong>服务端激活回执已确认</strong><small>receipt {receipt.receiptId.slice(0, 8)} · {receipt.mappings.length} 个目标映射已返回</small></span></div> : null}
            <div className="card-generation-footer">
              <span>{selectedCount > 0 ? `已选择 ${selectedCount} 个候选` : "先用服务端回执确认审核决定"}</span>
              <div className="surface-action-pair">
                {run.status === "review_ready" && selectedCount > 0 ? <button type="button" className="surface-primary" disabled={busyAction !== null} onClick={() => void activate()}>激活选中的目标<ArrowRight size={15} aria-hidden="true" /></button> : null}
                {run.status === "review_ready" ? <button type="button" className="surface-secondary" disabled={busyAction !== null} onClick={() => void close()}>结束审核</button> : null}
                {!reviewStageStatuses.has(run.status) && !run.recovery ? <button type="button" className="surface-secondary" disabled={busyAction !== null} onClick={() => void cancel()}>取消生成</button> : null}
                <button type="button" className="text-action" onClick={() => invoke("open-notebook")}>回研究册</button>
              </div>
            </div>
          </>
        ) : null}
      </div>
      <p className="prototype-note task-artifact task-artifact--provenance">此面板只消费服务端 run、候选、审核结果和激活回执；答案 reveal 仍遵守曝光生命周期。</p>
    </>
  );
}
