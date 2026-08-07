/**
 * P2-2d：FAST_EXTRACT 中间确定性校验器（实施计划 §3.1, P2-2）。
 *
 * 纯代码、无模型。校验清单：
 * 1. Schema 合法(Candidate Local ID 唯一)
 * 2. Evidence ID ∈ Allowlist；Evidence 引用类型合法
 * 3. 每个 Required Bundle 有明确决策(Candidate 或 No-Candidate)
 * 4. Claim 长度在上下限内；无空 Claim(Zod schema 层保证 min/max)
 * 5. 数字/公式/代码 Evidence 类型一致(Candidate cognitiveType ↔ Evidence blockType/公式标记)
 * 6. 输出未截断(Finish Reason 完整)
 *
 * 失败分类(决定重试/升级)：
 * - retryable(协议/schema/截断/allowlist/Bundle 覆盖)→ 仅重试 FAST_EXTRACT(≤2 次)
 * - escalate(复杂语义错误:类型不一致)→ 升级 Full Supervisor
 */

import { fastExtractionArtifactSchema, type FastExtractionArtifact } from "@ailearn/shared";

/** Evidence 引用信息(供类型一致性校验) */
export interface FastExtractionEvidenceInfo {
  refId: string;
  /** note_blocks.type: paragraph | code | list | quote | image(null 表示未知) */
  blockType: string | null;
  /** 是否为图片证据 */
  isImage: boolean;
  /** 引用文本是否含公式标记($..$ / $$..$$),由调用方检测 */
  containsFormulaMarker: boolean;
}

export interface FastExtractionValidationContext {
  /** Evidence Allowlist(refId → 类型信息) */
  evidenceAllowlist: Map<string, FastExtractionEvidenceInfo>;
  /** 引用 evidence 的 Bundle 归属(refId → bundleId),用于 Required Bundle 覆盖校验 */
  evidenceBundleByRef: Map<string, string>;
  /** 全部 Required Bundle id */
  requiredBundleIds: string[];
  /** provider finish reason("stop" | "length" | ...) */
  finishReason: string;
}

export interface FastExtractionIssue {
  code: string;
  /** retryable(重试 FAST_EXTRACT) | escalate(升级 Full) */
  severity: "retryable" | "escalate";
  details: string;
}

export interface FastExtractionValidationResult {
  passed: boolean;
  issues: FastExtractionIssue[];
}

/**
 * 校验 FastExtractionArtifact(纯函数,可单测)。
 */
export function validateFastExtractionArtifact(
  artifact: unknown,
  ctx: FastExtractionValidationContext,
): FastExtractionValidationResult {
  const issues: FastExtractionIssue[] = [];

  // 1. Schema 合法
  const parsed = fastExtractionArtifactSchema.safeParse(artifact);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      passed: false,
      issues: [{
        code: "schema_invalid",
        severity: "retryable",
        details: `${first?.path.join(".") ?? "root"}: ${first?.message ?? "schema violation"}`,
      }],
    };
  }
  const a: FastExtractionArtifact = parsed.data;

  // 2a. Local ID 唯一
  const localIds = new Set<string>();
  for (const c of a.candidates) {
    if (localIds.has(c.localId)) {
      issues.push({ code: "duplicate_local_id", severity: "retryable", details: `localId=${c.localId}` });
    }
    localIds.add(c.localId);
  }

  // 2b. Evidence ID ∈ Allowlist + 引用类型合法
  for (const c of a.candidates) {
    for (const refId of c.evidenceRefIds) {
      const info = ctx.evidenceAllowlist.get(refId);
      if (!info) {
        issues.push({
          code: "evidence_not_in_allowlist",
          severity: "retryable",
          details: `localId=${c.localId} evidence=${refId}`,
        });
      }
    }
    // 2c. relationHints.localTargetId 悬空引用检查(review should-fix)
    // 后续按 relationHints 合并时会拿到不存在的 localId,提前拒绝。
    // (存在性检查在全部 localId 收集后统一执行,见步骤 2e)
    for (const hint of c.relationHints ?? []) {
      if (hint.localTargetId === c.localId) {
        issues.push({
          code: "self_referencing_relation",
          severity: "retryable",
          details: `localId=${c.localId} localTargetId=${hint.localTargetId}`,
        });
      }
    }
  }

  // 2d. noCandidateDecisions.bundleId ∈ requiredBundleIds(review should-fix)
  // 模型幻觉的多余决策不应被静默接受。
  const requiredSet = new Set(ctx.requiredBundleIds);
  for (const d of a.noCandidateDecisions) {
    if (!requiredSet.has(d.bundleId)) {
      issues.push({
        code: "no_candidate_bundle_not_required",
        severity: "retryable",
        details: `bundle=${d.bundleId} 不在 Required Bundle 列表`,
      });
    }
  }

  // 3. 每个 Required Bundle 有明确决策
  const coveredBundles = new Set<string>();
  for (const c of a.candidates) {
    for (const refId of c.evidenceRefIds) {
      const bundleId = ctx.evidenceBundleByRef.get(refId);
      if (bundleId) coveredBundles.add(bundleId);
    }
  }
  for (const d of a.noCandidateDecisions) {
    coveredBundles.add(d.bundleId);
  }
  for (const required of ctx.requiredBundleIds) {
    if (!coveredBundles.has(required)) {
      issues.push({
        code: "bundle_without_decision",
        severity: "retryable",
        details: `bundle=${required}`,
      });
    }
  }

  // 2e. relationHints.localTargetId 存在性检查(review should-fix):
  // 所有 localId 已收集完毕,悬空引用在此统一拒绝。
  for (const c of a.candidates) {
    for (const hint of c.relationHints ?? []) {
      if (!localIds.has(hint.localTargetId)) {
        issues.push({
          code: "dangling_relation_target",
          severity: "retryable",
          details: `localId=${c.localId} localTargetId=${hint.localTargetId} 不存在`,
        });
      }
    }
  }

  // 5. 数字/公式/代码 Evidence 类型一致(复杂语义错误 → escalate)
  for (const c of a.candidates) {
    if (c.cognitiveType === "code") {
      const refsCode = c.evidenceRefIds.some((refId) => {
        const info = ctx.evidenceAllowlist.get(refId);
        return info?.blockType === "code";
      });
      if (!refsCode) {
        issues.push({
          code: "code_evidence_type_mismatch",
          severity: "escalate",
          details: `localId=${c.localId} 需引用代码块 Evidence`,
        });
      }
    }
    if (c.cognitiveType === "formula") {
      const refsFormula = c.evidenceRefIds.some((refId) => {
        const info = ctx.evidenceAllowlist.get(refId);
        return info?.containsFormulaMarker ?? false;
      });
      if (!refsFormula) {
        issues.push({
          code: "formula_evidence_type_mismatch",
          severity: "escalate",
          details: `localId=${c.localId} 需引用含公式标记的 Evidence`,
        });
      }
    }
  }

  // 6. 输出未截断
  if (ctx.finishReason === "length") {
    issues.push({
      code: "output_truncated",
      severity: "retryable",
      details: `finishReason=length(输出截断)`,
    });
  }

  return { passed: issues.length === 0, issues };
}
