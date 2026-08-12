/**
 * Learning Session assessment command outbox.
 *
 * This queue contains only scoped identifiers. It is deliberately separate
 * from canonical learning events: assessment may retry without creating a
 * mastery or schedule event. A worker claims a row with a lease so a process
 * crash can be recovered without user-cookie loopback HTTP.
 */

import { sql } from "drizzle-orm";
import {
  assessEpisode as runAssessment,
  type AssessmentRepository,
  type AssessEpisodeInput,
} from "./assessment-service.ts";
import { AssessmentServiceError } from "./assessment-service.ts";

export type ProcessingCommandType = "assessment_requested" | "commit_requested";

export interface AssessmentOutboxJob {
  id: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  artifactId: string;
  commandType: ProcessingCommandType;
  idempotencyKey: string;
  attempts: number;
  leaseOwner: string;
}

export interface AssessmentProcessingOutboxRepository {
  enqueueAssessment(input: {
    workspaceId: string;
    userId: string;
    sessionId: string;
    episodeId: string;
    artifactId: string;
  }): Promise<void>;
  claimNext(now: Date, workerId: string, leaseMs: number): Promise<AssessmentOutboxJob | null>;
  markProcessed(jobId: string, workerId: string, now: Date): Promise<void>;
  release(jobId: string, workerId: string, availableAt: Date, error: string): Promise<void>;
}

export interface ProcessingOutboxTx {
  execute(query: unknown): Promise<unknown>;
}

function assessmentIdempotencyKey(input: {
  sessionId: string;
  episodeId: string;
  artifactId: string;
}): string {
  return `assessment:${input.sessionId}:${input.episodeId}:${input.artifactId}`;
}

export function createPgAssessmentProcessingOutboxRepository(
  transaction: ProcessingOutboxTx,
): AssessmentProcessingOutboxRepository {
  return {
    async enqueueAssessment(input) {
      await transaction.execute(sql`
        INSERT INTO learning_session_processing_outbox (
          workspace_id, user_id, session_id, episode_id,
          command_type, payload, idempotency_key
        ) VALUES (
          ${input.workspaceId}, ${input.userId}, ${input.sessionId}, ${input.episodeId},
          'assessment_requested',
          ${JSON.stringify({
            sessionId: input.sessionId,
            episodeId: input.episodeId,
            artifactId: input.artifactId,
          })},
          ${assessmentIdempotencyKey(input)}
        )
        ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      `);
    },

    async claimNext(now, workerId, leaseMs) {
      const leaseExpiresAt = new Date(now.getTime() + leaseMs);
      const nowIso = now.toISOString();
      const leaseExpiresAtIso = leaseExpiresAt.toISOString();
      const rows = (await transaction.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM learning_session_processing_outbox
          WHERE processed_at IS NULL
            AND available_at <= ${nowIso}
            AND (lease_expires_at IS NULL OR lease_expires_at <= ${nowIso})
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE learning_session_processing_outbox AS job
        SET attempts = job.attempts + 1,
            leased_at = ${nowIso},
            lease_owner = ${workerId},
            lease_expires_at = ${leaseExpiresAtIso},
            updated_at = ${nowIso}
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id, job.workspace_id AS "workspaceId",
          job.user_id AS "userId", job.session_id AS "sessionId",
          job.episode_id AS "episodeId", job.payload,
          job.command_type AS "commandType", job.idempotency_key AS "idempotencyKey",
          job.attempts, job.lease_owner AS "leaseOwner"
      `)) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) return null;
      const payload = row.payload as Record<string, unknown> | null;
      if (typeof payload?.artifactId !== "string") {
        throw new Error("assessment outbox payload 缺少 artifactId");
      }
      return {
        id: String(row.id),
        workspaceId: String(row.workspaceId),
        userId: String(row.userId),
        sessionId: String(row.sessionId),
        episodeId: String(row.episodeId),
        artifactId: payload.artifactId,
        commandType: String(row.commandType) as ProcessingCommandType,
        idempotencyKey: String(row.idempotencyKey),
        attempts: Number(row.attempts ?? 0),
        leaseOwner: String(row.leaseOwner),
      };
    },

    async markProcessed(jobId, workerId, now) {
      const nowIso = now.toISOString();
      await transaction.execute(sql`
        UPDATE learning_session_processing_outbox
        SET processed_at = ${nowIso}, leased_at = NULL, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = ${nowIso}
        WHERE id = ${jobId} AND lease_owner = ${workerId} AND processed_at IS NULL
      `);
    },

    async release(jobId, workerId, availableAt, error) {
      const availableAtIso = availableAt.toISOString();
      await transaction.execute(sql`
        UPDATE learning_session_processing_outbox
        SET available_at = ${availableAtIso}, leased_at = NULL, lease_owner = NULL,
            lease_expires_at = NULL, last_error = ${error.slice(0, 1000)},
            updated_at = now()
        WHERE id = ${jobId} AND lease_owner = ${workerId} AND processed_at IS NULL
      `);
    },
  };
}

export function assessmentInputFromOutboxJob(job: AssessmentOutboxJob): AssessEpisodeInput {
  return {
    workspaceId: job.workspaceId,
    userId: job.userId,
    sessionId: job.sessionId,
    episodeId: job.episodeId,
    artifactId: job.artifactId,
  };
}

/** Worker orchestration seam; the caller supplies a transaction-scoped repo. */
export async function processAssessmentOutboxJob(
  job: AssessmentOutboxJob,
  repositories: {
    assessment: AssessmentRepository;
    outbox: AssessmentProcessingOutboxRepository;
  },
  now = new Date(),
  assess: typeof runAssessment = runAssessment,
): Promise<"processed" | "released"> {
  try {
    await assess(assessmentInputFromOutboxJob(job), repositories.assessment);
    await repositories.outbox.markProcessed(job.id, job.leaseOwner, now);
    return "processed";
  } catch (error) {
    const message = error instanceof Error ? error.message : "assessment worker failed";
    // 永久性失败（4xx：artifact/episode 不存在、归属失配等）重试不可能成功，
    // 按 30 天软死信退避，避免无限高频重试占用 claim 循环且把错误细节反复落库；
    // 5xx/网络/provider 类错误仍按 attempts 递增退避。
    const isPermanent = error instanceof AssessmentServiceError
      && error.statusCode >= 400 && error.statusCode < 500;
    const backoffMs = isPermanent
      ? 30 * 24 * 60 * 60 * 1000
      : Math.min(60_000, Math.max(1_000, job.attempts * 2_000));
    await repositories.outbox.release(
      job.id,
      job.leaseOwner,
      new Date(now.getTime() + backoffMs),
      message,
    );
    return "released";
  }
}
