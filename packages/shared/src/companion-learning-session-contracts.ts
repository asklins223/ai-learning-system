/** Server-side companion Learning Session revision calculation.
 *
 * Kept separate from the browser-safe Zod wire contracts: the synchronous
 * SHA-256 implementation uses Node's crypto module and must never enter a
 * Next client bundle.
 */
import { canonicalJsonV1, sha256Utf8V1 } from "./content-hash.ts";

// ─── 学习会话域枚举（2026-08-12 契约收口）────────────────────────────────
// SQL 迁移为权威（0074 learning_sessions/episodes status CHECK、
// 0080 processing_phase CHECK），本组常量是 TS 侧镜像——worker/api 不得
// 裸写字符串字面量。

/** 0074 learning_sessions.status CHECK（'active','ended','cancelled','stale'）。 */
export const LearningSessionStatus = {
  ACTIVE: "active",
  ENDED: "ended",
  CANCELLED: "cancelled",
  STALE: "stale",
} as const;
export type LearningSessionStatus =
  (typeof LearningSessionStatus)[keyof typeof LearningSessionStatus];

/** 0074 learning_episodes.status CHECK（'draft','active','completed','stale','cancelled'）。 */
export const LearningEpisodeStatus = {
  DRAFT: "draft",
  ACTIVE: "active",
  COMPLETED: "completed",
  STALE: "stale",
  CANCELLED: "cancelled",
} as const;
export type LearningEpisodeStatus =
  (typeof LearningEpisodeStatus)[keyof typeof LearningEpisodeStatus];

/** 0080 learning_episodes.processing_phase CHECK（9 值）。 */
export const LearningProcessingPhase = {
  PREPARING: "preparing",
  SCENE_READY: "scene_ready",
  AWAITING_RESPONSE: "awaiting_response",
  ASSESSMENT_PENDING: "assessment_pending",
  ASSESSMENT_COMPLETE: "assessment_complete",
  COMMIT_PENDING: "commit_pending",
  COMMITTED: "committed",
  CANCELLED: "cancelled",
  STALE: "stale",
} as const;
export type LearningProcessingPhase =
  (typeof LearningProcessingPhase)[keyof typeof LearningProcessingPhase];

export interface CompanionLearningSessionContextRevisionInputV1 {
  sessionId: string;
  episodeId: string;
  cardId: string;
  keyPointId: string;
  sessionStatus: string;
  episodeStatus: string;
  processingPhase: string;
  episodeEpoch: number;
  planHash: string;
  contentExposureKey: string;
  sessionUpdatedAt: string;
  episodeUpdatedAt: string;
  answerLocked: boolean;
}

/**
 * Unique server-side revision entry point. Timestamps and answer lock are
 * included so a grant becomes stale after a learning state transition;
 * pageInstanceId remains an ephemeral page boundary and is excluded.
 */
export function computeCompanionLearningSessionContextRevisionV1(
  input: CompanionLearningSessionContextRevisionInputV1,
): string {
  return sha256Utf8V1(canonicalJsonV1({
    version: 1,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    cardId: input.cardId,
    keyPointId: input.keyPointId,
    sessionStatus: input.sessionStatus,
    episodeStatus: input.episodeStatus,
    processingPhase: input.processingPhase,
    episodeEpoch: input.episodeEpoch,
    planHash: input.planHash,
    contentExposureKey: input.contentExposureKey,
    sessionUpdatedAt: input.sessionUpdatedAt,
    episodeUpdatedAt: input.episodeUpdatedAt,
    answerLocked: input.answerLocked,
  }));
}
