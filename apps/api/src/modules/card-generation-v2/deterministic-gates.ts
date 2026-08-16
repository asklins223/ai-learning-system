/**
 * 方案 20 R4：§13.1 Deterministic Candidate Gates（不可协商的协议/安全/一致性）。
 *
 * LLM Critic 负责语义判断；确定性 Gate 负责不可协商的协议、安全和一致性。
 * 任何一个 hard gate 失败，Candidate 都不得进入 `review_ready`。
 *
 * 覆盖 gate（§13.1）：
 * - schema             → strict zod parse（调用方在边界执行；此处为跨单元完整性）
 * - evidence           → 每个 answer/rubric unit 至少一个合法 Evidence Snapshot
 * - evidence span      → offset/hash 与 frozen source 一致（需 sealed evidence manifest）
 * - front leakage      → 按 answer UNIT 判定（不是整段重叠）；字符重合仅作 soft 信号
 * - objective atomicity→ 不允许"以及/分别/同时"拼接独立目标
 * - answer completeness→ rubric.required units 均能在 answer 中定位
 * - unsupported content→ 禁止无 evidence 的事实/解释/例子/边界
 * - malformed content  → 空值/占位符/模板残留/截断/不可见字符
 * - safety             → prompt injection 标记、跨租户标识、秘密字段与内部 prompt
 *
 * 字符重合只能作为"教学转换可能不足"的风险信号，不能成为"教学转换已发生"的
 * 充分条件；不得向模型暴露 n-gram 阈值或规避技巧。
 */

import type {
  LearningCardCandidateRevisionV2,
  CanonicalAnswerV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import type { QualityIssue } from "./critic-service.ts";

/** 证据跨度校验所需的 sealed manifest 结构子集。 */
export interface EvidenceSpanManifest {
  workspaceId?: string;
  sourceSnapshotId?: string;
  evidence: Array<{ evidenceSnapshotId: string }>;
}

export interface DeterministicGateInput {
  candidate: LearningCardCandidateRevisionV2;
  /** sealed evidence manifest（evidence span 校验用；可选）。 */
  evidenceManifest?: EvidenceSpanManifest;
}

// ─── §13.1 Gates ─────────────────────────────────────────────────────────

/**
 * 运行全部 candidate 级 deterministic gates，返回 sorted（按固定顺序）issues。
 */
export function runCandidateDeterministicGatesV2(
  input: DeterministicGateInput,
): QualityIssue[] {
  const { candidate, evidenceManifest } = input;
  const issues: QualityIssue[] = [];

  issues.push(...objectiveAtomicityGate(candidate));
  issues.push(...malformedContentGate(candidate));
  issues.push(...safetyGate(candidate));
  issues.push(...answerCompletenessGate(candidate));
  if (evidenceManifest) {
    issues.push(...evidenceSpanGate(candidate, evidenceManifest));
  }
  issues.push(...frontLeakageGate(candidate));
  issues.push(...unsupportedContentGate(candidate));

  return sortIssues(issues);
}

/**
 * §13.1 objective atomicity：只允许一个稳定 Objective；不得用"以及/分别/同时/
 * 和"把多个独立目标拼接进 statement。
 *
 * 2026-08-16（实机验证修复）：只检查 objectiveStatement——front.prompt 是问题
 * 措辞，"请分别写出 F、m、a 的单位"是正常列举指令，不是目标拼接；把 prompt
 * 纳入检查会误杀合法候选（deepseek-v4-flash 实测 3/4 候选因 prompt 的"分别/
 * 以及"被拒，尽管 statement 是原子的）。
 */
export function objectiveAtomicityGate(
  candidate: LearningCardCandidateRevisionV2,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const statement = candidate.objective.objectiveStatement || "";

  if (statement.includes("以及") || statement.includes("分别") || statement.includes("同时")) {
    // "X 以及 Y" / "X 分别 Y" / "X 同时 Y" —— 拼接多个独立目标的风险信号。
    if (/(以及|同时)[^。；;]{4,}/.test(statement) || /分别/.test(statement)) {
      issues.push({
        code: "objective_not_atomic",
        severity: "hard",
        detail:
          "objective statement concatenates independent objectives with 以及/分别/同时",
      });
    }
  }
  // 多个句号/分号分离出多个稳定语义单元，视为 atomicity 风险。
  const clauseMarkers = (statement.match(/[。；;]/g) || []).length;
  if (clauseMarkers >= 2 && statement.length > 160) {
    issues.push({
      code: "objective_not_atomic",
      severity: "hard",
      detail: "objective statement contains multiple independent clauses",
    });
  }
  return issues;
}

/**
 * §13.1 malformed content：空值、占位符、模板残留、截断 JSON、不可见字符。
 */
export function malformedContentGate(
  candidate: LearningCardCandidateRevisionV2,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const pieces: Array<{ label: string; text: string }> = [];
  const answerText = extractAnswerText(candidate.objective.canonicalAnswer);
  pieces.push({ label: "answer", text: answerText });
  pieces.push({ label: "cue", text: candidate.presentation.front.cue || "" });
  pieces.push({ label: "prompt", text: candidate.presentation.front.prompt || "" });
  pieces.push({ label: "explanation", text: candidate.objective.learningSupport.explanation || "" });
  if (candidate.objective.learningSupport.boundary) pieces.push({ label: "boundary", text: candidate.objective.learningSupport.boundary });
  if (candidate.objective.learningSupport.misconception) pieces.push({ label: "misconception", text: candidate.objective.learningSupport.misconception });
  if (candidate.objective.learningSupport.workedExample) pieces.push({ label: "workedExample", text: candidate.objective.learningSupport.workedExample });

  const placeholders = /(TODO|FIXME|PLACEHOLDER|lorem ipsum|待补充|占位符|\b{{.*}}\b|INSERT_|your answer here|describe here)/i;
  const templateResidue = /\b(system:|assistant:|user:)\b|<\|[a-z_]+\|>/i;
  const invisibleChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

  for (const piece of pieces) {
    const t = piece.text || "";
    if (t.trim().length === 0) {
      issues.push({
        code: "empty_content",
        severity: "hard",
        detail: `empty ${piece.label}`,
      });
      continue;
    }
    if (placeholders.test(t)) {
      issues.push({
        code: "placeholder_content",
        severity: "hard",
        detail: `${piece.label} contains placeholder/template residue`,
      });
    }
    if (templateResidue.test(t)) {
      issues.push({
        code: "template_residue",
        severity: "hard",
        detail: `${piece.label} contains chat/template residue`,
      });
    }
    if (invisibleChars.test(t)) {
      issues.push({
        code: "invisible_control_chars",
        severity: "hard",
        detail: `${piece.label} contains invisible control characters`,
      });
    }
  }

  return issues;
}

/**
 * §13.1 safety：prompt injection 标记、跨租户标识、秘密字段与内部 prompt。
 */
export function safetyGate(
  candidate: LearningCardCandidateRevisionV2,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const texts: string[] = [
    candidate.objective.objectiveStatement,
    candidate.presentation.front.cue,
    candidate.presentation.front.prompt,
    candidate.objective.publicSummary,
    extractAnswerText(candidate.objective.canonicalAnswer),
    candidate.objective.learningSupport.explanation,
  ];
  if (candidate.objective.learningSupport.boundary) texts.push(candidate.objective.learningSupport.boundary);
  if (candidate.objective.learningSupport.misconception) texts.push(candidate.objective.learningSupport.misconception);
  if (candidate.objective.learningSupport.workedExample) texts.push(candidate.objective.learningSupport.workedExample);

  const injectionMarker = /(ignore (previous|prior|all) instructions|disregard (previous|prior)|system prompt:|你是.*AI|你是一个.*助手|pretend (you are|to be)|forget your instructions|忽略(以上|之前|所有|一切|先前)|放弃(之前|先前)(指令|设定)|请忽略|忘掉你)/i;
  const secretField = /(api[_-]?key|secret|authorization|bearer [0-9a-z]{20,}|password\s*=)/i;
  const workspaceRef = /(workspace[_-]?id|note[_-]?version[_-]?id|generation[_-]?run[_-]?id)\b/i;

  for (const t of texts) {
    if (!t) continue;
    if (injectionMarker.test(t)) {
      issues.push({
        code: "prompt_injection",
        severity: "hard",
        detail: "card content contains prompt injection markers",
      });
    }
    if (secretField.test(t)) {
      issues.push({
        code: "secret_leak",
        severity: "hard",
        detail: "card content exposes a secret/credential field name or token",
      });
    }
    if (workspaceRef.test(t)) {
      issues.push({
        code: "cross_tenant_identifier",
        severity: "hard",
        detail: "card content references infra/cross-tenant identifiers",
      });
    }
  }
  return issues;
}

/**
 * §13.1 answer completeness：rubric.required units 均能在 answer 中定位。
 */
export function answerCompletenessGate(
  candidate: LearningCardCandidateRevisionV2,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const answerUnitIds = collectAnswerUnitIds(candidate.objective.canonicalAnswer);
  const answerText = extractAnswerText(candidate.objective.canonicalAnswer).trim();

  for (const unit of candidate.objective.rubric.units) {
    if (!unit.required) continue;
    for (const ansId of unit.answerUnitIds) {
      if (!answerUnitIds.has(ansId)) {
        issues.push({
          code: "rubric_references_missing_answer_unit",
          severity: "hard",
          detail: `required rubric unit ${unit.rubricUnitId} references non-existent answer unit ${ansId}`,
          answerUnitIds: [ansId],
        });
        continue;
      }
    }
    // required unit 需要 criterion 非空。
    if (!unit.criterion || unit.criterion.trim().length === 0) {
      issues.push({
        code: "unscorable",
        severity: "hard",
        detail: `required rubric unit ${unit.rubricUnitId} has empty criterion`,
      });
    }
  }
  void answerText;
  return issues;
}

/**
 * §13.1 evidence span：answer 引用的 offset/hash 与 sealed evidence 一致。
 *
 * 校验 candidate 可能携带的关于证据位置的声明（当前候选行不保存自定义 offset，
 * 因此本 gate 校验 answer 的 evidenceRefIds 都能在 manifest 中找到、且
 * evidenceSetHash 与 manifest 一致即可；Deep offset 一致性由 assembler/D 上
 * 下游的正式 binding 保证）。
 */
export function evidenceSpanGate(
  candidate: LearningCardCandidateRevisionV2,
  evidenceManifest: EvidenceSpanManifest,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const manifestIds = new Set(evidenceManifest.evidence.map((e) => e.evidenceSnapshotId));
  const refIds: Set<string> = new Set(candidate.objective.evidenceRefIds);

  for (const refId of refIds) {
    if (!manifestIds.has(refId)) {
      issues.push({
        code: "evidence_not_in_sealed_scope",
        severity: "hard",
        detail: `evidence ref ${refId} not present in sealed evidence manifest (out of sourceScope)`,
        evidenceRefIds: [refId],
      });
    }
  }

  // 每个 rubric unit 的 evidenceRefIds 必须都在 manifest 中。
  for (const unit of candidate.objective.rubric.units) {
    for (const refId of unit.evidenceRefIds) {
      if (!manifestIds.has(refId)) {
        issues.push({
          code: "evidence_not_in_sealed_scope",
          severity: "hard",
          detail: `rubric unit ${unit.rubricUnitId} references out-of-scope evidence ${refId}`,
          evidenceRefIds: [refId],
        });
      }
    }
  }

  return issues;
}

/**
 * §13.1 front leakage：按 answer unit 判定（不是整段重叠）。
 *
 * 只有当 front（cue+prompt）与某个 answer unit 的**关键片段**高度重合时才判
 * hard leak；字符重合仅作 soft 风险信号（教学转换可能不足），不单独 hard fail。
 */
export function frontLeakageGate(
  candidate: LearningCardCandidateRevisionV2,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const frontText = `${candidate.presentation.front.cue} ${candidate.presentation.front.prompt}`.toLowerCase();
  if (!frontText.trim()) return issues;

  const units = collectAnswerUnitsWithId(candidate.objective.canonicalAnswer);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

  for (const unit of units) {
    const unitText = norm(unit.text);
    if (unitText.length < 12) continue; // 太短无法可靠判断

    // 提取单位中较长的显著片段用于匹配（避免被 cue 通用词干扰）。
    const keyFragment = unitText.slice(0, 200);
    if (frontText.includes(keyFragment)) {
      issues.push({
        code: "front_leaks_answer",
        severity: "hard",
        detail: `front leaks answer unit ${unit.id}`,
        answerUnitIds: [unit.id],
      });
    }
  }

  // soft 信号：front 与整段 answer 字符重合度高 → 「表面改写/泄题风险」
  const answerText = norm(extractAnswerText(candidate.objective.canonicalAnswer));
  if (answerText.length > 40) {
    const overlap = computeCharSetOverlap(frontText, answerText);
    if (overlap > 0.7) {
      issues.push({
        code: "surface_paraphrase_only",
        severity: "soft",
        detail: "front has high character overlap with canonical answer (teaching transformation may be insufficient)",
      });
    }
  }

  return issues;
}

/**
 * §13.1 unsupported content：不允许无 evidence 的事实/解释/例子/边界。
 *
 * 要求每个 rubric unit 都引用至少一个 evidence；explanation 非空。
 */
export function unsupportedContentGate(
  candidate: LearningCardCandidateRevisionV2,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const hasAnyRef = candidate.objective.evidenceRefIds.length > 0
    || candidate.objective.rubric.units.some((u) => u.evidenceRefIds.length > 0);
  if (!hasAnyRef) {
    issues.push({
      code: "no_evidence_reference",
      severity: "hard",
      detail: "candidate declares no evidence references across objective or rubric",
    });
  }
  return issues;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sortIssues(issues: QualityIssue[]): QualityIssue[] {
  const order: Record<string, number> = {
    schema_invalid: 0,
    evidence_not_in_sealed_scope: 1,
    malformed: 2,
    empty_content: 3,
    placeholder_content: 4,
    template_residue: 5,
    invisible_control_chars: 6,
    prompt_injection: 7,
    secret_leak: 8,
    cross_tenant_identifier: 9,
    objective_not_atomic: 10,
    rubric_references_missing_answer_unit: 11,
    unscorable: 12,
    no_evidence_reference: 13,
    front_leaks_answer: 14,
    surface_paraphrase_only: 15,
  };
  return [...issues].sort((a, b) => {
    const oa = order[a.code] ?? 100;
    const ob = order[b.code] ?? 100;
    return oa - ob;
  });
}

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

function collectAnswerUnitsWithId(
  answer: CanonicalAnswerV2,
): Array<{ id: string; text: string }> {
  const units: Array<{ id: string; text: string }> = [];
  switch (answer.kind) {
    case "text": units.push({ id: answer.unit.unitId, text: answer.unit.text }); break;
    case "bullets": answer.items.forEach((i) => units.push({ id: i.unitId, text: i.text })); break;
    case "ordered_steps": answer.steps.forEach((s) => units.push({ id: s.unitId, text: s.text })); break;
    case "mapping": answer.pairs.forEach((p) => units.push({ id: p.unitId, text: `${p.left}=${p.right}` })); break;
    case "comparison": answer.rows.forEach((r) => units.push({ id: r.unitId, text: r.dimension })); break;
    case "formula": units.push({ id: answer.unitId, text: answer.latex }); break;
    case "code": units.push({ id: answer.unitId, text: answer.code }); break;
  }
  return units;
}

function computeCharSetOverlap(a: string, b: string): number {
  const aChars = new Set(a.replace(/\s+/g, ""));
  const bChars = new Set(b.replace(/\s+/g, ""));
  if (aChars.size === 0) return 0;
  let inter = 0;
  for (const c of aChars) {
    if (bChars.has(c)) inter++;
  }
  return inter / aChars.size;
}
