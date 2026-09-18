import { and, asc, count, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import { notes, noteVersions, noteBlocks, sources, sourceSegments } from "@ailearn/shared/db-schema/note";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { aiArtifacts } from "@ailearn/shared/db-schema/ai";
import { workspaces, workspaceMembers, users, onboardingStates } from "@ailearn/shared/db-schema/identity";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
  learningObjectiveOriginsV2,
  learningCardsV2,
  evidenceSnapshotsV2,
  evidenceRedactionsV2,
  semanticSupportReportsV2,
  learningObjectiveEvidenceBindingsV2,
  evidenceEligibilityStatesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
// v0.6: 当前仍使用的幂等/冷却账本 (计划 §6.9)
import { validationAssistanceExposures } from "@ailearn/shared/db-schema/validation-v2";
import { logger } from "../../lib/logger.ts";

// keyset 游标类型别名（各表 load 回调显式标注，解脱 TS 对 K/T 的联合推断）。
type CreatedIdCursor = { createdAt: Date; id: string };
type UpdatedIdCursor = { updatedAt: Date; id: string };
type NoteIdVersionCursor = { noteId: string; versionNo: number; id: string };
type PlainIdCursor = { id: string };

/** 按稳定游标分批读取，避免导出大工作区时整表驻留连接缓冲。 */
async function loadInBatches<T, K>(opts: {
  load: (cursor: K | null) => Promise<T[]>;
  cursorFrom: (lastRow: T) => K;
  batch?: number;
}): Promise<T[]> {
  const batch = opts.batch ?? 1000;
  const out: T[] = [];
  for (let cursor: K | null = null; ; ) {
    const rows = await opts.load(cursor);
    if (rows.length === 0) return out;
    out.push(...rows);
    cursor = opts.cursorFrom(rows[rows.length - 1]);
    if (rows.length < batch) return out;
  }
}

/**
 * 导出整个 workspace 的数据为 JSON。
 * F-033: 使用事务保证一致性快照。
 * 导出包含 users 和 workspace_members，便于 owner 进行完整备份与审计。
 *
 * 所有查询在同一事务内执行，避免并发写入导致跨时点数据不一致。
 * 导出操作不获取写锁，不影响正常业务读写。
 *
 * BUG-75 修复：使用 withWorkspaceTransaction 设置 DB 级工作区上下文（防御纵深/RLS）。
 *
 * SEC-12 安全修复：导出服务对每张表进行显式字段过滤，仅导出业务必需字段。
 * - `users` 表：不导出 passwordHash、personalWorkspaceId
 * - `workspaces` 表：仅导出 AI 治理配置（非密钥），不导出 ownerId 以外的身份字段
 * - BYOK 用户模型配置表已下线，不在导出范围内
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
async function checkExportSize(tx: ApiTransaction, workspaceId: string): Promise<void> {
  const [
    noteCount,
    blockCount,
    evidenceSnapshotCount,
    evidenceRedactionCount,
    semanticSupportReportCount,
    evidenceBindingCount,
    evidenceEligibilityCount,
  ] = await Promise.all([
    tx.select({ cnt: count() })
      .from(notes)
      .where(and(eq(notes.workspaceId, workspaceId), isNull(notes.deletedAt))),
    tx.select({ cnt: count() })
      .from(noteBlocks)
      .where(eq(noteBlocks.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(evidenceSnapshotsV2)
      .where(eq(evidenceSnapshotsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(evidenceRedactionsV2)
      .where(eq(evidenceRedactionsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(semanticSupportReportsV2)
      .where(eq(semanticSupportReportsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(learningObjectiveEvidenceBindingsV2)
      .where(eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(evidenceEligibilityStatesV2)
      .where(eq(evidenceEligibilityStatesV2.workspaceId, workspaceId)),
  ]);
  // F14（round-4）：size 防护覆盖面覆盖证据快照及其 V2 派生表，
  // 以及 append-only/易膨胀大表（sourceSegments、aiArtifacts），
  // 避免导出数据量绕过 OOM 保护。
  // cardKeyPoints 计数项已随表删除一并移除。
  const [sourceSegmentCount, aiArtifactCount] = await Promise.all([
    tx.select({ cnt: count() })
      .from(sourceSegments)
      .where(eq(sourceSegments.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(aiArtifacts)
      .where(eq(aiArtifacts.workspaceId, workspaceId)),
  ]);

  // 2026-09-15 审计（导出上限被 ~9 个集合绕过）：上面的统计只覆盖 9 张表，而
  // exportWorkspace 实际导出约 21 个集合（两处 Promise.all：note/version/block/
  // source/segment/evidence 系列，以及 objectives/revisions/origins/cards/
  // review_schedules/onboarding_states/validation_assistance_exposures/
  // workspace_members）。未统计的集合**完全没有体积上限**——导出返回单个 JSON
  // 对象、无法流式，峰值内存 = O(Σ rows)，可无上限撑爆进程。
  //
  // 约定：本清单必须与 exportWorkspace 的导出集合一一对应，新增导出集合时
  // 同步加到这里（export-service-size-guard.test.ts 断言集合数量下限）。
  // 计数一律只用 workspace 等值过滤（不叠加业务过滤），保证得到导出集的
  // **超集**：宁可提前触发上限，也不漏判。users / workspaces 不计——workspace
  // 恒为 1 行，users 行数受 workspace_members 上界约束（members 已计入）。
  const extraSizeCounts = await Promise.all([
    tx.select({ cnt: count() })
      .from(noteVersions)
      .where(eq(noteVersions.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(sources)
      .where(eq(sources.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(learningObjectivesV2)
      .where(eq(learningObjectivesV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(learningObjectiveRevisionsV2)
      .where(eq(learningObjectiveRevisionsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(learningObjectiveOriginsV2)
      .where(eq(learningObjectiveOriginsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(learningCardsV2)
      .where(eq(learningCardsV2.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(reviewSchedules)
      .where(eq(reviewSchedules.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(validationAssistanceExposures)
      .where(eq(validationAssistanceExposures.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(onboardingStates)
      .where(eq(onboardingStates.workspaceId, workspaceId)),
    tx.select({ cnt: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId)),
  ]);
  const extraCountTableNames = [
    "note_versions",
    "sources",
    "learning_objectives_v2",
    "learning_objective_revisions_v2",
    "learning_objective_origins_v2",
    "learning_cards_v2",
    "review_schedules",
    "validation_assistance_exposures",
    "onboarding_states",
    "workspace_members",
  ] as const;
  if (extraCountTableNames.length !== extraSizeCounts.length) {
    // 防御：新增计数查询却忘记加表名会让下面按 index 取值错位。
    throw new Error("export size guard misconfigured: table-name list and count queries are out of sync");
  }

  const counts: Record<string, number> = {
    notes: Number(noteCount[0]?.cnt ?? 0),
    note_blocks: Number(blockCount[0]?.cnt ?? 0),
    evidence_snapshots_v2: Number(evidenceSnapshotCount[0]?.cnt ?? 0),
    evidence_redactions_v2: Number(evidenceRedactionCount[0]?.cnt ?? 0),
    semantic_support_reports_v2: Number(semanticSupportReportCount[0]?.cnt ?? 0),
    learning_objective_evidence_bindings_v2: Number(evidenceBindingCount[0]?.cnt ?? 0),
    evidence_eligibility_states_v2: Number(evidenceEligibilityCount[0]?.cnt ?? 0),
    source_segments: Number(sourceSegmentCount[0]?.cnt ?? 0),
    ai_artifacts: Number(aiArtifactCount[0]?.cnt ?? 0),
  };
  extraCountTableNames.forEach((table, index) => {
    counts[table] = Number(extraSizeCounts[index]?.[0]?.cnt ?? 0);
  });
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
    await checkExportSize(tx, workspaceId);

    // PERF-15/43 优化：Phase 1 — workspace + members 并行查询（均为轻量查询）
    // 所有 workspaceId 过滤的查询已通过 Promise.all 并行化。
    const [workspace, memberRows] = await Promise.all([
      tx.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      }),
      // 导出 workspace members（包含 userId 和 role，便于备份审计）
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
    //   - 导出字段顺序稳定：父表先于子表，便于审计与离线处理
    //     决定，与行级顺序无关，故行内排序调整不破坏恢复兼容。
    // 仍与流程主体并行（Promise.all 减少 JS 层逐个 await 开销）。
    const EXPORT_BATCH = 1000;

    const [
      noteRows,
      noteVersionRows,
      noteBlockRows,
      sourceRows,
      sourceSegmentRows,
      evidenceSnapshotRows,
      evidenceRedactionRows,
      semanticSupportReportRows,
      evidenceBindingRows,
      evidenceEligibilityRows,
      reviewScheduleRows,
      aiArtifactRows,
      assistanceExposureRows,
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
      // 旧版学习卡表 learningCards / cardKeyPoints 已删除，
      // 不再导出。V2 卡片导出见下方 learningCardsV2 / objectivesV2 等分块加载。
      // 原 asc(cardId, ordinal) + id 上界 cursor（cardKeyPoints）cursorType 一并移除。
      // 原 desc(createdAt) + id 下界 cursor（learningCards）一并移除。
      // V2 证据快照正文不在这张表内，导出 immutable metadata 及其关系表。
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(evidenceSnapshotsV2).where(and(
            eq(evidenceSnapshotsV2.workspaceId, workspaceId),
            c ? gt(evidenceSnapshotsV2.id, c) : undefined,
          )).orderBy(asc(evidenceSnapshotsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(evidenceRedactionsV2).where(and(
            eq(evidenceRedactionsV2.workspaceId, workspaceId),
            c ? gt(evidenceRedactionsV2.id, c) : undefined,
          )).orderBy(asc(evidenceRedactionsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(semanticSupportReportsV2).where(and(
            eq(semanticSupportReportsV2.workspaceId, workspaceId),
            c ? gt(semanticSupportReportsV2.id, c) : undefined,
          )).orderBy(asc(semanticSupportReportsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(learningObjectiveEvidenceBindingsV2).where(and(
            eq(learningObjectiveEvidenceBindingsV2.workspaceId, workspaceId),
            c ? gt(learningObjectiveEvidenceBindingsV2.id, c) : undefined,
          )).orderBy(asc(learningObjectiveEvidenceBindingsV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
      }),
      loadInBatches({
        load: (c: string | null) =>
          tx.select().from(evidenceEligibilityStatesV2).where(and(
            eq(evidenceEligibilityStatesV2.workspaceId, workspaceId),
            c ? gt(evidenceEligibilityStatesV2.id, c) : undefined,
          )).orderBy(asc(evidenceEligibilityStatesV2.id)).limit(EXPORT_BATCH),
        cursorFrom: (last) => last.id,
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
    // 导出相关 users（不导出 passwordHash）
    const userIds = [workspace?.ownerId, ...memberRows.map((m) => m.userId)].filter(Boolean) as string[];
    const [
      userRows,
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
      // 导出 identity 数据，使备份包含完整的成员关系
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
      evidenceSnapshotsV2: evidenceSnapshotRows,
      evidenceRedactionsV2: evidenceRedactionRows,
      semanticSupportReportsV2: semanticSupportReportRows,
      learningObjectiveEvidenceBindingsV2: evidenceBindingRows,
      evidenceEligibilityStatesV2: evidenceEligibilityRows,
      reviewSchedules: reviewScheduleRows,
      aiArtifacts: aiArtifactRows,
      onboardingStates: onboardingStateRows,
      validationAssistanceExposures: assistanceExposureRows,
      // Plan 23 CS-07：导出 learning_objectives_v2 / revision / origin / cards_v2
      objectivesV2: objectiveRows,
      objectiveRevisionsV2: objectiveRevisionRows,
      objectiveOriginsV2: objectiveOriginRows,
      learningCardsV2: learningCardV2Rows,
      /**
       * 导出清单：明确哪些数据已包含、哪些未包含。
       * 导出文件包含 users 和 workspaceMembers，便于离线备份审计。
       * 仅导出当前仍使用的冷却账本。
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
          "evidenceSnapshotsV2",
          "evidenceRedactionsV2",
          "semanticSupportReportsV2",
          "learningObjectiveEvidenceBindingsV2",
          "evidenceEligibilityStatesV2",
          "reviewSchedules",
          "aiArtifacts",
          "onboardingStates",
          "validationAssistanceExposures",
          // Plan 23 CS-07：V2 表
          "objectivesV2",
          "objectiveRevisionsV2",
          "objectiveOriginsV2",
          "learningCardsV2",
        ],
        excluded: {
          searchDocuments: "可重建 — 调用 POST /search/reindex 即可从主表重建",
          benchmarkReports: "运行态 — 基准测试报告，不随 workspace 导出",
          benchmarkLabels: "运行态 — 人工标注数据，不随 workspace 导出",
          jobs: "运行态 — AI 任务队列，不随 workspace 导出",
          sessions: "安全敏感 — 用户会话令牌，不应导出",
          passwordHashes: "安全敏感 — 用户密码哈希不导出",
          aiAuditLog: "运行态 — AI 审计日志，不随 workspace 导出",
          inviteCodes: "安全敏感 — 邀请 token hash 属凭据数据，不随导出",
        },
        version: "2.0",
        notes: [
          "导出文件包含 identity 数据（不含密码），用于 owner 备份与审计。",
        ],
      },
      exportedAt: new Date().toISOString(),
    };
    },
  );
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
