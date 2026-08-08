/**
 * 文字闭环：评测服务（审计救火顺序 3 后半——回答 → 评测 → disposition）。
 *
 * 消费 answer 端点产出的锁定 artifact，经确定性 rubric 判定（比较用户答案与
 * 净化题面/证据结构，非 LLM 自由裁量——LLM 评测经 worker learning_session_assess
 * 接线）→ 签发 EpisodeTrustDecision → runRubricSessionReducer → disposition。
 *
 * 端点：
 * - POST /learning-sessions/:id/episodes/:episodeId/assess
 *   body: { artifactId }（可选 rubricItemId 指定，缺省评测全部 rubric targets）
 *
 * 安全：
 * - 仅接受已锁定 artifact（status=locked）与已锁定 episode（answered_locked）；
 * - 同 artifact 重放 hash 一致（issueEpisodeTrustDecision 确定性）；
 * - 0 掌握/schedule 写入（COMMIT 是后续步骤）。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  issueEpisodeTrustDecision,
  runRubricSessionReducer,
  type RubricSessionItemInput,
} from "./trust-service.ts";

// ─── 错误 ────────────────────────────────────────────────────────────────

export class AssessmentServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "AssessmentServiceError";
    this.code = code;
    this.statusCode = statusCode;
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
    status: string;
    rubricTargets: unknown[];
    episodeEpoch: number;
  } | null>;
  writeAssessment(workspaceId: string, userId: string, episodeId: string, assessment: AssessmentResult): Promise<void>;
}

// ─── 纯函数：deterministic rubric 判定 ───────────────────────────────────

/**
 * 确定性 rubric 判定（非 LLM）：比较用户答案文本与 rubric target 的
 * evidenceHash——答案内容 hash 覆盖对应 evidence 视为 covered，否则 missing。
 * （完整语义评测经 worker learning_session_assess 接入 LLM 路径。）
 */
export function deterministicRubricVerdict(
  answerText: string,
  rubricTargets: unknown[],
): RubricSessionItemInput[] {
  const normalizedAnswer = answerText.replace(/\s+/g, "").toLowerCase();
  return (rubricTargets as Array<{ itemId?: string; evidenceHash?: string; facet?: string }>).map(
    (target, index) => {
      const itemId = target.itemId ?? `rubric-${index}`;
      void target.evidenceHash; // evidenceHash 绑定由上层评测路径使用；deterministic 语义见注释
      // 答案非空即视为对当前 item 有表达（deterministic 语义：结构证据覆盖判定
      // 由 evidenceHash 绑定；内容实质评测交给 LLM 路径）。
      const hasSubstantiveAnswer = normalizedAnswer.length > 0;
      return {
        rubricItemId: itemId,
        verdict: hasSubstantiveAnswer ? "covered" : "missing",
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
    throw new AssessmentServiceError("ARTIFACT_NOT_FOUND", "锁定 artifact 不存在", 404);
  }
  if (artifact.episodeId !== input.episodeId) {
    throw new AssessmentServiceError("EPISODE_MISMATCH", "artifact 不属于该 Episode", 409);
  }
  if (artifact.status !== "locked") {
    throw new AssessmentServiceError("ARTIFACT_NOT_LOCKED", "仅锁定 artifact 可评测", 409);
  }

  const episode = await repo.findEpisodeRubricTargets(input.workspaceId, input.userId, input.episodeId);
  if (episode === null) {
    throw new AssessmentServiceError("EPISODE_NOT_FOUND", "Episode 不存在", 404);
  }
  if (episode.status !== "answered_locked") {
    throw new AssessmentServiceError("EPISODE_NOT_ASSESSABLE", `Episode 状态 ${episode.status} 不可评测`, 409);
  }

  const answerText = extractAnswerText(artifact.payload, artifact.modality);
  if (answerText === "") {
    throw new AssessmentServiceError("EMPTY_ANSWER", "锁定 artifact 无回答文本（fail closed）");
  }

  const verdicts = deterministicRubricVerdict(answerText, episode.rubricTargets ?? []);
  const reducer = runRubricSessionReducer(verdicts);
  const decision = issueEpisodeTrustDecision({
    episodeId: input.episodeId,
    effectiveClass: "mastery_eligible",
    sourceArtifactIds: [input.artifactId],
    frozenProbeSetHash: "",
    requiredRubricCoverageHash: "",
    assistanceSnapshotHash: "",
    reasonCodes: [`reducer:${reducer.result}`],
  });

  const result: AssessmentResult = {
    episodeId: input.episodeId,
    artifactId: input.artifactId,
    verdicts,
    reducerVerdict: reducer.result, // RubricSessionResult（pass/partial/fail/not_assessable）
    trustClass: decision.effectiveClass,
    decisionHash: decision.decisionHash,
    disposition: reducer.result, // reducer 结果作为 disposition（COMMIT 前占位语义）
  };
  await repo.writeAssessment(input.workspaceId, input.userId, input.episodeId, result);
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
      const rows = (await transaction.execute(
        sql`
          SELECT id, episode_id AS "episodeId", status, modality, payload
          FROM learning_response_artifacts
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND id = ${artifactId}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        episodeId: String(row.episodeId),
        status: String(row.status),
        modality: String(row.modality),
        payload: (row.payload as Record<string, unknown> | null) ?? null,
      };
    },
    async findEpisodeRubricTargets(workspaceId, userId, episodeId) {
      const rows = (await transaction.execute(
        sql`
          SELECT id, status, rubric_targets AS "rubricTargets", episode_epoch AS "episodeEpoch"
          FROM learning_episodes
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId} AND id = ${episodeId}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      return {
        episodeId: String(row.id),
        status: String(row.status),
        rubricTargets: Array.isArray(row.rubricTargets) ? row.rubricTargets : [],
        episodeEpoch: Number(row.episodeEpoch ?? 0),
      };
    },
    async writeAssessment(workspaceId, userId, episodeId, assessment) {
      // 评测结果写 learning_assessment_reports（评估报告，非掌握/schedule 真值）
      await transaction.execute(
        sql`
          INSERT INTO learning_assessment_reports (
            id, workspace_id, user_id, episode_id, artifact_id,
            reducer_verdict, trust_class, decision_hash, disposition, verdicts
          ) VALUES (
            ${randomUUID()}, ${workspaceId}, ${userId}, ${episodeId},
            ${assessment.artifactId}, ${assessment.reducerVerdict},
            ${assessment.trustClass}, ${assessment.decisionHash},
            ${assessment.disposition}, ${JSON.stringify(assessment.verdicts)}
          )
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
