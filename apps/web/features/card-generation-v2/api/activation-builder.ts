/**
 * Card Generation V2 — Activation request builder (R7, §17.5)。
 *
 * 从 run public view + plan + 已选 candidates 构造 `ActivateCardCandidatesRequestV2`。
 *
 * 诚实边界（后端不暴露的字段，见 R7 验收）：
 * - `sourceSnapshotHash`：服务端 serializeRunPublic 未下发的 run 私密字段，
 *   plan 也不含 → 客户端无法可靠取得。若无法取得则抛出，不伪造。
 * - 单个 candidate 的 `candidateEvidenceBindingPlanHash` / `qualityReportHashes`：
 *   public candidate DTO 与 plan 均不含 → 同上处理。
 * - `clientReviewHash`：在浏览器用 WebCrypto 按 §17.5 规范兜底计算。
 */

import type { CardPlanV2 } from "@ailearn/shared";
import type { ActivateCardCandidatesRequestV2 } from "@ailearn/shared";
import type { CandidatePublicView, RunPublicView } from "../api-client";
import { sha256Hex } from "./sha256";

const REVIEW_UI_CONTRACT_VERSION = "learning-card-v2-review-1";

export interface ActivationSource {
  run: RunPublicView;
  plan: CardPlanV2;
  selected: CandidatePublicView[];
  runSourceSnapshotHash?: string;
}

/** §17.5 clientReviewHash：H(runId + rev + sorted candidateId:revision:hash)。 */
async function clientReviewHash(activation: {
  runId: string;
  expectedReviewDraftRevision: number;
  selected: Array<{
    candidateId: string;
    revision: number;
    revisionHash: string;
  }>;
}): Promise<string> {
  const sorted = [...activation.selected]
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
    .map((s) => `${s.candidateId}:${s.revision}:${s.revisionHash}`)
    .join("|");
  return sha256Hex(
    `${activation.runId}:${activation.expectedReviewDraftRevision}:${sorted}:${REVIEW_UI_CONTRACT_VERSION}`,
  );
}

/**
 * 构建激活请求。无法取得后端必填的绑定/来源 hash 时抛出带原因的明确错误，
 * 以触发 UI 的“激活被阻断”提示，而不是发出注定失败的伪造请求。
 */
export async function buildActivateCandidatesRequest(
  source: ActivationSource,
): Promise<ActivateCardCandidatesRequestV2> {
  const { run, plan, selected } = source;

  if (plan.result.kind !== "author_candidates") {
    throw new Error("该 Run 没有可激活的候选。");
  }
  const sourceSnapshotHash =
    source.runSourceSnapshotHash ??
    // plan 目前不含 sourceSnapshotHash；run public view 也不下发。
    undefined;

  const missing: string[] = [];
  if (!sourceSnapshotHash) missing.push("sourceSnapshotHash");
  for (const c of selected) {
    if (!c.candidateEvidenceBindingPlanHash) missing.push(`candidateEvidenceBindingPlanHash(${c.candidateId})`);
    if (c.qualityReportHashes?.length === 0) missing.push(`qualityReportHashes(${c.candidateId})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `服务端当前未下发激活所需的闭包元数据（${missing.join(", ")}），激活被阻断。`,
    );
  }

  const reviewHash = await clientReviewHash({
    runId: run.runId,
    expectedReviewDraftRevision: run.reviewDraftRevision,
    selected: selected.map((c) => ({
      candidateId: c.candidateId,
      revision: c.revision,
      revisionHash: c.candidateRevisionHash,
    })),
  });

  return {
    version: 2,
    runId: run.runId,
    sourceSnapshotHash: sourceSnapshotHash!,
    semanticSpecHash: run.semanticSpecHash,
    inputSnapshotHash: run.inputSnapshotHash,
    expectedCardContentEpoch: run.cardContentEpoch,
    planRevisionId: plan.planRevisionId,
    expectedPlanVersion: plan.planVersion,
    planHash: plan.planHash,
    selectedCandidates: selected.map((c) => ({
      candidateRevisionId: c.candidateRevisionId,
      candidateId: c.candidateId,
      revision: c.revision,
      revisionHash: c.candidateRevisionHash,
      candidateEvidenceBindingPlanHash: c.candidateEvidenceBindingPlanHash!,
      qualityReportHashes: c.qualityReportHashes ?? [],
      intent: { kind: "create_new" },
    })),
    existingLifecycleActions: [],
    expectedReviewDraftRevision: run.reviewDraftRevision,
    clientReviewHash: reviewHash,
  };
}
