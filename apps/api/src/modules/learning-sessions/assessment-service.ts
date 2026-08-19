/**
 * 文字闭环：评测服务（审计救火顺序 3 后半——回答 → 评测 → disposition）。
 *
 * 消费 answer 端点产出的锁定 artifact。独立 Critic 尚未接入前，本服务只产生
 * diagnostic/not_assessable 报告，绝不把答案升级为正式理解或掌握事实。
 *
 * 端点：
 * - POST /learning-sessions/:id/episodes/:episodeId/assess
 *   body: { artifactId }（可选 rubricItemId 指定，缺省评测全部 rubric targets）
 *
 * 安全：
 * - 仅接受已锁定 artifact（status=locked）与 processing_phase=assessment_pending；
 * - 同 artifact 重放 hash 一致（issueEpisodeTrustDecision 确定性）；
 * - 0 掌握/schedule 写入（COMMIT 是后续步骤）。
 */

import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { DomainError } from "@ailearn/shared";
import { computeAssessmentReportHash, computeAssessmentInputHash, computeFailClosedAssessmentDecisionHash } from "@ailearn/shared/learning-assessment";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  isLearningSessionCanonicalCommitEnabled,
  isLearningSessionV2InternalEnabled,
} from "../../config/learning-companion-flags.ts";
import {
  issueEpisodeTrustDecision,
  runRubricSessionReducer,
  type RubricSessionItemInput,
} from "./trust-service.ts";

// ─── 错误 ────────────────────────────────────────────────────────────────

export class AssessmentServiceError extends DomainError {
  constructor(code: string, message: string, statusCode = 400) {
    super({ name: "AssessmentServiceError", code, message, statusCode });
  }
}

// ─── 输入/输出 ───────────────────────────────────────────────────────────

export interface AssessEpisodeInput {
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  artifactId: string;
}

export interface AssessmentResult {
  episodeId: string;
  sessionId: string;
  artifactId: string;
  verdicts: RubricSessionItemInput[];
  reducerVerdict: string;
  trustClass: string;
  decisionHash: string;
  disposition: string;
}

/** 可注入 repository（PG + 单测内存） */
export interface AssessmentRepository {
  findLockedArtifact(workspaceId: string, userId: string, artifactId: string): Promise<{
    id: string;
    episodeId: string;
    status: string;
    modality: string;
    payload: Record<string, unknown> | null;
  } | null>;
  findEpisodeRubricTargets(workspaceId: string, userId: string, episodeId: string): Promise<{
    episodeId: string;
    sessionId: string;
    status: string;
    processingPhase: string;
    rubricTargets: unknown[];
    episodeEpoch: number;
  } | null>;
  writeAssessment(
    workspaceId: string,
    userId: string,
    sessionId: string,
    episodeId: string,
    assessment: AssessmentResult,
  ): Promise<void>;
  /** Idempotent replay after a worker/API race has already completed it. */
  findExistingAssessment?: (
    workspaceId: string,
    userId: string,
    episodeId: string,
    artifactId: string,
  ) => Promise<AssessmentResult | null>;
  /** Advance the processing axis without changing Episode lifecycle status. */
  markAssessmentComplete?: (
    workspaceId: string,
    userId: string,
    episodeId: string,
  ) => Promise<void>;
}

// ─── 纯函数：deterministic rubric 判定 ───────────────────────────────────

/**
 * 独立 Critic 缺席时 fail closed。不能用“答案非空”证明任何 rubric criterion；
 * 所有 item 都标记 not_assessable。
 */
export function deterministicRubricVerdict(
  _answerText: string,
  rubricTargets: unknown[],
): RubricSessionItemInput[] {
  return (rubricTargets as Array<{ itemId?: string; facet?: string }>).map(
    (target, index) => {
      const itemId = target.itemId ?? `rubric-${index}`;
      return {
        rubricItemId: itemId,
        verdict: "not_assessable",
        weight: 1,
        required: true,
      };
    },
  );
}

// ─── 服务函数 ────────────────────────────────────────────────────────────

export async function assessEpisode(
  input: AssessEpisodeInput,
  repo: AssessmentRepository,
): Promise<AssessmentResult> {
  const artifact = await repo.findLockedArtifact(input.workspaceId, input.userId, input.artifactId);
  if (artifact === null) {
    throw new AssessmentServiceError("artifact_not_found", "锁定 artifact 不存在", 404);
  }
  if (artifact.episodeId !== input.episodeId) {
    throw new AssessmentServiceError("episode_mismatch", "artifact 不属于该 Episode", 409);
  }
  if (artifact.status !== "locked") {
    throw new AssessmentServiceError("artifact_not_locked", "仅锁定 artifact 可评测", 409);
  }

  const episode = await repo.findEpisodeRubricTargets(input.workspaceId, input.userId, input.episodeId);
  if (episode === null) {
    throw new AssessmentServiceError("episode_not_found", "Episode 不存在", 404);
  }
  if (episode.sessionId !== input.sessionId) {
    // Episode 必须属于当前 session，重放路径也不能绕过这个边界。
    throw new AssessmentServiceError("session_mismatch", "Episode 不属于该 Session", 409);
  }
  if (episode.processingPhase === "assessment_complete") {
    const existing = await repo.findExistingAssessment?.(
      input.workspaceId,
      input.userId,
      input.episodeId,
      input.artifactId,
    );
    if (existing) return existing;
    throw new AssessmentServiceError(
      "assessment_result_not_found",
      "Episode 已完成评估但报告不可重放",
      409,
    );
  }
  if (episode.status !== "active" || episode.processingPhase !== "assessment_pending") {
    throw new AssessmentServiceError(
      "episode_not_assessable",
      `Episode 当前阶段 ${episode.processingPhase} 不可评测`,
      409,
    );
  }
  const answerText = extractAnswerText(artifact.payload, artifact.modality);
  if (answerText === "") {
    throw new AssessmentServiceError("empty_answer", "锁定 artifact 无回答文本（fail closed）");
  }
  if (!episode.rubricTargets || episode.rubricTargets.length === 0) {
    // review should-fix：空 rubric 直接 4xx——reducer 对空集抛 ReducerError 会变 500
    throw new AssessmentServiceError(
      "rubric_targets_empty",
      "Episode 无 rubric targets（无法评测，fail closed）",
      422,
    );
  }

  const verdicts = deterministicRubricVerdict(answerText, episode.rubricTargets ?? []);
  const reducer = runRubricSessionReducer(verdicts);
  const reasonCodes = ["assessment_critic_unavailable", `reducer:${reducer.result}`];
  if (!isLearningSessionCanonicalCommitEnabled()) reasonCodes.push("canonical_commit_disabled");
  const decision = issueEpisodeTrustDecision({
    episodeId: input.episodeId,
    effectiveClass: "not_assessable",
    sourceArtifactIds: [input.artifactId],
    frozenProbeSetHash: computeAssessmentInputHash("assessment-critic-unavailable"),
    requiredRubricCoverageHash: computeAssessmentInputHash("assessment-coverage-unavailable"),
    assistanceSnapshotHash: computeAssessmentInputHash("assessment-assistance-unavailable"),
    reasonCodes,
  });
  const sharedDecisionHash = computeFailClosedAssessmentDecisionHash({
    episodeId: input.episodeId,
    artifactId: input.artifactId,
    reducerResult: reducer.result,
    canonicalCommitEnabled: isLearningSessionCanonicalCommitEnabled(),
  });
  if (decision.decisionHash !== sharedDecisionHash) {
    throw new AssessmentServiceError("assessment_hash_mismatch", "评估决策 hash 不一致", 500);
  }

  const result: AssessmentResult = {
    episodeId: input.episodeId,
    sessionId: input.sessionId,
    artifactId: input.artifactId,
    verdicts,
    reducerVerdict: reducer.result, // RubricSessionResult（pass/partial/fail/not_assessable）
    trustClass: decision.effectiveClass,
    decisionHash: decision.decisionHash,
    disposition: "not_assessable",
  };
  await repo.writeAssessment(
    input.workspaceId,
    input.userId,
    input.sessionId,
    input.episodeId,
    result,
  );
  await repo.markAssessmentComplete?.(input.workspaceId, input.userId, input.episodeId);
  return result;
}

/** 从 artifact payload 提取回答文本（text_or_mixed 的 text / voice 的 confirmedTranscript） */
export function extractAnswerText(
  payload: Record<string, unknown> | null,
  modality: string,
): string {
  if (!payload) return "";
  if (modality === "voice") {
    return typeof payload.confirmedTranscript === "string" ? payload.confirmedTranscript.trim() : "";
  }
  return typeof payload.text === "string" ? payload.text.trim() : "";
}

// ─── PG 实现 ─────────────────────────────────────────────────────────────

export interface AssessmentTx {
  execute(query: unknown): Promise<unknown>;
}

export function createPgAssessmentRepository(transaction: AssessmentTx): AssessmentRepository {
  return {
    async findLockedArtifact(workspaceId, userId, artifactId) {
      // 轻微·16（round-4）：不再载入整条 payload jsonb，只取 extractAnswerText
      // 真正用到的两个字段（text 与 confirmedTranscript，按 modality 二选一）。
      const rows = (await transaction.execute(
        sql`
          SELECT id, episode_id AS "episodeId", status, modality,
                 payload->>'text' AS "text",
                 payload->>'confirmedTranscript' AS "confirmedTranscript"
          FROM learning_response_artifacts
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND id = ${artifactId}
          LIMIT 1
        `,
      )) as Array<{
        id: unknown;
        episodeId: unknown;
        status: unknown;
        modality: unknown;
        text: unknown;
        confirmedTranscript: unknown;
      }>;
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        episodeId: String(row.episodeId),
        status: String(row.status),
        modality: String(row.modality),
        // 按 modality 合成最小 payload：text_or_mixed → text，voice → confirmedTranscript。
        payload: {
          ...(row.modality === "voice"
            ? { confirmedTranscript: typeof row.confirmedTranscript === "string" ? row.confirmedTranscript : "" }
            : { text: typeof row.text === "string" ? row.text : "" }),
        },
      };
    },
    async findEpisodeRubricTargets(workspaceId, userId, episodeId) {
      const rows = (await transaction.execute(
        sql`
          SELECT id, session_id AS "sessionId", status,
                 processing_phase AS "processingPhase", rubric_targets AS "rubricTargets",
                 episode_epoch AS "episodeEpoch"
          FROM learning_episodes
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND id = ${episodeId}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      return {
        episodeId: String(row.id),
        sessionId: String(row.sessionId),
        status: String(row.status),
        processingPhase: String(row.processingPhase ?? "awaiting_response"),
        rubricTargets: Array.isArray(row.rubricTargets) ? row.rubricTargets : [],
        episodeEpoch: Number(row.episodeEpoch ?? 0),
      };
    },
    async writeAssessment(workspaceId, userId, sessionId, episodeId, assessment) {
      // 评测结果写 learning_assessment_reports（评估报告，非掌握/schedule 真值）。
      // review 修复：INSERT 严格对齐 0074 列；session_id 用真 session（非 episodeId，
      // FK 指向 learning_sessions）；report_hash 撞唯一索引 → ON CONFLICT 幂等重放。
      const rubricAssessments = assessment.verdicts.map((v) => ({
        rubricItemId: v.rubricItemId,
        verdict: v.verdict,
        weight: v.weight,
        required: v.required,
      }));
      const reportHash = computeAssessmentReportHash(
        episodeId,
        assessment.artifactId,
        assessment.decisionHash,
      );
      await transaction.execute(
        sql`
          INSERT INTO learning_assessment_reports (
            session_id, episode_id, workspace_id, user_id,
            critic_version, reducer_version, assessment_source,
            rubric_assessments, report_hash, decision_hash
          ) VALUES (
            ${sessionId}, ${episodeId}, ${workspaceId}, ${userId},
            'diagnostic-fail-closed-v1', 'rubric-session-reducer-v2', 'deterministic',
            ${JSON.stringify(rubricAssessments)}, ${reportHash}, ${assessment.decisionHash}
          )
          ON CONFLICT (workspace_id, episode_id, report_hash) DO NOTHING
        `,
      );
    },
    async findExistingAssessment(workspaceId, userId, episodeId, artifactId) {
      const rows = (await transaction.execute(
        sql`
          SELECT session_id AS "sessionId", rubric_assessments AS "rubricAssessments",
                 decision_hash AS "decisionHash"
          FROM learning_assessment_reports
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
            AND episode_id = ${episodeId}
            AND rubric_assessments IS NOT NULL
            AND report_hash = ${computeAssessmentReportHash(
              episodeId,
              artifactId,
              computeFailClosedAssessmentDecisionHash({
                episodeId,
                artifactId,
                reducerResult: "not_assessable",
                canonicalCommitEnabled: isLearningSessionCanonicalCommitEnabled(),
              }),
            )}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row || typeof row.decisionHash !== "string") return null;
      const raw = Array.isArray(row.rubricAssessments) ? row.rubricAssessments : [];
      return {
        episodeId,
        sessionId: String(row.sessionId),
        artifactId,
        verdicts: raw.map((item) => ({
          rubricItemId: String((item as Record<string, unknown>).rubricItemId),
          verdict: "not_assessable" as const,
          weight: Number((item as Record<string, unknown>).weight ?? 1),
          required: Boolean((item as Record<string, unknown>).required ?? true),
        })),
        reducerVerdict: "not_assessable",
        trustClass: "not_assessable",
        decisionHash: row.decisionHash,
        disposition: "not_assessable",
      };
    },
    async markAssessmentComplete(workspaceId, userId, episodeId) {
      await transaction.execute(
        sql`
          UPDATE learning_episodes
          SET processing_phase = 'assessment_complete', updated_at = now()
          WHERE id = ${episodeId}
            AND workspace_id = ${workspaceId}
            AND user_id = ${userId}
            AND status = 'active'
            AND processing_phase = 'assessment_pending'
        `,
      );
    },
  };
}

// ─── 路由 ────────────────────────────────────────────────────────────────

const assessParamsSchema = z.object({ id: z.string().uuid(), episodeId: z.string().uuid() });
const assessBodySchema = z.object({ artifactId: z.string().uuid() });

export async function assessmentRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string; episodeId: string } }>(
    "/learning-sessions/:id/episodes/:episodeId/assess",
    { preHandler: [requireSession] },
    async (req, reply) => {
      if (!isLearningSessionV2InternalEnabled()) {
        return reply.code(404).send({
          error: "learning_session_v2_disabled",
          message: "学习伴星重构路径当前仅供内部验证",
        });
      }
      const parsed = assessParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        throw app.httpErrors.badRequest("session/episode id 非法");
      }
      const body = parseBody(app, assessBodySchema, req.body);
      try {
        const { withWorkspaceTransaction } = await import("../../db/client.ts");
        // 评测在单事务内（读 artifact/episode + 写评估报告原子）
        return await withWorkspaceTransaction(
          { workspaceId: req.session.workspaceId, userId: req.session.userId },
          async (t) => {
            const repo = createPgAssessmentRepository(t as unknown as AssessmentTx);
            return assessEpisode(
              {
                workspaceId: req.session.workspaceId,
                userId: req.session.userId,
                sessionId: parsed.data.id,
                episodeId: parsed.data.episodeId,
                artifactId: body.artifactId,
              },
              repo,
            );
          },
        );
      } catch (err) {
        if (err instanceof AssessmentServiceError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
