/**
 * CommitPort PG 实现（COMMIT 锁序与 CAS 快照）。
 *
 * 实现 commitEpisode 的幂等根基（security_review MEDIUM #1 与
 * "重试/断线/crash 不重复副作用"的兜底）：
 * - getCommitKey / setCommitKey：learning_episodes.commit_key（唯一索引
 *   learning_episodes_commit_key_unique_idx 已建）——同事务原子写，
 *   冲突抛错 → 整体回滚，重试绝不重复 result/schedule 副作用；
 * - lockSteps / loadCommitGuard：固定锁序 + CAS 快照读取。
 *
 * operational_only / practice / diagnostic 事件分别落入既有审计表或专用
 * Session 事件表；它们不冒充 canonical fact。facet observation 仍在缺少
 * submission/rubric FK 映射时 fail closed，避免错误拼接 validation 真相。
 */

import { sql } from "drizzle-orm";
import type {
  CommitGuardSnapshot,
  CommitLockStep,
  CommitPort,
  OperationalOnlyWriteInput,
  ScheduleSideEffectInput,
  ScheduleSideEffectResult,
  PracticeEventWriteInput,
  FacetObservationWriteInput,
} from "./episode-commit.ts";
import type {
  CanonicalEventAppendInput,
  CanonicalEventAppendResult,
} from "./canonical-events.ts";
import {
  appendCanonicalEvent,
  pgCanonicalEventStore,
} from "./canonical-events.ts";
import type { ApiTransaction } from "../../db/client.ts";

export interface CommitPortTx {
  execute(query: unknown): Promise<unknown>;
}

export interface WorkspaceUserScope {
  workspaceId: string;
  userId: string;
}

export class CommitPortNotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} 尚未接入生产写端口（诚实 fail closed，不假写）`);
    this.name = "CommitPortNotImplementedError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    // postgres.js/drizzle execute 路径对 jsonb 有时返回原始字符串——
    // 防御性解析（失败回退空对象，fail closed）。
    try {
      const parsed = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fallthrough
    }
    return {};
  }
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function requireDrizzleTransaction(transaction: CommitPortTx, method: string): ApiTransaction {
  const candidate = transaction as CommitPortTx & {
    select?: unknown;
    insert?: unknown;
    update?: unknown;
  };
  if (
    typeof candidate.select !== "function"
    || typeof candidate.insert !== "function"
    || typeof candidate.update !== "function"
  ) {
    throw new CommitPortNotImplementedError(`${method}（需要 ApiTransaction）`);
  }
  return transaction as ApiTransaction;
}

async function activeScheduleCount(
  transaction: CommitPortTx,
  scope: WorkspaceUserScope,
  keyPointId: string,
): Promise<number> {
  const rows = (await transaction.execute(
    sql`
      SELECT count(*)::int AS "count"
      FROM review_schedules
      WHERE workspace_id = ${scope.workspaceId}
        AND user_id = ${scope.userId}
        AND key_point_id = ${keyPointId}
        AND status = 'pending'
    `,
  )) as Array<Record<string, unknown>>;
  return Number(rows[0]?.count ?? 0);
}

/**
 * PG CommitPort：锁序、CAS 快照与 commit key 的真实 PostgreSQL 实现。
 * 尚未接入生产写端口的方法继续 fail closed（抛 CommitPortNotImplementedError），
 * 不制造假 canonical/schedule 写入。
 */
export function createPgCommitPort(transaction: CommitPortTx): CommitPort {
  return {
    async lockSteps(steps: readonly CommitLockStep[], scope: WorkspaceUserScope, episodeId: string) {
      // 这些查询必须保持与 COMMIT_LOCK_ORDER 相同的调用顺序。runtime_control
      // 当前与 Episode runtime epoch 共存于同一行；等独立 runtime-control
      // 表落地时只替换该分支，不改变外部锁序合同。
      for (const step of steps) {
        switch (step) {
          case "runtime_control":
          case "learning_episode":
            await transaction.execute(
              sql`
                SELECT id FROM learning_episodes
                WHERE id = ${episodeId}
                  AND workspace_id = ${scope.workspaceId}
                  AND user_id = ${scope.userId}
                FOR UPDATE
              `,
            );
            break;
          case "authoritative_target_guard":
            await transaction.execute(
              sql`
                SELECT kp.id
                FROM card_key_points kp
                JOIN learning_episodes e ON e.key_point_id = kp.id
                WHERE e.id = ${episodeId}
                  AND e.workspace_id = ${scope.workspaceId}
                  AND e.user_id = ${scope.userId}
                FOR UPDATE
              `,
            );
            break;
          case "keypoint_schedule_guard":
            await transaction.execute(
              sql`
                SELECT rs.id
                FROM review_schedules rs
                JOIN learning_episodes e ON e.key_point_id = rs.key_point_id
                WHERE e.id = ${episodeId}
                  AND rs.workspace_id = ${scope.workspaceId}
                  AND rs.user_id = ${scope.userId}
                  AND rs.status = 'pending'
                FOR UPDATE
              `,
            );
            break;
          case "input_schedule":
            await transaction.execute(
              sql`
                SELECT rs.id
                FROM review_schedules rs
                JOIN learning_episodes e
                  ON e.scheduling_decision ->> 'inputScheduleId' = rs.id::text
                WHERE e.id = ${episodeId}
                  AND rs.workspace_id = ${scope.workspaceId}
                  AND rs.user_id = ${scope.userId}
                FOR UPDATE
              `,
            );
            break;
        }
      }
    },

    async loadCommitGuard(scope: WorkspaceUserScope, episodeId: string): Promise<CommitGuardSnapshot> {
      const rows = (await transaction.execute(
        sql`
          SELECT episode_epoch AS "episodeEpoch", status,
                 runtime_epoch_snapshot AS "runtimeEpochSnapshot",
                 episode_target_fingerprint AS "contentFingerprint",
                 scheduling_decision AS "schedulingDecision",
                 commit_key AS "commitKey"
          FROM learning_episodes
          WHERE id = ${episodeId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const row = rows[0];
      if (!row) {
        throw new Error(`loadCommitGuard: episode ${episodeId} 不存在（workspace 内）`);
      }
      const schedulingDecision = asRecord(row.schedulingDecision);
      const inputScheduleId = asString(schedulingDecision.inputScheduleId);

      const pendingRows = (await transaction.execute(
        sql`
          SELECT rs.id
          FROM review_schedules rs
          WHERE rs.workspace_id = ${scope.workspaceId}
            AND rs.user_id = ${scope.userId}
            AND rs.key_point_id = (SELECT key_point_id FROM learning_episodes WHERE id = ${episodeId})
            AND rs.status = 'pending'
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;

      let inputScheduleActive = false;
      let currentInputScheduleGeneration: number | null = null;
      if (inputScheduleId) {
        const inputRows = (await transaction.execute(
          sql`
            SELECT status, generation
            FROM review_schedules
            WHERE id = ${inputScheduleId}
              AND workspace_id = ${scope.workspaceId}
              AND user_id = ${scope.userId}
            LIMIT 1
          `,
        )) as Array<Record<string, unknown>>;
        const inputSchedule = inputRows[0];
        inputScheduleActive = String(inputSchedule?.status ?? "") === "pending";
        currentInputScheduleGeneration = inputSchedule
          ? Number(inputSchedule.generation ?? 0)
          : null;
      }

      return {
        // runtime-control 独立表尚未存在；当前唯一持久化的 runtime epoch 是
        // PREPARE 写入 Episode 的快照。使用同一真实列，避免旧实现硬编码 0
        // 导致所有非 0 epoch 在 COMMIT 时被错误阻断。
        currentRuntimeEpoch: Number(row.runtimeEpochSnapshot ?? 0),
        currentEpisodeEpoch: Number(row.episodeEpoch ?? 0),
        episodeStatus: String(row.status ?? "active") as CommitGuardSnapshot["episodeStatus"],
        currentContentRevision: null,
        currentContentFingerprint: String(row.contentFingerprint ?? ""),
        currentSchedulingDecisionHash: asString(schedulingDecision.decisionHash) ?? "",
        kill: false,
        activePendingScheduleExists: pendingRows.length > 0,
        inputScheduleActive,
        currentInputScheduleGeneration,
      };
    },

    async writeOperationalOnly(input: OperationalOnlyWriteInput) {
      // operational_only is intentionally a low-sensitivity audit row, not a
      // canonical learning fact. companion_audit already has the required RLS,
      // TTL and opaque-entity contract, so COMMIT does not create a parallel
      // mastery/event table for blocked or stale results.
      await transaction.execute(
        sql`
          INSERT INTO companion_audit (
            workspace_id, user_id, page_action_type,
            page_opaque_id, action_opaque_id, entity_opaque_ids,
            context_permission_hashes, policy_version, result, created_at
          ) VALUES (
            ${input.workspaceId}, ${input.userId}, 'runtime_fence',
            'learning_session', 'episode_commit',
            ARRAY[${input.episodeId}, ${input.keyPointId}]::text[],
            ${JSON.stringify({
              attribution: input.attribution,
              casFailures: input.casFailures,
              reasonCodes: input.reasonCodes,
            })},
            'episode-commit-v1', ${input.attribution}, ${input.now.toISOString()}
          )
        `,
      );
    },
    async appendCanonicalEvent(input: CanonicalEventAppendInput): Promise<CanonicalEventAppendResult> {
      // Reuse the already audited canonical-event store instead of creating a
      // second SQL writer here. It writes the existing validation/review/
      // understanding fact and learning_outbox_events in this same transaction.
      const drizzleTransaction = requireDrizzleTransaction(transaction, "appendCanonicalEvent");
      return appendCanonicalEvent(pgCanonicalEventStore(drizzleTransaction), input);
    },
    async applyScheduleSideEffect(input: ScheduleSideEffectInput): Promise<ScheduleSideEffectResult> {
      if (input.authorizedAction !== "create_initial" && input.authorizedAction !== "consume_pending") {
        return {
          scheduleId: null,
          activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
          idempotent: true,
        };
      }

      // A retry after the successor was written must be a read-only replay. The
      // supersedes edge is the schedule-side idempotency boundary; commit_key
      // remains the Episode-side boundary.
      if (input.supersedesScheduleId) {
        const successorRows = (await transaction.execute(
          sql`
            SELECT id
            FROM review_schedules
            WHERE workspace_id = ${input.workspaceId}
              AND user_id = ${input.userId}
              AND supersedes_schedule_id = ${input.supersedesScheduleId}
              AND status = 'pending'
            LIMIT 1
          `,
        )) as Array<Record<string, unknown>>;
        const successor = successorRows[0];
        if (successor) {
          return {
            scheduleId: String(successor.id),
            activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
            idempotent: true,
          };
        }
      }

      if (input.authorizedAction === "create_initial") {
        const existingRows = (await transaction.execute(
          sql`
            SELECT id
            FROM review_schedules
            WHERE workspace_id = ${input.workspaceId}
              AND user_id = ${input.userId}
              AND key_point_id = ${input.keyPointId}
              AND status = 'pending'
            LIMIT 1
          `,
        )) as Array<Record<string, unknown>>;
        const existing = existingRows[0];
        if (existing) {
          return {
            scheduleId: String(existing.id),
            activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
            idempotent: true,
          };
        }

        const insertedRows = (await transaction.execute(
          sql`
            INSERT INTO review_schedules (
              workspace_id, user_id, subject_type, subject_id,
              validation_event_id, status, next_review_at, interval_days,
              key_point_id, generation, policy_version, reason_code,
              supersedes_schedule_id, updated_at
            ) VALUES (
              ${input.workspaceId}, ${input.userId}, 'key_point', ${input.keyPointId},
              ${input.validationEventId ?? null}, 'pending', ${input.nextReviewAt.toISOString()}, ${input.intervalDays},
              ${input.keyPointId}, 0, ${input.policyVersion}, ${input.reasonCode},
              NULL, ${input.now.toISOString()}
            )
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
        )) as Array<Record<string, unknown>>;
        if (insertedRows[0]) {
          return {
            scheduleId: String(insertedRows[0].id),
            activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
            idempotent: false,
          };
        }

        const racedRows = (await transaction.execute(
          sql`
            SELECT id
            FROM review_schedules
            WHERE workspace_id = ${input.workspaceId}
              AND user_id = ${input.userId}
              AND key_point_id = ${input.keyPointId}
              AND status = 'pending'
            LIMIT 1
          `,
        )) as Array<Record<string, unknown>>;
        if (!racedRows[0]) throw new Error("applyScheduleSideEffect: pending schedule insert raced without a winner");
        return {
          scheduleId: String(racedRows[0].id),
          activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
          idempotent: true,
        };
      }

      if (!input.inputScheduleId) {
        throw new Error("applyScheduleSideEffect: consume_pending 缺少 inputScheduleId");
      }
      const completedRows = (await transaction.execute(
        sql`
          UPDATE review_schedules
          SET status = 'completed', last_review_at = ${input.now.toISOString()}, updated_at = ${input.now.toISOString()}
          WHERE id = ${input.inputScheduleId}
            AND workspace_id = ${input.workspaceId}
            AND user_id = ${input.userId}
            AND status = 'pending'
          RETURNING generation
        `,
      )) as Array<Record<string, unknown>>;
      if (!completedRows[0]) {
        throw new Error("applyScheduleSideEffect: input schedule 不存在、越权或已消费");
      }
      const successorGeneration = Number(completedRows[0].generation ?? input.inputScheduleGeneration ?? 0) + 1;
      const successorRows = (await transaction.execute(
        sql`
          INSERT INTO review_schedules (
            workspace_id, user_id, subject_type, subject_id,
            validation_event_id, status, next_review_at, interval_days,
            key_point_id, generation, policy_version, reason_code,
            supersedes_schedule_id, updated_at
          ) VALUES (
            ${input.workspaceId}, ${input.userId}, 'key_point', ${input.keyPointId},
            ${input.validationEventId ?? null}, 'pending', ${input.nextReviewAt.toISOString()}, ${input.intervalDays},
            ${input.keyPointId}, ${successorGeneration}, ${input.policyVersion}, ${input.reasonCode},
            ${input.inputScheduleId}, ${input.now.toISOString()}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
      )) as Array<Record<string, unknown>>;
      if (!successorRows[0]) {
        const replayRows = (await transaction.execute(
          sql`
            SELECT id
            FROM review_schedules
            WHERE workspace_id = ${input.workspaceId}
              AND user_id = ${input.userId}
              AND supersedes_schedule_id = ${input.inputScheduleId}
              AND status = 'pending'
            LIMIT 1
          `,
        )) as Array<Record<string, unknown>>;
        if (!replayRows[0]) throw new Error("applyScheduleSideEffect: successor schedule insert raced without a winner");
        return {
          scheduleId: String(replayRows[0].id),
          activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
          idempotent: true,
        };
      }
      return {
        scheduleId: String(successorRows[0].id),
        activeScheduleCount: await activeScheduleCount(transaction, input, input.keyPointId),
        idempotent: false,
      };
    },
    async writePracticeEvent(_input: PracticeEventWriteInput) {
      const input = _input;
      const allowedSummaryKeys = new Set(["disposition", "sourceFingerprint", "commitKey"]);
      const safeSummary: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.summary)) {
        if (!allowedSummaryKeys.has(key)) continue;
        if (typeof value !== "string" || value.length > 256) {
          throw new Error(`writePracticeEvent: summary.${key} 非法`);
        }
        safeSummary[key] = value;
      }
      const idempotencyKey = safeSummary.commitKey ?? `${input.episodeId}:${input.eventType}`;
      const insertedRows = (await transaction.execute(
        sql`
          INSERT INTO learning_session_practice_events (
            workspace_id, user_id, session_id, episode_id, key_point_id,
            event_type, idempotency_key, summary
          )
          SELECT
            ${input.workspaceId}, ${input.userId}, e.session_id, e.id, ${input.keyPointId},
            ${input.eventType}, ${idempotencyKey}, ${JSON.stringify(safeSummary)}
          FROM learning_episodes e
          WHERE e.id = ${input.episodeId}
            AND e.workspace_id = ${input.workspaceId}
            AND e.user_id = ${input.userId}
            AND e.key_point_id = ${input.keyPointId}
          ON CONFLICT (workspace_id, user_id, episode_id, idempotency_key) DO NOTHING
          RETURNING id
        `,
      )) as Array<Record<string, unknown>>;
      if (insertedRows[0]) return;

      const existingRows = (await transaction.execute(
        sql`
          SELECT id
          FROM learning_session_practice_events
          WHERE workspace_id = ${input.workspaceId}
            AND user_id = ${input.userId}
            AND episode_id = ${input.episodeId}
            AND idempotency_key = ${idempotencyKey}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      if (existingRows[0]) return;
      throw new Error("writePracticeEvent: episode/key point 不存在或不属于当前 scope");
    },
    async writeFacetObservation(_input: FacetObservationWriteInput) {
      throw new CommitPortNotImplementedError("writeFacetObservation");
    },

    async getCommitKey(scope: WorkspaceUserScope, episodeId: string): Promise<string | null> {
      const rows = (await transaction.execute(
        sql`
          SELECT commit_key AS "commitKey" FROM learning_episodes
          WHERE id = ${episodeId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          LIMIT 1
        `,
      )) as Array<Record<string, unknown>>;
      const key = rows[0]?.commitKey;
      return key == null ? null : String(key);
    },

    async setCommitKey(scope: WorkspaceUserScope, episodeId: string, commitKey: string) {
      // 唯一索引 learning_episodes_commit_key_unique_idx 兜底：
      // 冲突（已存在 commitKey）→ 抛错 → 整体回滚，重试不重复副作用。
      // 用 RETURNING id 判断影响行数（postgres-js 结果无 rowCount，
      // 只有 count/rows；无 RETURNING 的 UPDATE 返回空数组无法校验）。
      const rows = await transaction.execute(
        sql`
          UPDATE learning_episodes
          SET commit_key = ${commitKey}, updated_at = now()
          WHERE id = ${episodeId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          RETURNING id
        `,
      );
      // 校验影响行数：episode 不存在/越权时 UPDATE 0 行，绝不能静默成功
      // （否则副作用照写而 commit_key 未落，产生不可重放的状态）。
      const affected = Array.isArray(rows) ? rows.length : 1; // 非数组实现默认视为成功
      if (affected === 0) {
        throw new Error(`setCommitKey: episode ${episodeId} 不存在或不属于当前 scope`);
      }
    },
  };
}
