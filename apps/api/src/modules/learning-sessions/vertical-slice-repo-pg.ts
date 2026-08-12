/**
 * VerticalSliceRepository 的 PostgreSQL 生产实现。
 *
 * 唯一生产消费方是 commit-outbox（API 侧 commit_requested 消费者）：
 * 评估 worker 写 assessment_complete 后入队，API 用 SECURITY DEFINER
 * claim 函数跨 workspace 领取，然后在 withWorkspaceTransaction 内用本
 * repo + Pg CommitExecutor 跑 stabilizeEpisode 编排。
 *
 * 字段来源（诚实映射，不伪造）：
 * - findEpisode：复用 createPgSessionRepository.findEpisode（rowToEpisode
 *   40/40 透传 learning_episodes 行）。
 * - listLockedArtifacts：learning_response_artifacts 行 → LockedArtifactView。
 *   fingerprintMatch = artifact.episode_target_fingerprint 与 episode 的
 *   episode_target_fingerprint 是否一致（与 worker 评估时同一比对逻辑）；
 *   contentAssisted = assistance_snapshot->>'contentAssisted'（jsonb 布尔）；
 *   effectiveTrustClass = effective_trust_class 列（可能为 NULL → support_only
 *   保守处理）。status 只返回 'locked'。
 * - listRubricAssessments：learning_assessment_reports 最新一条的
 *   rubric_assessments jsonb（评估可能幂等写多条 report_hash，取 created_at
 *   最新，与"评估最终结果"语义一致）。
 * - listActivePendingSchedules：review_schedules 中该 key point 的 pending 行。
 */

import { sql } from "drizzle-orm";
import { TrustClass } from "@ailearn/shared";
import type { ApiTransaction } from "../../db/client.ts";
import { createPgSessionRepository } from "./session-service.ts";
import type {
  ActivePendingScheduleView,
  LockedArtifactView,
  VerticalSliceRepository,
} from "./vertical-slice.ts";
import type { RubricAssessment } from "./trust-service.ts";

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function createPgVerticalSliceRepository(
  transaction: ApiTransaction,
): VerticalSliceRepository {
  const sessionRepo = createPgSessionRepository(transaction);

  return {
    async findEpisode(workspaceId, userId, episodeId) {
      return sessionRepo.findEpisode(workspaceId, userId, episodeId);
    },

    async listLockedArtifacts(workspaceId, userId, episodeId) {
      const episodeRows = (await transaction.execute(sql`
        SELECT episode_target_fingerprint AS "fingerprint"
        FROM learning_episodes
        WHERE id = ${episodeId}
          AND workspace_id = ${workspaceId}
          AND user_id = ${userId}
        LIMIT 1
      `)) as Array<Record<string, unknown>>;
      const episodeFingerprint = asString(episodeRows[0]?.fingerprint);
      const rows = (await transaction.execute(sql`
        SELECT id AS "artifactId",
               status,
               episode_target_fingerprint AS "episodeTargetFingerprint",
               effective_trust_class AS "effectiveTrustClass",
               assistance_snapshot AS "assistanceSnapshot"
        FROM learning_response_artifacts
        WHERE episode_id = ${episodeId}
          AND workspace_id = ${workspaceId}
          AND user_id = ${userId}
          AND status = 'locked'
        ORDER BY revision, id
      `)) as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const artifactFingerprint = asString(row.episodeTargetFingerprint);
        const assistance = asRecord(row.assistanceSnapshot);
        return {
          artifactId: String(row.artifactId),
          status: "locked" as const,
          effectiveTrustClass: asString(row.effectiveTrustClass) as TrustClass
            ?? TrustClass.NOT_ASSESSABLE,
          // 与 worker 评估时同一比对逻辑（episode_target_fingerprint 一致才算 match）
          fingerprintMatch:
            artifactFingerprint !== null
            && episodeFingerprint !== null
            && artifactFingerprint === episodeFingerprint,
          contentAssisted: assistance.contentAssisted === true,
        } satisfies LockedArtifactView;
      });
    },

    async listRubricAssessments(workspaceId, userId, episodeId) {
      const rows = (await transaction.execute(sql`
        SELECT rubric_assessments AS "rubricAssessments"
        FROM learning_assessment_reports
        WHERE episode_id = ${episodeId}
          AND workspace_id = ${workspaceId}
          AND user_id = ${userId}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (row === undefined) return [];
      // postgres.js/drizzle execute 路径对 jsonb 有时返回 string（未 parse）——
      // 防御性解析，保证 rubric_assessments 是数组。
      const raw = row.rubricAssessments;
      let assessments: RubricAssessment[] = [];
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) assessments = parsed as RubricAssessment[];
        } catch {
          assessments = [];
        }
      } else if (Array.isArray(raw)) {
        assessments = raw as RubricAssessment[];
      }
      return assessments;
    },

    async listActivePendingSchedules(workspaceId, userId, keyPointId) {
      const rows = (await transaction.execute(sql`
        SELECT id AS "scheduleId", generation, status
        FROM review_schedules
        WHERE key_point_id = ${keyPointId}
          AND workspace_id = ${workspaceId}
          AND user_id = ${userId}
          AND status = 'pending'
        ORDER BY created_at, id
      `)) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        scheduleId: String(row.scheduleId),
        generation: Number(row.generation ?? 0),
        status: String(row.status),
      })) satisfies ActivePendingScheduleView[];
    },
  };
}
