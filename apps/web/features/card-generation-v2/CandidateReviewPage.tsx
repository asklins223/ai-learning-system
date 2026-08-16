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
import type { CandidateRevealContentV2, CandidateReviewItemV2 } from "./contracts/ui-contracts";
import type { CardPlanV2, CandidateActionCommandV2, CardActivationReceiptV2 } from "@ailearn/shared";

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
  const [activating, setActivating] = useState(false);
  const [activated, setActivated] = useState(false);
  const [activatedReceipt, setActivatedReceipt] = useState<CardActivationReceiptV2 | null>(null);

  useEffect(() => {
    let cancelled = false;
    let activeClient = v2;

    async function boot() {
      try {
        if (!activeClient) {
          const mod = await import("./api-client");
          activeClient = mod.createV2Client();
          if (!cancelled) setResolvedClient(activeClient);
        }
        const runResult = await activeClient.getRun(runId);
        const planResult = await activeClient.getRunPlan(runId);
        const candResult = await activeClient.getRunCandidates(runId);
        if (cancelled) return;
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
        await effectiveV2.candidateAction(
          runId,
          toCandidateActionCommand(
            request,
            runId,
            plan,
            run?.reviewDraftRevision ?? 1,
            // 2026-08-16：cardContentEpoch 从 run 取（plan 类型无此字段，
            // 此前 plan.cardContentEpoch 为 undefined → 请求体缺字段 → 400）。
            run?.cardContentEpoch ?? 1,
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
        answer:
          reveal.canonicalAnswer.kind === "text"
            ? reveal.canonicalAnswer.unit.text
            : "参考答案",
        explanation: reveal.explanation,
        evidencePreview: reveal.evidencePreviews[0]?.preview ?? "",
      };
    },
    [effectiveV2, runId, candidates],
  );

  const onActivate = useCallback(
    async (selected: CandidateReviewItemV2[]) => {
      if (!effectiveV2 || !run || !plan) return;
      setActivating(true);
      setActivationError(null);
      setActivated(false);
      try {
        const selectedPublic = selected
          .map((item) => candidates.find((c) => c.candidateId === item.candidateId))
          .filter((c): c is CandidatePublicView => Boolean(c));
        const request = await buildActivateCandidatesRequest({
          run,
          plan,
          selected: selectedPublic,
          runSourceSnapshotHash: run.sourceSnapshotHash,
        });
        const receipt = await effectiveV2.activateCandidates(
          runId,
          request,
          newV2IdempotencyKey("candidate-activate"),
        );
        setActivatedReceipt(receipt);
        setActivated(true);
      } catch (error) {
        setActivationError(
          error instanceof Error ? error.message : "激活失败。",
        );
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
          onActivate={(sel) => void onActivate(sel)}
          backend={backend}
        />
      )}
      {activating && (
        <p className="candidate-review__notice" role="status">
          <Icon.Refresh />正在启用所选学习卡…
        </p>
      )}
      {activationError && (
        <p className="candidate-review__notice candidate-review__notice--error" role="alert">
          <Icon.Warn />{activationError}
        </p>
      )}
      {activated && activatedReceipt?.mappings[0] && (
        <div className="candidate-review__activated" role="status">
          <p className="candidate-review__notice">已启用。可开始第一次验证。</p>
          <a
            className="card-v2-button card-v2-button--primary"
            href={`/learning-runs/new?origin=card_v2&cardId=${encodeURIComponent(activatedReceipt.mappings[0].cardId)}&objectiveId=${encodeURIComponent(activatedReceipt.mappings[0].objectiveId)}&returnTo=${encodeURIComponent(`/notes/${encodeURIComponent(run?.noteId ?? "")}`)}`}
          >
            <Icon.Play />开始三分钟验证
          </a>
          <a
            className="card-v2-button card-v2-button--quiet"
            href={`/learning-cards/${encodeURIComponent(activatedReceipt.mappings[0].cardId)}`}
          >
            查看学习卡
          </a>
        </div>
      )}
    </div>
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
