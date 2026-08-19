import type { ValidationOutcome } from "./enums.ts";

// V1 domain model types (NoteVersionBlock, LearningCardKeyPoint, Evidence,
// LearningCard, AIArtifact, ValidationFeedback, ValidationEvent, ReviewSchedule)
// have been removed — V1 tables are deleted and V2 contracts live in
// learning-card-v2-contracts.ts, card-generation-v2-contracts.ts, etc.

// ─── v0.6: Sanitized Question DTO (计划 §9.2) ─────────────────────────────

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

