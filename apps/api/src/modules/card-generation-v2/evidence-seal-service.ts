/**
 * 方案 20 R4：Evidence Seal IO 壳（§14.1/§14.3/§10.1 step 1-2）。
 *
 * 2026-08-24（AI 设计审查 §4.4 第二批）：纯逻辑（类型/sourceScope 过滤/hash/
 * seal 计划构建）已下沉至 packages/shared 的 card-generation-v2-pipeline
 * （evidence-seal-core.ts），worker 经子路径平级消费，消除反向依赖。本文件
 * 只保留 DB 写入：把 shared 计算出的 snapshot/eligibility 行在
 * source_sealing 事务内落库（幂等：onConflictDoNothing）。
 */

import type { ApiTransaction } from "../../db/client.ts";
import {
  evidenceSnapshotsV2,
  evidenceEligibilityStatesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import {
  filterBlocksBySourceScope,
  computeSealedEvidenceSnapshotHashV2,
  planEvidenceSnapshotsV2,
  type EvidenceSealBlock,
  type SealedEvidenceEntryV2,
  type EvidenceSealManifestV2,
  type SealEvidenceInput,
} from "@ailearn/shared/card-generation-v2-pipeline";

export type {
  EvidenceSealBlock,
  SealedEvidenceEntryV2,
  EvidenceSealManifestV2,
  SealEvidenceInput,
};
export {
  filterBlocksBySourceScope,
  computeSealedEvidenceSnapshotHashV2,
};

/** seal 结果：manifest + sourceContentHash（与 generation-run 闭包一致）。 */
export interface SealEvidenceResultV2 {
  manifest: EvidenceSealManifestV2;
  sourceContentHash: string;
}

/**
 * §10.1 step 1-2：在 source_sealing 事务内 seal evidence snapshots + eligibility。
 *
 * 纯逻辑计算在 shared 的 planEvidenceSnapshotsV2；本壳只负责两批 INSERT。
 * 幂等策略：对同一 (workspaceId, evidenceSnapshotId) 已存在则跳过（重复 seal
 * 不产生重复 eligibility）；范围内任一 block 生成一条 snapshot。
 */
export async function sealEvidenceSnapshotsV2(
  tx: ApiTransaction,
  input: SealEvidenceInput,
): Promise<SealEvidenceResultV2> {
  const plan = planEvidenceSnapshotsV2(input);
  const { noteVersionId, sourceScope } = input;

  if (plan.snapshotRows.length > 0) {
    await tx.insert(evidenceSnapshotsV2).values(plan.snapshotRows).onConflictDoNothing();
  }
  if (plan.eligibilityRows.length > 0) {
    await tx.insert(evidenceEligibilityStatesV2).values(plan.eligibilityRows).onConflictDoNothing();
  }

  const manifest: EvidenceSealManifestV2 = {
    workspaceId: input.workspaceId,
    sourceSnapshotId: input.sourceSnapshotId,
    noteId: input.noteId,
    noteVersionId,
    sourceScope,
    evidence: plan.manifestEvidence,
  };

  // runId 仅用于日志/审计记录；不需要写 run 表（manifest 可由
  // evidence_snapshots_v2 按 sourceSnapshotId 重算）。
  void input.runId;

  return { manifest, sourceContentHash: plan.sourceContentHash };
}
