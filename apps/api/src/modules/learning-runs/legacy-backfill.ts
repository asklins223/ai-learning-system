/**
 * E17：旧多 Episode Session 迁移 backfill（文档 16 §16.3）。
 *
 * 一个旧 Session 按 Episode 拆 Run：每个新 Run 保存 legacySessionId/
 * legacyEpisodeId/legacyOrdinal（历史页可按 group 还原旧顺序；ordinal 按
 * 同 Session 内 createdAt 递增编号）。语义：
 * - active Episode → active Run（保留 phase）；paused 由旧状态推导；
 * - 已完成 Episode → completed Run（result=null fail closed：不补造成功
 *   结果，由旧 validation/review 事实另行对账）；
 * - 旧 stale → stale Run（target_fingerprint_changed）；
 * - 旧 cancelled → cancelled Run（runtime_cancelled）；
 * - 不可解释状态（draft 等）→ 跳过并计数（对账报告）。
 * backfill 幂等（legacyEpisodeId 已迁移则跳过，0133 部分唯一索引兜底）并
 * 输出对账报告。入口：apps/api/src/scripts/backfill-legacy-sessions.ts。
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { learningRuns } from "../../db/schema/learning-runs.ts";
import { learningSessions, learningEpisodes } from "../../db/schema/learning-sessions.ts";
import type { LearningSessionOriginRef } from "../../db/schema/learning-sessions.ts";
import type { LearningRunOriginV1 } from "@ailearn/shared";
import { canonicalLearningEventOutbox } from "../../db/schema/learning-runs.ts";

export interface BackfillReport {
  migrated: number;
  skippedExisting: number;
  skippedNoTarget: number;
  /** status 不可解释（draft 等非终态未知状态）而跳过。 */
  skippedUnknown: number;
  orphanEpisodes: number;
}

/**
 * 旧 LearningSessionOriginRef → 新 LearningRunOriginV1 投影（§16.3）。
 * 旧 {type,id} 与 01-2 事实不携带 scheduleGeneration——review 缺位时写 0
 * （旧栈删除前该字段仅审计用；key_point/question_suggestion → star_map）。
 */
export function projectLegacyOrigin(
  originRef: LearningSessionOriginRef | null | undefined,
  keyPointId: string,
): LearningRunOriginV1 {
  const ref = originRef as { type?: string; id?: string } | null | undefined;
  switch (ref?.type) {
    case "card":
      return { kind: "card", cardId: ref.id ?? "", keyPointId: keyPointId || "" };
    case "review_schedule":
      return { kind: "review", scheduleId: ref.id ?? "", keyPointId, scheduleGeneration: 0 };
    case "key_point":
    case "question_suggestion":
    default:
      // 旧栈无 star_map 所需 lens/filter/baselineCheckpoint 数据——降级为
      // today（字段完整，仅审计用；旧栈删除后不再产生此类投影）。
      return { kind: "today", keyPointId };
  }
}

interface LegacyEpisodeRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  userId: string;
  keyPointId: string;
  status: string;
  processingPhase: string;
  origin: string;
  originRef: unknown;
  intent: string;
  createdAt: Date;
}

/** 确定性投影旧 Episode → 新 Run 行（不含 id）。 */
export function projectEpisodeToRun(episode: LegacyEpisodeRow): {
  phase: string;
  result: unknown | null;
  terminalReasonCode: string | null;
} | null {
  switch (episode.status) {
    case "active": {
      const phase = episode.processingPhase === "awaiting_response"
        ? "active"
        : "assessing";
      return { phase, result: null, terminalReasonCode: null };
    }
    case "completed": {
      // completed 投影（result=null fail closed：不补造成功结果，旧 canonical
      // 事实由 validation/review 对账另行核对）。
      return { phase: "completed", result: null, terminalReasonCode: null };
    }
    case "stale":
      return { phase: "stale", result: null, terminalReasonCode: "target_fingerprint_changed" };
    case "cancelled":
      return { phase: "cancelled", result: null, terminalReasonCode: "runtime_cancelled" };
    default:
      return null;
  }
}

/**
 * 单次 backfill（在 withWorkspaceTransaction 内调用；幂等）。
 * 只处理"有 canonical 事实或非终态"的 Episode；不可解释的 Episode 跳过
 * 并计数（对账报告）。
 */
export async function backfillLegacySessionsToRuns(
  tx: ApiTransaction,
  workspaceId: string,
  now: Date = new Date(),
): Promise<BackfillReport> {
  const report: BackfillReport = {
    migrated: 0,
    skippedExisting: 0,
    skippedNoTarget: 0,
    skippedUnknown: 0,
    orphanEpisodes: 0,
  };

  const episodes = await tx
    .select({
      id: learningEpisodes.id,
      sessionId: learningEpisodes.sessionId,
      workspaceId: learningEpisodes.workspaceId,
      userId: learningEpisodes.userId,
      keyPointId: learningEpisodes.keyPointId,
      status: learningEpisodes.status,
      processingPhase: learningEpisodes.processingPhase,
      origin: learningEpisodes.origin,
      originRef: learningEpisodes.originRef,
      intent: learningEpisodes.intent,
      createdAt: learningEpisodes.createdAt,
    })
    .from(learningEpisodes)
    .where(eq(learningEpisodes.workspaceId, workspaceId))
    .orderBy(learningEpisodes.createdAt, learningEpisodes.id);

  // §16.3：同 Session 多 Episode 按 createdAt（+id 次排序键）递增编号
  // legacyOrdinal（历史页按 group 还原旧顺序）。per-episode 序号 map。
  const ordinalByEpisode = new Map<string, number>();
  let currentSessionId: string | null = null;
  let currentOrdinal = 0;
  for (const episode of episodes) {
    if (episode.sessionId !== currentSessionId) {
      currentSessionId = episode.sessionId;
      currentOrdinal = 0;
    }
    currentOrdinal += 1;
    ordinalByEpisode.set(episode.id, currentOrdinal);
  }

  // 预加载已迁移的 legacyEpisodeId 集合，避免逐 episode 的存在性查询（N+1）。
  // 幂等仍由 DB 部分唯一索引最终兜底。
  const migratedEpisodeIds = new Set<string>();
  if (episodes.length > 0) {
    const migratedRows = await tx
      .select({ legacyEpisodeId: learningRuns.legacyEpisodeId })
      .from(learningRuns)
      .where(and(
        eq(learningRuns.workspaceId, workspaceId),
        inArray(
          learningRuns.legacyEpisodeId,
          episodes.map((e) => e.id),
        ),
      ));
    for (const r of migratedRows) {
      if (r.legacyEpisodeId !== null) migratedEpisodeIds.add(r.legacyEpisodeId);
    }
  }

  for (const episode of episodes) {
    // 幂等：已迁移（legacyEpisodeId 存在）跳过。
    if (migratedEpisodeIds.has(episode.id)) {
      report.skippedExisting += 1;
      continue;
    }
    if (!episode.keyPointId) {
      report.skippedNoTarget += 1;
      continue;
    }

    const projected = projectEpisodeToRun(episode as LegacyEpisodeRow);
    if (!projected) {
      report.skippedUnknown += 1;
      continue;
    }

    // 该 Episode 是否有 canonical fact（validation event / review attempt 投影为
    // envelope 的来源检查：保守——completed 无 canonical 证据时也迁移但 result=null）。
    await tx.insert(learningRuns).values({
      workspaceId: episode.workspaceId,
      userId: episode.userId,
      origin: projectLegacyOrigin(
        episode.originRef as LearningSessionOriginRef | null,
        episode.keyPointId,
      ),
      returnTarget: { kind: "today" } as never,
      keyPointId: episode.keyPointId,
      targetFingerprint: `legacy:${episode.id}`,
      goal: (episode.intent ?? "stabilize") as never,
      phase: projected.phase as never,
      timeBudgetSeconds: 180,
      plannedActiveSeconds: 180,
      result: projected.result as never,
      terminalReasonCode: projected.terminalReasonCode,
      legacySessionId: episode.sessionId,
      legacyEpisodeId: episode.id,
      legacyOrdinal: ordinalByEpisode.get(episode.id) ?? 1,
      createdAt: episode.createdAt,
      updatedAt: now,
    });
    report.migrated += 1;
  }

  // 孤儿引用对账：episode 的 session 已不存在（含 session 被删除的情形）。
  const sessions = await tx
    .select({ id: learningSessions.id, status: learningSessions.status })
    .from(learningSessions)
    .where(eq(learningSessions.workspaceId, workspaceId));
  const sessionIds = new Set(sessions.map((s) => s.id));
  for (const episode of episodes) {
    if (!sessionIds.has(episode.sessionId)) report.orphanEpisodes += 1;
  }

  return report;
}

/** 对账：已迁移 Run 与旧 Episode 的 canonical event 一致性（抽样断言）。 */
export async function verifyLegacyRunReconciliation(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<{ migratedRuns: number; canonicalEnvelopes: number }> {
  // PERF-A#15：改用 SQL count(*) 聚合，避免把全部 Run/envelope 行物化进内存
  // （大 workspace 下 unbounded）。语义不变（与原来的 .length 等价）。
  const [runsRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, workspaceId),
      inArray(learningRuns.legacyEpisodeId, tx
        .select({ id: learningEpisodes.id })
        .from(learningEpisodes)
        .where(eq(learningEpisodes.workspaceId, workspaceId))),
    ));
  const [envelopesRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(canonicalLearningEventOutbox)
    .where(eq(canonicalLearningEventOutbox.workspaceId, workspaceId));
  return {
    migratedRuns: Number(runsRow?.count ?? 0),
    canonicalEnvelopes: Number(envelopesRow?.count ?? 0),
  };
}



