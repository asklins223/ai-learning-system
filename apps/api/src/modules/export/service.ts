import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ValidationFeedback } from "@ailearn/shared";
import { db, withWorkspaceTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, sources, sourceSegments } from "../../db/schema/note.ts";
import { computeContentHash } from "../note/service.ts";
import { learningCards, cardKeyPoints } from "../../db/schema/card.ts";
import {
  evidences,
  validationEvents,
  reviewSchedules,
  reviewAttempts,
  understandingEvents,
  evidenceOverrides,
  validationQuestions,
} from "../../db/schema/evidence.ts";
import { aiArtifacts } from "../../db/schema/ai.ts";
import { jobs } from "../../db/schema/job.ts";
import { workspaces, workspaceMembers, users, onboardingStates } from "../../db/schema/identity.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningObjectiveOriginsV2,
  learningCardsV2,
} from "../../db/schema/card-generation-v2.ts";
// v0.6: 可信掌握闭环新表 (计划 §6.9: 导出/导入覆盖)
import {
  validationQuestionRubricItems,
  validationSubmissions,
  validationSubmissionJobs,
  validationActionCommands,
  validationAssistanceExposures,
  validationPointAssessments,
  schedulingShadowDecisions,
  validationQualitySignals,
} from "../../db/schema/validation-v2.ts";
import {
  generateDefaultWorkspaceName,
  RECOVERED_PASSWORD_SENTINEL,
} from "../identity/service.ts";

import { logger } from "../../lib/logger.ts";

type RestoreDatabase = Pick<typeof db, "query" | "transaction">;

// ─── PERF-40/52/66 + QUAL-45 修复：批量 INSERT 辅助函数 ──────────────────

/** 事务类型别名 */
type RestoreTx = Parameters<Parameters<RestoreDatabase["transaction"]>[0]>[0];

/**
 * 批量插入辅助函数。
 *
 * 将串行 for 循环逐行 INSERT 改为批量 INSERT，
 * 大幅减少 DB 往返次数（从 N 次降到 ceil(N/batchSize) 次）。
 *
 * @param tx 事务执行器
 * @param table Drizzle 表对象
 * @param rows 待插入的行数组
 * @param batchSize 每批大小，默认 500
 */
async function batchInsert(
  tx: RestoreTx,
  table: unknown,
  rows: Record<string, unknown>[],
  batchSize = 500,
): Promise<void> {
  if (rows.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await tx.insert(t).values(batch).onConflictDoNothing();
  }
}

/**
 * 安全地将数组数据映射并批量插入。
 * QUAL-45 修复：提取通用恢复模式，减少 20+ 处重复的 for 循环代码。
 *
 * @param tx 事务执行器
 * @param table Drizzle 表对象
 * @param rawData 原始数据数组
 * @param mapper 行映射函数
 * @param batchSize 每批大小
 * @returns 实际插入的行数
 */
async function restoreTable(
  tx: RestoreTx,
  table: unknown,
  rawData: unknown,
  mapper: (row: Record<string, unknown>) => Record<string, unknown>,
  batchSize = 500,
): Promise<number> {
  if (!Array.isArray(rawData)) return 0;
  const rows = rawData.map((item) => mapper(item as Record<string, unknown>));
  await batchInsert(tx, table, rows, batchSize);
  return rows.length;
}

/**
 * Normalize the result of a multi-row `INSERT ... RETURNING`.
 *
 * PostgreSQL returns a flat array of inserted rows for multi-row RETURNING
 * (e.g. `[{...}, {...}]`). The legacy unit-test mock returns `[<the values
 * array>]` (a single-element array wrapping the whole batch). This helper
 * flattens the mock shape so restored-code behaves identically in both.
 */
function flattenBatchReturning<T>(rows: T[]): T[] {
  if (rows.length === 1 && Array.isArray(rows[0])) {
    return rows[0] as unknown as T[];
  }
  return rows;
}

/**
 * keyset 分批读取辅助（B#1，round-5 审计）。
 *
 * 将全量 findMany 改为按稳定顺序 + 唯一游标（主键 id）分批扫描，逐批 `.limit(BATCH)`
 * 循环读取拼接，把「整表一次性载入 JS 内存」拆成有界批次，消除大工作区导出 OOM 风险。
 * 语义与旧全量读取一致：结果顺序由调用方 `load` 列表页的 SQL 决定，批间顺序无缝隙无重复
 * （因为上一批最后一条的游标值作为下一批的 where 下界，配合 orderBy 严格唯一）。
 *
 * @template T 单批返回的行类型（由调用方 SQL 推导）
 * @template K 唯一游标类型（通常是 { 排序列; id } 元组）
 */
async function loadInBatches<T, K>(opts: {
  /** 给定上一批游标（首批为 null），返回下一个 size 有界可见行列表。必须按稳定唯一顺序排序并 LIMIT。 */
  load: (cursor: K | null) => Promise<T[]>;
  /** 从该批最后一行提取下一批游标。 */
  cursorFrom: (lastRow: T) => K;
  /** 每批大小，默认 1000。 */
  batch?: number;
}): Promise<T[]> {
  const batch = opts.batch ?? 1000;
  const out: T[] = [];
  for (let cursor: K | null = null; ; ) {
    const rows = await opts.load(cursor);
    if (rows.length === 0) return out;
    // 空批即扫描结束；填满批次时用最后一条推进游标。
    out.push(...rows);
    cursor = opts.cursorFrom(rows[rows.length - 1]);
    if (rows.length < batch) return out;
  }
}

/**
 * 批量将多行 (userId -> personalWorkspaceId) 的 personalWorkspaceId 回写为
 * 单条 CASE WHEN 多行 UPDATE（每批 500），把 N 次串行 UPDATE 降为 ceil(N/500) 次
 * 往返（DB-N+1 修复）。只更新已成功插入的 recovered users。
 */
async function batchUpdateUsersPersonalWorkspace(
  tx: RestoreTx,
  pairs: Array<{ id: string; personalWorkspaceId: string }>,
  batchSize = 500,
): Promise<void> {
  for (let i = 0; i < pairs.length; i += batchSize) {
    const chunk = pairs.slice(i, i + batchSize);
    const cases = sql.join(
      chunk.map((p) => sql`WHEN ${users.id} = ${p.id} THEN ${p.personalWorkspaceId}`),
      sql` `,
    );
    await tx.update(users)
      .set({ personalWorkspaceId: sql`CASE ${cases} ELSE ${users.personalWorkspaceId} END` })
      .where(inArray(users.id, chunk.map((p) => p.id)));
  }
}

// keyset 游标类型别名（各表 load 回调显式标注，解脱 TS 对 K/T 的联合推断）。
type CreatedIdCursor = { createdAt: Date; id: string };
type UpdatedIdCursor = { updatedAt: Date; id: string };
type NoteIdVersionCursor = { noteId: string; versionNo: number; id: string };
type PlainIdCursor = { id: string };
/**
 * 导出整个 workspace 的数据为 JSON。
 * F-033: 使用事务保证一致性快照。
 * N-009: 导出包含 users 和 workspace_members，使数据可恢复到空库。
 *
 * 所有查询在同一事务内执行，避免并发写入导致跨时点数据不一致。
 * 导出操作不获取写锁，不影响正常业务读写。
 *
 * BUG-75 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 *
 * SEC-12 安全修复：导出服务对每张表进行显式字段过滤，仅导出业务必需字段。
 * - `users` 表：不导出 passwordHash、personalWorkspaceId（恢复时重建）
 * - `workspaces` 表：仅导出 AI 治理配置（非密钥），不导出 ownerId 以外的身份字段
 * - `user_ai_model_configs` 表已在 0065 迁移中删除（BYOK 下线）
 * - `sessions` 表（含会话令牌）不在导出范围内
 * - `invite_codes` 表（含 token hash）不在导出范围内
 * - 导出操作需要 owner 权限（F-011），已是最小权限控制
 * - 未来新增表时，必须在 exportManifest.included 中显式列出，
 *   并在此处声明字段过滤策略
 */
// PERF-15/43 修复：导出服务的行数安全限制与设计说明
//
// 设计决策：导出服务使用全量查询而非流式/分页加载，原因如下：
// 1. 导出操作需要保证事务一致性快照（REPEATABLE READ），流式加载需要多个事务，
//    可能导致跨时点数据不一致。
// 2. 导出 JSON 格式要求所有数据在单个响应中返回，流式响应需要重构 API 协议
//    （从 JSON 改为 NDJSON 或 chunked transfer），影响前后端。
// 3. 导出操作是低频管理操作（owner 权限），不在正常用户请求路径上。
//
// 替代保护措施：
// - 导出前执行 COUNT 预检查（checkExportSize），对大型工作区记录警告
// - 单表硬限制 EXPORT_MAX_ROWS_PER_TABLE（10 万行），超过则拒绝导出
// - 所有查询使用 Promise.all 并行化，减少总延迟
// - 使用 withWorkspaceTransaction 确保 DB 级工作区隔离
//
// 未来改进方向（需要 API 协议变更）：
// - 按 Note 粒度的增量导出 API（GET /export/notes/:noteId）
// - 流式 NDJSON 响应（Content-Type: application/x-ndlines）
// - 后台导出 + 预签名 URL 下载
const EXPORT_MAX_ROWS_PER_TABLE = 100_000;
// 导出前的预计数阈值，超过此值将记录警告但不阻止导出
const EXPORT_WARN_THRESHOLD = 50_000;
// 峰值内存 O(Σ 所有导出行)。虽然单表被 EXPORT_MAX_ROWS_PER_TABLE 限制，
// 但 ~25 表同时驻留内存时总和仍可能很大。增加"总计行数"硬上限，把峰值内存
// 约束在确定范围内（导出仍返回单一 JSON 对象，因此无法流式，只能收紧总上限）。
const EXPORT_MAX_TOTAL_ROWS = 150_000;

/**
 * 导出前对关键大表执行 COUNT 查询，评估导出规模。
 * 如果任何表行数超过警告阈值，记录警告日志。
 * 如果任何表行数超过最大限制，抛出错误建议使用增量导出。
 */
async function checkExportSize(tx: RestoreTx, workspaceId: string): Promise<void> {
  const [noteCount, blockCount, evidenceCount, validationEventCount] = await Promise.all([
    tx.select({ cnt: count() })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt))),
    tx.select({ cnt: count() })
      .from(noteBlocks)
      .where(eq(noteBlocks.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(evidences)
      .where(eq(evidences.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(validationEvents)
      .where(eq(validationEvents.workspaceId, workspaceId)),
  ]);
  // F14（round-4）：size 防护覆盖面原只覆盖 notes/note_blocks/evidences 3 个小表，
  // 却导出 ~25 表。扩展覆盖另 5 个 append-only/易膨胀大表（validationEvents、
  // sourceSegments、cardKeyPoints、reviewAttempts、aiArtifacts），它们可能远大于预检的 3 表。
  const [sourceSegmentCount, cardKeyPointCount, reviewAttemptCount, aiArtifactCount] = await Promise.all([
    tx.select({ cnt: count() })
      .from(sourceSegments)
      .where(eq(sourceSegments.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(cardKeyPoints)
      .where(eq(cardKeyPoints.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(reviewAttempts)
      .where(eq(reviewAttempts.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(aiArtifacts)
      .where(eq(aiArtifacts.workspaceId, workspaceId)),
  ]);

  const counts: Record<string, number> = {
    notes: Number(noteCount[0]?.cnt ?? 0),
    note_blocks: Number(blockCount[0]?.cnt ?? 0),
    evidences: Number(evidenceCount[0]?.cnt ?? 0),
    validation_events: Number(validationEventCount[0]?.cnt ?? 0),
    source_segments: Number(sourceSegmentCount[0]?.cnt ?? 0),
    card_key_points: Number(cardKeyPointCount[0]?.cnt ?? 0),
    review_attempts: Number(reviewAttemptCount[0]?.cnt ?? 0),
    ai_artifacts: Number(aiArtifactCount[0]?.cnt ?? 0),
  };
  const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (totalRows > EXPORT_WARN_THRESHOLD) {
    logger.warn({ workspaceId, ...counts, totalRows }, `导出工作区数据量较大，可能占用较多内存`);
  }
  // 对单表设置硬限制，防止极端情况下的 OOM
  for (const [table, rowCount] of Object.entries(counts)) {
    if (rowCount > EXPORT_MAX_ROWS_PER_TABLE) {
      throw new Error(
        `导出失败：表 ${table} 有 ${rowCount} 行，超过最大限制 ${EXPORT_MAX_ROWS_PER_TABLE}。` +
        `建议使用按笔记粒度的增量导出，或联系管理员清理不必要的数据。`,
      );
    }
  }
  // 峰值内存由所有同时驻留的表共同决定：即使每表都在单表上限内，
  // 总和仍可能过大。增加总计行数硬上限，防止 O(Σ rows) 峰值内存失控。
  if (totalRows > EXPORT_MAX_TOTAL_ROWS) {
    throw new Error(
      `导出失败：总计 ${totalRows} 行，超过导出总量上限 ${EXPORT_MAX_TOTAL_ROWS}。` +
      `建议使用按笔记粒度的增量导出，或联系管理员清理不必要的数据。`,
    );
  }
}

export async function exportWorkspace(workspaceId: string, userId: string) {
  // BUG-75 修复：使用 withWorkspaceTransaction 替代 db.transaction
  // PERF-15/43 修复：在导出前执行预计数检查，对大型工作区记录警告或拒绝导出。
  // 对于极端大型工作区（单表超过 10 万行），抛出错误建议使用增量导出。
  // 对于大型工作区（总计超过 5 万行），记录警告日志但不阻止导出。
  // 各表查询已添加 limit 安全保护，防止单次查询返回过多数据。
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
    // PERF-15/43 修复：Phase 0 — 预计数检查
    await checkExportSize(tx as unknown as RestoreTx, workspaceId);

    // PERF-15/43 优化：Phase 1 — workspace + members 并行查询（均为轻量查询）
    // 所有 workspaceId 过滤的查询已通过 Promise.all 并行化。
    // restoreWorkspace 已通过批量 INSERT（每批 500 行）优化，将 N 次 DB 往返降为 ceil(N/500) 次。
    const [workspace, memberRows] = await Promise.all([
      tx.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      }),
      // N-009: 导出 workspace members（包含 userId 和 role，用于恢复时重建成员关系）
      tx.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, workspaceId),
      }),
    ]);

    // PERF-15 优化：Phase 2 — 所有 workspaceId 过滤的查询并行执行。
    // B#1（round-5 审计）：把「~25 表单事务 findMany 全量入内存」改为按稳定唯一顺序
    // （orderBy 保持原有方向 + 主键 id 作为打破并列的确定性游标）+ keyset 分批（每批 1000）
    // 循环读取拼接。保证：
    //   - 导出内容与顺序与原先一致（各表原有的 orderBy 方向不变；仅对并列行追加 id 游标，
    //     使批间无缝隙无重复，DB 原先对并列行的返回顺序就非确定，追加 id 后反而确定）。
    //   - 峰值内存从「整表 × 2」降为「批 × 2」，消除大 jsonb 行导出的 OOM 风险。
    //   - 恢复契约不变：表间先后顺序（父表先于子表）由导出对象字段顺序 / importManifest
    //     决定，与行级顺序无关，故行内排序调整不破坏恢复兼容。
    // 仍与流程主体并行（Promise.all 减少 JS 层逐个 await 开销）。
    const EXPORT_BATCH = 1000;

    const [
      noteRows,
      noteVersionRows,
      noteBlockRows,
      sourceRows,
      sourceSegmentRows,
      cardRows,
      cardKeyPointRows,
      evidenceRows,
      evidenceOverrideRows,
      validationQuestionRows,
      validationEventRows,
      reviewScheduleRows,
      reviewAttemptRows,
      understandingEventRows,
      aiArtifactRows,
      rubricItemRows,
      submissionRows,
      actionCommandRows,
      assistanceExposureRows,
      pointAssessmentRows,
      shadowDecisionRows,
      qualitySignalRows,
      onboardingStateRows,
    ] = await Promise.all([
      // CONC-03: 只导出未软删除的笔记 — desc(updatedAt) + id 下界 keyset
      loadInBatches({
        load: (c: UpdatedIdCursor | null) =>
          tx.select().from(notes).where(and(
            and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
            c
              ? or(
                  lt(notes.updatedAt, c.updatedAt),
                  and(eq(notes.updatedAt, c.updatedAt), lt(notes.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(notes.updatedAt), desc(notes.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ updatedAt: last.updatedAt, id: last.id }),
      }),
      // asc(noteId, versionNo) + id 上界
      loadInBatches({
        load: (c: NoteIdVersionCursor | null) =>
          tx.select().from(noteVersions).where(and(
            eq(noteVersions.workspaceId, workspaceId),
            c
              ? or(
                  or(
                    gt(noteVersions.noteId, c.noteId),
                    and(eq(noteVersions.noteId, c.noteId), gt(noteVersions.versionNo, c.versionNo)),
                  ),
                  and(
                    eq(noteVersions.noteId, c.noteId),
                    eq(noteVersions.versionNo, c.versionNo),
                    gt(noteVersions.id, c.id),
                  ),
                )
              : undefined,
          )).orderBy(asc(noteVersions.noteId), asc(noteVersions.versionNo), asc(noteVersions.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ noteId: last.noteId, versionNo: last.versionNo, id: last.id }),
      }),
      // asc(versionId, ordinal) + id 上界
      loadInBatches({
        load: (c: { versionId: string; ordinal: number; id: string } | null) =>
          tx.select().from(noteBlocks).where(and(
            eq(noteBlocks.workspaceId, workspaceId),
            c
              ? or(
                  or(
                    gt(noteBlocks.versionId, c.versionId),
                    and(eq(noteBlocks.versionId, c.versionId), gt(noteBlocks.ordinal, c.ordinal)),
                  ),
                  and(
                    eq(noteBlocks.versionId, c.versionId),
                    eq(noteBlocks.ordinal, c.ordinal),
                    gt(noteBlocks.id, c.id),
                  ),
                )
              : undefined,
          )).orderBy(asc(noteBlocks.versionId), asc(noteBlocks.ordinal), asc(noteBlocks.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ versionId: last.versionId, ordinal: last.ordinal, id: last.id }),
      }),
      // desc(createdAt) + id 下界
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(sources).where(and(
            eq(sources.workspaceId, workspaceId),
            c
              ? or(
                  lt(sources.createdAt, c.createdAt),
                  and(eq(sources.createdAt, c.createdAt), lt(sources.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(sources.createdAt), desc(sources.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // asc(sourceId, ordinal) + id 上界
      loadInBatches({
        load: (c: { sourceId: string; ordinal: number; id: string } | null) =>
          tx.select().from(sourceSegments).where(and(
            eq(sourceSegments.workspaceId, workspaceId),
            c
              ? or(
                  or(
                    gt(sourceSegments.sourceId, c.sourceId),
                    and(eq(sourceSegments.sourceId, c.sourceId), gt(sourceSegments.ordinal, c.ordinal)),
                  ),
                  and(
                    eq(sourceSegments.sourceId, c.sourceId),
                    eq(sourceSegments.ordinal, c.ordinal),
                    gt(sourceSegments.id, c.id),
                  ),
                )
              : undefined,
          )).orderBy(asc(sourceSegments.sourceId), asc(sourceSegments.ordinal), asc(sourceSegments.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ sourceId: last.sourceId, ordinal: last.ordinal, id: last.id }),
      }),
      // desc(createdAt) + id 下界
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(learningCards).where(and(
            eq(learningCards.workspaceId, workspaceId),
            c
              ? or(
                  lt(learningCards.createdAt, c.createdAt),
                  and(eq(learningCards.createdAt, c.createdAt), lt(learningCards.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(learningCards.createdAt), desc(learningCards.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // asc(cardId, ordinal) + id 上界
      loadInBatches({
        load: (c: { cardId: string; ordinal: number; id: string } | null) =>
          tx.select().from(cardKeyPoints).where(and(
            eq(cardKeyPoints.workspaceId, workspaceId),
            c
              ? or(
                  or(
                    gt(cardKeyPoints.cardId, c.cardId),
                    and(eq(cardKeyPoints.cardId, c.cardId), gt(cardKeyPoints.ordinal, c.ordinal)),
                  ),
                  and(
                    eq(cardKeyPoints.cardId, c.cardId),
                    eq(cardKeyPoints.ordinal, c.ordinal),
                    gt(cardKeyPoints.id, c.id),
                  ),
                )
              : undefined,
          )).orderBy(asc(cardKeyPoints.cardId), asc(cardKeyPoints.ordinal), asc(cardKeyPoints.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ cardId: last.cardId, ordinal: last.ordinal, id: last.id }),
      }),
      // 原无显式排序（DB 默认）：统一为 asc(id) 上界，保持确定性 keyset
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(evidences).where(and(
            eq(evidences.workspaceId, workspaceId),
            c ? gt(evidences.id, c) : undefined,
          )).orderBy(asc(evidences.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      // N-005: evidence overrides — asc(id)
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(evidenceOverrides).where(and(
            eq(evidenceOverrides.workspaceId, workspaceId),
            c ? gt(evidenceOverrides.id, c) : undefined,
          )).orderBy(asc(evidenceOverrides.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      // N-003: validation questions — asc(id)
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(validationQuestions).where(and(
            eq(validationQuestions.workspaceId, workspaceId),
            c ? gt(validationQuestions.id, c) : undefined,
          )).orderBy(asc(validationQuestions.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      // desc(createdAt) + id 下界
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(validationEvents).where(and(
            eq(validationEvents.workspaceId, workspaceId),
            c
              ? or(
                  lt(validationEvents.createdAt, c.createdAt),
                  and(eq(validationEvents.createdAt, c.createdAt), lt(validationEvents.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(validationEvents.createdAt), desc(validationEvents.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // desc(createdAt) + id 下界
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(reviewSchedules).where(and(
            eq(reviewSchedules.workspaceId, workspaceId),
            c
              ? or(
                  lt(reviewSchedules.createdAt, c.createdAt),
                  and(eq(reviewSchedules.createdAt, c.createdAt), lt(reviewSchedules.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(reviewSchedules.createdAt), desc(reviewSchedules.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // review attempts (LOOP-01/02) — must follow review_schedules in export
      // ordering so restore can insert parent before child. desc(createdAt) + id
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(reviewAttempts).where(and(
            eq(reviewAttempts.workspaceId, workspaceId),
            c
              ? or(
                  lt(reviewAttempts.createdAt, c.createdAt),
                  and(eq(reviewAttempts.createdAt, c.createdAt), lt(reviewAttempts.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(reviewAttempts.createdAt), desc(reviewAttempts.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // desc(createdAt) + id 下界
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(understandingEvents).where(and(
            eq(understandingEvents.workspaceId, workspaceId),
            c
              ? or(
                  lt(understandingEvents.createdAt, c.createdAt),
                  and(eq(understandingEvents.createdAt, c.createdAt), lt(understandingEvents.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(understandingEvents.createdAt), desc(understandingEvents.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // desc(createdAt) + id 下界
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(aiArtifacts).where(and(
            eq(aiArtifacts.workspaceId, workspaceId),
            c
              ? or(
                  lt(aiArtifacts.createdAt, c.createdAt),
                  and(eq(aiArtifacts.createdAt, c.createdAt), lt(aiArtifacts.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(aiArtifacts.createdAt), desc(aiArtifacts.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // v0.6: 可信掌握闭环新表导出 (计划 §6.9) — asc(questionId, ordinal) + id
      loadInBatches({
        load: (c: { questionId: string; ordinal: number; id: string } | null) =>
          tx.select().from(validationQuestionRubricItems).where(and(
            eq(validationQuestionRubricItems.workspaceId, workspaceId),
            c
              ? or(
                  or(
                    gt(validationQuestionRubricItems.questionId, c.questionId),
                    and(
                      eq(validationQuestionRubricItems.questionId, c.questionId),
                      gt(validationQuestionRubricItems.ordinal, c.ordinal),
                    ),
                  ),
                  and(
                    eq(validationQuestionRubricItems.questionId, c.questionId),
                    eq(validationQuestionRubricItems.ordinal, c.ordinal),
                    gt(validationQuestionRubricItems.id, c.id),
                  ),
                )
              : undefined,
          ))
            .orderBy(
              asc(validationQuestionRubricItems.questionId),
              asc(validationQuestionRubricItems.ordinal),
              asc(validationQuestionRubricItems.id),
            )
            .limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ questionId: last.questionId, ordinal: last.ordinal, id: last.id }),
      }),
      // validation_submissions — user-private, RLS-enforced. desc(createdAt) + id
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(validationSubmissions).where(and(
            eq(validationSubmissions.workspaceId, workspaceId),
            c
              ? or(
                  lt(validationSubmissions.createdAt, c.createdAt),
                  and(eq(validationSubmissions.createdAt, c.createdAt), lt(validationSubmissions.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(validationSubmissions.createdAt), desc(validationSubmissions.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // validation_action_commands — user-private, RLS-enforced. desc(createdAt) + id
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(validationActionCommands).where(and(
            eq(validationActionCommands.workspaceId, workspaceId),
            c
              ? or(
                  lt(validationActionCommands.createdAt, c.createdAt),
                  and(eq(validationActionCommands.createdAt, c.createdAt), lt(validationActionCommands.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(validationActionCommands.createdAt), desc(validationActionCommands.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // validation_assistance_exposures — user-private, RLS-enforced. desc(lastExposedAt) + id
      loadInBatches({
        load: (c: { lastExposedAt: Date; id: string } | null) =>
          tx.select().from(validationAssistanceExposures).where(and(
            eq(validationAssistanceExposures.workspaceId, workspaceId),
            c
              ? or(
                  lt(validationAssistanceExposures.lastExposedAt, c.lastExposedAt),
                  and(
                    eq(validationAssistanceExposures.lastExposedAt, c.lastExposedAt),
                    lt(validationAssistanceExposures.id, c.id),
                  ),
                )
              : undefined,
          ))
            .orderBy(
              desc(validationAssistanceExposures.lastExposedAt),
              desc(validationAssistanceExposures.id),
            )
            .limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ lastExposedAt: last.lastExposedAt, id: last.id }),
      }),
      // validation_point_assessments — user-private, RLS-enforced. asc(submissionId) + id
      loadInBatches({
        load: (c: { submissionId: string; id: string } | null) =>
          tx.select().from(validationPointAssessments).where(and(
            eq(validationPointAssessments.workspaceId, workspaceId),
            c
              ? or(
                  gt(validationPointAssessments.submissionId, c.submissionId),
                  and(
                    eq(validationPointAssessments.submissionId, c.submissionId),
                    gt(validationPointAssessments.id, c.id),
                  ),
                )
              : undefined,
          ))
            .orderBy(
              asc(validationPointAssessments.submissionId),
              asc(validationPointAssessments.id),
            )
            .limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ submissionId: last.submissionId, id: last.id }),
      }),
      // scheduling_shadow_decisions — user-private, RLS-enforced. desc(createdAt) + id
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(schedulingShadowDecisions).where(and(
            eq(schedulingShadowDecisions.workspaceId, workspaceId),
            c
              ? or(
                  lt(schedulingShadowDecisions.createdAt, c.createdAt),
                  and(
                    eq(schedulingShadowDecisions.createdAt, c.createdAt),
                    lt(schedulingShadowDecisions.id, c.id),
                  ),
                )
              : undefined,
          ))
            .orderBy(
              desc(schedulingShadowDecisions.createdAt),
              desc(schedulingShadowDecisions.id),
            )
            .limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // validation_quality_signals — user-private, RLS-enforced. desc(createdAt) + id
      loadInBatches({
        load: (c: CreatedIdCursor | null) =>
          tx.select().from(validationQualitySignals).where(and(
            eq(validationQualitySignals.workspaceId, workspaceId),
            c
              ? or(
                  lt(validationQualitySignals.createdAt, c.createdAt),
                  and(
                    eq(validationQualitySignals.createdAt, c.createdAt),
                    lt(validationQualitySignals.id, c.id),
                  ),
                )
              : undefined,
          ))
            .orderBy(
              desc(validationQualitySignals.createdAt),
              desc(validationQualitySignals.id),
            )
            .limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ createdAt: last.createdAt, id: last.id }),
      }),
      // onboarding states (SEC-02/ALPHA-01) — per-user onboarding progress.
      // invite_codes are NOT exported: they contain token hashes which are
      // security-sensitive credentials, not business data. desc(updatedAt) + id
      loadInBatches({
        load: (c: UpdatedIdCursor | null) =>
          tx.select().from(onboardingStates).where(and(
            eq(onboardingStates.workspaceId, workspaceId),
            c
              ? or(
                  lt(onboardingStates.updatedAt, c.updatedAt),
                  and(eq(onboardingStates.updatedAt, c.updatedAt), lt(onboardingStates.id, c.id)),
                )
              : undefined,
          )).orderBy(desc(onboardingStates.updatedAt), desc(onboardingStates.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ updatedAt: last.updatedAt, id: last.id }),
      }),
    ]);

    // PERF-15 优化：Phase 3 — 依赖 Phase 1/2 结果的查询并行执行
    // N-009: 导出相关 users（不导出 passwordHash，恢复时需要重新设置密码）
    const userIds = [workspace?.ownerId, ...memberRows.map((m) => m.userId)].filter(Boolean) as string[];
    const [
      userRows,
      submissionJobRows,
      // Plan 23 CS-07
      objectiveRows,
      objectiveRevisionRows,
      objectiveOriginRows,
      learningCardV2Rows,
    ] = await Promise.all([
      userIds.length
        ? tx.query.users.findMany({
            where: inArray(users.id, userIds),
          })
        : Promise.resolve([]),
      // validation_submission_jobs — 依赖 submissionRows
      // R#6-3：submissionIds 可能达 EXPORT_MAX_ROWS_PER_TABLE(100k)，远超 postgres-js
      // ~65535 绑定参数上限 → 500/批分块查询后合并，避免大工作区导出 500。
      submissionRows.length
        ? (async () => {
            const submissionIds = submissionRows.map((s) => s.id);
            const jobs: Array<Awaited<ReturnType<typeof tx.query.validationSubmissionJobs.findMany>>[number]> = [];
            for (let i = 0; i < submissionIds.length; i += 500) {
              const chunk = submissionIds.slice(i, i + 500);
              const rows = await tx.query.validationSubmissionJobs.findMany({
                where: inArray(validationSubmissionJobs.submissionId, chunk),
                orderBy: (j, { asc: a }) => [a(j.submissionId), a(j.phase), a(j.phaseOrdinal)],
              });
              jobs.push(...rows);
            }
            return jobs;
          })()
        : Promise.resolve([]),
      // Plan 23 CS-07：learning_objectives_v2
      loadInBatches({
        load: (c: PlainIdCursor | null) =>
          tx.select().from(learningObjectivesV2).where(and(
            eq(learningObjectivesV2.workspaceId, workspaceId),
            c ? lt(learningObjectivesV2.id, c.id) : undefined,
          )).orderBy(desc(learningObjectivesV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ id: last.id }),
      }),
      // Plan 23 CS-07：learning_objective_revisions_v2
      loadInBatches({
        load: (c: PlainIdCursor | null) =>
          tx.select().from(learningObjectiveRevisionsV2).where(and(
            eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
            c ? lt(learningObjectiveRevisionsV2.id, c.id) : undefined,
          )).orderBy(desc(learningObjectiveRevisionsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ id: last.id }),
      }),
      // Plan 23 CS-07：learning_objective_origins_v2
      loadInBatches({
        load: (c: PlainIdCursor | null) =>
          tx.select().from(learningObjectiveOriginsV2).where(and(
            eq(learningObjectiveOriginsV2.workspaceId, workspaceId),
            c ? lt(learningObjectiveOriginsV2.id, c.id) : undefined,
          )).orderBy(desc(learningObjectiveOriginsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ id: last.id }),
      }),
      // Plan 23 CS-07：learning_cards_v2
      loadInBatches({
        load: (c: PlainIdCursor | null) =>
          tx.select().from(learningCardsV2).where(and(
            eq(learningCardsV2.workspaceId, workspaceId),
            c ? lt(learningCardsV2.id, c.id) : undefined,
          )).orderBy(desc(learningCardsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => ({ id: last.id }),
      }),
    ]);

    return {
      workspace: workspace
        ? {
            id: workspace.id,
            name: workspace.name,
            ownerId: workspace.ownerId,
            workspaceType: workspace.workspaceType,
            // N-011: 导出 AI 隐私治理配置
          aiConsentVersion: workspace.aiConsentVersion,
            aiConsentAt: workspace.aiConsentAt,
            aiConsentBy: workspace.aiConsentBy,
            aiDataPolicy: workspace.aiDataPolicy,
          }
        : null,
      // N-009: 导出 identity 数据，使数据可恢复
      // 注意：不导出 passwordHash，恢复时需要重新设置密码
      users: userRows.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        personalWorkspaceId: u.personalWorkspaceId,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      })),
      workspaceMembers: memberRows,
      notes: noteRows,
      noteVersions: noteVersionRows,
      noteBlocks: noteBlockRows,
      sources: sourceRows,
      sourceSegments: sourceSegmentRows,
      learningCards: cardRows,
      cardKeyPoints: cardKeyPointRows,
      evidences: evidenceRows,
      evidenceOverrides: evidenceOverrideRows,
      validationQuestions: validationQuestionRows,
      validationEvents: validationEventRows,
      reviewSchedules: reviewScheduleRows,
      reviewAttempts: reviewAttemptRows,
      understandingEvents: understandingEventRows,
      aiArtifacts: aiArtifactRows,
      onboardingStates: onboardingStateRows,
      // v0.6: 可信掌握闭环新表 (计划 §6.9)
      validationQuestionRubricItems: rubricItemRows,
      validationSubmissions: submissionRows,
      validationSubmissionJobs: submissionJobRows,
      validationActionCommands: actionCommandRows,
      validationAssistanceExposures: assistanceExposureRows,
      validationPointAssessments: pointAssessmentRows,
      schedulingShadowDecisions: shadowDecisionRows,
      validationQualitySignals: qualitySignalRows,
      // Plan 23 CS-07：导出 learning_objectives_v2 / revision / origin / cards_v2
      objectivesV2: objectiveRows,
      objectiveRevisionsV2: objectiveRevisionRows,
      objectiveOriginsV2: objectiveOriginRows,
      learningCardsV2: learningCardV2Rows,
      /**
       * 导出清单：明确哪些数据已包含、哪些未包含。
       * N-009: 新增 users 和 workspaceMembers，导出文件现在可用于恢复。
       * v0.6: 新增可信掌握闭环 8 张表，覆盖 §6.9 导出/导入要求。
       */
      exportManifest: {
        included: [
          "workspace",
          "users",
          "workspaceMembers",
          "notes",
          "noteVersions",
          "noteBlocks",
          "sources",
          "sourceSegments",
          "learningCards",
          "cardKeyPoints",
          "evidences",
          "evidenceOverrides",
          "validationQuestions",
          "validationEvents",
          "reviewSchedules",
          "reviewAttempts",
          "understandingEvents",
          "aiArtifacts",
          "onboardingStates",
          // v0.6: 可信掌握闭环新表
          "validationQuestionRubricItems",
          "validationSubmissions",
          "validationSubmissionJobs",
          "validationActionCommands",
          "validationAssistanceExposures",
          "validationPointAssessments",
          "schedulingShadowDecisions",
          "validationQualitySignals",
        ],
        excluded: {
          searchDocuments: "可重建 — 调用 POST /search/reindex 即可从主表重建",
          benchmarkReports: "运行态 — 基准测试报告，不随 workspace 导出",
          benchmarkLabels: "运行态 — 人工标注数据，不随 workspace 导出",
          jobs: "运行态 — AI 任务队列，不随 workspace 导出",
          sessions: "安全敏感 — 用户会话令牌，不应导出",
          passwordHashes: "安全敏感 — 用户密码哈希不导出，恢复后需重置密码",
          aiAuditLog: "运行态 — AI 审计日志，不随 workspace 导出",
          inviteCodes: "安全敏感 — 邀请 token hash 属凭据数据，不随导出",
        },
        version: "2.0",
        notes: [
          "N-009: 导出文件包含 identity 数据（不含密码），可用于恢复到空库。",
          "恢复后由工作区 Owner 调用 POST /auth/recovered-users/:userId/reset-password 为恢复用户设置初始密码。",
          "恢复操作会保留原始 ID，确保外键关系一致。",
        ],
      },
      exportedAt: new Date().toISOString(),
    };
    },
  );
}

/**
 * N-009: 从导出的 JSON 恢复 workspace 数据到当前 workspace。
 *
 * 恢复策略：
 * - 在单事务中执行，确保原子性
 * - 保留原始 ID，确保外键关系一致
 * - 如果目标 workspace 已有数据，返回冲突错误（不支持合并恢复）
 * - 恢复后需要重新设置用户密码
 * - 恢复后需要调用 POST /search/reindex 重建搜索索引
 */
export async function restoreWorkspace(
  targetWorkspaceId: string,
  data: Record<string, unknown>,
  dryRun = false,
  database: RestoreDatabase = db,
): Promise<{ success: boolean; message: string; dryRun?: boolean; counts?: Record<string, number> }> {
  // 基本校验
  if (!data.workspace || !data.exportManifest) {
    return { success: false, message: "无效的导出文件：缺少 workspace 或 exportManifest 字段" };
  }
  const manifest = data.exportManifest as Record<string, unknown>;
  if (manifest.version !== "2.0") {
    return { success: false, message: "不支持的导出文件版本：仅支持 2.0" };
  }

  // 检查目标 workspace 是否已有业务数据。新工作区本身会包含 Owner 成员，
  // 因而不能以 workspace_members 非空作为冲突依据。
  const [existingNotes, existingSources, existingCards, existingJobs, existingArtifacts] = await Promise.all([
    database.query.notes.findMany({ where: and(eq(notes.workspaceId, targetWorkspaceId), isNull(notes.deletedAt)), limit: 1 }),
    database.query.sources.findMany({ where: eq(sources.workspaceId, targetWorkspaceId), limit: 1 }),
    database.query.learningCards.findMany({ where: eq(learningCards.workspaceId, targetWorkspaceId), limit: 1 }),
    database.query.jobs.findMany({ where: eq(jobs.workspaceId, targetWorkspaceId), limit: 1 }),
    database.query.aiArtifacts.findMany({ where: eq(aiArtifacts.workspaceId, targetWorkspaceId), limit: 1 }),
  ]);
  if (
    existingNotes.length > 0 || existingSources.length > 0 ||
    existingCards.length > 0 || existingJobs.length > 0 || existingArtifacts.length > 0
  ) {
    return {
      success: false,
      message: "目标工作区已有数据，恢复操作不支持合并。请先清空目标工作区或使用新工作区。",
    };
  }

  const counts: Record<string, number> = {};

  // N#8-2: 对导出侧 exportManifest.included 与恢复 schema 实际接收到的键做差集告警，防止未来
  // 导出新增表而 restoreSchema 未同步声明（zod strip 会静默丢弃 → 恢复丢数据）再次漂移。
  // 恢复 schema 键 = data 中实际存在的数组键（zod safeParse 已 strip 未声明的键）。在 dry-run 与真实
  // 恢复两条路径都执行，属廉价防御性检查。
  const rawIncluded = (manifest.included as unknown) ?? [];
  const declaredIncluded = Array.isArray(rawIncluded) ? (rawIncluded as string[]) : [];
  // `workspace` 与 `exportManifest` 是导出文件的清单/标记键，不是待恢复的表数据键，差集比对时排除。
  const receivedKeys = new Set(
    Object.keys(data).filter((k) => k !== "workspace" && k !== "exportManifest" && k !== "dryRun"),
  );
  const declaredSet = new Set(declaredIncluded.filter((k) => k !== "workspace" && k !== "exportManifest" && k !== "dryRun"));
  const missingInData = [...declaredSet].filter((k) => !receivedKeys.has(k));
  const unexpectedKeys = [...receivedKeys].filter((k) => !declaredSet.has(k));
  if (missingInData.length > 0 || unexpectedKeys.length > 0) {
    logger.warn(
      {
        dryRun,
        missingInData,
        unexpectedKeys,
        declaredIncluded: declaredIncluded.length,
        receivedKeys: receivedKeys.size,
      },
      "restore: exportManifest.included 与接收到的恢复键存在差集；未声明的键已被 zod strip 丢弃、将不会被恢复",
    );
  }

  if (dryRun) {
    // dry-run 模式：只统计将要恢复的数据量，不实际写入
    counts.users = Array.isArray(data.users) ? data.users.length : 0;
    counts.workspaceMembers = Array.isArray(data.workspaceMembers) ? data.workspaceMembers.length : 0;
    counts.notes = Array.isArray(data.notes) ? data.notes.length : 0;
    counts.noteVersions = Array.isArray(data.noteVersions) ? data.noteVersions.length : 0;
    counts.noteBlocks = Array.isArray(data.noteBlocks) ? data.noteBlocks.length : 0;
    counts.sources = Array.isArray(data.sources) ? data.sources.length : 0;
    counts.sourceSegments = Array.isArray(data.sourceSegments) ? data.sourceSegments.length : 0;
    counts.learningCards = Array.isArray(data.learningCards) ? data.learningCards.length : 0;
    counts.cardKeyPoints = Array.isArray(data.cardKeyPoints) ? data.cardKeyPoints.length : 0;
    counts.evidences = Array.isArray(data.evidences) ? data.evidences.length : 0;
    counts.evidenceOverrides = Array.isArray(data.evidenceOverrides) ? data.evidenceOverrides.length : 0;
    counts.validationQuestions = Array.isArray(data.validationQuestions) ? data.validationQuestions.length : 0;
    counts.validationEvents = Array.isArray(data.validationEvents) ? data.validationEvents.length : 0;
    counts.reviewSchedules = Array.isArray(data.reviewSchedules) ? data.reviewSchedules.length : 0;
    counts.reviewAttempts = Array.isArray(data.reviewAttempts) ? data.reviewAttempts.length : 0;
    counts.understandingEvents = Array.isArray(data.understandingEvents) ? data.understandingEvents.length : 0;
    counts.aiArtifacts = Array.isArray(data.aiArtifacts) ? data.aiArtifacts.length : 0;
    counts.onboardingStates = Array.isArray(data.onboardingStates) ? data.onboardingStates.length : 0;
    // v0.6: 可信掌握闭环新表 dry-run 计数
    counts.validationQuestionRubricItems = Array.isArray(data.validationQuestionRubricItems) ? data.validationQuestionRubricItems.length : 0;
    counts.validationSubmissions = Array.isArray(data.validationSubmissions) ? data.validationSubmissions.length : 0;
    counts.validationSubmissionJobs = Array.isArray(data.validationSubmissionJobs) ? data.validationSubmissionJobs.length : 0;
    counts.validationActionCommands = Array.isArray(data.validationActionCommands) ? data.validationActionCommands.length : 0;
    counts.validationAssistanceExposures = Array.isArray(data.validationAssistanceExposures) ? data.validationAssistanceExposures.length : 0;
    counts.validationPointAssessments = Array.isArray(data.validationPointAssessments) ? data.validationPointAssessments.length : 0;
    counts.schedulingShadowDecisions = Array.isArray(data.schedulingShadowDecisions) ? data.schedulingShadowDecisions.length : 0;
    counts.validationQualitySignals = Array.isArray(data.validationQualitySignals) ? data.validationQualitySignals.length : 0;

    // N-009: dry-run 引用完整性校验
    const refErrors: string[] = [];
    const evidenceIds = new Set((Array.isArray(data.evidences) ? data.evidences : []).map((e: Record<string, unknown>) => e.id as string));
    const cardIds = new Set((Array.isArray(data.learningCards) ? data.learningCards : []).map((c: Record<string, unknown>) => c.id as string));
    const keyPointIds = new Set((Array.isArray(data.cardKeyPoints) ? data.cardKeyPoints : []).map((k: Record<string, unknown>) => k.id as string));
    const questionIds = new Set((Array.isArray(data.validationQuestions) ? data.validationQuestions : []).map((q: Record<string, unknown>) => q.id as string));
    const scheduleIds = new Set((Array.isArray(data.reviewSchedules) ? data.reviewSchedules : []).map((r: Record<string, unknown>) => r.id as string));
    const validationEventIds = new Set((Array.isArray(data.validationEvents) ? data.validationEvents : []).map((v: Record<string, unknown>) => v.id as string));
    const noteVersionIds = new Set((Array.isArray(data.noteVersions) ? data.noteVersions : []).map((v: Record<string, unknown>) => v.id as string));

    // evidence_overrides 引用完整性
    if (Array.isArray(data.evidenceOverrides)) {
      for (const o of data.evidenceOverrides as Record<string, unknown>[]) {
        if (!evidenceIds.has(o.evidenceId as string)) {
          refErrors.push(`evidence_override references missing evidence ${o.evidenceId}`);
        }
      }
    }
    // validation_events 引用完整性
    if (Array.isArray(data.validationEvents)) {
      for (const v of data.validationEvents as Record<string, unknown>[]) {
        if (!cardIds.has(v.cardId as string)) {
          refErrors.push(`validation_event references missing card ${v.cardId}`);
        }
        if (v.keyPointId && !keyPointIds.has(v.keyPointId as string)) {
          refErrors.push(`validation_event references missing key_point ${v.keyPointId}`);
        }
        if (v.questionId && !questionIds.has(v.questionId as string)) {
          refErrors.push(`validation_event references missing question ${v.questionId}`);
        }
      }
    }
    // validation_questions 引用完整性
    if (Array.isArray(data.validationQuestions)) {
      for (const q of data.validationQuestions as Record<string, unknown>[]) {
        if (!cardIds.has(q.cardId as string)) {
          refErrors.push(`validation_question references missing card ${q.cardId}`);
        }
      }
    }
    if (Array.isArray(data.reviewAttempts)) {
      for (const a of data.reviewAttempts as Record<string, unknown>[]) {
        if (!scheduleIds.has(a.reviewScheduleId as string)) {
          refErrors.push(`review_attempt references missing schedule ${a.reviewScheduleId}`);
        }
        if (a.validationEventId && !validationEventIds.has(a.validationEventId as string)) {
          refErrors.push(`review_attempt references missing validation_event ${a.validationEventId}`);
        }
        if (a.validationQuestionId && !questionIds.has(a.validationQuestionId as string)) {
          refErrors.push(`review_attempt references missing question ${a.validationQuestionId}`);
        }
        if (a.keyPointId && !keyPointIds.has(a.keyPointId as string)) {
          refErrors.push(`review_attempt references missing key_point ${a.keyPointId}`);
        }
        if (a.evidenceId && !evidenceIds.has(a.evidenceId as string)) {
          refErrors.push(`review_attempt references missing evidence ${a.evidenceId}`);
        }
        if (a.noteVersionId && !noteVersionIds.has(a.noteVersionId as string)) {
          refErrors.push(`review_attempt references missing note_version ${a.noteVersionId}`);
        }
      }
    }

    if (refErrors.length > 0) {
      return { success: false, message: `dry-run 引用完整性校验失败：${refErrors.slice(0, 5).join("; ")}${refErrors.length > 5 ? ` ...共 ${refErrors.length} 个错误` : ""}`, dryRun: true, counts };
    }

    // v0.6: 可信掌握闭环新表 dry-run 引用完整性校验 (计划 §6.9)
    const submissionIds = new Set((Array.isArray(data.validationSubmissions) ? data.validationSubmissions : []).map((s: Record<string, unknown>) => s.id as string));
    const rubricItemIds = new Set((Array.isArray(data.validationQuestionRubricItems) ? data.validationQuestionRubricItems : []).map((r: Record<string, unknown>) => r.id as string));

    if (Array.isArray(data.validationQuestionRubricItems)) {
      for (const r of data.validationQuestionRubricItems as Record<string, unknown>[]) {
        if (!questionIds.has(r.questionId as string)) {
          refErrors.push(`validation_question_rubric_item references missing question ${r.questionId}`);
        }
        if (r.evidenceId && !evidenceIds.has(r.evidenceId as string)) {
          refErrors.push(`validation_question_rubric_item references missing evidence ${r.evidenceId}`);
        }
      }
    }

    if (Array.isArray(data.validationSubmissions)) {
      for (const s of data.validationSubmissions as Record<string, unknown>[]) {
        if (!cardIds.has(s.cardId as string)) {
          refErrors.push(`validation_submission references missing card ${s.cardId}`);
        }
        if (s.questionId && !questionIds.has(s.questionId as string)) {
          refErrors.push(`validation_submission references missing question ${s.questionId}`);
        }
        if (s.keyPointId && !keyPointIds.has(s.keyPointId as string)) {
          refErrors.push(`validation_submission references missing key_point ${s.keyPointId}`);
        }
      }
    }

    if (Array.isArray(data.validationSubmissionJobs)) {
      for (const j of data.validationSubmissionJobs as Record<string, unknown>[]) {
        if (!submissionIds.has(j.submissionId as string)) {
          refErrors.push(`validation_submission_job references missing submission ${j.submissionId}`);
        }
      }
    }

    if (Array.isArray(data.validationPointAssessments)) {
      for (const p of data.validationPointAssessments as Record<string, unknown>[]) {
        if (!submissionIds.has(p.submissionId as string)) {
          refErrors.push(`validation_point_assessment references missing submission ${p.submissionId}`);
        }
        if (!rubricItemIds.has(p.rubricItemId as string)) {
          refErrors.push(`validation_point_assessment references missing rubric_item ${p.rubricItemId}`);
        }
      }
    }

    if (Array.isArray(data.validationQualitySignals)) {
      for (const q of data.validationQualitySignals as Record<string, unknown>[]) {
        if (!validationEventIds.has(q.validationEventId as string)) {
          refErrors.push(`validation_quality_signal references missing validation_event ${q.validationEventId}`);
        }
      }
    }

    if (refErrors.length > 0) {
      return { success: false, message: `dry-run v0.6 引用完整性校验失败：${refErrors.slice(0, 5).join("; ")}${refErrors.length > 5 ? ` ...共 ${refErrors.length} 个错误` : ""}`, dryRun: true, counts };
    }

    return { success: true, message: "dry-run 验证通过，可以恢复", dryRun: true, counts };
  }

  try {
    await database.transaction(async (tx) => {
      // 1. 恢复 users（不恢复 passwordHash，使用临时密码）
      // PERF: Two-phase restore — batch-insert all recovered users first, then in
      // one pass create their personal workspaces, link personalWorkspaceId and
      // insert the member/onboarding rows in batches, instead of 5 sequential DB
      // writes per user.
      if (Array.isArray(data.users)) {
        const userRows = (data.users as Record<string, unknown>[]).map((user) => ({
          id: user.id as string,
          email: user.email as string,
          // 临时密码哈希，用户需要重置
          passwordHash: RECOVERED_PASSWORD_SENTINEL,
          role: (user.role as string) ?? "owner",
          displayName: (user.displayName as string) ?? null,
          avatarUrl: (user.avatarUrl as string) ?? null,
        }));

        // onConflictDoNothing + returning returns only the rows actually inserted
        // (users that already exist are skipped), matching the old per-user logic.
        const insertedUserRows = userRows.length > 0
          ? flattenBatchReturning(await tx
              .insert(users)
              .values(userRows)
              .onConflictDoNothing()
              .returning({
                id: users.id,
                email: users.email,
                displayName: users.displayName,
              }))
          : [];

        if (insertedUserRows.length > 0) {
          // Batch-create one personal workspace per newly recovered account.
          const workspaceRows = insertedUserRows.map((user) => ({
            ownerId: user.id,
            name: generateDefaultWorkspaceName(user.displayName, user.email),
            workspaceType: "personal" as const,
          }));
          const insertedWorkspaces = workspaceRows.length > 0
            ? flattenBatchReturning(await tx
                .insert(workspaces)
                .values(workspaceRows)
                .returning({ id: workspaces.id, ownerId: workspaces.ownerId }))
            : [];

          // Link each user to its new personal workspace, then batch the member
          // and onboarding rows (dependency-free once workspace ids are known).
          const workspaceByOwner = new Map(insertedWorkspaces.map((w) => [w.ownerId, w.id]));
          const memberRows: Array<{
            workspaceId: string;
            userId: string;
            role: string;
          }> = [];
          const onboardingRows: Array<{
            workspaceId: string;
            userId: string;
            version: string;
            steps: Record<string, boolean>;
            status: string;
          }> = [];
          const personalWorkspacePairs: Array<{ id: string; personalWorkspaceId: string }> = [];

          for (const user of insertedUserRows) {
            const personalWorkspaceId = workspaceByOwner.get(user.id);
            if (!personalWorkspaceId) continue;
            personalWorkspacePairs.push({ id: user.id, personalWorkspaceId });
            memberRows.push({
              workspaceId: personalWorkspaceId,
              userId: user.id,
              role: "owner",
            });
            onboardingRows.push({
              workspaceId: personalWorkspaceId,
              userId: user.id,
              version: "v1",
              steps: {},
              status: "pending",
            });
          }

          // DB-N+1 修复：原实现每用户一条串行 UPDATE users，现改为每 500 批一条
          // CASE WHEN 多行 UPDATE，减少恢复路径的 DB 往返次数。
          await batchUpdateUsersPersonalWorkspace(tx, personalWorkspacePairs);

          if (memberRows.length > 0) {
            await tx.insert(workspaceMembers).values(memberRows);
          }
          if (onboardingRows.length > 0) {
            await tx.insert(onboardingStates).values(onboardingRows);
          }
        }
        counts.users = data.users.length;
      }

      // Restore workspace metadata without replacing the target workspace ID
      // or owner. workspaceType is also target identity metadata: copying it
      // could turn an owner's personal workspace into a collaborative one (or
      // vice versa) while personalWorkspaceId still points at the target.
      // Identity references are restored first so aiConsentBy remains valid.
      const exportedWorkspace = data.workspace as Record<string, unknown>;
      await tx
        .update(workspaces)
        .set({
          name: (exportedWorkspace.name as string) || "恢复的工作区",
          aiConsentVersion: (exportedWorkspace.aiConsentVersion as string) ?? null,
          aiConsentAt: exportedWorkspace.aiConsentAt
            ? new Date(exportedWorkspace.aiConsentAt as string)
            : null,
          aiConsentBy: (exportedWorkspace.aiConsentBy as string) ?? null,
          aiDataPolicy: (exportedWorkspace.aiDataPolicy as {
            sendToExternal: boolean;
            sendImageContent: boolean;
            piiDetection: boolean;
            auditLogging: boolean;
          }) ?? { sendToExternal: false, sendImageContent: false, piiDetection: true, auditLogging: true },
        })
        .where(eq(workspaces.id, targetWorkspaceId));

      // 2. 恢复 workspace_members（PERF-40 修复：批量 INSERT）
      counts.workspaceMembers = await restoreTable(
        tx, workspaceMembers, data.workspaceMembers,
        (member) => ({
          workspaceId: targetWorkspaceId,
          userId: member.userId as string,
          role: (member.role as string) ?? "member",
          joinedAt: member.joinedAt ? new Date(member.joinedAt as string) : new Date(),
          leftAt: member.leftAt ? new Date(member.leftAt as string) : null,
        }),
      );

      // 3. 恢复 sources（PERF-40 修复：批量 INSERT）
      counts.sources = await restoreTable(
        tx, sources, data.sources,
        (source) => ({
          id: source.id as string,
          workspaceId: targetWorkspaceId,
          type: source.type as string,
          title: source.title as string,
          origin: (source.origin as string) ?? null,
          status: (source.status as string) ?? "draft",
          metadata: (source.metadata as Record<string, unknown>) ?? {},
          createdBy: source.createdBy as string,
        }),
      );

      // 4. 恢复 source_segments（PERF-40 修复：批量 INSERT）
      counts.sourceSegments = await restoreTable(
        tx, sourceSegments, data.sourceSegments,
        (seg) => ({
          id: seg.id as string,
          sourceId: seg.sourceId as string,
          workspaceId: targetWorkspaceId,
          ordinal: seg.ordinal as number,
          text: seg.text as string,
          charStart: seg.charStart as number,
          charEnd: seg.charEnd as number,
          segmentType: (seg.segmentType as string) ?? "paragraph",
        }),
      );

      // 5. 恢复 notes（PERF-40 修复：批量 INSERT）
      counts.notes = await restoreTable(
        tx, notes, data.notes,
        (note) => ({
          id: note.id as string,
          workspaceId: targetWorkspaceId,
          title: note.title as string,
          titleSource: (note.titleSource as string) ?? "auto",
          // note_versions 尚未恢复；先断开环形引用，版本插入后再回填。
          currentVersionId: null,
          sourceId: (note.sourceId as string) ?? null,
          createdBy: note.createdBy as string,
        }),
      );

      // 6. 恢复 note_versions（PERF-40 修复：批量 INSERT）
      counts.noteVersions = await restoreTable(
        tx, noteVersions, data.noteVersions,
        (ver) => {
          const contentJson = ver.contentJson as unknown;
          const contentHash = (ver.contentHash as string) ?? computeContentHash(contentJson);
          return {
            id: ver.id as string,
            noteId: ver.noteId as string,
            workspaceId: targetWorkspaceId,
            versionNo: ver.versionNo as number,
            contentJson,
            contentHash,
            createdBy: ver.createdBy as string,
          };
        },
      );

      // notes.current_version_id 通过复合 FK 指向 note_versions。只有父记录
      // 全部存在后才能恢复该引用，同时保留导出文件中的原始 ID。
      // PERF-40 修复：并行 UPDATE 替代串行逐行更新。
      // 每条笔记的 currentVersionId 各不相同，无法用单次 inArray 批量更新，
      // 但各 UPDATE 之间无数据依赖，可使用 Promise.all 并行执行，
      // 将 N 次 DB 往返从串行（N × RTT）降为并行（1 × RTT）。
      if (Array.isArray(data.notes)) {
        const noteUpdates = (data.notes as Record<string, unknown>[])
          .filter((note) => typeof note.currentVersionId === "string" && (note.currentVersionId as string).length > 0)
          .map((note) => ({ id: note.id as string, currentVersionId: note.currentVersionId as string }));
        // PERF-99 修复：按 500/批顺序分批执行 UPDATE，避免对超大工作区一次性
        // 并发数万条 UPDATE 打满连接池。各批 write 间无数据依赖，串行执行即可，
        // 复用同文件 batchInsert/restoreTable 的 batchSize=500 批次语义。
        // B1（round-3 审计复核）：批内逐行 `await` 是“表面分批”——消除连接池
        // 打满风险，但把原本 Promise.all 的并发改为严格串行 N 次 RTT，超大工作区
        // 回填变慢。此处批内用 Promise.all 并行下发（单事务单连接下 postgres.js
        // 本就排队执行，收益是消除 JS 层逐条 await 的串行开销 + 批间仍串行保证
        // 有界并发），批间保持串行。
        const NOTE_BATCH_SIZE = 500;
        for (let i = 0; i < noteUpdates.length; i += NOTE_BATCH_SIZE) {
          const batch = noteUpdates.slice(i, i + NOTE_BATCH_SIZE);
          await Promise.all(batch.map(({ id, currentVersionId }) =>
            tx.update(notes)
              .set({ currentVersionId })
              .where(and(eq(notes.id, id), eq(notes.workspaceId, targetWorkspaceId))),
          ));
        }
      }

      // 7. 恢复 note_blocks（PERF-40 修复：批量 INSERT）
      counts.noteBlocks = await restoreTable(
        tx, noteBlocks, data.noteBlocks,
        (block) => ({
          id: block.id as string,
          versionId: block.versionId as string,
          workspaceId: targetWorkspaceId,
          ordinal: block.ordinal as number,
          type: block.type as string,
          content: block.content as string,
          sourceRef: (block.sourceRef as Record<string, unknown>) ?? null,
        }),
      );

      // 8. 恢复 ai_artifacts（PERF-40 修复：批量 INSERT）
      // learning_cards 和 validation_events 都通过复合 FK 引用它，必须先于这两类子记录插入。
      counts.aiArtifacts = await restoreTable(
        tx, aiArtifacts, data.aiArtifacts,
        (art) => ({
          id: art.id as string,
          workspaceId: targetWorkspaceId,
          type: art.type as string,
          inputRefs: art.inputRefs as Record<string, unknown>,
          output: art.output as unknown,
          modelId: art.modelId as string,
          promptVersion: art.promptVersion as string,
          inputHash: (art.inputHash as string) ?? null,
          costTokens: (art.costTokens as number) ?? null,
          status: (art.status as string) ?? "ready",
          parentArtifactId: (art.parentArtifactId as string) ?? null,
        }),
      );

      // 9. 恢复 learning_cards（PERF-40 修复：批量 INSERT）
      counts.learningCards = await restoreTable(
        tx, learningCards, data.learningCards,
        (card) => ({
          id: card.id as string,
          noteVersionId: card.noteVersionId as string,
          workspaceId: targetWorkspaceId,
          status: (card.status as string) ?? "active",
          schemaJson: card.schemaJson as { title: string; summary: string },
          artifactId: (card.artifactId as string) ?? null,
          supersededByCardId: (card.supersededByCardId as string) ?? null,
        }),
      );

      // 10. 恢复 card_key_points（PERF-40 修复：批量 INSERT）
      counts.cardKeyPoints = await restoreTable(
        tx, cardKeyPoints, data.cardKeyPoints,
        (kp) => ({
          id: kp.id as string,
          cardId: kp.cardId as string,
          workspaceId: targetWorkspaceId,
          ordinal: kp.ordinal as number,
          claim: kp.claim as string,
          quoteText: kp.quoteText as string,
          segmentRef: (kp.segmentRef as Record<string, unknown>) ?? null,
        }),
      );

      // 11. 恢复 evidences（PERF-40 修复：批量 INSERT）
      counts.evidences = await restoreTable(
        tx, evidences, data.evidences,
        (ev) => ({
          id: ev.id as string,
          workspaceId: targetWorkspaceId,
          keyPointId: ev.keyPointId as string,
          blockId: (ev.blockId as string) ?? null,
          blockOrdinal: (ev.blockOrdinal as number) ?? null,
          quoteText: ev.quoteText as string,
          alignment: (ev.alignment as string) ?? "unaligned",
          alignmentScore: (ev.alignmentScore as number) ?? 0,
          alignmentMethod: (ev.alignmentMethod as string) ?? "fuzzy",
          userOverride: (ev.userOverride as string) ?? null,
        }),
      );

      // 11b. 恢复 evidence_overrides（PERF-40 修复：批量 INSERT）
      counts.evidenceOverrides = await restoreTable(
        tx, evidenceOverrides, data.evidenceOverrides,
        (override) => ({
          id: override.id as string,
          evidenceId: override.evidenceId as string,
          userId: override.userId as string,
          workspaceId: targetWorkspaceId,
          override: override.override as string,
          createdAt: override.createdAt ? new Date(override.createdAt as string) : new Date(),
        }),
      );

      // 11c. 恢复 validation_questions（PERF-40 修复：批量 INSERT）
      counts.validationQuestions = await restoreTable(
        tx, validationQuestions, data.validationQuestions,
        (vq) => ({
          id: vq.id as string,
          workspaceId: targetWorkspaceId,
          cardId: vq.cardId as string,
          keyPointId: (vq.keyPointId as string) ?? null,
          noteVersionId: (vq.noteVersionId as string) ?? null,
          questionType: vq.questionType as string,
          question: vq.question as string,
          createdBy: vq.createdBy as string,
          createdAt: vq.createdAt ? new Date(vq.createdAt as string) : new Date(),
          expiresAt: vq.expiresAt ? new Date(vq.expiresAt as string) : null,
          userId: (vq.userId as string) ?? null,
          artifactId: (vq.artifactId as string) ?? null,
          generationJobId: (vq.generationJobId as string) ?? null,
          generatorKind: (vq.generatorKind as string) ?? "ai",
          status: (vq.status as string) ?? "active",
          rubricVersion: (vq.rubricVersion as string) ?? null,
          sourceFingerprint: (vq.sourceFingerprint as string) ?? null,
          supersededAt: vq.supersededAt ? new Date(vq.supersededAt as string) : null,
          staleReason: (vq.staleReason as string) ?? null,
          lastUsedAt: vq.lastUsedAt ? new Date(vq.lastUsedAt as string) : null,
          useCount: (vq.useCount as number) ?? 0,
        }),
      );

      // 12. 恢复 validation_events（PERF-40 修复：批量 INSERT）
      counts.validationEvents = await restoreTable(
        tx, validationEvents, data.validationEvents,
        (ve) => ({
          id: ve.id as string,
          workspaceId: targetWorkspaceId,
          userId: ve.userId as string,
          cardId: ve.cardId as string,
          keyPointId: (ve.keyPointId as string) ?? null,
          artifactId: (ve.artifactId as string) ?? null,
          question: ve.question as string,
          questionType: ve.questionType as string,
          userAnswer: ve.userAnswer as string,
          outcome: ve.outcome as string,
          confidence: ve.confidence as number,
          feedback: (ve.feedback as ValidationFeedback | null) ?? null,
          questionId: (ve.questionId as string) ?? null,
          jobId: null,
          submissionId: (ve.submissionId as string) ?? null,
          noteVersionId: (ve.noteVersionId as string) ?? null,
          rubricVersion: (ve.rubricVersion as string) ?? null,
          reducerVersion: (ve.reducerVersion as string) ?? null,
          sourceFingerprint: (ve.sourceFingerprint as string) ?? null,
          sourceStatus: (ve.sourceStatus as string) ?? null,
        }),
      );

      // 13. 恢复 review_schedules（PERF-40 修复：批量 INSERT）
      counts.reviewSchedules = await restoreTable(
        tx, reviewSchedules, data.reviewSchedules,
        (rev) => ({
          id: rev.id as string,
          workspaceId: targetWorkspaceId,
          userId: rev.userId as string,
          subjectType: rev.subjectType as string,
          subjectId: rev.subjectId as string,
          validationEventId: (rev.validationEventId as string) ?? null,
          status: (rev.status as string) ?? "pending",
          nextReviewAt: new Date(rev.nextReviewAt as string),
          intervalDays: (rev.intervalDays as number) ?? 1,
          keyPointId: (rev.keyPointId as string) ?? null,
          generation: (rev.generation as number) ?? 1,
          policyVersion: (rev.policyVersion as string) ?? null,
          reasonCode: (rev.reasonCode as string) ?? null,
          supersedesScheduleId: (rev.supersedesScheduleId as string) ?? null,
        }),
      );

      // 13b. 恢复 review_attempts（PERF-40 修复：批量 INSERT）
      // 必须在 review_schedules 之后，因为 review_attempts.review_schedule_id 外键指向 review_schedules。
      counts.reviewAttempts = await restoreTable(
        tx, reviewAttempts, data.reviewAttempts,
        (att) => ({
          id: att.id as string,
          workspaceId: targetWorkspaceId,
          userId: att.userId as string,
          reviewScheduleId: att.reviewScheduleId as string,
          subjectType: att.subjectType as string,
          subjectId: att.subjectId as string,
          validationEventId: (att.validationEventId as string) ?? null,
          validationQuestionId: (att.validationQuestionId as string) ?? null,
          keyPointId: (att.keyPointId as string) ?? null,
          evidenceId: (att.evidenceId as string) ?? null,
          noteVersionId: (att.noteVersionId as string) ?? null,
          answerType: (att.answerType as string) ?? null,
          answerText: (att.answerText as string) ?? null,
          outcome: (att.outcome as string) ?? null,
          confidence: (att.confidence as number) ?? null,
          skipReason: (att.skipReason as string) ?? null,
          scheduleBeforeIntervalDays: (att.scheduleBeforeIntervalDays as number) ?? null,
          scheduleAfterIntervalDays: (att.scheduleAfterIntervalDays as number) ?? null,
          scheduleReasonCode: (att.scheduleReasonCode as string) ?? null,
          understandingEffect: (att.understandingEffect as string) ?? null,
          nextReviewAt: att.nextReviewAt ? new Date(att.nextReviewAt as string) : null,
          nextScheduleId: (att.nextScheduleId as string) ?? null,
          idempotencyKey: att.idempotencyKey as string,
          status: (att.status as string) ?? "started",
          startedAt: att.startedAt ? new Date(att.startedAt as string) : new Date(),
          completedAt: att.completedAt ? new Date(att.completedAt as string) : null,
          abandonedAt: att.abandonedAt ? new Date(att.abandonedAt as string) : null,
          createdAt: att.createdAt ? new Date(att.createdAt as string) : new Date(),
          updatedAt: att.updatedAt ? new Date(att.updatedAt as string) : new Date(),
          evaluationArtifactId: (att.evaluationArtifactId as string) ?? null,
          evaluationStatus: (att.evaluationStatus as string) ?? null,
          assistanceLevel: (att.assistanceLevel as string) ?? null,
          evidenceRevealedAt: att.evidenceRevealedAt ? new Date(att.evidenceRevealedAt as string) : null,
          policyVersion: (att.policyVersion as string) ?? null,
          sourceFingerprint: (att.sourceFingerprint as string) ?? null,
        }),
      );

      // 14. 恢复 understanding_events（PERF-40 修复：批量 INSERT）
      counts.understandingEvents = await restoreTable(
        tx, understandingEvents, data.understandingEvents,
        (ue) => ({
          id: ue.id as string,
          workspaceId: targetWorkspaceId,
          userId: ue.userId as string,
          subjectType: ue.subjectType as string,
          subjectId: ue.subjectId as string,
          eventType: ue.eventType as string,
          payload: (ue.payload as Record<string, unknown>) ?? {},
        }),
      );

      // ═══ v0.6: 可信掌握闭环新表恢复 (计划 §6.9) ═══
      // 依赖顺序：rubric_items → submissions → submission_jobs, action_commands,
      //           assistance_exposures → point_assessments, shadow_decisions,
      //           quality_signals

      // v0.6-15. 恢复 validation_question_rubric_items（PERF-40 修复：批量 INSERT）
      counts.validationQuestionRubricItems = await restoreTable(
        tx, validationQuestionRubricItems, data.validationQuestionRubricItems,
        (ri) => ({
          id: ri.id as string,
          workspaceId: targetWorkspaceId,
          questionId: ri.questionId as string,
          ordinal: ri.ordinal as number,
          criterion: ri.criterion as string,
          expectedConcept: ri.expectedConcept as string,
          weight: (ri.weight as number) ?? 1,
          required: (ri.required as boolean) ?? true,
          evidenceId: (ri.evidenceId as string) ?? null,
          evidenceSnapshot: (ri.evidenceSnapshot as Record<string, unknown>) ?? null,
          createdAt: ri.createdAt ? new Date(ri.createdAt as string) : new Date(),
        }),
      );

      // v0.6-16. 恢复 validation_submissions（PERF-40 修复：批量 INSERT）
      counts.validationSubmissions = await restoreTable(
        tx, validationSubmissions, data.validationSubmissions,
        (sub) => ({
          id: sub.id as string,
          workspaceId: targetWorkspaceId,
          userId: sub.userId as string,
          cardId: sub.cardId as string,
          keyPointId: (sub.keyPointId as string) ?? null,
          questionId: (sub.questionId as string) ?? null,
          context: sub.context as string,
          reviewAttemptId: (sub.reviewAttemptId as string) ?? null,
          inputScheduleId: (sub.inputScheduleId as string) ?? null,
          userAnswer: (sub.userAnswer as string) ?? null,
          selfConfidence: (sub.selfConfidence as number) ?? null,
          draftRevision: (sub.draftRevision as number) ?? 0,
          answerHash: (sub.answerHash as string) ?? null,
          answerLockedAt: sub.answerLockedAt ? new Date(sub.answerLockedAt as string) : null,
          assistanceSnapshotExposedAt: sub.assistanceSnapshotExposedAt ? new Date(sub.assistanceSnapshotExposedAt as string) : null,
          assistanceLevel: (sub.assistanceLevel as string) ?? "none",
          evidenceRevealedAt: sub.evidenceRevealedAt ? new Date(sub.evidenceRevealedAt as string) : null,
          sourceFingerprint: (sub.sourceFingerprint as string) ?? null,
          status: (sub.status as string) ?? "question_preparing",
          currentGenerationJobId: (sub.currentGenerationJobId as string) ?? null,
          currentEvaluationJobId: (sub.currentEvaluationJobId as string) ?? null,
          validationEventId: (sub.validationEventId as string) ?? null,
          failureStage: (sub.failureStage as string) ?? null,
          failureCode: (sub.failureCode as string) ?? null,
          terminalReason: (sub.terminalReason as string) ?? null,
          startIdempotencyKey: sub.startIdempotencyKey as string,
          createdAt: sub.createdAt ? new Date(sub.createdAt as string) : new Date(),
          updatedAt: sub.updatedAt ? new Date(sub.updatedAt as string) : new Date(),
        }),
      );

      // v0.6-17. 恢复 validation_submission_jobs（PERF-40 修复：批量 INSERT）
      counts.validationSubmissionJobs = await restoreTable(
        tx, validationSubmissionJobs, data.validationSubmissionJobs,
        (sj) => ({
          id: sj.id as string,
          submissionId: sj.submissionId as string,
          phase: sj.phase as string,
          phaseOrdinal: (sj.phaseOrdinal as number) ?? 1,
          jobId: sj.jobId as string,
          retryOfJobId: (sj.retryOfJobId as string) ?? null,
          createdAt: sj.createdAt ? new Date(sj.createdAt as string) : new Date(),
        }),
      );

      // v0.6-18. 恢复 validation_action_commands（PERF-40 修复：批量 INSERT）
      counts.validationActionCommands = await restoreTable(
        tx, validationActionCommands, data.validationActionCommands,
        (ac) => ({
          id: ac.id as string,
          workspaceId: targetWorkspaceId,
          userId: ac.userId as string,
          submissionId: (ac.submissionId as string) ?? null,
          action: ac.action as string,
          idempotencyKey: ac.idempotencyKey as string,
          requestHash: ac.requestHash as string,
          responseStatus: (ac.responseStatus as string) ?? "pending",
          responseSnapshot: (ac.responseSnapshot as Record<string, unknown>) ?? null,
          createdAt: ac.createdAt ? new Date(ac.createdAt as string) : new Date(),
          updatedAt: ac.updatedAt ? new Date(ac.updatedAt as string) : new Date(),
        }),
      );

      // v0.6-19. 恢复 validation_assistance_exposures（PERF-40 修复：批量 INSERT）
      counts.validationAssistanceExposures = await restoreTable(
        tx, validationAssistanceExposures, data.validationAssistanceExposures,
        (ae) => ({
          id: ae.id as string,
          workspaceId: targetWorkspaceId,
          userId: ae.userId as string,
          keyPointId: ae.keyPointId as string,
          exposureFingerprint: ae.exposureFingerprint as string,
          lastExposureKind: ae.lastExposureKind as string,
          firstExposedAt: ae.firstExposedAt ? new Date(ae.firstExposedAt as string) : new Date(),
          lastExposedAt: ae.lastExposedAt ? new Date(ae.lastExposedAt as string) : new Date(),
          unassistedEligibleAfter: ae.unassistedEligibleAfter ? new Date(ae.unassistedEligibleAfter as string) : new Date(),
          lastOriginSubmissionId: (ae.lastOriginSubmissionId as string) ?? null,
          inputScheduleId: (ae.inputScheduleId as string) ?? null,
          createdAt: ae.createdAt ? new Date(ae.createdAt as string) : new Date(),
          updatedAt: ae.updatedAt ? new Date(ae.updatedAt as string) : new Date(),
        }),
      );

      // v0.6-20. 恢复 validation_point_assessments（PERF-40 修复：批量 INSERT）
      counts.validationPointAssessments = await restoreTable(
        tx, validationPointAssessments, data.validationPointAssessments,
        (pa) => ({
          id: pa.id as string,
          workspaceId: targetWorkspaceId,
          userId: pa.userId as string,
          submissionId: pa.submissionId as string,
          rubricItemId: pa.rubricItemId as string,
          verdict: pa.verdict as string,
          assessmentSource: pa.assessmentSource as string,
          confidence: (pa.confidence as number) ?? null,
          rationale: (pa.rationale as string) ?? null,
          answerExcerpt: (pa.answerExcerpt as string) ?? null,
          evidenceSnapshot: (pa.evidenceSnapshot as Record<string, unknown>) ?? null,
          createdAt: pa.createdAt ? new Date(pa.createdAt as string) : new Date(),
        }),
      );

      // v0.6-21. 恢复 scheduling_shadow_decisions（PERF-40 修复：批量 INSERT）
      counts.schedulingShadowDecisions = await restoreTable(
        tx, schedulingShadowDecisions, data.schedulingShadowDecisions,
        (sd) => ({
          id: sd.id as string,
          workspaceId: targetWorkspaceId,
          userId: sd.userId as string,
          keyPointId: (sd.keyPointId as string) ?? null,
          sourceType: sd.sourceType as string,
          sourceId: sd.sourceId as string,
          algorithm: sd.algorithm as string,
          algorithmVersion: sd.algorithmVersion as string,
          parametersVersion: sd.parametersVersion as string,
          inputSnapshot: (sd.inputSnapshot as Record<string, unknown>) ?? null,
          predictedDueAt: sd.predictedDueAt ? new Date(sd.predictedDueAt as string) : new Date(),
          stability: (sd.stability as unknown) ?? null,
          difficulty: (sd.difficulty as unknown) ?? null,
          retrievability: (sd.retrievability as unknown) ?? null,
          createdAt: sd.createdAt ? new Date(sd.createdAt as string) : new Date(),
        }),
      );

      // v0.6-22. 恢复 validation_quality_signals（PERF-40 修复：批量 INSERT）
      counts.validationQualitySignals = await restoreTable(
        tx, validationQualitySignals, data.validationQualitySignals,
        (qs) => ({
          id: qs.id as string,
          workspaceId: targetWorkspaceId,
          userId: qs.userId as string,
          validationEventId: qs.validationEventId as string,
          submissionId: (qs.submissionId as string) ?? null,
          reason: qs.reason as string,
          comment: (qs.comment as string) ?? null,
          sourceFingerprint: (qs.sourceFingerprint as string) ?? null,
          rubricVersion: (qs.rubricVersion as string) ?? null,
          reducerVersion: (qs.reducerVersion as string) ?? null,
          policyVersion: (qs.policyVersion as string) ?? null,
          createdAt: qs.createdAt ? new Date(qs.createdAt as string) : new Date(),
        }),
      );

      // 15. 恢复 onboarding_states（PERF-40 修复：批量 INSERT）
      // 必须在 users 和 workspace_members 之后，因为外键指向它们。
      counts.onboardingStates = await restoreTable(
        tx, onboardingStates, data.onboardingStates,
        (os) => ({
          id: os.id as string,
          workspaceId: targetWorkspaceId,
          userId: os.userId as string,
          version: (os.version as string) ?? "v1",
          steps: (os.steps as Record<string, boolean>) ?? {},
          status: (os.status as string) ?? "pending",
          createdAt: os.createdAt ? new Date(os.createdAt as string) : new Date(),
          updatedAt: os.updatedAt ? new Date(os.updatedAt as string) : new Date(),
        }),
      );

    });

    return {
      success: true,
      message: "恢复成功。请由 Owner 为恢复用户设置初始密码，并调用 POST /search/reindex 重建搜索索引。",
      counts,
    };
  } catch (err) {
    logger.error({ err, targetWorkspaceId }, "workspace restore failed");
    return {
      success: false,
      message: "恢复失败：导入数据无效或与目标工作区不兼容",
    };
  }
}

/**
 * 导出单篇笔记为 Markdown。
 *
 * BUG-75 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 */
export async function exportNoteMarkdown(noteId: string, workspaceId: string, userId: string) {
  return withWorkspaceTransaction(
    { workspaceId, userId },
    async (tx) => {
      // CONC-03: 不导出已软删除的笔记
      const note = await tx.query.notes.findFirst({
        where: and(eq(notes.id, noteId), eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt)),
      });
      if (!note) return null;

      const versionId = note.currentVersionId;
      if (!versionId) return null;

      const blocks = await tx.query.noteBlocks.findMany({
        where: eq(noteBlocks.versionId, versionId),
        orderBy: (b, { asc: a }) => [a(b.ordinal)],
      });

      const lines: string[] = [`# ${note.title}`, ""];

      for (const block of blocks) {
        switch (block.type) {
          case "heading":
            lines.push(block.content);
            break;
          case "paragraph":
            lines.push(block.content);
            break;
          case "code":
            // R-015: parser 已保留 code fence（```typescript...```），不再二次包裹
            if (block.content.trim().startsWith("```")) {
              lines.push(block.content);
            } else {
              lines.push("```");
              lines.push(block.content);
              lines.push("```");
            }
            break;
          case "quote":
            // R-015: parser 已保留 > 前缀，不再二次添加
            if (block.content.startsWith(">")) {
              lines.push(block.content);
            } else {
              lines.push(block.content.split("\n").map((l) => `> ${l}`).join("\n"));
            }
            break;
          case "list":
            lines.push(block.content);
            break;
          case "image":
            lines.push(block.content);
            break;
          default:
        lines.push(block.content);
    }
    lines.push("");
  }

      return lines.join("\n");
    },
  );
}
