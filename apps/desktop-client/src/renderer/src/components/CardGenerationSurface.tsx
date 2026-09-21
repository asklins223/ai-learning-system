import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Eye,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type {
  CardActivationReceiptDesktopV1,
  CardGenerationCandidateV1,
  CardGenerationExposureEligibilityV1,
  CardGenerationRunSnapshotV1,
  DesktopCandidateRevealV2,
  DesktopCardRejectReasonV2,
} from "@ailearn/shared/card-generation-desktop-contracts";
import { useRoomStore } from "../app/room-store";
import { resetObjectiveLibraryView } from "./surfaces/objective-library-view-state";
import { createCommandId, createRequestMeta, gatewayErrorMessage, RendererGatewayError, unwrapGatewayResult } from "../app/desktop-client";
import {
  cardGenerationProgressView,
  cardGenerationRecoveryReasonLabel,
  cardGenerationStageCount,
  cardGenerationStatusLabel,
  cardGenerationSyncReportText,
  isCardGenerationInFlight,
  isCardGenerationReviewOpen,
  isCardGenerationReviewStage,
  isCardGenerationStopped,
} from "./surfaces/card-generation-status";
import { HudPage } from "./hud/HudPage";
import { useHudPage } from "./hud/use-hud-page";
import { formatRelative } from "./surfaces/surface-data";

/**
 * The review page shows one candidate at a time. Its projection carries no
 * answer and no evidence — those arrive only from the reveal call, which is a
 * deliberate, recorded act: the server keeps an exposure for the exact candidate
 * revision and lets it decide when this card may first be validated. Deciding
 * without revealing is allowed and is not a silent default any more.
 */

/**
 * The three states a step can be in on the progress header. The header prints
 * the state as a word next to every step name, so "完成了哪些、还剩哪些" is
 * readable without counting or comparing colours.
 */
const progressStepStateLabels = {
  done: "已完成",
  current: "进行中",
  todo: "待进行",
} as const;

/**
 * 半分钟一次的重渲染时钟，让"最后更新 N 分钟前"跟得上真实时间。
 * 它不拉数据 —— 数据推进靠服务端事件，这里只负责让"多久没动"这个读数
 * 不撒谎。run 不在（空态/加载中）时不跑。
 */
function useStalenessClock(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [active]);
}

/** A decision's own label, in the vocabulary the server keeps. */
function candidateDecisionLabel(candidate: CardGenerationCandidateV1): string {
  if (candidate.qualityState === "failed") return "质量检查未通过";
  if (candidate.qualityState === "checking" || candidate.qualityState === "authored") return "还在检查";
  if (candidate.publishState === "activated") return "已激活";
  if (candidate.publishState === "activation_failed") return "激活没成功";
  if (candidate.publishState === "superseded" || candidate.publishState === "expired") return "已失效";
  if (candidate.reviewDecision === "reject") return "已拒绝";
  // keep/merged used to fall through to "待审核", so a candidate the reviewer had
  // just accepted still looked undecided.
  if (candidate.reviewDecision === "keep") return "已保留 · 在激活队列里";
  if (candidate.reviewDecision === "merged") return "已合并";
  return "待审核";
}

function isActivatableCandidate(candidate: CardGenerationCandidateV1): candidate is CardGenerationCandidateV1 & { candidateEvidenceBindingPlanHash: string } {
  return candidate.reviewDecision === "keep"
    && candidate.publishState === "unpublished"
    && candidate.candidateEvidenceBindingPlanHash !== null;
}

function knowledgeFormLabel(value: CardGenerationCandidateV1["objective"]["knowledgeForm"]): string {
  return {
    fact: "事实",
    definition: "定义",
    relationship: "关系",
    comparison: "比较",
    sequence: "顺序",
    procedure: "步骤",
    causal_model: "因果模型",
    boundary: "边界",
    application_rule: "应用规则",
  }[value];
}

/**
 * 审核页这一行只说"激活后能做什么练习"。选项文本和正确项服务端就没下发，
 * 这里也就无从泄露——它只是让"这张卡带不带客观题"这件事变得可见。
 */
function practiceItemLabel(
  item: { kind: string; optionCount?: number } | null | undefined,
): string {
  if (!item) return "没有，只能用自己的话答";
  switch (item.kind) {
    case "single_choice": return `选择题 · ${item.optionCount ?? "?"} 个选项`;
    case "true_false": return "判断题 · 对不对二选一";
    case "ordering": return `排序题 · 排 ${item.optionCount ?? "?"} 步`;
    case "matching": return `配对题 · ${item.optionCount ?? "?"} 组`;
    default: return "有，但这次没读出来";
  }
}

function strategyLabel(value: CardGenerationCandidateV1["strategy"]): string {
  return {
    recall: "主动回忆",
    cloze: "关键补全",
    compare: "对比辨析",
    sequence: "顺序重建",
    why: "机制解释",
    boundary: "边界判断",
    application: "情境应用",
  }[value];
}

function transformationLabel(value: CardGenerationCandidateV1["transformationKind"]): string {
  return {
    retrieval_definition: "提取定义",
    mechanism_reconstruction: "重建机制",
    structured_comparison: "结构化对比",
    procedure_reconstruction: "重建步骤",
    boundary_discrimination: "辨析边界",
    misconception_correction: "纠正误解",
    source_grounded_application: "来源情境应用",
  }[value];
}

/**
 * What revealing the answer already did to this candidate, in the reviewer's
 * words. The preflight is the same one activation runs, so the two pages cannot
 * disagree about whether an exposure exists.
 */
function exposureLabel(exposure: CardGenerationExposureEligibilityV1 | null, failure: string | null): string {
  if (failure) return "还没读到结果";
  if (!exposure) return "正在确认…";
  if (exposure.exposureStatus === "exposed") {
    return exposure.lastExposedAt
      ? `已查看 · ${formatRelative(exposure.lastExposedAt)}`
      : "已查看";
  }
  if (exposure.exposureStatus === "not_exposed") return "未查看";
  return "还没读到结果";
}

function firstValidationLabel(exposure: CardGenerationExposureEligibilityV1 | null, failure: string | null): string {
  if (failure) return "还没读到结果";
  if (!exposure) return "正在确认…";
  switch (exposure.initialValidationPolicyEffect) {
    // 这里说代价，不说术语：审核人真正要决定的是"要不要现在看答案"，
    // 代价是激活之后这张卡要等一天才能正式验证（复盘 #9）。
    case "eligible": return "激活后马上能正式验证";
    case "wait_for_initial_validation": return "答案看过了：激活后要等 24 小时才能正式验证";
    default: return "还没读到结果";
  }
}

/** The reject vocabulary, in the reviewer's words. */
const REJECT_REASONS: readonly { readonly value: DesktopCardRejectReasonV2; readonly label: string }[] = [
  { value: "not_useful", label: "没有练习价值" },
  { value: "duplicate", label: "与已有内容重复" },
  { value: "too_trivial", label: "过于简单" },
  { value: "wrong", label: "内容不正确" },
  { value: "too_fragmented", label: "拆得太碎" },
  { value: "other", label: "其它原因" },
];

/** One revealed answer, drawn with the shape its own kind carries. */
function AnswerBlock({ answer }: { readonly answer: DesktopCandidateRevealV2["canonicalAnswer"] }) {
  switch (answer.kind) {
    case "text":
      return <p className="reveal-answer__text">{answer.unit.text}</p>;
    case "bullets":
      return <ul className="reveal-answer__list">{answer.items.map((item) => <li key={item.unitId}>{item.text}</li>)}</ul>;
    case "ordered_steps":
      return <ol className="reveal-answer__list">{answer.steps.map((step) => <li key={step.unitId}>{step.text}</li>)}</ol>;
    case "mapping":
      return (
        <dl className="reveal-answer__pairs">
          {answer.pairs.map((pair) => (
            <div key={pair.unitId}>
              <dt>{pair.left}</dt>
              <dd>{pair.right}</dd>
            </div>
          ))}
        </dl>
      );
    case "comparison":
      return (
        <table className="md-table reveal-answer__table">
          <thead>
            <tr>{answer.columns.map((column, index) => <th key={index}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {answer.rows.map((row) => (
              <tr key={row.unitId}>
                <th scope="row">{row.dimension}</th>
                {row.values.map((value, index) => <td key={index}>{value}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "formula":
      return (
        <>
          <p className="reveal-answer__formula">{answer.latex}</p>
          <ul className="reveal-answer__list">
            {answer.variableMeanings.map((item) => (
              <li key={item.symbol}><b>{item.symbol}</b> {item.meaning}</li>
            ))}
          </ul>
        </>
      );
    case "code":
      return (
        <>
          <pre className="code-block"><code>{answer.code}</code></pre>
          {answer.explanation ? <p className="small">{answer.explanation}</p> : null}
        </>
      );
  }
}

export function CardGenerationSurface() {
  const runId = useRoomStore((state) => state.activeCardGenerationRunId);
  const invoke = useRoomStore((state) => state.invoke);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveCardGenerationRunId = useRoomStore((state) => state.setActiveCardGenerationRunId);
  const setReturnTarget = useRoomStore((state) => state.setReturnTarget);
  const [run, setRun] = useState<CardGenerationRunSnapshotV1 | null>(null);
  const [candidates, setCandidates] = useState<CardGenerationCandidateV1[]>([]);
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CardActivationReceiptDesktopV1 | null>(null);
  const [loading, setLoading] = useState(true);
  /** The page-level read failed; an action's own failure never lands here. */
  const [failure, setFailure] = useState<string | null>(null);
  /** A review/activate/cancel that did not confirm, kept beside the card. */
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [noteTitle, setNoteTitle] = useState<string | null>(null);
  const [runIdHealed, setRunIdHealed] = useState(false);
  const [reveal, setReveal] = useState<{ candidateId: string; data: DesktopCandidateRevealV2 } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealFailure, setRevealFailure] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [exposure, setExposure] = useState<CardGenerationExposureEligibilityV1 | null>(null);
  const [exposureFailure, setExposureFailure] = useState<string | null>(null);
  /**
   * 最近一次"手动重新读一次服务端状态"的回执。刷新按钮此前点完什么都不说，
   * 用户看到状态没变就以为按钮坏了 —— 现在它必须报出这次同步读到了什么，
   * 以及它和上一次相比有没有变化。
   */
  const [syncReport, setSyncReport] = useState<{ at: string; status: string | null; changed: boolean } | null>(null);
  const noteTitleRunRef = useRef<string | null>(null);
  const epochRef = useRef<number | undefined>(undefined);
  const undoRef = useRef<HTMLButtonElement>(null);
  /** 上一次读到的 run 状态，供同步回执判断"变了没有"。 */
  const lastStatusRef = useRef<string | null>(null);

  // 跳转自愈：runId 只活在渲染进程 store 里（重启、刷新或异常导航会丢）。
  // store 为空时从 room projection 的活跃生成摘要取回 —— 只要有活跃任务，
  // 进入工作台就不会落到"还没有生成任务"的空态。
  useEffect(() => {
    if (runId || runIdHealed || !window.ailearn) return;
    let active = true;
    void (async () => {
      try {
        const sessionResponse = await window.ailearn.auth.getState({ meta: createRequestMeta() });
        const session = unwrapGatewayResult(sessionResponse);
        if (session.status !== "authenticated" || !session.workspace) {
          throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
        }
        const projectionResponse = await window.ailearn.room.getProjection({ meta: createRequestMeta(session.workspaceEpoch) });
        if (projectionResponse.workspaceEpoch) epochRef.current = projectionResponse.workspaceEpoch;
        const projection = unwrapGatewayResult(projectionResponse);
        const generations = projection.activeGenerationSummary.state === "data"
          ? projection.activeGenerationSummary.data
          : [];
        const generation = generations[0] ?? null;
        if (active && generation) setActiveCardGenerationRunId(generation.runId);
      } catch {
        // 没有可恢复的任务时保持空态；用户仍可从"返回笔记"重新开始。
      } finally {
        if (active) setRunIdHealed(true);
      }
    })();
    return () => { active = false; };
  }, [runId, runIdHealed, setActiveCardGenerationRunId]);

  // 进度页只标注"这是哪篇笔记的任务"；标题读取失败就退回通用文案。
  useEffect(() => {
    if (!run || !window.ailearn) return;
    if (noteTitleRunRef.current === run.runId) return;
    noteTitleRunRef.current = run.runId;
    setNoteTitle(null);
    void (async () => {
      try {
        const response = await window.ailearn.note.get({ meta: createRequestMeta(epochRef.current), noteId: run.noteId });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        setNoteTitle(unwrapGatewayResult(response).title || null);
      } catch {
        setNoteTitle(null);
      }
    })();
  }, [run]);

  const load = useCallback(async (showLoading = false): Promise<string | null> => {
    if (!runId || !window.ailearn) {
      setLoading(false);
      return null;
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

      if (isCardGenerationReviewStage(nextRun.status)) {
        const candidateResponse = await window.ailearn.note.cardGeneration.getCandidates({
          meta: createRequestMeta(epochRef.current),
          runId,
        });
        if (candidateResponse.workspaceEpoch) epochRef.current = candidateResponse.workspaceEpoch;
        const nextCandidates = unwrapGatewayResult(candidateResponse).candidates;
        setCandidates(nextCandidates);
        setActiveCandidateId((current) => nextCandidates.some((candidate) => candidate.candidateId === current)
          ? current
          : nextCandidates.find((candidate) => candidate.reviewDecision === "undecided")?.candidateId ?? nextCandidates[0]?.candidateId ?? null);
      } else {
        setCandidates([]);
        setActiveCandidateId(null);
      }
      setFailure(null);
      return nextRun.status;
    } catch (error) {
      setFailure(gatewayErrorMessage(error));
      return null;
    } finally {
      setLoading(false);
    }
  }, [runId]);

  /**
   * 用户按下的"刷新状态 / 重新检查"。它只重新读服务端状态，但必须留下回执：
   * 读到什么、和上次相比变了没有。状态没变时说清楚"服务端仍是同一个状态"，
   * 而不是让按钮看起来毫无作用。
   */
  const resync = useCallback(async () => {
    const before = lastStatusRef.current;
    const next = await load(true);
    setSyncReport({ at: new Date().toISOString(), status: next, changed: next !== null && next !== before });
  }, [load]);

  // 每一次读到的 run 状态都记在 ref 里（而不是塞在 load 的分支里），同步回执才有
  // 一个可靠的上一次值可以比较 —— 自动刷新（服务端事件）也会更新它。
  useEffect(() => {
    if (run) lastStatusRef.current = run.status;
  }, [run]);

  useEffect(() => {
    setRun(null);
    setCandidates([]);
    setActiveCandidateId(null);
    setReceipt(null);
    setFailure(null);
    setActionFailure(null);
    setReveal(null);
    setRejectingId(null);
    setSyncReport(null);
    lastStatusRef.current = null;
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

  /** The next candidate nobody has decided on, so a decision keeps the flow going. */
  const nextUndecided = (fromId: string): CardGenerationCandidateV1 | null => {
    const index = candidates.findIndex((candidate) => candidate.candidateId === fromId);
    return candidates.slice(index + 1).find((candidate) => candidate.reviewDecision === "undecided")
      ?? candidates.find((candidate) => candidate.reviewDecision === "undecided")
      ?? null;
  };

  const review = async (
    candidate: CardGenerationCandidateV1,
    decision: "keep" | "reject" | "undo",
    reasonCode?: DesktopCardRejectReasonV2,
  ) => {
    if (!run || !window.ailearn || busyAction) return;
    const actionKey = `${candidate.candidateId}:${decision}`;
    setBusyAction(actionKey);
    setActionFailure(null);
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
            : decision === "reject"
              ? {
                  type: "reject",
                  candidateId: candidate.candidateId,
                  expectedRevision: candidate.revision,
                  expectedRevisionHash: candidate.candidateRevisionHash,
                  reasonCode: reasonCode ?? "not_useful",
                }
              : {
                  type: "undo_decision",
                  candidateId: candidate.candidateId,
                  expectedRevision: candidate.revision,
                  expectedRevisionHash: candidate.candidateRevisionHash,
                },
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      setRejectingId(null);
      if (decision === "undo") {
        setActiveCandidateId(candidate.candidateId);
      } else {
        // The decision is recorded; the review keeps moving instead of leaving
        // the reviewer on a card whose buttons have just disappeared.
        const next = nextUndecided(candidate.candidateId);
        if (next) setActiveCandidateId(next.candidateId);
      }
      setReveal(null);
      setRevealFailure(null);
      await load(false);
      if (decision !== "undo") undoRef.current?.focus();
    } catch (error) {
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const revealCandidate = async (candidate: CardGenerationCandidateV1) => {
    if (!run || !window.ailearn || revealing) return;
    setRevealing(true);
    setRevealFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.reveal({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-reveal"),
        runId: run.runId,
        candidateId: candidate.candidateId,
        request: {
          candidateId: candidate.candidateId,
          expectedCandidateRevision: candidate.revision,
          expectedCandidateRevisionHash: candidate.candidateRevisionHash,
        },
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      setReveal({ candidateId: candidate.candidateId, data: unwrapGatewayResult(response) });
    } catch (error) {
      setRevealFailure(gatewayErrorMessage(error));
    } finally {
      setRevealing(false);
    }
  };

  /**
   * 「保留」就是排队：激活集合 = 全部已保留且可激活的候选，不再额外勾选。
   * 之前这里既要「保留」又要勾「加入待激活」，而计数只统计已保留的勾选，
   * 于是先勾后不保留会静默激活 0 张（2026-09-20 实走复盘 #1）。
   */
  const activate = async () => {
    if (!run || !window.ailearn || busyAction) return;
    const selectedCandidates = candidates.filter(
      (candidate): candidate is CardGenerationCandidateV1 & { candidateEvidenceBindingPlanHash: string } =>
        isActivatableCandidate(candidate),
    );
    if (selectedCandidates.length === 0) return;
    setBusyAction("activate");
    setActionFailure(null);
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
      await load(false);
    } catch (error) {
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const cancel = async () => {
    if (!run || !window.ailearn || busyAction) return;
    setBusyAction("cancel");
    setActionFailure(null);
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
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const close = async () => {
    if (!run || !window.ailearn || busyAction) return;
    setBusyAction("close");
    setActionFailure(null);
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
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  /** 保留即排队：待激活数 = 已保留且可激活的候选数。 */
  const activatableCount = candidates.filter(isActivatableCandidate).length;
  const undecidedCount = candidates.filter((candidate) => candidate.reviewDecision === "undecided").length;
  const progressView = run ? cardGenerationProgressView(run.status, run.progress) : null;
  const generationStage = progressView?.stage ?? 0;
  const waitingForRun = !runId && !runIdHealed;
  const generationStages = [
    ["读取笔记", "核对封存下来的原文版本"],
    ["形成问题", "围绕主张生成可验证候选"],
    ["对齐证据", "核对质量门与证据绑定"],
    ["等待审核", "由你决定保留、丢弃或激活"],
  ] as const;
  /**
   * 进度头条：第几步、完成几步、整体百分比。百分比 = (已完成阶段 + 当前阶段内的
   * 细分进度) ÷ 4，细分只来自服务端聚合的候选计数（`run.progress`），客户端不猜时间。
   * 计数文案与百分比同源，所以页面上不会出现两个互相矛盾的读数。
   * `progressView === null` 的状态（失败/待处理/已结束等）说不出走到哪一步，
   * 整块进度不渲染——曾经这里用「不在前三阶段就算第 3 步」兜底，于是进度条恒定 75%
   * 且前三行一起亮「已完成」（2026-09-20 实走复盘 #2）。
   */
  const progressStep = progressView ? Math.min(progressView.stage + 1, cardGenerationStageCount) : 0;
  const progressDone = progressView ? Math.min(progressView.stage, cardGenerationStageCount) : 0;
  const progressTodo = progressView ? Math.max(cardGenerationStageCount - progressStep, 0) : 0;
  const progressPercent = progressView?.percent ?? 0;
  const progressInFlight = Boolean(run && isCardGenerationInFlight(run.status));
  const page = run && isCardGenerationReviewStage(run.status) ? "candidate" : "generating";
  useHudPage(page);

  // 返回原笔记：以 run.sourceRef 为准（activeNoteRef 在导航中可能已被清空或
  // 指向别处），同笔记时保留原 ref 的 mode（阅读/编辑原样回去）。
  const returnToNote = useCallback(() => {
    const current = useRoomStore.getState().activeNoteRef;
    if (run && current?.noteId !== run.sourceRef.noteId) {
      setActiveNoteRef({ noteId: run.sourceRef.noteId, noteVersionId: run.sourceRef.noteVersionId });
    }
    // The note page's back pill then names this workbench, which is where the
    // reader actually came from.
    useRoomStore.getState().setNoteReturnTo("generation");
    invoke("open-notebook");
  }, [invoke, run, setActiveNoteRef]);

  // 生成是后台任务：工作台开着时，左下返回胶囊始终指回这篇笔记——
  // 用户随时可以离开进度页去做别的，进度与候选不会因此丢失。
  useEffect(() => {
    setReturnTarget({ label: "返回笔记", run: returnToNote });
    return () => setReturnTarget(null);
  }, [returnToNote, setReturnTarget]);

  // 「最后更新 N 分钟前」要自己走字。run 的推进是事件驱动的（服务端推一下才读
  // 一次），但"多久没动"是墙上的钟在走：没有这个时钟，一个安静了十分钟的 run
  // 会永远停在"1 分钟前"，用户会把诚实的服务端状态误读成显示卡死。它只触发
  // 重渲染，不重新请求 —— 轮询是刷新按钮的职责，不是时钟的。
  useStalenessClock(Boolean(run));

  const activeCandidate = candidates.find((candidate) => candidate.candidateId === activeCandidateId)
    ?? candidates[0]
    ?? null;
  const activeCandidateIndex = activeCandidate ? candidates.indexOf(activeCandidate) : 0;
  /**
   * 审核是否开着 —— 由 run 状态决定，`needs_attention` 也算（见共享谓词）。
   * 候选自己的 isReviewReady / qualityState / publishState 仍是更严的第二道门。
   */
  const reviewOpen = Boolean(run && isCardGenerationReviewOpen(run.status));
  const activeReveal = reveal && activeCandidate && reveal.candidateId === activeCandidate.candidateId ? reveal.data : null;
  const activeCandidateKey = activeCandidate?.candidateId ?? null;
  const activeCandidateRevision = activeCandidate?.revision ?? null;
  const runKey = run?.runId ?? null;

  // The preflight the activation path already runs, read for the card on screen:
  // revealing the answer is what creates the exposure, so the row follows both
  // the candidate and the reveal.
  useEffect(() => {
    if (!runKey || !reviewOpen || !activeCandidateKey || activeCandidateRevision === null || !window.ailearn) {
      setExposure(null);
      setExposureFailure(null);
      return undefined;
    }
    let active = true;
    setExposure(null);
    setExposureFailure(null);
    void (async () => {
      try {
        const response = await window.ailearn.note.cardGeneration.exposure({
          meta: createRequestMeta(epochRef.current),
          runId: runKey,
          candidateId: activeCandidateKey,
          revision: activeCandidateRevision,
        });
        if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
        if (active) setExposure(unwrapGatewayResult(response));
      } catch (error) {
        if (active) setExposureFailure(gatewayErrorMessage(error));
      }
    })();
    return () => { active = false; };
  }, [runKey, reviewOpen, activeCandidateKey, activeCandidateRevision, reveal]);

  const moveCandidate = (offset: -1 | 1) => {
    const next = candidates[activeCandidateIndex + offset];
    if (!next) return;
    setActiveCandidateId(next.candidateId);
    setRejectingId(null);
    setRevealFailure(null);
  };
  /**
   * 恢复契约签发的返回动作（return_note / open_latest_note / start_new_generation）。
   * 它同时也是审核侧栏「返回笔记」的去重依据：契约已经给了一个返回按钮时，
   * 侧栏不能再补第二个同名的常驻入口。
   */
  const recoveryExitAction = run?.recovery?.allowedActions.find(
    (action) => action.kind === "return_note" || action.kind === "open_latest_note" || action.kind === "start_new_generation",
  ) ?? null;
  const retry = async () => {
    if (!run || !window.ailearn || busyAction) return;
    setBusyAction("retry");
    setActionFailure(null);
    try {
      const response = await window.ailearn.note.cardGeneration.retry({
        meta: createRequestMeta(epochRef.current),
        commandId: createCommandId("card-generation-retry"),
        runId: run.runId,
      });
      if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
      unwrapGatewayResult(response);
      await load(false);
    } catch (error) {
      setActionFailure(gatewayErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const recoveryActions = () => run?.recovery?.allowedActions.map((action) => {
    if (action.kind === "refresh_status") {
      return <button key={action.kind} type="button" className="button" disabled={busyAction !== null} onClick={() => void resync()}><RefreshCw size={14} aria-hidden="true" />{loading ? "正在重新检查…" : "重新检查"}</button>;
    }
    if (action.kind === "retry_generation") {
      // 服务端确认这次失败是"质量门禁"造成的、且来源没过期，才签发这个动作。
      // 它是**同一条 run 内的重跑**（复用已封存来源），比回笔记重开一次便宜得多，
      // 所以必须是主按钮；措辞要如实说明"重跑"而不是"修好了"。
      return <button key={action.kind} type="button" className="button primary" disabled={busyAction !== null} onClick={() => void retry()}><RotateCcw size={14} aria-hidden="true" />{busyAction === "retry" ? "正在重新规划…" : "再生成一次候选"}</button>;
    }
    if (action.kind === "return_note" || action.kind === "open_latest_note" || action.kind === "start_new_generation") {
      return (
        <button key={action.kind} type="button" className="button primary" onClick={() => { setActiveNoteRef(action.sourceRef); invoke("open-notebook"); }}>
          <ArrowLeft size={14} aria-hidden="true" />{action.kind === "start_new_generation" ? "回笔记重新生成" : "返回笔记"}
        </button>
      );
    }
    return null;
  }) ?? null;

  /**
   * 审核侧栏要不要自己补一个「返回笔记」。左侧那张纸在空态、失败态和
   * no_cards_recommended 时都自带返回入口，恢复契约也会签发一个 —— 只有
   * 正常审核一张候选、且没有恢复契约时，侧栏才需要这个常驻入口。
   */
  const showSlipReturn = Boolean(activeCandidate) && !run?.recovery && !failure;

  return (
    <HudPage page={page}>
      {page === "generating" ? (
        <section className="card-press card-generation-board" aria-label="学习卡生成进度">
          <header className="card-generation-board__header">
            <div>
              <span className="tag green">{run ? cardGenerationStatusLabel(run.status) : "准备中"}</span>
              <h2>{noteTitle ? `把《${noteTitle}》整理成学习卡` : "把一篇笔记整理成可练习的问题"}</h2>
              <p>{run ? `生成任务 ${run.runId.slice(0, 8)} · 后台进行中，离开本页不会中断 · 有新进展会自动更新，也可以随时刷新` : "进度只跟着已经确认的阶段走。"}</p>
            </div>
            <button type="button" className="button card-generation-board__sync" disabled={loading} onClick={() => void resync()}>
              <RefreshCw size={14} aria-hidden="true" />{loading ? "正在刷新…" : "刷新状态"}
            </button>
          </header>

          {/* 进度头条：一眼看清「走到第几步 / 当前在做什么 / 完成了几步 / 还剩几步」。
              百分比 = (已完成阶段 + 当前阶段内的候选进度) ÷ 4，细分只来自服务端计数，
              不猜时间；说不出阶段的状态整块不显示，而不是亮一条走完的轨道。 */}
          {run && progressView ? (
            <section className="card-generation-progress" aria-label="生成进度">
              <div className="card-generation-progress__summary">
                <div className="card-generation-progress__current">
                  <span className="card-generation-progress__eyebrow">
                    {progressView.eyebrow}
                  </span>
                  <strong className="card-generation-progress__name">
                    {progressInFlight
                      ? <LoaderCircle className="run-spinner" size={17} aria-hidden="true" />
                      : <Check size={17} aria-hidden="true" />}
                    {cardGenerationStatusLabel(run.status)}
                  </strong>
                  <span className="card-generation-progress__meta">
                    {[
                      // 在途时不报步数（`run.status` 还在那个大事务里），但张数是实时
                      // 读数（0249），所以 `detail` 照旧显示——以前这里整块换成一句
                      // "中间计数要等这一批写完"，那句现在已经是假话了。
                      ...(progressView.inFlight
                        ? []
                        : [`已完成 ${progressDone} 步 · 待进行 ${progressTodo} 步`]),
                      ...(progressView.detail ? [progressView.detail] : []),
                      `最后更新 ${formatRelative(run.updatedAt)}`,
                    ].join(" · ")}
                  </span>
                </div>
                <div
                  className="card-generation-progress__gauge"
                  role="progressbar"
                  aria-label="整体进度"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  aria-valuetext={`第 ${progressStep} 步，共 ${cardGenerationStageCount} 步：${cardGenerationStatusLabel(run.status)}${progressView.detail ? `，${progressView.detail}` : ""}`}
                >
                  <strong className="card-generation-progress__percent">{progressPercent}<i>%</i></strong>
                  <span className="card-generation-progress__percent-caption">整体进度</span>
                </div>
              </div>
              <ol className="card-generation-progress__steps" aria-label="生成步骤">
                {generationStages.map(([label], index) => {
                  const state = index < generationStage ? "done" : index === generationStage ? "current" : "todo";
                  return (
                    <li
                      key={label}
                      className={`card-generation-progress__step is-${state}`}
                      aria-current={state === "current" ? "step" : undefined}
                    >
                      <span className="card-generation-progress__rail" aria-hidden="true" />
                      <span className="card-generation-progress__label">
                        {state === "done" ? <Check size={11} aria-hidden="true" /> : null}
                        {label}
                      </span>
                      <span className="card-generation-progress__state">{progressStepStateLabels[state]}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          {/* 同步回执：按下刷新之后必须说清楚读到了什么。 */}
          {run && syncReport ? (
            <p className="card-generation-board__sync-report" role="status" aria-live="polite">
              {cardGenerationSyncReportText(syncReport.status, syncReport.changed)}
              <span className="card-generation-board__sync-at">· {formatRelative(syncReport.at)}</span>
            </p>
          ) : null}

          {loading || waitingForRun ? <div className="card-generation-hud-state" role="status"><LoaderCircle className="run-spinner" size={24} aria-hidden="true" /><strong>正在读取生成任务</strong><p>正在核对笔记版本和生成进度。</p></div> : null}
          {!loading && !waitingForRun && failure ? <div className="card-generation-hud-state" role="alert"><CircleAlert size={24} aria-hidden="true" /><strong>无法确认这次生成</strong><p>{failure}</p><button type="button" className="button" onClick={() => void resync()}>重新同步</button></div> : null}
          {!loading && !waitingForRun && !failure && !run ? <div className="card-generation-hud-state" role="status"><Sparkles size={24} aria-hidden="true" /><strong>还没有进行中的生成任务</strong><p>回到笔记页，从已保存的整篇笔记重新开始。</p><button type="button" className="button primary" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button></div> : null}

          {!loading && !failure && run ? (
            <>
              {isCardGenerationStopped(run.status) ? (
                <div className="card-generation-hud-state" role="status">
                  <CircleAlert size={24} aria-hidden="true" />
                  <strong>这次生成已取消</strong>
                  <p>没有生成出候选卡，进度也不会往前走。回到笔记页可以重新开始一次。</p>
                  <div className="actions">
                    <button type="button" className="button primary" onClick={returnToNote}>
                      <ArrowLeft size={14} aria-hidden="true" />返回笔记
                    </button>
                  </div>
                </div>
              ) : !run.recovery && progressView ? (
                <div className="press-track">
                  {generationStages.map(([label, detail], index) => (
                    <article className={`press-stage${index < generationStage ? " done" : ""}${index === generationStage ? " active" : ""}`} data-step={String(index + 1).padStart(2, "0")} aria-current={index === generationStage ? "step" : undefined} key={label}>
                      <h3>{label}</h3>
                      <p>{detail}</p>
                      <div className="press-paper">
                        <strong>{index < generationStage ? "已完成" : index === generationStage ? cardGenerationStatusLabel(run.status) : "等待前一步"}</strong>
                        <span>{index === 0
                          // "已封存" is only true once the run has moved past the
                          // sealing stage; a queued run has not sealed anything yet.
                          ? generationStage > 0
                            ? (run.sourceOutdated ? "来源版本已变化" : "来源版本已封存")
                            : "正在确认要封存的来源版本"
                          : index === generationStage
                            ? `有新进展会自动更新 · 更新于 ${formatRelative(run.updatedAt)}`
                            : "不会在本机提前推断"}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : !run.recovery ? (
                // 既说不出走到哪一步、服务端也没签发恢复动作（例如结束后未激活）：
                // 只能给状态与出口，不能点亮一条假装走完的轨道。
                <div className="card-generation-hud-state" role="status">
                  <CircleAlert size={24} aria-hidden="true" />
                  <strong>{cardGenerationStatusLabel(run.status)}</strong>
                  <p>这次生成停下来了，后台也没有给出可以恢复的下一步。回到笔记页可以重新开始一次。</p>
                  <div className="actions">
                    <button type="button" className="button primary" onClick={returnToNote}>
                      <ArrowLeft size={14} aria-hidden="true" />返回笔记
                    </button>
                  </div>
                </div>
              ) : (
                <div className="card-generation-recovery" role="status">
                  <strong>{cardGenerationRecoveryReasonLabel(run.recovery.publicReasonCode)}</strong>
                  <p>{run.recovery.retryability === "resync_required" ? "先重新读一次进度；这台电脑不会把失败的那一步再跑一遍。" : "下一步只做后台明确说可以恢复的那件事。"}</p>
                  <div className="actions">{recoveryActions()}</div>
                </div>
              )}
              {actionFailure ? <p className="small card-generation-board__failure" role="alert">这一步没成功：{actionFailure}</p> : null}
              <footer className="card-generation-board__footer">
                <span>{run.sourceOutdated ? "笔记已有新版本，本次候选不会被当作最新内容。" : `生成计划 ${run.currentPlanVersion || "—"} · 审核版本 ${run.reviewDraftRevision}`}</span>
                <div className="actions">
                  {/* A cancelled run has nothing left to cancel. */}
                  {!run.recovery && run.status !== "cancelled" && run.status !== "activated" && run.status !== "closed_without_activation" ? (
                    <button type="button" className="button" disabled={busyAction !== null} onClick={() => void cancel()}>
                      {busyAction === "cancel" ? "正在取消…" : "取消生成"}
                    </button>
                  ) : null}
                  <button type="button" className="button" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button>
                </div>
              </footer>
            </>
          ) : null}
        </section>
      ) : (
        <div className="review-table candidate-review-table">
          <section
            className="study-card candidate-study-card"
            aria-labelledby="candidate-card-title"
            data-rejecting={rejectingId !== null && rejectingId === activeCandidate?.candidateId ? "true" : undefined}
          >
            {loading ? <div className="card-generation-hud-state" role="status"><LoaderCircle className="run-spinner" size={24} aria-hidden="true" /><strong>正在读取候选卡</strong></div> : null}
            {!loading && failure ? <div className="card-generation-hud-state" role="alert"><CircleAlert size={24} aria-hidden="true" /><strong>候选卡暂时不可用</strong><p>{failure}</p><div className="actions"><button type="button" className="button" onClick={() => void resync()}>重新同步</button><button type="button" className="button primary" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button></div></div> : null}
            {!loading && !failure && run?.status === "no_cards_recommended" ? <div className="card-generation-hud-state" role="status"><Check size={24} aria-hidden="true" /><strong>这次不建议生成学习卡</strong><p>这是有效结果，不需要为了填满页面而制造低质量候选。</p><button type="button" className="button primary" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button></div> : null}
            {/* 恢复态且一张候选都没有：这里不是死端。右侧签发的是「重新检查 + 返回笔记」，
                所以左侧只解释发生了什么，返回入口交给右侧一次呈现（不再各画一个同名按钮）。 */}
            {!loading && !failure && run?.recovery && !activeCandidate ? <div className="card-generation-hud-state" role="status"><CircleAlert size={24} aria-hidden="true" /><strong>{cardGenerationRecoveryReasonLabel(run.recovery.publicReasonCode)}</strong><p>这次没有读到可以审核的候选。右侧的「重新检查」会再读一次进度，告诉你有没有变化；候选一旦下发，会一张一张出现在这里。</p></div> : null}
            {!loading && !failure && !run?.recovery && !activeCandidate ? <div className="card-generation-hud-state" role="status"><CircleAlert size={24} aria-hidden="true" /><strong>没有可审核候选</strong><p>还没有可展示的候选，或者这次生成已经结束。</p><div className="actions"><button type="button" className="button" onClick={() => void resync()}>重新检查</button><button type="button" className="button primary" onClick={returnToNote}><ArrowLeft size={14} aria-hidden="true" />返回笔记</button></div></div> : null}
            {/* 同步回执同样出现在审核页：这是「重新检查」唯一能说话的地方。 */}
            {!loading && !failure && syncReport ? <p className="small notebook-note candidate-review-sync" role="status" aria-live="polite">{cardGenerationSyncReportText(syncReport.status, syncReport.changed)}<span className="card-generation-board__sync-at">· {formatRelative(syncReport.at)}</span></p> : null}
            {!loading && !failure && activeCandidate ? (
              <>
                <div className="candidate-study-card__body">
                  <div className="candidate-card__meta" role="status" aria-live="polite">
                    <span>候选 {activeCandidateIndex + 1} / {candidates.length}{undecidedCount ? ` · ${undecidedCount} 张还没决定` : " · 都已决定"}</span>
                    <span>{candidateDecisionLabel(activeCandidate)}</span>
                  </div>
                  <p className="candidate-card__kicker">这张卡准备验证</p>
                  <h2 id="candidate-card-title">{activeCandidate.objective.statement}</h2>
                  {activeCandidate.front.cue ? (
                    <p className="candidate-card__cue"><b>线索</b>{activeCandidate.front.cue}</p>
                  ) : null}
                  {activeCandidate.front.context ? (
                    <p className="candidate-card__context"><b>情境</b>{activeCandidate.front.context}</p>
                  ) : null}
                  <p className="candidate-card__prompt">{activeCandidate.front.prompt}</p>
                  {activeCandidate.front.mediaRefs?.length ? (
                    <p className="small candidate-card__refs">素材引用：{activeCandidate.front.mediaRefs.join(" · ")}</p>
                  ) : null}
                  {activeCandidate.recommendation.reasonCodes.length ? (
                    <p className="small candidate-card__reasons">
                      建议依据：{activeCandidate.recommendation.reasonCodes.join(" · ")}
                    </p>
                  ) : null}
                  <div className="answer-slip">
                    <small>理解目标摘要</small>
                    <strong>{activeCandidate.objective.publicSummary}</strong>
                  </div>

                  {/* The answer and its evidence are one deliberate call away, not
                      withheld: the reveal is what the server records as exposure. */}
                  {activeReveal ? (
                    <section className="reveal-slip" aria-label="答案与来源证据">
                      <h3 className="serif">答案</h3>
                      <AnswerBlock answer={activeReveal.canonicalAnswer} />
                      <p className="small">{activeReveal.explanation}</p>
                      {activeReveal.boundary ? <p className="small"><b>边界</b>　{activeReveal.boundary}</p> : null}
                      {activeReveal.misconception ? <p className="small"><b>常见误解</b>　{activeReveal.misconception}</p> : null}
                      {activeReveal.workedExample ? <p className="small"><b>示例</b>　{activeReveal.workedExample}</p> : null}
                      <h3 className="serif">来源证据</h3>
                      {activeReveal.evidencePreviews.length ? (
                        <ul className="reveal-evidence">
                          {activeReveal.evidencePreviews.map((item) => (
                            <li key={item.evidenceSnapshotId}>
                              {item.sourceLabel ? <b>{item.sourceLabel}</b> : null}
                              <span>{item.preview}</span>
                            </li>
                          ))}
                        </ul>
                      ) : <p className="small">这次候选没有附带可展示的来源片段。</p>}
                      <p className="small">答案已经看过。这张卡激活之后要等 24 小时才能开始正式首次验证（这段时间随时可以练，只是不计入正式状态）；右侧「首次验证」会写明它的影响。</p>
                    </section>
                  ) : null}
                  {revealFailure ? (
                    <p className="small notebook-note" role="alert">
                      答案读取未确认：{revealFailure}
                      <button type="button" className="text-action text-action--strong" onClick={() => void revealCandidate(activeCandidate)}>重试</button>
                    </p>
                  ) : null}
                  {actionFailure ? <p className="small notebook-note" role="alert">这一步没成功：{actionFailure}</p> : null}
                </div>

                <div className="stamp-actions">
                  <button type="button" className="button" disabled={activeCandidateIndex === 0} onClick={() => moveCandidate(-1)}>上一张</button>
                  {!activeReveal && reviewOpen ? (
                    <button
                      type="button"
                      className="button"
                      disabled={revealing}
                      title="先看过答案再决定保不保留。代价要说在前面：这张卡激活之后要等 24 小时才能做正式首次验证，期间只能练习。"
                      onClick={() => void revealCandidate(activeCandidate)}
                    >
                      <Eye size={14} aria-hidden="true" />{revealing ? "正在读取答案…" : "查看答案与证据"}
                    </button>
                  ) : null}
                  {reviewOpen && activeCandidate.reviewDecision === "undecided" && activeCandidate.isReviewReady && activeCandidate.candidateEvidenceBindingPlanHash !== null && rejectingId !== activeCandidate.candidateId ? (
                    <>
                      <button type="button" className="button" disabled={busyAction !== null} onClick={() => setRejectingId(activeCandidate.candidateId)}>
                        <X size={14} aria-hidden="true" />不保留
                      </button>
                      <button type="button" className="button primary" disabled={busyAction !== null} onClick={() => void review(activeCandidate, "keep")}>
                        <Check size={14} aria-hidden="true" />{busyAction === `${activeCandidate.candidateId}:keep` ? "正在保留…" : "保留（进入激活队列）"}
                      </button>
                    </>
                  ) : null}
                  {reviewOpen && activeCandidate.reviewDecision !== "undecided" && activeCandidate.publishState === "unpublished" ? (
                    <button ref={undoRef} type="button" className="button" disabled={busyAction !== null} onClick={() => void review(activeCandidate, "undo")}>
                      <RotateCcw size={14} aria-hidden="true" />{busyAction === `${activeCandidate.candidateId}:undo` ? "正在撤销…" : "撤销决定"}
                    </button>
                  ) : null}
                  <button type="button" className="button" disabled={activeCandidateIndex >= candidates.length - 1} onClick={() => moveCandidate(1)}>下一张</button>
                </div>

                {rejectingId === activeCandidate.candidateId ? (
                  <div className="reject-reasons" role="group" aria-label="不保留的原因">
                    <span>为什么不要这张卡？</span>
                    {REJECT_REASONS.map((reason) => (
                      <button
                        key={reason.value}
                        type="button"
                        className="text-action text-action--strong"
                        disabled={busyAction !== null}
                        onClick={() => void review(activeCandidate, "reject", reason.value)}
                      >
                        {busyAction === `${activeCandidate.candidateId}:reject` ? "正在提交…" : reason.label}
                      </button>
                    ))}
                    <button type="button" className="text-action" onClick={() => setRejectingId(null)}>取消</button>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          <aside className="evidence-slip candidate-review-slip">
            <span className="tag green">{run ? cardGenerationStatusLabel(run.status) : "等待审核"}</span>
            <h3>{activeCandidate
              ? activeCandidate.recommendation.recommended ? "建议保留这张" : "逐张做判断"
              : run?.recovery ? cardGenerationRecoveryReasonLabel(run.recovery.publicReasonCode) : "逐张做判断"}</h3>
            {/* 恢复态的 run 仍然可能带着通过门禁的候选：把「还能做什么」说在前面，
                否则用户只会看到「需要处理」而不知道这张卡上的按钮仍然是有效的。 */}
            {run?.recovery && activeCandidate ? (
              <p className="small candidate-review-slip__recovery">
                <CircleAlert size={13} aria-hidden="true" />
                这次生成有候选没有通过整体门禁，但通过门禁的候选仍然由你决定 —— 保留、丢弃、激活都照常可用。
              </p>
            ) : null}
            {activeCandidate ? (
              <dl>
                <div><dt>题型</dt><dd>{strategyLabel(activeCandidate.strategy)}</dd></div>
                <div><dt>教学变换</dt><dd>{transformationLabel(activeCandidate.transformationKind)}</dd></div>
                <div><dt>理解形态</dt><dd>{knowledgeFormLabel(activeCandidate.objective.knowledgeForm)}</dd></div>
                <div><dt>预计用时</dt><dd>约 {activeCandidate.estimatedReviewSeconds} 秒</dd></div>
                <div><dt>候选版本</dt><dd>v{activeCandidate.revision} · 计划 {activeCandidate.planVersion}</dd></div>
                <div><dt>质量状态</dt><dd>{candidateDecisionLabel(activeCandidate)}</dd></div>
                <div><dt>随卡练习</dt><dd>{practiceItemLabel(activeCandidate.practiceItem)}</dd></div>
                <div><dt>看过答案</dt><dd>{exposureLabel(exposure, exposureFailure)}</dd></div>
                <div><dt>首次验证</dt><dd>{firstValidationLabel(exposure, exposureFailure)}</dd></div>
              </dl>
            ) : <p>候选一旦可审核，会在左侧一次出现一张。</p>}
            <div className="rule" />
            <p className="small">问题和目标一直是公开的；答案、评分依据和原文片段只在你主动查看时才给，并且会记下你看过一次 —— 上表的"首次验证"就是看过一次的后果。</p>
            {receipt ? <p className="candidate-review-slip__receipt" role="status"><Check size={15} aria-hidden="true" />已确认 {receipt.mappings.length} 个目标映射</p> : null}
            <div className="candidate-review-slip__actions">
              {reviewOpen && undecidedCount > 0 ? (
                // 曾经这一步会静默把所有"未决"候选打成未选中并丢弃（activation-service
                // 的 not_selected_at_activation），而界面上没有任何一句话提到这个后果。
                <p className="small">
                  还有 {undecidedCount} 张没有决定：点「激活」只提交已保留的 {activatableCount} 张，
                  其余会被记为未选中并丢弃。想留哪张就先在它上面点「保留」。
                </p>
              ) : null}
              {run?.recovery ? recoveryActions() : null}
              {reviewOpen && activatableCount > 0 ? (
                <button type="button" className="button primary" disabled={busyAction !== null} onClick={() => void activate()}>
                  {busyAction === "activate" ? "正在激活…" : `激活 ${activatableCount} 个目标`}<ArrowRight size={14} aria-hidden="true" />
                </button>
              ) : null}
              {reviewOpen ? (
                <button type="button" className="button" disabled={busyAction !== null} onClick={() => void close()}>
                  {busyAction === "close" ? "正在结束…" : "结束本次审核"}
                </button>
              ) : null}
              {/* 跳过去是来看刚激活的卡的，所以先把列表的筛选/搜索/滚动清掉：
                  库里那个筛选活得比一次挂载长，上一次留下的「答对过」会把新激活的
                  卡（状态是「还没正式答过」）全挡掉，页面看起来就是空的（复盘 #4）。 */}
              {receipt ? (
                <button
                  type="button"
                  className="button green"
                  onClick={() => { resetObjectiveLibraryView(); invoke("open-objectives"); }}
                >
                  查看理解目标
                </button>
              ) : null}
              {/* 「返回笔记」在同一屏只出现一次：恢复契约已经签发过返回动作，或者左侧
                  那张纸自己带着返回入口（空态/失败态）时，这里就不再补一个同名按钮。 */}
              {showSlipReturn ? (
                <button type="button" className="text-action" onClick={returnToNote}><ArrowLeft size={13} aria-hidden="true" />返回笔记</button>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </HudPage>
  );
}
