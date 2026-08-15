/**
 * Projection 物化服务（文档 16 §15.1/§15.5 P7 最小实现）。
 *
 * Projector 在应用 source event 的同一幂等事务中物化 immutable change set：
 * - canonical envelope 应用 → understanding_change_sets(kind=canonical) +
 *   新 checkpoint（watermark 前移）+ outbox status=published；
 * - practice trail 应用 → change set(kind=practice_only) + 新 checkpoint。
 *
 * changeSetId 由 (runId, sourceEventId, fromHash, toHash) 确定性派生；重复
 * 请求返回同一对象（表唯一约束兜底）。changedNodes 只表示本 event 的直接
 * 效果（event-local 摘要），不是完整图补丁；客户端不得自行 diff 图 JSON。
 */

import { and, desc, eq } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  understandingChangeSets,
  understandingProjectionCheckpoints,
} from "../../db/schema/understanding-projection.ts";
import { canonicalLearningEventOutbox, practiceTrailEventOutbox } from "../../db/schema/learning-runs.ts";
import type { CanonicalLearningEventEnvelopeV1 } from "@ailearn/shared";
import { issueCheckpointToken, parseCheckpointToken } from "./projection-checkpoint.ts";
import { sha256Hex } from "../learning-runs/run-planner.ts";

export interface ProjectionScope {
  workspaceId: string;
  userId: string;
}

/** 当前 watermark（最近 checkpoint；无历史 → null watermarks）。 */
async function currentWatermark(
  executor: ApiTransaction,
  scope: ProjectionScope,
): Promise<{ canonical: string | null; practice: string | null; token: string | null }> {
  const rows = await executor
    .select()
    .from(understandingProjectionCheckpoints)
    .where(and(
      eq(understandingProjectionCheckpoints.workspaceId, scope.workspaceId),
      eq(understandingProjectionCheckpoints.userId, scope.userId),
    ))
    .orderBy(desc(understandingProjectionCheckpoints.capturedAt))
    .limit(1);
  const row = rows[0];
  return {
    canonical: row?.lastCanonicalEventId ?? null,
    practice: row?.lastPracticeEventId ?? null,
    token: row?.token ?? null,
  };
}

/** 签发新 checkpoint（watermark 前移）。 */
async function issueCheckpoint(
  executor: ApiTransaction,
  scope: ProjectionScope,
  watermark: { canonical: string | null; practice: string | null },
  now: Date,
): Promise<string | null> {
  const token = issueCheckpointToken({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    lastCanonicalEventId: watermark.canonical,
    lastPracticeEventId: watermark.practice,
    capturedAt: now.toISOString(),
  });
  if (!token) return null; // 密钥未配置：checkpoint 不可用（fail closed）。
  await executor.insert(understandingProjectionCheckpoints).values({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    token,
    lastCanonicalEventId: watermark.canonical,
    lastPracticeEventId: watermark.practice,
    capturedAt: now,
    createdAt: now,
  });
  return token;
}

/** canonical envelope 应用（commit 事务内调用；幂等由表唯一约束兜底）。 */
export async function materializeCanonicalChangeSet(
  executor: ApiTransaction,
  scope: ProjectionScope,
  envelope: CanonicalLearningEventEnvelopeV1,
  runId: string,
  now: Date = new Date(),
): Promise<{ changeSetId: string; toCheckpointToken: string | null } | null> {
  const before = await currentWatermark(executor, scope);
  const fromToken = before.token ?? "initial";
  const toToken = await issueCheckpoint(executor, scope, {
    canonical: envelope.canonicalEventId,
    practice: before.practice,
  }, now);
  if (!toToken) return null;

  // event-local 摘要（只描述本 event 直接效果；before 为上一 watermark 摘要）。
  const changedNodes = [{
    keyPointId: envelope.keyPointId,
    factKind: envelope.fact.kind,
    disposition: envelope.fact.disposition,
    taskIds: envelope.taskIds,
    canonicalEventId: envelope.canonicalEventId,
  }];
  const fromHash = sha256Hex(fromToken);
  const toHash = sha256Hex(toToken);
  const changeSetId = `cs:${sha256Hex(`${runId}|${envelope.canonicalEventId}|${fromHash}|${toHash}`).slice(0, 24)}`;

  await executor.insert(understandingChangeSets).values({
    changeSetId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    runId,
    sourceEventId: envelope.canonicalEventId,
    kind: "canonical",
    fromCheckpointToken: fromToken,
    toCheckpointToken: toToken,
    changedNodes: changedNodes as never,
    practiceTrailChanges: [],
    createdAt: now,
  }).onConflictDoNothing();

  await executor.update(canonicalLearningEventOutbox)
    .set({ status: "published", processedAt: now })
    .where(and(
      eq(canonicalLearningEventOutbox.commitId, envelope.commitId),
      eq(canonicalLearningEventOutbox.canonicalEventId, envelope.canonicalEventId),
      eq(canonicalLearningEventOutbox.workspaceId, scope.workspaceId),
      eq(canonicalLearningEventOutbox.userId, scope.userId),
    ));
  return { changeSetId, toCheckpointToken: toToken };
}

/** practice trail 应用（practice 结算事务内调用；仅官方 scope）。 */
export async function materializePracticeChangeSet(
  executor: ApiTransaction,
  scope: ProjectionScope,
  input: {
    runId: string;
    practiceEventId: string;
    keyPointId: string;
    artifactIds: string[];
    trailScope?: "official_user" | "sandbox";
  },
  now: Date = new Date(),
): Promise<{ changeSetId: string; toCheckpointToken: string | null } | null> {
  // §16.4 纵深：sandbox trail 绝不物化进官方 projection（scope 显式过滤）。
  if ((input.trailScope ?? "official_user") !== "official_user") return null;
  const before = await currentWatermark(executor, scope);
  const fromToken = before.token ?? "initial";
  const toToken = await issueCheckpoint(executor, scope, {
    canonical: before.canonical,
    practice: input.practiceEventId,
  }, now);
  if (!toToken) return null;

  const fromHash = sha256Hex(fromToken);
  const toHash = sha256Hex(toToken);
  const changeSetId = `cs:${sha256Hex(`${input.runId}|${input.practiceEventId}|${fromHash}|${toHash}`).slice(0, 24)}`;
  await executor.insert(understandingChangeSets).values({
    changeSetId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    runId: input.runId,
    sourceEventId: input.practiceEventId,
    kind: "practice_only",
    fromCheckpointToken: fromToken,
    toCheckpointToken: toToken,
    changedNodes: [],
    practiceTrailChanges: [{ keyPointId: input.keyPointId, artifactIds: input.artifactIds }],
    createdAt: now,
  }).onConflictDoNothing();

  await executor.update(practiceTrailEventOutbox)
    .set({ status: "published", processedAt: now })
    .where(and(
      eq(practiceTrailEventOutbox.runId, input.runId),
      eq(practiceTrailEventOutbox.practiceEventId, input.practiceEventId),
      eq(practiceTrailEventOutbox.workspaceId, scope.workspaceId),
      eq(practiceTrailEventOutbox.userId, scope.userId),
    ));
  return { changeSetId, toCheckpointToken: toToken };
}

/** checkpoint 是否覆盖某 canonical event（服务端解码判断，客户端不可自行比较）。 */
export async function checkpointCoversCanonicalEvent(
  executor: ApiTransaction,
  scope: ProjectionScope,
  token: string,
  canonicalEventId: string,
): Promise<boolean> {
  const watermark = parseCheckpointToken(token);
  if (!watermark) return false;
  if (watermark.workspaceId !== scope.workspaceId || watermark.userId !== scope.userId) return false;
  // 覆盖判断：该 event 的 outbox 行必须存在且其"序"不晚于 watermark 事件——
  // 简化实现：watermark.canonical === eventId 直接覆盖；否则查 change_sets 中
  // 该 event 的 toCheckpointToken 是否被 watermark 之后（按 created_at 序）。
  if (watermark.lastCanonicalEventId === canonicalEventId) return true;
  const rows = await executor
    .select({ toCheckpointToken: understandingChangeSets.toCheckpointToken, createdAt: understandingChangeSets.createdAt })
    .from(understandingChangeSets)
    .where(and(
      eq(understandingChangeSets.workspaceId, scope.workspaceId),
      eq(understandingChangeSets.userId, scope.userId),
      eq(understandingChangeSets.sourceEventId, canonicalEventId),
    ))
    .limit(1);
  if (rows.length === 0) return false;
  // watermark 事件的 checkpoint 时间晚于该 event 的物化时间 → 已覆盖。
  const watermarkRows = await executor
    .select({ capturedAt: understandingProjectionCheckpoints.capturedAt })
    .from(understandingProjectionCheckpoints)
    .where(eq(understandingProjectionCheckpoints.token, token))
    .limit(1);
  const watermarkAt = watermarkRows[0]?.capturedAt ?? new Date(0);
  return watermarkAt.getTime() >= rows[0].createdAt.getTime();
}
