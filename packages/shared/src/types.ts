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
  subjectType: "card" | "validation";
  subjectId: string;
  validationEventId: string | null;
  status: ReviewStatus;
  nextReviewAt: string;
  intervalDays: number;
  lastReviewAt: string | null;
  createdAt: string;
}
