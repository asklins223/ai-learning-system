/**
 * 方案 20 C3：Grounding Critic + Pedagogy Critic + Deterministic Gates。
 *
 * §10.1 steps 6–12:
 * 6. Deterministic precheck
 * 7. Grounding Critic
 * 8. Global Selector / Merge / Dedup
 * 9. merge/rewrite → 新 revision 回到 6–7
 * 10. Pedagogy Critic（card-level + set-level）
 * 11. 最多一次 bounded repair；新 revision 回到 6–10
 * 12. Deterministic final gates
 *
 * 硬约束：
 * - 两个 Critic 物理独立（不同 prompt、不同调用）；
 * - hard issue 真正阻断；
 * - Critic invalid/timeout 产生 0 发布；
 * - 机械/渐进 fallback 完全不可达。
 *
 * R4：真实四阶段 provider 输出为符合 §12.2/§12.3 合同的 strict 结构
 * （`GroundingCriticReportV2` / `PedagogyCriticReportV2`）。deterministic
 * precheck 作为 step 6 的补充确定性信号，不替代独立的 LLM Critic 判定。
 *
 * 2026-08-24（AI 设计审查 §4.4 修复）：本文件自 apps/api/src/modules/card-generation-v2/
 * 下沉至 packages/shared（纯逻辑、无 DB/provider 依赖）。worker 与 api 作为平级
 * 消费者经 @ailearn/shared/card-generation-v2-pipeline 子路径引用，消除 worker
 * 内 ../../../../apps/api 反向路径依赖。
 */

import type {
  LearningCardCandidateRevisionV2,
  CardSetGateReportV2,
  CanonicalAnswerV2,
} from "../card-generation-v2-contracts.ts";
import type {
  GroundingCriticReportV2,
  PedagogyCriticReportV2,
} from "../card-quality-v2-contracts.ts";
import {
  computeCardSetGateReportHashV2,
} from "../card-generation-v2-hashing.ts";

// ─── Quality Report ──────────────────────────────────────────────────────

export interface QualityReportV2 {
  reportId: string;
  reportType: "grounding" | "pedagogy";
  candidateRevisionId: string;
  candidateRevisionHash: string;
  inputHash: string;
  version: number;
  reportHash: string;
  issues: QualityIssue[];
  verdict: "passed" | "failed" | "invalid";
  gateVersion: string;
}

export interface QualityIssue {
  code: string;
  severity: "hard" | "soft";
  detail: string;
  evidenceRefIds?: string[];
  answerUnitIds?: string[];
}

// ─── Grounding Critic ────────────────────────────────────────────────────

export interface GroundingCriticInput {
  candidate: LearningCardCandidateRevisionV2;
  /** sealed evidence manifest（真实 grounding 使用；deterministic 可选）。 */
  evidenceManifest?: {
    workspaceId: string;
    sourceSnapshotId: string;
    evidence: Array<{
      evidenceSnapshotId: string;
      evidenceSnapshotHash: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
    }>;
  };
  /** 与真实 grounding 报告一致的 input hash（evidenceEligibilityVectorHash）。 */
  evidenceEligibilityVectorHash?: string;
  /** 已存在的 active objective 摘要（Pedagogy 需要；Grounding 不需要）。 */
  existingObjectives?: ExistingObjectiveSummary[];
  /** 调用方取消信号（租约丢失 / 管道预算耗尽），透传到 LLM 调用。 */
  signal?: AbortSignal;
}

export interface ExistingObjectiveSummary {
  objectiveId: string;
  objectiveStatement: string;
  publicSummary: string;
}

/**
 * 真实 Grounding Critic 输出为符合 §12.2 合同的 `GroundingCriticReportV2`。
 */
export interface GroundingCriticProvider {
  evaluate(input: GroundingCriticInput): Promise<GroundingCriticReportV2>;
}

/**
 * §10.1 step 7: Grounding Critic。
 *
 * 验证候选的 canonical answer / rubric / evidence 与 source 一致。
 * 独立于 Pedagogy Critic。strict parse 由真实 provider 完成；
 * 这里对 non-pass verdict / hard issues 做二次 fail-closed。
 *
 * 2026-09-15（管线评审 H2）：在此处补齐与 pedagogy 对称的**结构化交叉校验**——
 * 此前只检查顶层 `verdict` 与 `hardIssues`，模型返回自相矛盾的
 * `{verdict:"pass", answerUnits:[{verdict:"contradicted"}]}` 时会被原样放行，
 * 被矛盾证据否决的候选照常进入 binding plan。现在 answer/relation/rubric 逐项
 * verdict 与 `explanation` 支撑失败一律压为 fail（可选支撑字段的证据不足
 * 按 §12.2 不阻断）。
 */
export async function runGroundingCritic(
  input: GroundingCriticInput,
  provider: GroundingCriticProvider,
): Promise<GroundingCriticReportV2> {
  const report = await provider.evaluate(input);
  const structuredFailure =
    report.answerUnits.some((u) => u.verdict !== "entailed")
    || report.relationSupport.some((r) => r.verdict !== "entailed")
    || report.rubricSupport.some((r) => r.verdict !== "supported")
    || report.learningSupport.some((s) => s.field === "explanation" && s.verdict !== "entailed")
    || report.learningSupport.some((s) => s.field !== "explanation" && s.verdict === "contradicted");
  if (report.verdict !== "pass" || report.hardIssues.length > 0 || structuredFailure) {
    return { ...report, verdict: "fail" };
  }
  return report;
}

/**
 * 确定性 Grounding precheck（§10.1 step 6）。不调用模型，纯规则。
 */
export function deterministicGroundingPrecheck(
  candidate: LearningCardCandidateRevisionV2,
  sourceContent: string,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const answer = candidate.objective.canonicalAnswer;

  // Check: answer text must not be empty
  if (answer.kind === "text" && answer.unit.text.trim().length === 0) {
    issues.push({
      code: "empty_answer",
      severity: "hard",
      detail: "Canonical answer text is empty",
      answerUnitIds: [answer.unit.unitId],
    });
  }

  // Check: answer must be supportable by source (basic overlap check)
  const answerText = extractAnswerText(answer);
  if (answerText && sourceContent.length > 0) {
    const answerLower = answerText.toLowerCase();
    const sourceLower = sourceContent.toLowerCase();

    // Try word-level overlap first (for Latin scripts)
    const answerWords = new Set(answerLower.split(/\s+/).filter((w) => w.length > 3));
    if (answerWords.size > 3) {
      let overlapCount = 0;
      for (const word of answerWords) {
        if (sourceLower.includes(word)) overlapCount++;
      }
      if (overlapCount / answerWords.size < 0.2) {
        issues.push({
          code: "answer_not_grounded",
          // 2026-08-16（实机验证修复）：按方案 20 §13.1「字符重合只能作为风险
          // 信号，不能作为教学转换是否发生的充分条件」，重叠检查从 hard 降级
          // 为 soft——真实 LLM 的教学转换（尤其中文改写）与原文词/字重叠天然
          // 偏低，hard 会误杀合法候选（deepseek-v4-flash 实测 100% 被拒）。
          severity: "soft",
          detail: "Canonical answer has <20% word overlap with source content",
        });
      }
    } else {
      // Fallback: character-level overlap (for CJK or short text)
      const answerChars = new Set<string>();
      for (let i = 0; i < answerLower.length - 1; i++) {
        const bigram = answerLower.slice(i, i + 2);
        if (bigram.trim().length === 2) answerChars.add(bigram);
      }
      if (answerChars.size > 5) {
        let charOverlap = 0;
        for (const bigram of answerChars) {
          if (sourceLower.includes(bigram)) charOverlap++;
        }
        if (charOverlap / answerChars.size < 0.15) {
          issues.push({
            code: "answer_not_grounded",
            // 2026-08-16：同词级检查，按 §13.1 降级为 soft 风险信号。
            severity: "soft",
            detail: "Canonical answer has <15% character overlap with source content",
          });
        }
      }
    }
  }

  // Check: rubric units must reference answer units
  const answerUnitIds = collectAnswerUnitIds(answer);
  for (const unit of candidate.objective.rubric.units) {
    for (const ansId of unit.answerUnitIds) {
      if (!answerUnitIds.has(ansId)) {
        issues.push({
          code: "rubric_references_missing_answer_unit",
          severity: "hard",
          detail: `Rubric unit ${unit.rubricUnitId} references non-existent answer unit ${ansId}`,
          answerUnitIds: [ansId],
        });
      }
    }
  }

  return issues;
}

// ─── Pedagogy Critic ─────────────────────────────────────────────────────

export interface PedagogyCriticInput {
  candidate: LearningCardCandidateRevisionV2;
  /** 参与集合级评审的全部候选（用于 set-level duplicate/fragmentation）。 */
  candidates: LearningCardCandidateRevisionV2[];
  /** 每个候选对应的 evidence binding plan hash（§12.3 需读取）。 */
  candidateEvidenceBindingPlanHashes: string[];
  /** 已存在 active objective 摘要（评价 marginal value）。 */
  existingObjectives: ExistingObjectiveSummary[];
  /**
   * 确定性 precheck 的 soft 风险信号（2026-08-25 审计修复）：按 candidateId
   * 提供的表面特征提示（如 surface_paraphrase_only / objective_not_atomic）。
   * 仅作评审参考，不替代 Critic 自己的语义裁决；hard 判定仍由冻结 issue
   * code 承担。
   */
  softPrecheckIssues?: Record<string, QualityIssue[]>;
  /** 对应 plan（判断是否超 CardPlan/与 learning goal 匹配）。 */
  plan?: {
    planRevisionId: string;
    planVersion: number;
    planHash: string;
  };
  inputHash: string;
  runId: string;
  /**
   * M4（2026-09-15 管线评审）：用户的 generation 请求（semanticRequest）。
   *
   * prompt 中"用户 generation 请求（不可信；只作为 soft 偏好参考）"此前恒为空对象，
   * 冻结 issue code `goal_mismatch` 失去判定输入。由调用方透传。
   */
  generationRequest?: unknown;
  /** 调用方取消信号（租约丢失 / 管道预算耗尽），透传到 LLM 调用。 */
  signal?: AbortSignal;
}

/**
 * 真实 Pedagogy Critic 输出为符合 §12.3 合同的 `PedagogyCriticReportV2`。
 */
export interface PedagogyCriticProvider {
  evaluate(input: PedagogyCriticInput): Promise<PedagogyCriticReportV2>;
}

/**
 * §10.1 step 10: Pedagogy Critic (card-level + set-level)。
 *
 * 2026-08-25（AI 设计审计修复）：与 runGroundingCritic 对齐的 fail-closed
 * 归一化——perCandidate 带 non-empty hardIssues（冻结 issue code，如
 * `front_leaks_answer` / `multiple_learning_objectives`）时，"keep" verdict
 * 不能覆盖 hard 结论（方案 20 §12.3：hard failure 不可被 soft verdict 覆盖；
 * 弱基座模型可能返回自相矛盾的 {verdict:"keep", hardIssues:[...]}）。归一化
 * 后该候选按 drop 处理；集合级 setIssues 同样把整体 verdict 从 pass 压为 fail。
 */
export async function runPedagogyCritic(
  input: PedagogyCriticInput,
  provider: PedagogyCriticProvider,
): Promise<PedagogyCriticReportV2> {
  const report = await provider.evaluate(input);
  let demoted = false;
  const normalizedPerCandidate = report.perCandidate.map((p) => {
    if (p.hardIssues.length > 0 && p.verdict === "keep") {
      demoted = true;
      return { ...p, verdict: "drop" as const };
    }
    return p;
  });
  const setFailed = report.setIssues.length > 0;
  if (!demoted && !setFailed) {
    // 无归一化发生 → 原样返回（保持与 provider 报告的对象同一性）。
    return report;
  }
  const finalVerdict = setFailed && report.verdict === "pass"
    ? ("fail" as const)
    : report.verdict;
  return { ...report, perCandidate: normalizedPerCandidate, verdict: finalVerdict };
}

/**
 * 确定性 Pedagogy precheck（step 6 补充信号）。不作为最终教学价值判定，
 * 教学价值由独立的 contract 级 Pedagogy provider 判定（§12.4）。
 *
 * 2026-08-24（AI 设计审查 §4.5 认识论分工）：front 泄题的子串匹配分支从
 * hard 降级为 soft——"正面是否以改写方式泄露答案"是语义判断，正则子串匹配
 * 的残余假阳不可归零；逐字照抄类机械泄题已由 deterministic-gates 的
 * frontLeakageGate（压缩标点 ≥12 连续字符同一）承担 hard 判定。本 precheck
 * 命中仅产生 surface_paraphrase_only（soft）风险信号，语义裁决归 Pedagogy
 * Critic 的冻结 code front_leaks_answer。
 */
export function deterministicPedagogyPrecheck(
  candidate: LearningCardCandidateRevisionV2,
  _sourceContent: string,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const front = candidate.presentation.front;
  const answerText = extractAnswerText(candidate.objective.canonicalAnswer);

  // Check: front must not leak answer——降级为 soft 风险信号（见函数头注释）
  if (answerText && front.prompt) {
    const answerLower = answerText.toLowerCase();
    const promptLower = front.prompt.toLowerCase();
    if (answerLower.length > 20 && promptLower.includes(answerLower.slice(0, 50))) {
      const firstAnswerUnitId = extractFirstAnswerUnitId(candidate.objective.canonicalAnswer);
      issues.push({
        code: "surface_paraphrase_only",
        severity: "soft",
        detail: "Front prompt contains answer text (risk signal; semantic verdict deferred to pedagogy critic)",
        answerUnitIds: firstAnswerUnitId ? [firstAnswerUnitId] : undefined,
      });
    }
  }

  // Check: cue must not be identical to claim
  if (front.cue === candidate.objective.objectiveStatement) {
    issues.push({
      code: "cue_is_claim_copy",
      severity: "hard",
      detail: "Front cue is identical to objective statement (surface paraphrase)",
    });
  }

  // Check: estimatedReviewSeconds must be reasonable
  if (candidate.presentation.estimatedReviewSeconds < 10) {
    issues.push({
      code: "review_time_too_short",
      severity: "soft",
      detail: "Estimated review time < 10 seconds suggests trivial card",
    });
  }

  return issues;
}

// ─── Deterministic Final Gates (§10.1 step 12) ───────────────────────────

/**
 * 执行 deterministic final gates。
 * 如果任何 hard issue 存在，gate 不通过。
 */
export function runDeterministicFinalGates(
  candidates: LearningCardCandidateRevisionV2[],
  groundingReports: QualityReportV2[],
  pedagogyReports: QualityReportV2[],
  plan: { planRevisionId: string; planVersion: number; planHash: string; runId: string },
  activationHardMax: number,
): { passed: boolean; gateReport: CardSetGateReportV2 } {
  const issues: CardSetGateReportV2["issues"] = [];

  // Gate 1: Count check
  if (candidates.length > activationHardMax) {
    issues.push({
      code: "count_out_of_plan",
      candidateIds: candidates.map((c) => c.candidateId),
      hard: true,
    });
  }

  // Gate 2: All candidates must have passed both critics
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const grounding = groundingReports[i];
    const pedagogy = pedagogyReports[i];

    if (!grounding || grounding.verdict !== "passed") {
      issues.push({
        code: "candidate_revision_mismatch",
        candidateIds: [candidate.candidateId],
        hard: true,
      });
    }
    if (!pedagogy || pedagogy.verdict !== "passed") {
      issues.push({
        code: "candidate_revision_mismatch",
        candidateIds: [candidate.candidateId],
        hard: true,
      });
    }
  }

  // Gate 3: Semantic duplicate/mergeable detection（§13.2 全集合语义聚类，
  // 不是逐卡字符 Jaccard：规范化 statement token 集 Jaccard + 共享 evidence refs）。
  const clusters = computeSemanticClustersV2(candidates);
  for (const cluster of clusters) {
    if (cluster.candidateIds.length > 1 && cluster.relation === "duplicate") {
      issues.push({
        code: "semantic_duplicate",
        candidateIds: cluster.candidateIds,
        hard: true,
      });
    } else if (cluster.candidateIds.length > 1 && cluster.relation === "mergeable") {
      issues.push({
        code: "mergeable_fragmentation",
        candidateIds: cluster.candidateIds,
        hard: true,
      });
    }
  }

  const passed = issues.length === 0;
  const finalCandidateIds = candidates.map((c) => c.candidateId);

  const reportWithoutHash: Omit<CardSetGateReportV2, "reportHash"> = {
    version: 2,
    runId: plan.runId,
    planRevisionId: plan.planRevisionId,
    planVersion: plan.planVersion,
    planHash: plan.planHash,
    candidateRevisionHashes: candidates.map((c) => c.candidateRevisionHash),
    candidateEvidenceBindingPlanHashes: [],
    finalCandidateIds,
    finalCount: candidates.length,
    recommendedCount: candidates.length,
    activationHardMax,
    semanticClusters: clusters,
    issues,
    passed,
    gateVersion: "deterministic-gate-v1",
  };
  const reportHash = computeCardSetGateReportHashV2(reportWithoutHash);
  const gateReport: CardSetGateReportV2 = { ...reportWithoutHash, reportHash };

  return { passed, gateReport };
}

// ─── Merge / Dedup (§10.1 step 8) ────────────────────────────────────────

/**
 * §13.2 Deck 级语义聚类（deterministic）：对候选做全集合语义聚类去重。
 *
 * 明确不是逐卡字符 Jaccard：相似度基于规范化 objective statement 的
 * token 集 Jaccard（去标点/空白/停用词后的稳定 token 序列），并叠加
 * 共享 evidence refs 信号（共享 ≥1 证据的候选更容易是 mergeable）。
 *
 * 返回的 clusters 覆盖全部候选（每个候选恰好一个簇）：
 * - duplicate：规范化 statement 完全一致（同一语义单元重复成卡）；
 * - mergeable：statement 高度相似（Jaccard ≥ 0.72）且共享证据，或
 *   Jaccard ≥ 0.85（即使无共享证据也视为可合并碎片）；
 * - distinct：其余候选各自独立成簇（relation 固定 "distinct"）。
 *
 * clusterId 由成员 candidateId 排序后 hash 派生，保证确定性。
 */
export function computeSemanticClustersV2(
  candidates: LearningCardCandidateRevisionV2[],
): Array<{ clusterId: string; candidateIds: string[]; relation: "distinct" | "mergeable" | "duplicate" }> {
  if (candidates.length === 0) return [];

  const normalized = candidates.map((c) => ({
    candidateId: c.candidateId,
    norm: normalizeStatementForClustering(c.objective.objectiveStatement),
    evidenceRefs: new Set(c.objective.evidenceRefIds ?? []),
  }));

  const clusterOf = new Map<string, number>();
  const clusters: Array<{ candidateIds: string[]; relation: "distinct" | "mergeable" | "duplicate" }> = [];

  const assign = (candidateId: string, relation: "distinct" | "mergeable" | "duplicate"): number => {
    const existing = clusterOf.get(candidateId);
    if (existing !== undefined) {
      // relation 升级：duplicate 优先于 mergeable 优先于 distinct
      const cur = clusters[existing].relation;
      if (relation === "duplicate" || (relation === "mergeable" && cur === "distinct")) {
        clusters[existing].relation = relation;
      }
      return existing;
    }
    const idx = clusters.length;
    clusters.push({ candidateIds: [candidateId], relation });
    clusterOf.set(candidateId, idx);
    return idx;
  };

  for (let i = 0; i < normalized.length; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const a = normalized[i];
      const b = normalized[j];
      if (a.norm.tokens.length === 0 || b.norm.tokens.length === 0) continue;

      const exactEqual = a.norm.canonical === b.norm.canonical;
      const jaccard = tokenSetJaccard(a.norm.tokens, b.norm.tokens);
      const sharedEvidence = [...a.evidenceRefs].some((r) => b.evidenceRefs.has(r));

      if (exactEqual) {
        const idx = assign(a.candidateId, "duplicate");
        clusters[idx].candidateIds.push(b.candidateId);
        clusterOf.set(b.candidateId, idx);
      } else if (jaccard >= 0.72 && sharedEvidence) {
        const idx = assign(a.candidateId, "mergeable");
        clusters[idx].candidateIds.push(b.candidateId);
        clusterOf.set(b.candidateId, idx);
      } else if (jaccard >= 0.85) {
        const idx = assign(a.candidateId, "mergeable");
        clusters[idx].candidateIds.push(b.candidateId);
        clusterOf.set(b.candidateId, idx);
      }
    }
  }

  // 未归簇的候选各自独立成簇（relation=distinct）
  for (const c of normalized) {
    if (!clusterOf.has(c.candidateId)) {
      clusters.push({ candidateIds: [c.candidateId], relation: "distinct" });
      clusterOf.set(c.candidateId, clusters.length - 1);
    }
  }

  // clusterId：成员排序后稳定 hash（不依赖共享 hash 工具，避免循环依赖）。
  const hashToken = (s: string): string => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };

  return clusters.map((cluster) => ({
    clusterId: hashToken([...cluster.candidateIds].sort().join("|")),
    candidateIds: [...cluster.candidateIds].sort(),
    relation: cluster.relation,
  }));
}

/** 规范化 statement：小写、去标点、去空白；返回 canonical 与 token 集。 */
function normalizeStatementForClustering(statement: string): {
  canonical: string;
  tokens: string[];
} {
  const lower = (statement ?? "").toLowerCase();
  // 保留 CJK 字符与拉丁字母数字；标点/空白全部去除。
  const canonical = lower.replace(/[^\p{L}\p{N}]+/gu, "");
  // token：连续 CJK 单字 + 拉丁词；CJK 场景下按字切分可稳定比较。
  const cjkChars = canonical.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
  const latinWords = lower.match(/[a-z0-9]+/g) ?? [];
  const tokens = [...cjkChars, ...latinWords];
  const stop = new Set(["的", "了", "是", "在", "与", "和", "或", "及", "一个", "一种", "为", "对", "于", "中", "以", "将", "把"]);
  return { canonical, tokens: [...new Set(tokens)].filter((t) => !stop.has(t)) };
}

/** token 集 Jaccard。 */
function tokenSetJaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * 合并语义重复的候选。
 * 返回合并后的候选列表和被合并的候选 ID 映射。
 */
export function mergeDuplicateCandidates(
  candidates: LearningCardCandidateRevisionV2[],
): {
  merged: LearningCardCandidateRevisionV2[];
  mergeMap: Map<string, string>; // merged candidateId → surviving candidateId
} {
  const mergeMap = new Map<string, string>();
  const survivors: LearningCardCandidateRevisionV2[] = [];
  const seenStatements = new Map<string, number>();

  for (const candidate of candidates) {
    const stmt = candidate.objective.objectiveStatement.toLowerCase();
    const existingIdx = seenStatements.get(stmt);
    if (existingIdx !== undefined) {
      // Merge into existing
      mergeMap.set(candidate.candidateId, survivors[existingIdx].candidateId);
    } else {
      seenStatements.set(stmt, survivors.length);
      survivors.push(candidate);
    }
  }

  return { merged: survivors, mergeMap };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function extractAnswerText(answer: CanonicalAnswerV2): string {
  switch (answer.kind) {
    case "text": return answer.unit.text;
    case "bullets": return answer.items.map((i) => i.text).join(" ");
    case "ordered_steps": return answer.steps.map((s) => s.text).join(" ");
    case "mapping": return answer.pairs.map((p) => `${p.left}=${p.right}`).join(" ");
    case "comparison": return answer.rows.map((r) => r.values.join(" ")).join(" ");
    case "formula": return answer.latex;
    case "code": return answer.code;
  }
}

function collectAnswerUnitIds(answer: CanonicalAnswerV2): Set<string> {
  const ids = new Set<string>();
  switch (answer.kind) {
    case "text": ids.add(answer.unit.unitId); break;
    case "bullets": answer.items.forEach((i) => ids.add(i.unitId)); break;
    case "ordered_steps": answer.steps.forEach((s) => ids.add(s.unitId)); break;
    case "mapping": answer.pairs.forEach((p) => ids.add(p.unitId)); break;
    case "comparison": answer.rows.forEach((r) => ids.add(r.unitId)); break;
    case "formula": ids.add(answer.unitId); break;
    case "code": ids.add(answer.unitId); break;
  }
  return ids;
}

function extractFirstAnswerUnitId(answer: CanonicalAnswerV2): string | null {
  switch (answer.kind) {
    case "text": return answer.unit.unitId;
    case "bullets": return answer.items[0]?.unitId ?? null;
    case "ordered_steps": return answer.steps[0]?.unitId ?? null;
    case "mapping": return answer.pairs[0]?.unitId ?? null;
    case "comparison": return answer.rows[0]?.unitId ?? null;
    case "formula": return answer.unitId;
    case "code": return answer.unitId;
  }
}
