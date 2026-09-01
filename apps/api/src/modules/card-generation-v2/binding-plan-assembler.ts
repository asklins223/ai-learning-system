/**
 * 方案 20 R4：Candidate Evidence Binding Plan Assembler — IO 壳
 * （§12.2 段 2 / §14.3）。
 *
 * 2026-08-24（AI 设计审查 §4.4 第二批）：plan 组装/校验/hash 计算的纯逻辑
 * 已下沉至 packages/shared 的 card-generation-v2-pipeline
 * （binding-plan-core.ts），worker 经子路径平级消费，消除反向依赖。本文件
 * 保留 DB 持久化（persistCandidateEvidenceBindingPlanV2）并 re-export 纯
 * 逻辑符号，api 内部既有导入路径不变。
 *
 * 设计原则不变（§12.2 段 2 / §14.3 / §13.1）：
 * - 不调用模型、不选择新事实——只消费 exact Candidate revision、通过的
 *   Grounding report 与 sealed Evidence manifest；
 * - 每个声明的 target unit 必须与 report 中对应单元一一对齐；缺失、多余、
 *   跨 workspace、非 usable Evidence 一律 fail closed；
 * - `bindingPlanHash`/`evidenceEligibilityVectorHash` 必须进入 Pedagogy、
 *   Deck Gate、Activation Request 与 activation quality closure；
 * - 故意不含尚不存在的 `objectiveRevisionId/bindingId`（domain-separated
 *   计划闭包）。
 */

import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import { candidateEvidenceBindingPlansV2 } from "../../db/schema/card-generation-v2.ts";
import {
  assembleCandidateEvidenceBindingPlanV2,
  enumerateCandidateTargetUnits,
  type AssemblerEvidenceManifest,
  type EligibilityVectorEntry,
  type AssembleBindingPlanInput,
  type AssembleBindingPlanResult,
} from "@ailearn/shared/card-generation-v2-pipeline";

export {
  assembleCandidateEvidenceBindingPlanV2,
  enumerateCandidateTargetUnits,
};
export type {
  AssemblerEvidenceManifest,
  EligibilityVectorEntry,
  AssembleBindingPlanInput,
  AssembleBindingPlanResult,
};

/**
 * 持久化 binding plan 到 `candidate_evidence_binding_plans_v2`（1:1 candidate revision；
 * 表名以 @ailearn/shared/db-schema 的 candidateEvidenceBindingPlansV2 为准）。
 * plan 组装在 shared 纯逻辑层；本壳只负责 INSERT。
 */
export async function persistCandidateEvidenceBindingPlanV2(
  tx: ApiTransaction,
  input: AssembleBindingPlanInput,
): Promise<AssembleBindingPlanResult> {
  const result = assembleCandidateEvidenceBindingPlanV2(input);
  const { runId, workspaceId, candidate } = input;

  await tx.insert(candidateEvidenceBindingPlansV2).values({
    id: randomUUID(),
    workspaceId,
    bindingPlanId: result.bindingPlanId,
    runId,
    candidateRevisionId: candidate.candidateRevisionId,
    candidateRevisionHash: candidate.candidateRevisionHash,
    planRevisionId: candidate.planRevisionId,
    planVersion: candidate.planVersion,
    planHash: candidate.planHash,
    // R32：§14.3 闭包——必须持久化完整 binding 条目（targetUnit + evidenceSnapshotId/
    // evidenceSnapshotHash + relation + supportStrength + semanticSupportReportId/hash），
    // 不得只落 targetUnit。激活时 §17.5 step 9 的 canonical binding 机械映射与
    // §13.1 eligibility 重验都依赖完整条目；只落 targetUnit 会导致自然激活链路
    // 丢失证据身份（evidenceSnapshotId 为空 → uuid 列插入失败 / 绑定哈希失真）。
    targetUnitBindings: result.plan.bindings.map((b) => ({ ...b })) as unknown as Record<string, unknown>,
    bindingPlanHash: result.bindingPlanHash,
    evidenceEligibilityVectorHash: result.evidenceEligibilityVectorHash,
  });

  return result;
}
