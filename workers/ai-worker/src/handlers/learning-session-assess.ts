/** Learning Session assessment queue handler. */

import type { JobPayload } from "./index.ts";
import { assessLearningSession } from "./learning-session-assessment.ts";

export interface LearningSessionAssessJob extends JobPayload {
  type: "learning_session_assess";
  sessionId: string;
  episodeId: string;
  artifactId: string;
  workspaceId: string;
  userId: string;
}

/** 外层 processJob 传入的 handler 上下文（与 ClaimedJob 对齐） */
export interface LearningSessionAssessHandlerContext {
  id: string;
  payload: Record<string, unknown>;
  workspaceId: string;
  requestedBy: string | null;
  leaseToken: string;
  signal: AbortSignal;
}

export async function runLearningSessionAssess(
  ctx: LearningSessionAssessHandlerContext,
): Promise<void> {
  const payload = ctx.payload as Partial<LearningSessionAssessJob>;
  const sessionId = payload.sessionId;
  const episodeId = payload.episodeId;
  const artifactId = payload.artifactId;
  const userId = payload.userId ?? ctx.requestedBy;
  if (!sessionId || !episodeId || !artifactId || !userId) {
    throw new Error("learning_session_assess payload 缺 sessionId/episodeId/artifactId/userId");
  }
  if (ctx.signal.aborted) throw new Error("learning_session_assess aborted");
  await assessLearningSession({
    workspaceId: ctx.workspaceId,
    userId,
    sessionId,
    episodeId,
    artifactId,
  });
}
