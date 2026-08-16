"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Icon } from "@/components/ui/icons";
import {
  CandidateReview,
  type CandidateActionRequestV2Local,
} from "./CandidateReview";
import { ZeroCardResult } from "./ZeroCardResult";
import {
  newV2IdempotencyKey,
  V2ApiError,
  type CandidatePublicView,
  type RunPublicView,
  type V2Client,
} from "./api-client";
import {
  toCandidateReviewItem,
  toCandidateSetSummary,
  toZeroCardResult,
} from "./api/adapters";
import {
  buildActivateCandidatesRequest,
} from "./api/activation-builder";
import { CardGenerationV2ActivationDialog } from "@/components/note-editor/CardGenerationV2ActivationDialog";
import type { CandidateRevealContentV2, CandidateReviewItemV2 } from "./contracts/ui-contracts";
import type { CardPlanV2, CandidateActionCommandV2, CardActivationReceiptV2, CanonicalAnswerV2 } from "@ailearn/shared";

export interface CandidateReviewPageProps {
  runId: string;
  client?: V2Client;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

/**
 * 真实 V2 候选审核页（R7 §19.3/§19.4）。
 *
 * 拉取 run view + plan + candidates；keep/reject/edit/merge → candidateAction；
 * reveal → revealCandidate；zero-card → no_cards_recommended plan；
 * activate → activateCandidates（缺服务端未下发的闭包 hash 时会明确阻断）。
 * `client` 可注入以便测试。
 */
function formatCanonicalAnswer(answer: CanonicalAnswerV2): string {
  switch (answer.kind) {
    case "text":
      return answer.unit.text;
    case "bullets":
      return answer.items.map((item) => `• ${item.text}`).join("\n");
    case "ordered_steps":
      return answer.steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n");
    case "mapping":
      return answer.pairs.map((pair) => `${pair.left} → ${pair.right}`).join("\n");
    case "comparison":
      return [
        answer.columns.join(" | "),
        ...answer.rows.map((row) => `${row.dimension}: ${row.values.join(" | ")}`),
      ].join("\n");
    case "formula":
      return answer.latex;
    case "code":
      return answer.code;
    default:
      // 兜底：未知/缺失 kind 时返回可读内容而不是抛错或显示占位文本。
      return JSON.stringify(answer) || "";
  }
}

export function CandidateReviewPage({
  runId,
  client,
}: CandidateReviewPageProps) {
  const v2 = useMemo(() => client ?? null, [client]);
  // 2026-08-16（实机验证修复）：boot() 在 client 未注入时局部 fallback
  // createV2Client() 加载数据成功，但未提升为 state → v2 恒 null →
  // backend=undefined（页面显示"开发预览"）→ onActivate 的 `!v2` 短路，
  // 点击"启用 N 张学习卡"完全无反应。此处把 fallback client 提升为 state，
  // 使审核/激活真实走 API。
  const [resolvedClient, setResolvedClient] = useState<V2Client | null>(null);
  const effectiveV2 = v2 ?? resolvedClient;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [run, setRun] = useState<RunPublicView | null>(null);
  const [plan, setPlan] = useState<CardPlanV2 | null>(null);
  const [candidates, setCandidates] = useState<CandidatePublicView[]>([]);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationErrorOpen, setActivationErrorOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activatedReceipt, setActivatedReceipt] = useState<CardActivationReceiptV2 | null>(null);
  const [activationModalOpen, setActivationModalOpen] = useState(false);
  const [activationHasExposure, setActivationHasExposure] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let activeClient = v2;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    async function boot() {
      try {
        if (!activeClient) {
          const mod = await import("./api-client");
          activeClient = mod.createV2Client();
          if (!cancelled) setResolvedClient(activeClient);
        }
        const runResult = await activeClient.getRun(runId);
        let planResult: CardPlanV2 | null = null;
        try {
          planResult = await activeClient.getRunPlan(runId);
        } catch (planErr) {
          const status = (planErr as { statusCode?: number }).statusCode;
          // 2026-08-16（实机验证修复）：plan 未就绪（404）不是"服务未开启"——
          // 重新生成/新 run 刚创建时 plan 还在 worker 生成中，轮询等待而不是报错。
          if (status !== 404) throw planErr;
        }
        let candResult: { candidates: CandidatePublicView[] } = { candidates: [] };
        try {
          candResult = await activeClient.getRunCandidates(runId);
        } catch (candErr) {
          const status = (candErr as { statusCode?: number }).statusCode;
          if (status !== 404) throw candErr;
        }
        if (cancelled) return;
        // plan 或候选尚未就绪（仍在 planning/authoring/checking）：1.5s 后重试。
        // 终态 run（no_cards_recommended/activated/failed 等）候选为空是正常
        // 结果（渲染 ZeroCardResult 或空列表），不再轮询。
        const terminal = [
          "no_cards_recommended",
          "activated",
          "closed_without_activation",
          "failed",
          "cancelled",
          "stale",
        ].includes(runResult.status);
        if (!planResult || (candResult.candidates.length === 0 && !terminal)) {
          pollTimer = setTimeout(() => void boot(), 1500);
          return;
        }
        setRun(runResult);
        setPlan(planResult);
        setCandidates(candResult.candidates);
        setLoad({ status: "ready" });
      } catch (error) {
        if (cancelled) return;
        if (
          error instanceof V2ApiError &&
          (error.statusCode === 404 || error.statusCode === 503)
        ) {
          setLoad({
            status: "error",
            message: "Card V2 生成服务尚未开启，无法载入候选。",
          });
        } else {
          setLoad({
            status: "error",
            message: error instanceof Error ? error.message : "候选加载失败。",
          });
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [v2, runId]);

  // F#7（🟡20）：backend 对象用 useMemo 稳定化——原 useCallback 每渲染调用
  // buildBackend() 都新建对象，抵消 CandidateReview 将来的 memo 收益。仅当
  // v2/plan/runId 变化才重建。
  const backend = useMemo(() => {
    if (!effectiveV2 || !plan) return undefined;
    return {
      refresh: async () => {
        const latest = await effectiveV2.getRunCandidates(runId);
        const latestPlan = await effectiveV2.getRunPlan(runId);
        setCandidates(latest.candidates);
        if (latestPlan) setPlan(latestPlan);
        return latest.candidates.map(toCandidateReviewItem);
      },
      submitAction: async (request: CandidateActionRequestV2Local) => {
        // 每次动作前拉最新 run，避免 keep/reveal 后 reviewDraftRevision 过期
        // 导致 edit/keep 失败、服务端不产生 recheck 任务。
        const latestRun = await effectiveV2.getRun(runId);
        setRun(latestRun);
        await effectiveV2.candidateAction(
          runId,
          toCandidateActionCommand(
            request,
            runId,
            plan,
            latestRun?.reviewDraftRevision ?? 1,
            latestRun?.cardContentEpoch ?? 1,
          ),
          newV2IdempotencyKey("candidate-action"),
        );
      },
    };
  }, [effectiveV2, runId, plan, run?.reviewDraftRevision]);

  const onReveal = useCallback(
    async (candidate: CandidateReviewItemV2): Promise<CandidateRevealContentV2> => {
      if (!effectiveV2) throw new Error("V2 client 不可用。");
      const pageCandidate = candidates.find((c) => c.candidateId === candidate.candidateId);
      if (!pageCandidate) throw new Error("候选不存在。");
      const reveal = await effectiveV2.revealCandidate(
        runId,
        candidate.candidateId,
        {
          candidateId: candidate.candidateId,
          expectedCandidateRevision: pageCandidate.revision,
          expectedCandidateRevisionHash: pageCandidate.candidateRevisionHash,
        },
        newV2IdempotencyKey("candidate-reveal"),
      );
      return {
        candidateId: reveal.candidateId,
        revision: reveal.revision,
        exposureId: reveal.exposureId,
        answer: formatCanonicalAnswer(reveal.canonicalAnswer),
        explanation: reveal.explanation,
        evidencePreview: reveal.evidencePreviews[0]?.preview ?? "",
      };
    },
    [effectiveV2, runId, candidates],
  );

  const onActivate = useCallback(
    async (selected: CandidateReviewItemV2[], hasExposure: boolean) => {
      if (!effectiveV2 || !run || !plan) return;
      setActivating(true);
      setActivationError(null);
      setActivationErrorOpen(false);
      try {
        // 激活要求服务端 review_decision=keep；先为所有“ready”但尚未 keep
        // 的已选候选提交 keep，避免激活时 409 not_kept。
        // 每次 keep 后 reviewDraftRevision 会变化，必须重新拉取 run 用最新值。
        let latestRun = run;
        for (const item of selected) {
          if (item.reviewState !== "ready") continue;
          const pageCandidate = candidates.find((c) => c.candidateId === item.candidateId);
          if (!pageCandidate) continue;
          await effectiveV2.candidateAction(
            runId,
            toCandidateActionCommand(
              {
                type: "keep",
                candidateId: item.candidateId,
                expectedRevision: item.revision,
                expectedRevisionHash: item.revisionHash,
              },
              runId,
              plan,
              latestRun?.reviewDraftRevision ?? 1,
              latestRun?.cardContentEpoch ?? 1,
            ),
            newV2IdempotencyKey("candidate-keep"),
          );
          latestRun = await effectiveV2.getRun(runId);
        }
        if (latestRun) setRun(latestRun);

        const selectedPublic = selected
          .map((item) => candidates.find((c) => c.candidateId === item.candidateId))
          .filter((c): c is CandidatePublicView => Boolean(c));
        const request = await buildActivateCandidatesRequest({
          run: latestRun ?? run,
          plan,
          selected: selectedPublic,
          runSourceSnapshotHash: (latestRun ?? run).sourceSnapshotHash,
        });
        const receipt = await effectiveV2.activateCandidates(
          runId,
          request,
          newV2IdempotencyKey("candidate-activate"),
        );
        setActivatedReceipt(receipt);
        setActivationHasExposure(hasExposure);
        setActivationModalOpen(true);
        // 激活成功：清除笔记页持久化的 V2 run 状态（key 与 NoteEditor 一致），
        // 避免返回笔记页后按钮仍显示"查看候选审核"、跳转到已关闭的 run。
        try {
          window.localStorage.removeItem(`ailearn.v2GenerationRun.${run.noteId}`);
        } catch {
          // ignore storage errors
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "激活失败。";
        setActivationError(message);
        setActivationErrorOpen(true);
      } finally {
        setActivating(false);
      }
    },
    [effectiveV2, run, plan, runId, candidates],
  );

  if (load.status === "loading") {
    return (
      <div className="card-v2-lab__stage" aria-busy="true">
        <section className="candidate-review__loading">
          <Icon.Sparkle />正在载入候选…
        </section>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <section className="candidate-review__error" role="alert">
        <Icon.Warn />
        <h2>候选加载失败</h2>
        <p>{load.message}</p>
      </section>
    );
  }

  if (plan && plan.result.kind === "no_cards_recommended") {
    return (
      <div className="card-v2-lab__stage">
        <ZeroCardResult result={toZeroCardResult({ result: plan.result })} onRetry={() => undefined} />
      </div>
    );
  }

  return (
    <>
      <div className="card-v2-lab__stage">
        {plan && run && (
          <CandidateReview
            summary={toCandidateSetSummary(
              run,
              candidates,
              plan.atomDecisions.length,
            )}
            initialCandidates={candidates.map(toCandidateReviewItem)}
            onReveal={onReveal}
            onActivate={(sel, exposed) => void onActivate(sel, exposed)}
            backend={backend}
          />
        )}
        {activating && (
          <p className="candidate-review__notice" role="status">
            <Icon.Refresh />正在启用所选学习卡…
          </p>
        )}
      </div>

      {activatedReceipt && activationModalOpen && (
        <CardGenerationV2ActivationDialog
          open={activationModalOpen}
          hasExposure={activationHasExposure}
          receipt={activatedReceipt}
          noteId={run?.noteId ?? ""}
          onClose={() => setActivationModalOpen(false)}
        />
      )}

      {activationErrorOpen && activationError && (
        <div className="candidate-edit-overlay card-v2-settings-overlay" role="alertdialog" aria-modal="true" aria-label="启用失败">
          <div className="candidate-edit-dialog card-v2-activation-dialog">
            <header>
              <div>
                <p>LEARNING CARD V2</p>
                <h2>启用失败</h2>
                <span>请处理后重试。</span>
              </div>
              <button type="button" onClick={() => setActivationErrorOpen(false)} aria-label="关闭">
                <Icon.Close />
              </button>
            </header>
            <div className="card-v2-activation-dialog__body">
              <div className="candidate-review__notice candidate-review__notice--error" role="alert">
                <Icon.Warn />
                <p>{activationError}</p>
              </div>
              <footer className="card-v2-activation-dialog__footer">
                <button type="button" className="card-v2-button card-v2-button--quiet" onClick={() => setActivationErrorOpen(false)}>关闭</button>
              </footer>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function toCandidateActionCommand(
  request: CandidateActionRequestV2Local,
  runId: string,
  plan: CardPlanV2,
  reviewDraftRevision: number,
  cardContentEpoch: number,
): CandidateActionCommandV2 {
  const base = {
    version: 2 as const,
    runId,
    expectedCardContentEpoch: cardContentEpoch,
    expectedPlanVersion: plan.planVersion,
    expectedPlanHash: plan.planHash,
    // 2026-08-16（实机验证修复）：reviewDraftRevision 用 run 实时值——此前
    // 硬编码 1，keep 后服务端 revision 变化导致后续动作 stale_revision。
    expectedReviewDraftRevision: reviewDraftRevision,
  };
  switch (request.type) {
    case "keep":
      return {
        ...base,
        action: {
          type: "keep",
          candidateId: request.candidateId,
          expectedRevision: request.expectedRevision,
          expectedRevisionHash: request.expectedRevisionHash,
        },
      };
    case "reject":
      return {
        ...base,
        action: {
          type: "reject",
          candidateId: request.candidateId,
          expectedRevision: request.expectedRevision,
          expectedRevisionHash: request.expectedRevisionHash,
          reasonCode: "not_useful",
        },
      };
    case "undo_reject":
      return {
        ...base,
        action: {
          type: "undo_decision",
          candidateId: request.candidateId,
          expectedRevision: request.expectedRevision,
          expectedRevisionHash: request.expectedRevisionHash,
        },
      };
    case "edit":
      return {
        ...base,
        action: {
          type: "edit",
          candidateId: request.candidateId,
          expectedRevision: request.expectedRevision,
          expectedRevisionHash: request.expectedRevisionHash,
          patch: {
            ...(request.patch?.objectiveStatement
              ? { objectiveStatement: request.patch.objectiveStatement }
              : {}),
            front: { prompt: request.patch?.front?.prompt ?? "" },
          },
        },
      };
    case "merge":
      return {
        ...base,
        action: {
          type: "merge",
          candidateIds: request.candidateIds ?? [request.candidateId],
          expectedRevisions: (request.candidateIds ?? [request.candidateId]).map(
            (id) => ({
              candidateId: id,
              revision: request.expectedRevision,
              hash: request.expectedRevisionHash,
            }),
          ),
          mergedDraft: {
            front: { prompt: request.patch?.front?.prompt ?? "" },
          },
        },
      };
  }
}
