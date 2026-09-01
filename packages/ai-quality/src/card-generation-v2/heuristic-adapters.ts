/**
 * §4.5 量化适配层：把 heuristic-metrics 的人工标注样本包装成
 * deterministic-gates 真实实现的输入。
 *
 * gate 是纯函数、只读取 candidate 的相关字段（objectiveStatement /
 * presentation.front / objective.canonicalAnswer），因此这里构造最小投影
 * 并断言到合同类型——不经过 zod parse（夹具不是端到端生成产物）。
 */

import {
  objectiveAtomicityGate as atomicityGateImpl,
  frontLeakageGate as frontLeakageGateImpl,
  type QualityIssue,
} from "@ailearn/shared/card-generation-v2-pipeline";
import type { LeakSample } from "./heuristic-metrics.ts";

/** 原子性样本：直接以 statement 驱动真实 gate。 */
export function objectiveAtomicityGate(statement: string): QualityIssue[] {
  const candidate = makeMinimalCandidate({
    objectiveStatement: statement,
    cue: "提示",
    prompt: "请回答该目标",
    answerText: "答案内容（与本 gate 无关）。",
  });
  return atomicityGateImpl(candidate);
}

/** 泄漏样本 → frontLeakageGate 输入。 */
export function frontLeakageGate(sample: Pick<LeakSample, "frontText" | "answerText">): QualityIssue[] {
  const { cue, prompt } = splitFront(sample.frontText);
  const candidate = makeMinimalCandidate({
    objectiveStatement: "与泄漏判定无关的目标语句。",
    cue,
    prompt,
    answerText: sample.answerText,
  });
  return frontLeakageGateImpl(candidate);
}

/**
 * 最小候选构造：仅填充 deterministic-gates 读取的字段，其余按合同形状给
 * 安全默认值后断言类型（gates 不做 schema 校验，缺字段不会进入其读取面）。
 */
function makeMinimalCandidate(parts: {
  objectiveStatement: string;
  cue: string;
  prompt: string;
  answerText: string;
}) {
  return {
    version: 2,
    candidateRevisionId: "00000000-0000-4000-8000-000000000001",
    candidateId: "00000000-0000-4000-8000-000000000002",
    revision: 1,
    runId: "00000000-0000-4000-8000-000000000003",
    planRevisionId: "00000000-0000-4000-8000-000000000004",
    planVersion: 1,
    planHash: "a".repeat(64),
    cardContentEpoch: 1,
    planObjectiveLocalId: "obj-heuristic-probe",
    recommendation: { recommended: true, reasonCodes: [] },
    derivedFromCandidateRevisions: [],
    objective: {
      objectiveStatement: parts.objectiveStatement,
      publicSummary: parts.objectiveStatement.slice(0, 100),
      conceptLabel: parts.objectiveStatement.slice(0, 20),
      knowledgeForm: "fact",
      preferredTaskIntents: ["recall"],
      canonicalAnswer: {
        kind: "text",
        unit: { unitId: "ans-probe", text: parts.answerText },
      },
      learningSupport: { explanation: "说明（与本 gate 无关）。" },
      rubric: {
        version: 2,
        units: [{
          rubricUnitId: "rubric-probe",
          facet: "recall",
          criterion: "能正确回答",
          required: true,
          answerUnitIds: ["ans-probe"],
          evidenceRefIds: [],
        }],
        passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
        rubricHash: "b".repeat(64),
      },
      relations: [],
      difficulty: "introductory",
      evidenceRefIds: ["e-1"],
    },
    presentation: {
      strategy: "recall",
      transformationKind: "retrieval_definition",
      front: { cue: parts.cue, prompt: parts.prompt },
      estimatedReviewSeconds: 30,
    },
    evidenceSetHash: "c".repeat(64),
    candidateRevisionHash: "d".repeat(64),
  } as unknown as Parameters<typeof atomicityGateImpl>[0];
}

/** 样本按「首个问号（含）之前 = cue」粗分；gate 只读拼接文本。 */
function splitFront(frontText: string): { cue: string; prompt: string } {
  const qIdx = frontText.indexOf("？");
  const idx = qIdx >= 0 ? qIdx + 1 : Math.max(1, Math.floor(frontText.length / 2));
  return { cue: frontText.slice(0, idx), prompt: frontText.slice(idx) || frontText.slice(0, idx) };
}
