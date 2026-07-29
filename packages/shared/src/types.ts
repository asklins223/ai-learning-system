import type {
  ArtifactType,
  CardStatus,
  EvidenceAlignment,
  ValidationOutcome,
  ArtifactStatus,
  ReviewStatus,
} from "./enums.ts";

export interface NoteVersionBlock {
  id: string;
  versionId: string;
  ordinal: number;
  type: "paragraph" | "heading" | "code" | "list" | "quote" | "image";
  content: string;
}

export interface LearningCardKeyPoint {
  id: string;
  ordinal: number;
  claim: string;
  quoteText: string;
  evidence?: Evidence;
}

export interface Evidence {
  id: string;
  keyPointId: string;
  blockId: string | null;
  blockOrdinal: number | null;
  quoteText: string;
  alignment: EvidenceAlignment;
  alignmentScore: number;
  alignmentMethod: "embedding" | "fuzzy" | "exact" | "manual";
  userOverride?: "confirmed" | "downgraded" | "rejected";
}

export interface LearningCard {
  id: string;
  noteVersionId: string;
  workspaceId: string;
  status: CardStatus;
  // R-028: schemaJson 只存 title/summary，keyPoints 存在独立的 card_key_points 表
  schemaJson: {
    title: string;
    summary: string;
  };
  artifactId: string | null;
  createdAt: string;
}

export interface AIArtifact {
  id: string;
  type: ArtifactType;
  modelId: string;
  promptVersion: string;
  status: ArtifactStatus;
  output: unknown;
  inputHash: string | null;
}

/** 结构化验证反馈（对齐产品文档 §5.8 的 JSON 输出契约） */
export interface ValidationFeedback {
  outcome: ValidationOutcome;
  confidence: number;
  coveredPoints: string[];
  missingPoints: string[];
  misunderstandings: string[];
  evidenceRefs: string[];
  /** AI 给出的自然语言反馈，供 UI 展示 */
  feedback: string;
}

export interface ValidationEvent {
  id: string;
  workspaceId: string;
  userId: string;
  cardId: string;
  keyPointId: string | null;
  artifactId: string | null;
  question: string;
  questionType: "explain" | "example" | "apply";
  userAnswer: string;
  outcome: ValidationOutcome;
  confidence: number;
  feedback: ValidationFeedback | null;
  createdAt: string;
}

export interface ReviewSchedule {
  id: string;
  workspaceId: string;
  userId: string;
  subjectType: "card" | "validation" | "key_point";
  subjectId: string;
  validationEventId: string | null;
  status: ReviewStatus;
  nextReviewAt: string;
  intervalDays: number;
  lastReviewAt: string | null;
  keyPointId: string | null;
  generation: number;
  policyVersion: string | null;
  reasonCode: string | null;
  supersedesScheduleId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── v0.6: Sanitized Question DTO (计划 §9.2) ─────────────────────────────

/**
 * 净化后的题目 DTO，提交前返回客户端。
 *
 * 字段白名单：只能包含 question ID、题型、题面、key point ordinal 和进度。
 * 不能包含生成卡片/笔记标题、claim、quote、rubric、expected point、
 * evidence 或历史结果。
 */
export interface SanitizedQuestion {
  /** 题目 ID */
  questionId: string;
  /** 题型：explain | example | apply */
  questionType: "explain" | "example" | "apply";
  /** 题面正文 */
  question: string;
  /** Key point 序号（中性显示，如"要点 2/5"） */
  keyPointOrdinal: number;
  /** 当前会话进度（如"验证任务 2/5"或"复习任务 3"） */
  progress?: {
    current: number;
    total: number;
    label: string;
  };
}

/**
 * v0.6 Question Safety Report (计划 §10.2)
 * 每条 active question 都绑定确定性 safety report。
 */
export interface QuestionSafetyReport {
  /** 是否通过安全门禁 */
  passed: boolean;
  /** 命中的 reason codes */
  reasonCodes: string[];
  /** 评估器版本 */
  assessorVersion: string;
  /** 检查时间戳 */
  assessedAt: string;
}
