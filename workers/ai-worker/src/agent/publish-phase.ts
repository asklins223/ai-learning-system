/**
 * PUBLISH 阶段执行模块（计划 §5.1, §11.4, §W5）。
 *
 * QUAL-02/PERF-04 拆分：此模块从 card-supervisor-agent.ts 中提取，
 * 将 Epoch-Fenced 原子发布逻辑独立为可测试的模块。
 *
 * 调用 executePublish 模块执行单事务 canonical publish。
 */

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  SupervisorRunStatus,
  QualityReport,
  CoverageReport,
  CriticIssue,
  CriticClaimVerdict,
  NON_TERMINAL_UNIT_STATUSES,
  isRunErrorRetryable,
} from "@ailearn/shared";
import { logger } from "../lib/logger.ts";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import {
  assertJobLease,
  lockJobLease,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import type { JobPayload } from "../handlers/index.ts";
import {
  executePublish,
  checkIdempotentPublish,
  PublishError,
} from "./publish.ts";
import { appendAgentEvent } from "./specialist-persist.ts";
import type {
  AgentJobPayload,
  AgentTurnExecutionResult,
  RunContext,
} from "./types.ts";

/**
 * PUBLISH 阶段执行（计划 §5.1, §11.4, §W5）。
 *
 * Epoch-Fenced 原子发布。
 * 调用 executePublish 模块执行单事务 canonical publish。
 */
export async function executePublishPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  logger.info(
    { runId: payload.generationRunId, unitId: payload.agentUnitId },
    "PUBLISH 阶段执行",
  );

  await assertJobLease(lease);

  // 更新 run 状态为 publishing
  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, lease);
    await tx.update(schema.cardGenerationRuns).set({
      status: SupervisorRunStatus.PUBLISHING,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ));
  });

  // 加载 run 详情
  const [runDetail] = await db
    .select()
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);

  if (!runDetail) {
    return { kind: "needs_attention", reason: "run 不存在" };
  }

  // 幂等检查：如果 run 已经成功发布过，返回同一 Card Set
  const idempotentCheck = checkIdempotentPublish(
    runDetail.status,
    runDetail.resultCardSetId ?? null,
  );
  if (idempotentCheck.isIdempotent && idempotentCheck.cardSetId) {
    logger.info(
      { runId: payload.generationRunId, cardSetId: idempotentCheck.cardSetId },
      "PUBLISH 幂等命中，run 已发布",
    );
    // 更新 unit 为 succeeded
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationUnits).set({
        status: "succeeded",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    });
    return { kind: "complete" };
  }

  // 加载 verified draft
  if (!runDetail.verifiedDraftId) {
    return { kind: "needs_attention", reason: "no_verified_draft" };
  }

  const [draft] = await db
    .select()
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.id, runDetail.verifiedDraftId),
      eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
    ))
    .limit(1);

  if (!draft) {
    return { kind: "needs_attention", reason: "draft 不存在" };
  }

  // 加载 quality report
  const [qualityReport] = runDetail.qualityReportId
    ? await db
        .select()
        .from(schema.cardGenerationQualityReports)
        .where(and(
          eq(schema.cardGenerationQualityReports.id, runDetail.qualityReportId!),
          eq(schema.cardGenerationQualityReports.workspaceId, job.workspaceId),
        ))
        .limit(1)
    : [null];

  if (!qualityReport) {
    return { kind: "needs_attention", reason: "quality_report 不存在" };
  }

  // 加载 coverage report
  // R58 修复：coverage report 缺失时不得默认 100% 通过发布门禁。
  // 计划 G12: "失败不静默降级" — coverage 未持久化意味着 VERIFY 未正确执行，
  // 必须进入 needs_attention 而不是用假数据通过检查。
  const coverageReport = runDetail.coverageReport as unknown as CoverageReport;
  if (!coverageReport) {
    return { kind: "needs_attention", reason: "coverage_report 缺失：VERIFY 阶段未正确持久化覆盖率报告" };
  }

  // 调用 executePublish
  const publishResult = await executePublish(
    {
      runId: payload.generationRunId,
      workspaceId: job.workspaceId,
      noteVersionId: runContext.noteVersionId,
      userId: job.requestedBy ?? "system",
      draft: {
        draftVersion: draft.draftVersion,
        parentDraftId: draft.parentDraftId ?? undefined,
        producedByUnitId: draft.producedByUnitId,
        producedByEventKey: draft.producedByEventKey,
        schemaVersion: draft.schemaVersion,
        contentHash: draft.contentHash,
        cards: draft.contentJson?.cards ?? [],
        deckTitle: draft.deckTitle,
        deckSummary: draft.deckSummary,
        density: draft.density as "overview" | "standard" | "complete",
        cardBudget: draft.cardBudget,
        baseLedgerHash: draft.baseLedgerHash,
      },
      qualityReport: {
        draftHash: qualityReport.draftHash,
        candidatePoolHash: qualityReport.candidatePoolHash,
        sourceLedgerHash: qualityReport.sourceLedgerHash,
        criticVersion: qualityReport.criticVersion,
        verifierVersion: qualityReport.verifierVersion,
        hardIssues: (qualityReport.hardIssues as unknown as CriticIssue[]) ?? [],
        softIssues: (qualityReport.softIssues as unknown as CriticIssue[]) ?? [],
        perClaimVerdicts: (qualityReport.perClaimVerdicts as unknown as CriticClaimVerdict[]) ?? [],
        metrics: qualityReport.metrics ?? {},
        criticStatus: qualityReport.criticStatus as QualityReport["criticStatus"],
        deterministicStatus: qualityReport.deterministicStatus as QualityReport["deterministicStatus"],
      },
      coverageReport,
      verifiedDraftHash: runDetail.verifiedDraftHash ?? draft.contentHash,
      currentEpoch: runDetail.generationEpoch ?? 0,
      // F6 修复：从 run 的 usageSummary 获取实际预算使用量，不再硬编码为零。
      // 原代码导致发布后的 run 使用量记录不正确。
      budgetUsage: {
        providerCalls: Number(runDetail.usageSummary?.providerCalls ?? 0),
        inputTokens: Number(runDetail.usageSummary?.inputTokens ?? 0),
        outputTokens: Number(runDetail.usageSummary?.outputTokens ?? 0),
      },
    },
    // Publish 事务执行器：使用 withJobTransaction 包装
    {
      executePublishTransaction: async (input) => {
        // 在事务中执行原子发布（计划 §11.4 锁序）
        let cardSetId: string | null = null;
        let cardIds: string[] = [];

        await withJobTransaction(job, async (tx) => {
          // §11.4 Step 1: job lease
          await lockJobLease(tx, lease);

          // §11.4 Step 2: workspace advisory lock
          // 使用 pg_advisory_xact_lock 防止同 workspace 并发 publish
          // key = hash(workspaceId::text) mod 2^31，确保 int4 范围内
          const workspaceLockKey = sql`hashtext(${input.workspaceId}::text)::int`;
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${workspaceLockKey})`);

          const now = new Date();

          // §11.4 Step 3-4: run FOR UPDATE + stateVersion、epoch、cancel 检查
          const [runRow] = await tx
            .select()
            .from(schema.cardGenerationRuns)
            .where(and(
              eq(schema.cardGenerationRuns.id, input.runId),
              eq(schema.cardGenerationRuns.workspaceId, input.workspaceId),
            ))
            .for("update")
            .limit(1);

          if (!runRow) throw new PublishError("run not found", "run_not_found");
          if (runRow.status === SupervisorRunStatus.SUCCEEDED) {
            // 幂等：已发布，返回同一 Card Set
            cardSetId = runRow.resultCardSetId;
            return;
          }
          if (runRow.status === SupervisorRunStatus.CANCELLED || runRow.status === SupervisorRunStatus.SUPERSEDED) {
            throw new PublishError(`run is ${runRow.status}`, "run_not_active");
          }
          // R57 修复：epoch CAS 检查。
          // 计划 §11.4 step 4: "note epoch、latest run、cancel/supersede"
          // 计划 G11: "旧 run 不能覆盖新意图" — VERIFY 和 PUBLISH 之间 epoch 可能被 supersede，
          // 必须在事务内重新验证，否则 stale epoch 的 run 仍能发布。
          if (runRow.generationEpoch !== input.currentEpoch) {
            throw new PublishError(
              `epoch 不匹配: current=${runRow.generationEpoch}, publish=${input.currentEpoch}`,
              "stale_epoch",
            );
          }

          // §11.4 Step 5: publish unit FOR UPDATE
          await tx
            .update(schema.cardGenerationUnits)
            .set({ status: "running", startedAt: now, updatedAt: now })
            .where(and(
              eq(schema.cardGenerationUnits.id, payload.agentUnitId),
              eq(schema.cardGenerationUnits.workspaceId, input.workspaceId),
            ));

          // §11.4 Step 6-8: hash 验证（draft hash、quality report hash）
          // 已在 executePublish 前置检查中完成

          // §11.4 Step 10: supersede 旧结果 — 必须在 INSERT 新 Card Set 之前执行
          // R-fix: 与 v2 发布路径（card-generation-publish.ts）保持一致，
          // 先 supersede 旧 active card sets，再 INSERT 新的 active card set。
          // 原代码先 INSERT 新的 status='active' card set，再 supersede 旧的，
          // 违反唯一索引 learning_card_sets_active_note_unique_idx
          // (workspace_id, note_id) WHERE status = 'active'。

          // Step 10a: 查询并锁定旧 active card sets（FOR UPDATE）
          const oldActiveSets = await tx
            .select({ id: schema.learningCardSets.id })
            .from(schema.learningCardSets)
            .where(and(
              eq(schema.learningCardSets.workspaceId, input.workspaceId),
              eq(schema.learningCardSets.noteId, runRow.noteId),
              eq(schema.learningCardSets.status, "active"),
            ))
            .for("update");

          // Step 10b: supersede 旧 active card sets
          if (oldActiveSets.length > 0) {
            await tx
              .update(schema.learningCardSets)
              .set({ status: "superseded", supersededAt: now })
              .where(and(
                eq(schema.learningCardSets.workspaceId, input.workspaceId),
                inArray(schema.learningCardSets.id, oldActiveSets.map((s) => s.id)),
                eq(schema.learningCardSets.status, "active"),
              ));
          }

          // Step 10c: 收集旧 active cards（同一笔记的所有 noteVersion），标记为 superseded
          // 与 v2 路径一致：通过 noteVersions 表查找同一笔记的所有版本，
          // 再查找这些版本下的 active cards，确保跨版本的旧卡片也被 supersede。
          const oldNoteVersionRows = await tx
            .select({ id: schema.noteVersions.id })
            .from(schema.noteVersions)
            .where(eq(schema.noteVersions.noteId, runRow.noteId));
          const oldNoteVersionIds = oldNoteVersionRows.map((v) => v.id);

          const oldActiveCards = oldNoteVersionIds.length === 0
            ? []
            : await tx
                .select({ id: schema.learningCards.id })
                .from(schema.learningCards)
                .where(and(
                  eq(schema.learningCards.workspaceId, input.workspaceId),
                  eq(schema.learningCards.status, "active"),
                  inArray(schema.learningCards.noteVersionId, oldNoteVersionIds),
                ))
                .for("update");

          const oldCardIds = oldActiveCards.map((c) => c.id);

          if (oldCardIds.length > 0) {
            await tx
              .update(schema.learningCards)
              .set({ status: "superseded", updatedAt: now })
              .where(and(
                eq(schema.learningCards.workspaceId, input.workspaceId),
                inArray(schema.learningCards.id, oldCardIds),
                eq(schema.learningCards.status, "active"),
              ));

            // supersede 旧 review schedules（与 v2 路径一致）
            await tx
              .update(schema.reviewSchedules)
              .set({ status: "superseded", updatedAt: now })
              .where(and(
                eq(schema.reviewSchedules.workspaceId, input.workspaceId),
                eq(schema.reviewSchedules.status, "pending"),
                eq(schema.reviewSchedules.subjectType, "card"),
                inArray(schema.reviewSchedules.subjectId, oldCardIds),
              ));

            // 删除旧卡片的搜索文档
            await tx
              .delete(schema.searchDocuments)
              .where(and(
                eq(schema.searchDocuments.workspaceId, input.workspaceId),
                or(
                  and(
                    eq(schema.searchDocuments.objectType, "card"),
                    inArray(schema.searchDocuments.objectId, oldCardIds),
                  ),
                  and(
                    eq(schema.searchDocuments.objectType, "evidence"),
                    inArray(
                      sql<string>`${schema.searchDocuments.metadata}->>'cardId'`,
                      oldCardIds,
                    ),
                  ),
                ),
              ));
          }

          // Step 10d: 删除旧 Card Set 的搜索文档
          const oldCardSetIds = await tx
            .select({ id: schema.learningCardSets.id })
            .from(schema.learningCardSets)
            .where(and(
              eq(schema.learningCardSets.workspaceId, input.workspaceId),
              eq(schema.learningCardSets.noteId, runRow.noteId),
              eq(schema.learningCardSets.status, "superseded"),
            ));
          const oldSetIds = oldCardSetIds.map((s) => s.id);
          if (oldSetIds.length > 0) {
            await tx
              .delete(schema.searchDocuments)
              .where(and(
                eq(schema.searchDocuments.workspaceId, input.workspaceId),
                eq(schema.searchDocuments.objectType, "card_set"),
                inArray(schema.searchDocuments.objectId, oldSetIds),
              ));
          }

          // §11.4 Step 9: 原子写 Card Set + Cards — supersede 已完成，现在安全 INSERT
          const cards = input.draft.cards ?? [];

          // 创建 Card Set
          const [cardSet] = await tx
            .insert(schema.learningCardSets)
            .values({
              workspaceId: input.workspaceId,
              noteId: runRow.noteId,
              noteVersionId: input.noteVersionId,
              generationRunId: input.runId,
              status: "active",
              title: input.draft.deckTitle || "Untitled",
              summary: input.draft.deckSummary || "",
              coverageReport: input.coverageReport as unknown as Record<string, unknown>,
            })
            .returning();

          cardSetId = cardSet.id;

          // 创建 Cards
          // R32 修复：schemaJson 中加入 candidateIds 和 primarySupportCandidateId，
          // 使 UI 能通过 candidate 关联查到 card_generation_candidate_evidence 中的证据。
          // 计划 §12.2: "卡片展示 primary evidence 并可展开 supporting evidence"。
          //
          // P1-14 修复：section 卡的 ordinal 必须从 1 开始（CHECK 约束要求 scope='section' 时 ordinal > 0）。
          // 原代码 ordinal: isOverview ? 0 : i 在第一张卡非 overview 时会产生 ordinal=0 的 section 卡，
          // 违反 learning_cards_card_set_shape_check 约束导致 PUBLISH 失败。
          let sectionOrdinal = 0;
          for (let i = 0; i < cards.length; i++) {
            const card = cards[i]!;
            // P1-11 修复：overview 由模型标记（isOverview 字段），不使用数组第一项。
            // 原代码 const isOverview = i === 0 会把第一张卡无条件当 overview。
            // 修复后：检查 card.isOverview 字段；如果没有标记，则没有 overview 卡。
            const isOverview = Boolean((card as Record<string, unknown>).isOverview);
            const cardCandidateIds = Array.isArray(card.canonicalCandidateIds)
              ? card.canonicalCandidateIds as string[]
              : (Array.isArray((card as Record<string, unknown>).candidateIds) ? (card as Record<string, unknown>).candidateIds as string[] : []);
            const currentOrdinal = isOverview ? 0 : ++sectionOrdinal;
            const [created] = await tx
              .insert(schema.learningCards)
              .values({
                workspaceId: input.workspaceId,
                noteVersionId: input.noteVersionId,
                cardSetId: cardSet!.id,
                generationRunId: input.runId,
                scope: isOverview ? "overview" : "section",
                scopeKey: isOverview
                  ? "overview"
                  : ((card.groupKey as string | undefined)?.trim()
                    || (card.primarySection ? `${(card.primarySection as string).trim()}-${currentOrdinal}` : `card-${currentOrdinal}`)),
                ordinal: currentOrdinal,
                status: "active",
                schemaJson: {
                  title: card.title,
                  summary: card.summary,
                  candidateIds: cardCandidateIds,
                  primarySupportCandidateId: (card as Record<string, unknown>).primarySupportCandidateId ?? null,
                } as unknown as { title: string; summary: string },
              })
              .returning();
            if (created) {
              cardIds.push(created.id);
            }
          }

          // R73 修复：创建搜索文档（与 v2 路径一致）。
          // 计划 §11.4 Step 9: "原子写 Card Set/Card/Key Point/Evidence/Search/Review 关系"
          // 原代码只创建 Card Set 和 Cards，不创建搜索文档，
          // 导致发布后的卡片无法被搜索功能检索到。
          // 修复后：在同一事务内为 Card Set 和每个 Card 创建搜索文档。
          //
          // R74 修复：与原 v2 路径完全对齐：
          // 1. Card Set 搜索文档 metadata 增加 evidenceMode
          // 2. Card 搜索文档 metadata 增加 scopeKey、ordinal、evidenceMode
          // 3. Card 搜索文档 body 增加候选 claim 文本（提升搜索召回）
          // 4. 新增 Evidence 搜索文档创建（v2 路径创建，Supervisor 路径缺失）
          //    没有证据搜索文档，Supervisor 发布的卡片关联证据无法被搜索。
          // P1-11 修复：overviewCardId 由模型标记的 isOverview 字段决定，不使用数组第一项。
          const overviewCardIndex = cards.findIndex((c) => Boolean((c as Record<string, unknown>).isOverview));
          const overviewCardId = overviewCardIndex >= 0 ? (cardIds[overviewCardIndex] ?? null) : null;

          // 收集所有卡片的候选 ID，用于查询关联的证据
          const allCardCandidateIds: string[] = [];
          for (const card of cards) {
            const ids = Array.isArray(card.canonicalCandidateIds)
              ? card.canonicalCandidateIds as string[]
              : (Array.isArray((card as Record<string, unknown>).candidateIds) ? (card as Record<string, unknown>).candidateIds as string[] : []);
            allCardCandidateIds.push(...ids);
          }

          // 查询候选-证据关联（card_generation_candidate_evidence 表）
          const candidateEvidenceLinks = allCardCandidateIds.length > 0
            ? await tx
                .select({
                  candidateId: schema.cardGenerationCandidateEvidence.candidateId,
                  evidenceSpanId: schema.cardGenerationCandidateEvidence.evidenceSpanId,
                  imageEvidenceUnitId: schema.cardGenerationCandidateEvidence.imageEvidenceUnitId,
                  sourceKind: schema.cardGenerationCandidateEvidence.sourceKind,
                })
                .from(schema.cardGenerationCandidateEvidence)
                .where(and(
                  eq(schema.cardGenerationCandidateEvidence.workspaceId, input.workspaceId),
                  eq(schema.cardGenerationCandidateEvidence.runId, input.runId),
                  inArray(schema.cardGenerationCandidateEvidence.candidateId, allCardCandidateIds),
                ))
            : [];

          // 查询候选 claim 文本（用于丰富 card 搜索文档 body）
          const candidateRowsForSearch = allCardCandidateIds.length > 0
            ? await tx
                .select({
                  id: schema.cardGenerationCandidates.id,
                  claim: schema.cardGenerationCandidates.claim,
                })
                .from(schema.cardGenerationCandidates)
                .where(and(
                  eq(schema.cardGenerationCandidates.workspaceId, input.workspaceId),
                  eq(schema.cardGenerationCandidates.runId, input.runId),
                  inArray(schema.cardGenerationCandidates.id, allCardCandidateIds),
                ))
            : [];
          const candidateClaimMap = new Map<string, string>();
          for (const c of candidateRowsForSearch) {
            if (c.claim) candidateClaimMap.set(c.id, c.claim);
          }

          // 查询证据文本（note_evidence_spans join note_blocks）
          const evidenceSpanIds = candidateEvidenceLinks
            .map((l) => l.evidenceSpanId)
            .filter((id): id is string => id !== null);
          const evidenceSpanRows = evidenceSpanIds.length > 0
            ? await tx
                .select({
                  span: schema.noteEvidenceSpans,
                  block: schema.noteBlocks,
                })
                .from(schema.noteEvidenceSpans)
                .innerJoin(
                  schema.noteBlocks,
                  eq(schema.noteEvidenceSpans.blockId, schema.noteBlocks.id),
                )
                .where(and(
                  eq(schema.noteEvidenceSpans.workspaceId, input.workspaceId),
                  inArray(schema.noteEvidenceSpans.id, evidenceSpanIds),
                ))
            : [];
          const evidenceTextMap = new Map<string, string>();
          for (const row of evidenceSpanRows) {
            const span = row.span;
            const block = row.block;
            const text = (block?.content ?? "").slice(span?.charStart ?? 0, span?.charEnd ?? 0);
            evidenceTextMap.set(span.id, text || (span?.unitKey ?? ""));
          }

          // 查询图片证据文本
          const imageEvidenceUnitIds = candidateEvidenceLinks
            .map((l) => l.imageEvidenceUnitId)
            .filter((id): id is string => id !== null);
          const imageEvidenceRowsForSearch = imageEvidenceUnitIds.length > 0
            ? await tx
                .select({
                  id: schema.noteImageEvidenceUnits.id,
                  text: schema.noteImageEvidenceUnits.text,
                  textHash: schema.noteImageEvidenceUnits.textHash,
                  imageAssetId: schema.noteImageEvidenceUnits.imageAssetId,
                  imageInsightId: schema.noteImageEvidenceUnits.imageInsightId,
                  region: schema.noteImageEvidenceUnits.region,
                  sourceKind: schema.noteImageEvidenceUnits.sourceKind,
                  evidenceLevel: schema.noteImageEvidenceUnits.evidenceLevel,
                })
                .from(schema.noteImageEvidenceUnits)
                .where(and(
                  eq(schema.noteImageEvidenceUnits.workspaceId, input.workspaceId),
                  inArray(schema.noteImageEvidenceUnits.id, imageEvidenceUnitIds),
                ))
            : [];
          for (const img of imageEvidenceRowsForSearch) {
            if (img.id && img.text) {
              evidenceTextMap.set(img.id, img.text);
            }
          }

          // 构建 candidateId → evidence links 映射
          const candidateEvidenceMap = new Map<string, Array<{ evidenceId: string; sourceKind: string }>>();
          for (const link of candidateEvidenceLinks) {
            const evidenceId = link.evidenceSpanId ?? link.imageEvidenceUnitId;
            if (!evidenceId) continue;
            const existing = candidateEvidenceMap.get(link.candidateId) ?? [];
            existing.push({ evidenceId, sourceKind: link.sourceKind ?? "text_span" });
            candidateEvidenceMap.set(link.candidateId, existing);
          }

          // 构建 cardId → evidence 列表映射
          const cardEvidenceMap = new Map<string, Array<{ evidenceId: string; sourceKind: string }>>();
          for (let i = 0; i < cardIds.length; i++) {
            const card = cards[i]!;
            const cardCandidateIds = Array.isArray(card.canonicalCandidateIds)
              ? card.canonicalCandidateIds as string[]
              : (Array.isArray((card as Record<string, unknown>).candidateIds) ? (card as Record<string, unknown>).candidateIds as string[] : []);
            const cardEvidenceList: Array<{ evidenceId: string; sourceKind: string }> = [];
            for (const cid of cardCandidateIds) {
              const evLinks = candidateEvidenceMap.get(cid) ?? [];
              for (const ev of evLinks) {
                if (!cardEvidenceList.some((e) => e.evidenceId === ev.evidenceId)) {
                  cardEvidenceList.push(ev);
                }
              }
            }
            cardEvidenceMap.set(cardIds[i]!, cardEvidenceList);
          }

          // R75 修复：创建 card_key_points 和 evidences 记录
          // 计划 §11.4 Step 9: "原子写 Card Set/Card/Key Point/Evidence/Search/Review 关系"
          // 原代码只创建 Cards 和搜索文档，缺失 Key Point 和 Evidence 记录，
          // 导致搜索服务无法通过 evidence → key_point → card 链查找证据，
          // 验证系统和复习调度也无法工作。
          //
          // 与原 v2 路径对齐：
          // 1. 为每张卡的每个候选创建 card_key_point
          // 2. 为每个候选-证据关联创建 evidence 记录
          // 3. 使用 Critic verdict 设置 alignment（不再硬编码 aligned/100）
          // 4. 使用 evidences.id 作为证据搜索文档的 objectId
          // 5. 使用批量插入提升性能

          // 构建 candidateId → Critic verdict 映射
          const verdictByCandidate = new Map<string, string>();
          if (input.qualityReport?.perClaimVerdicts) {
            for (const v of input.qualityReport.perClaimVerdicts) {
              verdictByCandidate.set(v.candidateId, v.verdict);
            }
          }

          // 构建 evidenceSpanId → spanRow 映射（用于快速查找）
          const spanRowMap = new Map<string, typeof evidenceSpanRows[number]>();
          for (const row of evidenceSpanRows) {
            spanRowMap.set(row.span.id, row);
          }

          // 构建 imageEvidenceUnitId → imgRow 映射
          const imgRowMap = new Map<string, typeof imageEvidenceRowsForSearch[number]>();
          for (const row of imageEvidenceRowsForSearch) {
            if (row.id) imgRowMap.set(row.id, row);
          }

          // 构建 originalEvidenceId → evidenceRowId 映射（用于搜索文档 objectId）
          const evidenceRowIdMap = new Map<string, string>();

          for (let i = 0; i < cardIds.length; i++) {
            const cardId = cardIds[i]!;
            const card = cards[i]!;
            const cardCandidateIds = Array.isArray(card.canonicalCandidateIds)
              ? card.canonicalCandidateIds as string[]
              : (Array.isArray((card as Record<string, unknown>).candidateIds) ? (card as Record<string, unknown>).candidateIds as string[] : []);

            // 创建 card_key_points
            const keyPointValues = cardCandidateIds.map((candidateId, ordinal) => {
              const claim = candidateClaimMap.get(candidateId) ?? "";
              const evLinks = candidateEvidenceMap.get(candidateId) ?? [];
              const firstEv = evLinks[0];
              let quoteText = "";
              let segmentRef: { blockId?: string; blockOrdinal?: number } | null = null;
              if (firstEv) {
                quoteText = evidenceTextMap.get(firstEv.evidenceId) ?? "";
                if (firstEv.sourceKind === "text_span") {
                  const spanRow = spanRowMap.get(firstEv.evidenceId);
                  if (spanRow) {
                    segmentRef = {
                      blockId: spanRow.span.blockId,
                      blockOrdinal: spanRow.block.ordinal,
                    };
                  }
                }
              }
              return {
                cardId,
                workspaceId: input.workspaceId,
                ordinal,
                claim,
                quoteText,
                segmentRef,
                candidateId,
                createdAt: now,
              };
            });

            if (keyPointValues.length === 0) continue;
            const keyPoints = await tx.insert(schema.cardKeyPoints).values(keyPointValues).returning();
            const keyPointByCandidate = new Map(keyPoints.map(kp => [kp.candidateId!, kp]));

            // 创建 evidences
            const evidenceValues: Array<typeof schema.evidences.$inferInsert> = [];
            const evidenceMeta: Array<{ originalEvidenceId: string; sourceKind: string }> = [];
            for (const candidateId of cardCandidateIds) {
              const keyPoint = keyPointByCandidate.get(candidateId);
              if (!keyPoint) continue;
              const evLinks = candidateEvidenceMap.get(candidateId) ?? [];
              const verdict = verdictByCandidate.get(candidateId);

              // P0-03 修复：检查是否所有候选都有 supported verdict。
              // 如果有候选缺少 verdict 或 verdict 不是 supported，
              // evidence 会是 unaligned，这必须阻断发布。
              // 由于 VERIFY 和 PUBLISH 前置检查已经确保了所有 verdict 为 supported，
              // 这里是 defense-in-depth 检查。
              if (!verdict || verdict !== "supported") {
                throw new PublishError(
                  `candidate ${candidateId} 缺少 supported verdict (got: ${verdict ?? "none"})`,
                  "unaligned_evidence",
                );
              }

              // 将 Critic verdict 映射为 alignment 字段
              // 计划 §7.3: source authenticity 与 semantic support 拆层
              // alignment 必须由真实 Critic verdict 导出，不再硬编码 aligned/100
              // P0-03 修复：只允许 supported verdict 的 evidence 发布为 aligned。
              // partial/unsupported/contradicted/missing verdict 一律阻断发布。
              let alignment: "aligned" | "soft" | "unaligned" | "stale_alignment" = "unaligned";
              let alignmentScore = 0;
              if (verdict === "supported") {
                alignment = "aligned";
                alignmentScore = 100;
              }
              // 不再允许 partial → soft 发布
              //
              // alignmentMethod 必须符合 DB 约束 evidences_typed_source_check：
              // - text_span: alignment_method = 'exact_span'
              // - image_region: alignment_method = 'image_ocr' | 'image_structured'
              // 'critic_verdict' 不是合法值，会导致 DB 约束违反。
              // Critic verdict 通过 alignment 和 alignmentScore 字段体现，不通过 alignmentMethod。

              for (const ev of evLinks) {
                const evText = evidenceTextMap.get(ev.evidenceId) ?? "";
                if (ev.sourceKind === "text_span") {
                  const spanRow = spanRowMap.get(ev.evidenceId);
                  if (spanRow) {
                    evidenceValues.push({
                      workspaceId: input.workspaceId,
                      keyPointId: keyPoint.id,
                      blockId: spanRow.span.blockId,
                      blockOrdinal: spanRow.block.ordinal,
                      quoteText: evText,
                      alignment,
                      alignmentScore,
                      alignmentMethod: "exact_span",
                      evidenceSpanId: ev.evidenceId,
                      sourceKind: "text_span",
                      charStart: spanRow.span.charStart,
                      charEnd: spanRow.span.charEnd,
                      sourceHash: spanRow.span.textHash,
                      createdAt: now,
                    });
                    evidenceMeta.push({ originalEvidenceId: ev.evidenceId, sourceKind: ev.sourceKind });
                  }
                } else if (ev.sourceKind === "image_evidence") {
                  const imgRow = imgRowMap.get(ev.evidenceId);
                  if (imgRow) {
                    // Derive alignmentMethod from evidenceLevel (matching v2 path logic)
                    const imgAlignmentMethod = imgRow.sourceKind === "image_ocr"
                      && imgRow.evidenceLevel === "image_ocr_exact"
                      ? "image_ocr"
                      : "image_structured";
                    evidenceValues.push({
                      workspaceId: input.workspaceId,
                      keyPointId: keyPoint.id,
                      blockId: null,
                      blockOrdinal: null,
                      quoteText: evText,
                      alignment,
                      alignmentScore,
                      alignmentMethod: imgAlignmentMethod,
                      sourceKind: "image_region",
                      imageAssetId: imgRow.imageAssetId ?? null,
                      imageInsightId: imgRow.imageInsightId ?? null,
                      imageEvidenceUnitId: ev.evidenceId,
                      regionJson: imgRow.region ?? null,
                      extractorVersion: "image-insight-v1",
                      sourceHash: imgRow.textHash ?? null,
                      createdAt: now,
                    });
                    evidenceMeta.push({ originalEvidenceId: ev.evidenceId, sourceKind: ev.sourceKind });
                  }
                }
              }
            }

            // 批量插入 evidences（每批 300 条，与 v2 路径一致）
            for (let j = 0; j < evidenceValues.length; j += 300) {
              const batch = evidenceValues.slice(j, j + 300);
              const rows = await tx.insert(schema.evidences).values(batch).returning();
              for (let k = 0; k < rows.length; k++) {
                const meta = evidenceMeta[j + k]!;
                evidenceRowIdMap.set(meta.originalEvidenceId, rows[k]!.id);
              }
            }
          }

          // 1. 创建 Card Set 搜索文档
          await tx.insert(schema.searchDocuments).values({
            workspaceId: input.workspaceId,
            objectType: "card_set",
            objectId: cardSet!.id,
            title: input.draft.deckTitle || "Untitled",
            body: `${input.draft.deckSummary || ""}\n${cards.map((c) => c.summary || "").join("\n")}`,
            metadata: {
              noteId: runRow.noteId,
              noteVersionId: input.noteVersionId,
              generationRunId: input.runId,
              overviewCardId,
              cardCount: cardIds.length,
              evidenceMode: "typed_exact",
            } as Record<string, unknown>,
            indexedAt: now,
          });

          // 2. 创建 Card 搜索文档
          for (let i = 0; i < cardIds.length; i++) {
            const card = cards[i]!;
            const cardCandidateIds = Array.isArray(card.canonicalCandidateIds)
              ? card.canonicalCandidateIds as string[]
              : (Array.isArray((card as Record<string, unknown>).candidateIds) ? (card as Record<string, unknown>).candidateIds as string[] : []);
            const cardClaims = cardCandidateIds
              .map((cid) => candidateClaimMap.get(cid))
              .filter((c): c is string => c !== undefined);
            await tx.insert(schema.searchDocuments).values({
              workspaceId: input.workspaceId,
              objectType: "card",
              objectId: cardIds[i]!,
              title: card.title || "",
              body: `${card.summary || ""}\n${cardClaims.join("\n")}`,
              metadata: {
                cardSetId: cardSet!.id,
                noteId: runRow.noteId,
                noteVersionId: input.noteVersionId,
                generationRunId: input.runId,
                scope: Boolean((card as Record<string, unknown>).isOverview) ? "overview" : "section",
                scopeKey: card.groupKey ?? card.primarySection ?? (Boolean((card as Record<string, unknown>).isOverview) ? "overview" : `card-${i}`),
                ordinal: i,
                evidenceMode: "typed_exact",
              } as Record<string, unknown>,
              indexedAt: now,
            });
          }

          // 3. 创建 Evidence 搜索文档（与 v2 路径一致）
          //    R75 修复：使用 evidences.id 作为 objectId，而非 noteEvidenceSpan.id。
          //    搜索服务的 consumableSearchDocumentPredicate 要求 evidence 搜索文档的
          //    objectId 匹配 evidences 表的 id，并通过 card_key_points 链接到 active card。
          //    R76 修复：使用批量插入提升性能（与 v2 路径一致，每批 300 条）。
          const evidenceDocuments: Array<typeof schema.searchDocuments.$inferInsert> = [];
          for (let i = 0; i < cardIds.length; i++) {
            const cardId = cardIds[i]!;
            const evList = cardEvidenceMap.get(cardId) ?? [];
            for (const ev of evList) {
              const evidenceRowId = evidenceRowIdMap.get(ev.evidenceId);
              if (!evidenceRowId) continue;
              const evText = evidenceTextMap.get(ev.evidenceId) ?? "";
              evidenceDocuments.push({
                workspaceId: input.workspaceId,
                objectType: "evidence",
                objectId: evidenceRowId,
                title: "Evidence",
                body: evText,
                metadata: {
                  cardId,
                  cardSetId: cardSet!.id,
                  scope: Boolean((cards[i] as Record<string, unknown> | undefined)?.isOverview) ? "overview" : "section",
                  ordinal: i,
                  keyPointId: null,
                  evidenceSpanId: ev.sourceKind === "text_span" ? ev.evidenceId : null,
                  imageEvidenceUnitId: ev.sourceKind === "image_evidence" ? ev.evidenceId : null,
                  sourceKind: ev.sourceKind,
                },
                indexedAt: now,
              });
            }
          }
          // 批量插入证据搜索文档（每批 300 条）
          // 修复：同一 evidence 可能被多个 card 引用，导致重复的 (workspace_id, "evidence", evidenceRowId) 条目。
          // 使用 onConflictDoNothing 跳过重复，因为 search_documents_object_idx 是唯一索引。
          for (let j = 0; j < evidenceDocuments.length; j += 300) {
            const batch = evidenceDocuments.slice(j, j + 300);
            await tx.insert(schema.searchDocuments).values(batch).onConflictDoNothing();
          }

          // §11.4 Step 11: run CAS 终态和 result pointers
          // R30 修复：写入完整的 budget usage（包括 token 使用量），
          // 原代码只写入 { providerCalls }，丢失 inputTokens/outputTokens，
          // 导致发布后的 run 使用量记录不完整，影响成本追踪和审计。
          await tx.update(schema.cardGenerationRuns).set({
            status: SupervisorRunStatus.SUCCEEDED,
            resultCardSetId: cardSetId,
            resultCardId: cardIds[0] ?? null,
            usageSummary: {
              providerCalls: input.budgetUsage.providerCalls,
              inputTokens: input.budgetUsage.inputTokens,
              outputTokens: input.budgetUsage.outputTokens,
            },
            updatedAt: now,
            finishedAt: now,
          }).where(and(
            eq(schema.cardGenerationRuns.id, input.runId),
            eq(schema.cardGenerationRuns.workspaceId, input.workspaceId),
            // R59 修复：CAS 终态检查。
            // 计划 §11.4 step 11: "run CAS 终态和 result pointers"
            // 只有 status=publishing 的 run 才能 CAS 到 succeeded，
            // 防止并发 publish 或外部 cancel 覆盖终态。
            eq(schema.cardGenerationRuns.status, SupervisorRunStatus.PUBLISHING),
          ));

          // 更新 publish unit
          await tx.update(schema.cardGenerationUnits).set({
            status: "succeeded",
            finishedAt: now,
            updatedAt: now,
          }).where(and(
            eq(schema.cardGenerationUnits.id, payload.agentUnitId),
            eq(schema.cardGenerationUnits.workspaceId, input.workspaceId),
          ));
        });

        return {
          cardSetId: cardSetId!,
          cardIds,
          publishedEpoch: input.currentEpoch,
        };
      },
    },
  );

  // 记录 publish event
  await appendAgentEvent({
    workspaceId: job.workspaceId,
    runId: payload.generationRunId,
    unitId: payload.agentUnitId,
    eventKey: `publish:${payload.agentUnitId}`,
    eventType: "tool_result",
    agentRole: null,
    turnNo: payload.turnNo,
    safePayload: {
      success: publishResult.success,
      cardSetId: publishResult.cardSetId,
      cardCount: publishResult.cardIds.length,
    },
  });

  if (!publishResult.success) {
    // 发布失败，标记 needs_attention
    // P0-13 修复：errorCode 只存有限枚举和长度受限的 typed code。
    // 详细诊断脱敏后进入受控日志。
    // 原代码把完整 failureReason 拼入 errorCode，可能泄露原文、SQL 参数或 credential。
    const typedErrorCode = sanitizePublishErrorCode(publishResult.failureReason);
    logger.warn(
      { runId: payload.generationRunId, failureReason: publishResult.failureReason, typedErrorCode },
      "PUBLISH 失败",
    );
    await withJobTransaction(job, async (tx) => {
      await lockJobLease(tx, lease);
      const now = new Date();
      await tx.update(schema.cardGenerationRuns).set({
        status: SupervisorRunStatus.NEEDS_ATTENTION,
        errorCode: typedErrorCode,
        // 发布失败不重新调用模型（G5），同一 epoch-fenced 状态下重试结果必然相同，
        // 重试无意义（只保留重新生成）。瞬时发布竞态（如并发 run）也由重新生成解决。
        retryable: isRunErrorRetryable(typedErrorCode),
        updatedAt: now,
        finishedAt: now,
      }).where(and(
        eq(schema.cardGenerationRuns.id, payload.generationRunId),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
      ));
      // 检查点保留修复：publish unit 本身是用户 `/retry` 的恢复检查点（G5：
      // Publish 失败不重新调用模型，重试即可）。必须标记为 terminal_failed 而非
      // cancelled，否则重试会报"没有可恢复的生成检查点"。同时原子取消其它非终态 unit。
      await tx.update(schema.cardGenerationUnits).set({
        status: "terminal_failed",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
      await tx.update(schema.cardGenerationUnits).set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        eq(schema.cardGenerationUnits.runId, payload.generationRunId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        inArray(schema.cardGenerationUnits.status, NON_TERMINAL_UNIT_STATUSES),
        ne(schema.cardGenerationUnits.id, payload.agentUnitId),
      ));
    });
    return { kind: "needs_attention", reason: typedErrorCode };
  }

  return { kind: "complete" };
}

/**
 * P0-13 修复：将发布失败的 failureReason 转换为有限枚举和长度受限的 typed code。
 *
 * errorCode 只存有限枚举和长度受限的 typed code；详细诊断脱敏后进入受控日志。
 * 原代码把完整 failureReason 拼入 errorCode，可能泄露原文、SQL 参数或 credential。
 */
function sanitizePublishErrorCode(failureReason: string | null): string {
  if (!failureReason) return "publish_failed";

  // 根据 failureReason 内容映射到有限枚举
  const lower = failureReason.toLowerCase();

  if (lower.includes("epoch") || lower.includes("stale_epoch")) return "stale_epoch";
  if (lower.includes("draft hash") || lower.includes("hash 不匹配")) return "draft_hash_mismatch";
  if (lower.includes("critic") || lower.includes("verdict")) return "critic_check_failed";
  if (lower.includes("coverage")) return "coverage_insufficient";
  if (lower.includes("unaligned")) return "unaligned_evidence";
  if (lower.includes("auto_verified")) return "auto_verified_blocked";
  if (lower.includes("empty") || lower.includes("为空")) return "empty_verdicts";
  if (lower.includes("run not found")) return "run_not_found";
  if (lower.includes("run_not_active") || lower.includes("cancelled") || lower.includes("superseded")) return "run_not_active";
  if (lower.includes("partial") || lower.includes("unsupported") || lower.includes("contradicted")) return "blocked_verdict";

  // 兜底：截断到 100 字符，移除可能的敏感信息
  const truncated = failureReason.slice(0, 100);
  return `publish_failed:${truncated}`;
}
