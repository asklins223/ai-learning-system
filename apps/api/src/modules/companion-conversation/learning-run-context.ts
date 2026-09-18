/**
 * LearningRun 页面给 Companion 的只读上下文。
 *
 * 与旧 learning-session-context 不同，这里把授权边界固定在 Run 的
 * target snapshot 与当前 task 上。Tutor 只能解释 Run PREPARE 时冻结的
 * target/evidence，不能因 Objective 后续编辑而漂移到另一份学习材料。
 */

import { sql } from "drizzle-orm";
import {
  companionLearningRunContextV1Schema,
  type CompanionLearningRunContextV1,
} from "@ailearn/shared";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import type { ApiTransaction } from "../../db/client.ts";

export interface CompanionLearningRunContextRow {
  runId: string;
  snapshotId: string;
  snapshotHash: string;
  contractSnapshotHash: string;
  taskId: string | null;
  phase: string;
  runRevision: number;
  runtimeEpoch: number;
  taskStatus: string | null;
  taskRevision: number | null;
  publishedTargetEligibility: string | null;
}

/**
 * 所有会让 Tutor 目标、任务或执行资格变化的字段均进 revision。调用方回传
 * 旧 revision 时，grant 会在同一事务内失效，而不会将旧证据带入新 Run 状态。
 */
export function contextRevisionForCompanionLearningRun(
  row: CompanionLearningRunContextRow,
): string {
  return sha256Utf8V1(canonicalJsonV1({
    version: 1,
    runId: row.runId,
    snapshotId: row.snapshotId,
    snapshotHash: row.snapshotHash,
    contractSnapshotHash: row.contractSnapshotHash,
    taskId: row.taskId,
    phase: row.phase,
    runRevision: row.runRevision,
    runtimeEpoch: row.runtimeEpoch,
    taskStatus: row.taskStatus,
    taskRevision: row.taskRevision,
    publishedTargetEligibility: row.publishedTargetEligibility,
  }));
}

/** Tutor 仅在尚未提交的当前 task 上可用；任何冻结闭包不完整均拒绝。 */
export function isCompanionLearningRunTutorEligible(
  row: CompanionLearningRunContextRow,
): boolean {
  return row.phase === "active"
    && row.taskId !== null
    && row.taskStatus === "active"
    && row.taskRevision !== null
    && row.snapshotHash === row.contractSnapshotHash
    // 缺失 eligibility 也不能默认允许：历史/损坏 snapshot 必须 fail closed。
    && (row.publishedTargetEligibility === "eligible" || row.publishedTargetEligibility === "practice_only");
}

export async function loadCompanionLearningRunContext(
  tx: Pick<ApiTransaction, "execute">,
  args: { workspaceId: string; userId: string; runId: string },
): Promise<CompanionLearningRunContextRow | null> {
  const rows = await tx.execute<{
    run_id: string;
    snapshot_id: string;
    snapshot_hash: string;
    contract_snapshot_hash: string;
    task_id: string | null;
    phase: string;
    run_revision: number | string;
    runtime_epoch: number | string;
    task_status: string | null;
    task_revision: number | string | null;
    published_target_eligibility: string | null;
  }>(sql`
    SELECT r.id AS run_id,
           c.snapshot_id,
           s.snapshot_hash,
           c.snapshot_hash AS contract_snapshot_hash,
           r.active_task_id AS task_id,
           r.phase,
           r.revision AS run_revision,
           r.runtime_epoch,
           t.status AS task_status,
           t.revision AS task_revision,
           s.published_target_eligibility
    FROM learning_runs r
    JOIN learning_run_private_contracts c
      ON c.run_id = r.id
      AND c.workspace_id = ${args.workspaceId}
      AND c.user_id = ${args.userId}
      AND c.snapshot_id IS NOT NULL
    JOIN learning_target_snapshots_v2 s
      ON s.run_id = r.id
      AND s.snapshot_id = c.snapshot_id
      AND s.workspace_id = ${args.workspaceId}
      AND s.user_id = ${args.userId}
    LEFT JOIN learning_tasks t
      ON t.id = r.active_task_id
      AND t.run_id = r.id
      AND t.workspace_id = ${args.workspaceId}
      AND t.user_id = ${args.userId}
    WHERE r.id = ${args.runId}
      AND r.workspace_id = ${args.workspaceId}
      AND r.user_id = ${args.userId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    runId: row.run_id,
    snapshotId: row.snapshot_id,
    snapshotHash: row.snapshot_hash,
    contractSnapshotHash: row.contract_snapshot_hash,
    taskId: row.task_id,
    phase: row.phase,
    runRevision: Number(row.run_revision),
    runtimeEpoch: Number(row.runtime_epoch),
    taskStatus: row.task_status,
    taskRevision: row.task_revision === null ? null : Number(row.task_revision),
    publishedTargetEligibility: row.published_target_eligibility,
  };
}

export function buildCompanionLearningRunContext(
  row: CompanionLearningRunContextRow,
): CompanionLearningRunContextV1 {
  if (!isCompanionLearningRunTutorEligible(row) || row.taskId === null) {
    throw new Error("learning run is not eligible for grounded tutor");
  }
  return companionLearningRunContextV1Schema.parse({
    version: 1,
    pageKind: "learning_run",
    sharing: "page_registered",
    runId: row.runId,
    snapshotId: row.snapshotId,
    taskId: row.taskId,
    requestedCapability: "none",
    contextRevision: contextRevisionForCompanionLearningRun(row),
    groundedTutorGrant: null,
  });
}
