/**
 * 救火 3a：回答提交端点（审计 #2——Session API 死路）。
 *
 * 补上缺失的生产路径：把用户回答写入 learning_response_artifacts 并锁定
 * Episode（processing_phase → assessment_pending），形成 Card → Session → 回答 → 锁定的
 * 最小垂直闭环（完整 Scene/评测/Commit 在后续救火步骤）。
 *
 * 端点：
 * - POST /learning-sessions/:id/episodes/:episodeId/answer
 *   body: { modality: "text_or_mixed" | "voice", text?: string, transcript?: string }
 *   → 写 artifact（status=locked）+ 推进 episode processing_phase，
 *     返回 artifact public view。
 *
 * 语义（01-2 §7.2 状态机）：
 * - Episode 必须 active 且未锁定（锁定后重复提交 → ARTIFACT_LOCKED）；
 * - 逐 hash 记录 contentHash（text 或 transcript 的确定性 hash）；
 * - 0 掌握/schedule 写入（评估与 Commit 属后续步骤）。
 */

import { randomUUID } from "node:crypto";
import { sha256Hex } from "@ailearn/shared/content-hash";
import { DomainError } from "@ailearn/shared";
import { sql } from "drizzle-orm";

// ─── 错误 ────────────────────────────────────────────────────────────────

export class AnswerSubmissionError extends DomainError {
  constructor(code: string, message: string, statusCode = 400) {
    super({ name: "AnswerSubmissionError", code, message, statusCode });
  }
}

// ─── 纯函数：内容哈希 ────────────────────────────────────────────────────

/** 回答内容确定性 hash（§13.2：内容 hash 以服务端计算为准） */
export function computeAnswerContentHash(text: string): string {
  return `sha256:${sha256Hex(`answer-v1:${text}`)}`;
}

/** probe 确定性 hash（security_review MEDIUM 修复：纯 hex 与 session-service sha256Hex 完全一致） */
export function frozenProbeHashForKey(keyPointId: string, contentExposureKey: string): string {
  return sha256Hex(`probe:${keyPointId}:0:${contentExposureKey}`);
}

// ─── 输入/输出类型 ───────────────────────────────────────────────────────

export type AnswerModality = "text_or_mixed" | "voice";

export interface SubmitAnswerInput {
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  /** 可选：客户端不传时由服务端从 episode 读取（防越权指定） */
  keyPointId?: string;
  /** 可选：同上 */
  probeId?: string;
  modality: AnswerModality;
  /** text_or_mixed：用户确认文本；voice：ASR 逐字 transcript */
  text: string;
  now?: Date;
}

export interface ArtifactPublicView {
  artifactId: string;
  episodeId: string;
  keyPointId: string;
  probeId: string;
  modality: AnswerModality;
  contentHash: string;
  status: "locked";
  answerLockedAt: string;
}

export interface SubmitAnswerResult {
  artifact: ArtifactPublicView;
  episodeStatus: "active";
  processingPhase: "assessment_pending";
}

/** 可注入 repository（PG 实现 + 单测内存实现） */
export interface AnswerSubmissionRepository {
  findEpisode(workspaceId: string, userId: string, episodeId: string): Promise<{
    id: string;
    sessionId: string;
    keyPointId: string;
    status: string;
    processingPhase: string;
    probeId: string | null;
    contentExposureKey: string;
    /** Frozen content identity copied into the immutable artifact. */
    episodeTargetFingerprint?: string;
  } | null>;
  /**
   * 确保当前 episode 存在可用的 probe 行（learning_session_probes 的
   * FrozenProbeRef 记录；不存在则创建，返回真实 probe id）。
   * review blocking 修复：learning_response_artifacts.probe_id 是
   * uuid notNull + FK——必须先有 probe 行才能写 artifact。
   */
  ensureProbe(input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    episodeId: string;
    keyPointId: string;
    probeHash: string;
  }): Promise<{ probeId: string }>;
  createArtifact(input: {
    id: string;
    workspaceId: string;
    userId: string;
    sessionId: string;
    episodeId: string;
    keyPointId: string;
    probeId: string;
    modality: AnswerModality;
    contentHash: string;
    payload: Record<string, unknown>;
    capturedAt: string;
    answerLockedAt: string;
    status: "locked";
    revision: number;
    episodeTargetFingerprint?: string;
    contentExposureKey?: string;
  }): Promise<{ id: string }>;
  lockEpisode(episodeId: string, now: string, workspaceId: string, userId: string): Promise<void>;
  /** Same-transaction command enqueue; pure unit repositories may omit it. */
  enqueueAssessment?(input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    episodeId: string;
    artifactId: string;
  }): Promise<void>;
}

// ─── 服务函数（纯逻辑 + 可注入 repo）───────────────────────────────────

export async function submitEpisodeAnswer(
  input: SubmitAnswerInput,
  repo: AnswerSubmissionRepository,
): Promise<SubmitAnswerResult> {
  const now = input.now ?? new Date();
  const text = input.text?.trim() ?? "";
  if (text === "") {
    throw new AnswerSubmissionError("empty_answer", "回答内容为空（fail closed）");
  }
  if (input.modality !== "text_or_mixed" && input.modality !== "voice") {
    throw new AnswerSubmissionError("invalid_modality", "不支持的作答模态");
  }

  const episode = await repo.findEpisode(input.workspaceId, input.userId, input.episodeId);
  if (episode === null) {
    throw new AnswerSubmissionError("episode_not_found", "Episode 不存在", 404);
  }
  if (episode.sessionId !== input.sessionId) {
    throw new AnswerSubmissionError("session_mismatch", "Episode 不属于该 Session", 409);
  }
  if (episode.status !== "active" || episode.processingPhase !== "awaiting_response") {
    throw new AnswerSubmissionError(
      "episode_not_answerable",
      `Episode 当前状态 ${episode.status} 不可作答（需 active）`,
      409,
    );
  }

  const contentHash = computeAnswerContentHash(text);
  const artifactId = randomUUID();
  const nowIso = now.toISOString();
  // keyPointId 优先取 episode（服务端权威）；probeId 经 ensureProbe 创建真实行
  const keyPointId = episode.keyPointId;
  const { probeId } = await repo.ensureProbe({
    workspaceId: input.workspaceId,
    userId: input.userId,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    keyPointId,
    probeHash: frozenProbeHashForKey(keyPointId, episode.contentExposureKey),
  });

  // 先锁后写（review nit：并发双提交第二方在 lockEpisode 处 409 而非 createArtifact 500）
  await repo.lockEpisode(input.episodeId, nowIso, input.workspaceId, input.userId);

  await repo.createArtifact({
    id: artifactId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    keyPointId,
    probeId,
    modality: input.modality,
    contentHash,
    payload: input.modality === "voice"
      ? { confirmedTranscript: text, segmentTimestamps: [] }
      : { text, contentHash },
    capturedAt: nowIso,
    answerLockedAt: nowIso,
    status: "locked",
    revision: 0,
    episodeTargetFingerprint: episode.episodeTargetFingerprint,
    contentExposureKey: episode.contentExposureKey,
  });
  // The route wraps this repository in one DB transaction. If enqueue fails,
  // the artifact and processing-phase CAS roll back together.
  await repo.enqueueAssessment?.({
    workspaceId: input.workspaceId,
    userId: input.userId,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    artifactId,
  });

  return {
    artifact: {
      artifactId,
      episodeId: input.episodeId,
      keyPointId,
      probeId,
      modality: input.modality,
      contentHash,
      status: "locked",
      answerLockedAt: nowIso,
    },
    episodeStatus: "active",
    processingPhase: "assessment_pending",
  };
}

// ─── PG 实现 ─────────────────────────────────────────────────────────────

/** drizzle 事务的 execute 能力（原生 SQL；tx.execute(sql\`...\`)） */
export interface AnswerSubmissionTx {
  execute(query: unknown): Promise<unknown>;
}

/**
 * PG 实现：用原生 SQL 写 learning_response_artifacts + 锁 learning_episodes。
 * 不依赖 drizzle 表强类型（learningResponseArtifacts 在 packages/db，
 * 此处经 tx.execute 原生 SQL 避免跨包表引用）。
 */
export function createPgAnswerSubmissionRepository(
  transaction: AnswerSubmissionTx,
): AnswerSubmissionRepository {
  return {
    async findEpisode(workspaceId, userId, episodeId) {
      const rows = (await transaction.execute(
        sql`
          SELECT id, session_id AS "sessionId", key_point_id AS "keyPointId",
                 status, processing_phase AS "processingPhase",
                 content_exposure_key AS "contentExposureKey",
                 episode_target_fingerprint AS "episodeTargetFingerprint",
                 NULL::uuid AS "probeId"
          FROM learning_episodes
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND id = ${episodeId}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        sessionId: String(row.sessionId),
        keyPointId: String(row.keyPointId),
        status: String(row.status),
        processingPhase: String(row.processingPhase ?? "awaiting_response"),
        contentExposureKey: String(row.contentExposureKey ?? ""),
        episodeTargetFingerprint: String(row.episodeTargetFingerprint ?? ""),
        probeId: row.probeId != null ? String(row.probeId) : null,
      };
    },
    // review blocking 修复：先建 probe 行（FK 前提），返回真实 probe id
    async ensureProbe(input) {
      // should-fix #1（review）：ON CONFLICT 用 (episode_id, sequence) 唯一索引，
      // 冲突时复用现有行（RETURNING 取真实 id），不撞 episodeSequenceUnique 23505。
      const probeId = randomUUID();
      const rows = (await transaction.execute(
        sql`
          INSERT INTO learning_session_probes (
            id, session_id, episode_id, workspace_id, user_id, sequence,
            public_scene_contract_id, public_payload_hash, private_solution_id,
            private_solution_hash, scene_safety_report_id, scene_safety_report_hash,
            template_trust_ceiling, disclosure_profile_hash, status
          ) VALUES (
            ${probeId}, ${input.sessionId}, ${input.episodeId}, ${input.workspaceId},
            ${input.userId}, 0, '', '', '', '', '', '',
            'mastery_eligible', ${input.probeHash}, 'draft'
          )
          ON CONFLICT (episode_id, sequence) DO UPDATE SET updated_at = now()
          RETURNING id
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      return { probeId: row && typeof row.id === "string" ? row.id : probeId };
    },
    async createArtifact(input) {
      await transaction.execute(
        sql`
          INSERT INTO learning_response_artifacts (
            id, workspace_id, user_id, session_id, episode_id, key_point_id, probe_id,
            public_scene_contract_id, public_payload_hash, private_solution_id,
            private_solution_hash, scene_safety_report_hash, disclosure_profile_hash,
            input_schema_hash, modality, content_hash, payload, captured_at,
            answer_locked_at, assistance_snapshot, episode_target_fingerprint,
            content_exposure_key, requested_trust_class, template_trust_ceiling,
            trust_policy_version, trust_reason_codes, correction_method, status, revision
          ) VALUES (
            ${input.id}, ${input.workspaceId}, ${input.userId}, ${input.sessionId},
            ${input.episodeId}, ${input.keyPointId}, ${input.probeId},
            '', '', '', '', '', '', '',
            ${input.modality}, ${input.contentHash}, ${JSON.stringify(input.payload)},
            ${input.capturedAt}, ${input.answerLockedAt},
            ${JSON.stringify({ assistanceLevel: "none", contentAssisted: false })},
            ${input.episodeTargetFingerprint ?? ''}, ${input.contentExposureKey ?? ''},
            'mastery_eligible', 'mastery_eligible', 'trust-policy-v1',
            ARRAY[]::text[],
            'none', ${input.status}, ${input.revision}
          )
        `,
      );
      return { id: input.id };
    },
    // should-fix #2（review）：条件 UPDATE 检查影响行数——并发双提交下第二个
    // 请求 UPDATE 0 行 → 抛 episode_not_answerable（fail closed，不静默成功）。
    async lockEpisode(episodeId, _now, workspaceId, userId) {
      const rows = (await transaction.execute(
        sql`
          UPDATE learning_episodes
          SET processing_phase = 'assessment_pending', updated_at = now()
          WHERE id = ${episodeId} AND workspace_id = ${workspaceId}
            AND user_id = ${userId} AND status = 'active'
            AND processing_phase = 'awaiting_response'
          RETURNING id
        `,
      )) as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        throw new AnswerSubmissionError(
          "episode_not_answerable",
          "Episode 已被并发提交锁定或状态不可作答（fail closed）",
          409,
        );
      }
    },
    async enqueueAssessment(input) {
      const { createPgAssessmentProcessingOutboxRepository } = await import("./assessment-processing-outbox.ts");
      await createPgAssessmentProcessingOutboxRepository(transaction).enqueueAssessment(input);
    },
  };
}
