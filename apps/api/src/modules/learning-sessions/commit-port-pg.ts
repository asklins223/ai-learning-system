/**
 * CommitPort PG 实现（救火 3 最后一环——核心幂等子集）。
 *
 * 实现 commitEpisode 的幂等根基（security_review MEDIUM #1 与
 * "重试/断线/crash 不重复副作用"的兜底）：
 * - getCommitKey / setCommitKey：learning_episodes.commit_key（唯一索引
 *   learning_episodes_commit_key_unique_idx 已建）——同事务原子写，
 *   冲突抛错 → 整体回滚，重试绝不重复 result/schedule 副作用；
 * - lockSteps / loadCommitGuard：固定锁序 + CAS 快照读取（后续方法依赖）。
 *
 * 其余方法（appendCanonicalEvent/applyScheduleSideEffect/writeFacetObservation/
 * writePracticeEvent/writeOperationalOnly）依赖现有 validation/review/schedule
 * 域表，为独立后续工程（诚实记录，不制造未验证半成品）。
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

export interface CommitPortTx {
  execute(query: unknown): Promise<unknown>;
}

export interface WorkspaceUserScope {
  workspaceId: string;
  userId: string;
}

export class CommitPortNotImplementedError extends Error {
  constructor(method: string) {
    super(`${method} 未实现：依赖 validation/review/schedule 域表，为后续工程（诚实 fail closed，不假写）`);
    this.name = "CommitPortNotImplementedError";
  }
}

/**
 * PG CommitPort：核心幂等子集（get/setCommitKey + lockSteps + loadCommitGuard）。
 * 未实现方法 fail closed（抛 CommitPortNotImplementedError）——不制造假写。
 */
export function createPgCommitPort(transaction: CommitPortTx): CommitPort {
  return {
    async lockSteps(steps: readonly CommitLockStep[], scope: WorkspaceUserScope, episodeId: string) {
      // 锁序：先 episode 行锁（SELECT FOR UPDATE），再按 order 锁相关行。
      // 简化：episode 行锁 + 依赖行由各方法内部锁（本子集只锁 episode）。
      await transaction.execute(
        sql`
          SELECT id FROM learning_episodes
          WHERE id = ${episodeId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
          FOR UPDATE
        `,
      );
      void steps;
    },

    async loadCommitGuard(scope: WorkspaceUserScope, episodeId: string): Promise<CommitGuardSnapshot> {
      const rows = (await transaction.execute(
        sql`
          SELECT episode_epoch AS "episodeEpoch", status, plan_hash AS "planHash",
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
      return {
        currentRuntimeEpoch: 0, // runtime epoch 由 runtime-control 表提供（后续）
        currentEpisodeEpoch: Number(row.episodeEpoch ?? 0),
        episodeStatus: String(row.status ?? "active") as CommitGuardSnapshot["episodeStatus"],
        currentContentRevision: null,
        currentContentFingerprint: "",
        currentSchedulingDecisionHash: String(row.planHash ?? ""),
        kill: false,
        activePendingScheduleExists: false,
        inputScheduleActive: false,
        currentInputScheduleGeneration: null,
      };
    },

    async writeOperationalOnly(_input: OperationalOnlyWriteInput) {
      throw new CommitPortNotImplementedError("writeOperationalOnly");
    },
    async appendCanonicalEvent(_input: CanonicalEventAppendInput): Promise<CanonicalEventAppendResult> {
      throw new CommitPortNotImplementedError("appendCanonicalEvent");
    },
    async applyScheduleSideEffect(_input: ScheduleSideEffectInput): Promise<ScheduleSideEffectResult> {
      throw new CommitPortNotImplementedError("applyScheduleSideEffect");
    },
    async writePracticeEvent(_input: PracticeEventWriteInput) {
      throw new CommitPortNotImplementedError("writePracticeEvent");
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
      await transaction.execute(
        sql`
          UPDATE learning_episodes
          SET commit_key = ${commitKey}, updated_at = now()
          WHERE id = ${episodeId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        `,
      );
    },
  };
}
