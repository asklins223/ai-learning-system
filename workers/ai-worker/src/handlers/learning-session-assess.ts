/**
 * 救火 4b：Learning Session 评测 handler。
 *
 * 处理 `learning_session_assess` job：对已锁定的 episode artifact 触发
 * 独立评测（Assessment Critic）并记录 disposition。
 *
 * 实现边界（诚实）：当前 worker 无学习域 DB 访问；本 handler 作为
 * **接线点**——把评测请求转发到 API 的评测端点（后续接入独立 Agent
 * Session 与 Assessment Critic 的 provider 调用）。job 状态转换
 * （claimed → success/failed）由外层 processJob 统一处理。
 */

import type { JobPayload } from "./index.ts";

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

/** API 评测端点（与救火 3a 的 answer 端点配套；评估实现接入后开放） */
const ASSESS_ENDPOINT = "/learning-sessions/:id/episodes/:episodeId/assess";

export async function runLearningSessionAssess(
  ctx: LearningSessionAssessHandlerContext,
): Promise<void> {
  const payload = ctx.payload as Partial<LearningSessionAssessJob>;
  const sessionId = payload.sessionId;
  const episodeId = payload.episodeId;
  const artifactId = payload.artifactId;
  if (!sessionId || !episodeId || !artifactId) {
    throw new Error("learning_session_assess payload 缺 sessionId/episodeId/artifactId");
  }
  // 接线点：真实评测需 worker 具备学习域读能力（或经 API 端点编排）。
  const apiBase = process.env.API_INTERNAL_URL;
  if (!apiBase) {
    throw new Error("API_INTERNAL_URL 未配置（learning_session_assess 需经 API 编排评测）");
  }
  const url = `${apiBase}${ASSESS_ENDPOINT.replace(":id", sessionId).replace(":episodeId", episodeId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ artifactId, workspaceId: ctx.workspaceId }),
    // review nit：超时中止 in-flight 请求——避免迟到 handler 在 lease 释放后继续执行
    //（防重复提交副作用由 processJob 的 leaseToken 条件 UPDATE 兜底）
    signal: ctx.signal,
  });
  if (!res.ok) {
    throw new Error(`learning_session_assess 上游失败 HTTP ${res.status}`);
  }
}
