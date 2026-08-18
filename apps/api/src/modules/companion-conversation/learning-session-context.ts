/**
 * Learning Session page adapter 的服务端只读投影。
 *
 * 该模块不写 canonical learning 数据，也不签发 grant；它只把当前 RLS
 * scope 内的 session/episode/card/key point 关系读出来，并复用 shared 的
 * 唯一 contextRevision 算法。菜单 proposal、grant endpoint 和 turn create
 * 都必须经过这里，避免各自计算出不同 revision。
 */

import { sql } from "drizzle-orm";
import {
  type CompanionLearningSessionContextV1,
  type CompanionLearningSessionContextRevisionInputV1,
} from "@ailearn/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";

// 2026-08-13（web 客户端打包修复）：revision 计算从 shared contracts 移入
// api 侧——contracts 保持无 node 依赖（客户端可安全打包）。
function computeCompanionLearningSessionContextRevisionV1(
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
import type { ApiTransaction } from "../../db/client.ts";

export interface CompanionLearningSessionContextRow {
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

function isoDate(value: Date | string): string {
  return new Date(value).toISOString();
}

export async function loadCompanionLearningSessionContext(
  tx: Pick<ApiTransaction, "execute">,
  args: { workspaceId: string; userId: string; sessionId?: string; episodeId?: string },
): Promise<CompanionLearningSessionContextRow | null> {
  const rows = await tx.execute<{
    session_id: string;
    episode_id: string;
    card_id: string;
    key_point_id: string;
    session_status: string;
    episode_status: string;
    processing_phase: string;
    episode_epoch: number;
    plan_hash: string;
    content_exposure_key: string;
    session_updated_at: Date | string;
    episode_updated_at: Date | string;
    answer_locked: boolean;
  }>(sql`
    SELECT s.id AS session_id,
           e.id AS episode_id,
           o.objective_id AS card_id,
           e.key_point_id,
           s.status AS session_status,
           e.status AS episode_status,
           e.processing_phase,
           e.episode_epoch,
           e.plan_hash,
           e.content_exposure_key,
           s.updated_at AS session_updated_at,
           e.updated_at AS episode_updated_at,
           EXISTS (
             SELECT 1
             FROM learning_response_artifacts a
             WHERE a.episode_id = e.id
               AND a.workspace_id = e.workspace_id
               AND a.user_id = e.user_id
               AND (a.answer_locked_at IS NOT NULL OR a.status IN ('locked', 'redacted'))
           ) AS answer_locked
    FROM learning_sessions s
    JOIN learning_episodes e ON e.session_id = s.id
    JOIN learning_objectives_v2 o ON o.objective_id = e.key_point_id
      AND o.workspace_id = ${args.workspaceId}
    WHERE s.workspace_id = ${args.workspaceId}
      AND s.user_id = ${args.userId}
      AND e.workspace_id = ${args.workspaceId}
      AND e.user_id = ${args.userId}
      ${args.sessionId ? sql`AND s.id = ${args.sessionId}` : sql``}
      ${args.episodeId ? sql`AND e.id = ${args.episodeId}` : sql``}
    -- 2026-08-11：无参（sessionId/episodeId 均缺）时 JOIN 可能命中多行，
    -- 此前 LIMIT 1 无 ORDER BY → 返回行不确定，contextRevision 抖动。
    -- 固定取最近更新的 episode（同 updated_at 按 id 稳定）。
    ORDER BY e.updated_at DESC, e.id
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    sessionId: row.session_id,
    episodeId: row.episode_id,
    cardId: row.card_id,
    keyPointId: row.key_point_id,
    sessionStatus: row.session_status,
    episodeStatus: row.episode_status,
    processingPhase: row.processing_phase,
    episodeEpoch: Number(row.episode_epoch),
    planHash: row.plan_hash,
    contentExposureKey: row.content_exposure_key,
    sessionUpdatedAt: isoDate(row.session_updated_at),
    episodeUpdatedAt: isoDate(row.episode_updated_at),
    answerLocked: row.answer_locked === true,
  };
}

export function contextRevisionForCompanionLearningSession(
  row: CompanionLearningSessionContextRow,
): string {
  return computeCompanionLearningSessionContextRevisionV1(row);
}

export function buildCompanionLearningSessionContext(
  row: CompanionLearningSessionContextRow,
): CompanionLearningSessionContextV1 {
  return {
    version: 1,
    pageKind: "learning_session",
    sharing: "page_registered",
    sessionId: row.sessionId,
    episodeId: row.episodeId,
    cardId: row.cardId,
    keyPointId: row.keyPointId,
    requestedCapability: "none",
    contextRevision: contextRevisionForCompanionLearningSession(row),
    groundedTutorGrant: null,
  };
}
