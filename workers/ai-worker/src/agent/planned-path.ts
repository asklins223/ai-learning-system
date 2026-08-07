import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { composeArtifactSchema } from "@ailearn/shared";
import { db, withWorkerWorkspaceTransaction } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { AgentJobPayload, RunContext } from "./types.ts";
import { assertJobLease, type JobLeaseContext } from "../lib/job-lease.ts";
import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import { scheduleCriticForDraft } from "./tools/quality.ts";
import { autoProgressAfterChildUnit } from "./pipeline-auto-progress.ts";
import { resumeParentSupervisorIfNeeded } from "./specialist-persist.ts";import { createNextTurnJob, createSupervisorUnit } from "./unit-helpers.ts";
import { BudgetTracker } from "./budget.ts";
import type { AgentTurnExecutionResult } from "./types.ts";

/**
 * P3 Planned 路径执行(P3-4 接线;全量审计缺口)。
 *
 * - executePlannedSpecialistPhase:单个 bundle 提取(plan 驱动,单次 provider 调用,
 *   决策写入正式 candidate 表,bundleId 归属);失败→升级 Full(失败 Artifact 不发布)
 * - executePlannedComposePhase:全部 specialist 完成后组合(读 candidates→单次 provider
 *   →composeArtifactSchema 校验→Draft 幂等提交→P1-1 自动 Critic)
 *
 * Gap Detection / Bounded Replan 由 plan-path 的 children 完成分支驱动(见 executePlanGenerationPhase)。
 */

// ─── provider 解析(与 fast-path 共享模式) ───────────────────────────────

async function resolveProvider(job: JobPayload, payload: AgentJobPayload): Promise<AIProvider> {
  const [run] = await db
    .select({ providerSnapshot: schema.cardGenerationRuns.providerSnapshot })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);
  const snap = (run?.providerSnapshot as Record<string, unknown>) ?? {};
  const providerName = (snap.providerName as string) ?? "mock";
  const config = (snap.config as Record<string, unknown>) ?? {};
  const provider = await createProvider(providerName, {
    apiKey: (config.apiKey as string) ?? null,
    baseUrl: (config.baseUrl as string) ?? null,
    model: (config.model as string) ?? null,
    visionModel: (config.visionModel as string) ?? null,
  } as never);
  if (!provider) throw new Error("provider 解析失败");
  return provider;
}

async function loadBlocksForRun(job: JobPayload, payload: AgentJobPayload): Promise<Array<{ id: string; ordinal: number; type: string; content: string }>> {
  const [run] = await db
    .select({ noteVersionId: schema.cardGenerationRuns.noteVersionId })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);
  if (!run) throw new Error("run 不存在");
  return db
    .select({
      id: schema.noteBlocks.id,
      ordinal: schema.noteBlocks.ordinal,
      type: schema.noteBlocks.type,
      content: schema.noteBlocks.content,
    })
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.versionId, run.noteVersionId))
    .orderBy(schema.noteBlocks.ordinal);
}

// ─── PLANNED_SPECIALIST 执行 ────────────────────────────────────────────

const SPECIALIST_PROMPT = `你是学习卡生成的专项提取 Specialist。根据给定的提取重点,从笔记内容中提取知识点。
严格输出 JSON：
{"bundleId":"<bundle>","candidates":[{"localId":"c1","topic":"<主题>","claim":"<单句命题>","sectionKey":"<段落>","evidenceRefIds":["<block-id>"],"cognitiveType":"concept|procedure|example","importance":"low|medium|high","difficulty":"low|medium|high"}],
 "noCandidateDecisions":[{"bundleId":"<bundle>","reason":"no_candidate|insufficient_evidence","detail":"..."}]}
约束:claim 必须是被证据支持的单句命题;evidenceRefIds 必须是给定内容块 id。不得输出 JSON 以外的内容。`;

export async function executePlannedSpecialistPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  await assertJobLease(lease);
  // manifest 存于 unit 表(AgentJobPayload 不含 inputManifest)
  const [unitRow] = await db
    .select({ inputManifest: schema.cardGenerationUnits.inputManifest })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ))
    .limit(1);
  const manifest = (unitRow?.inputManifest as Record<string, unknown>) ?? {};
  const bundleId = String(manifest.bundleId ?? "");
  const specialist = String(manifest.specialist ?? "text_extractor");
  const extractionFocus = String(manifest.extractionFocus ?? "");
  const replanVersion = Number(manifest.replanVersion ?? 1);
  logger.info(
    { runId: payload.generationRunId, unitId: payload.agentUnitId, bundleId, specialist, replanVersion },
    "PLANNED_SPECIALIST 阶段执行",
  );

  // 幂等:该 bundle 已有本 replanVersion 的候选 → 直接完成
  const existingCandidates = await db
    .select({ id: schema.cardGenerationCandidates.id })
    .from(schema.cardGenerationCandidates)
    .where(and(
      eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
      eq(schema.cardGenerationCandidates.runId, payload.generationRunId),
      eq(schema.cardGenerationCandidates.bundleId, bundleId),
      eq(schema.cardGenerationCandidates.originAgentEventKey, `planned_specialist:${payload.agentUnitId}:rv${replanVersion}`),
    ))
    .limit(1);
  if (existingCandidates) {
    logger.info({ runId: payload.generationRunId, bundleId }, "PLANNED_SPECIALIST: 该 bundle 候选已存在(幂等复用)");
    await markFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }

  const blocks = await loadBlocksForRun(job, payload);
  const evidenceText = blocks
    .map((b) => `[${b.id}] ${b.content}`)
    .join("\n");

  try {
    const provider = await resolveProvider(job, payload);
    const res = await provider.chatCompletion(
      [
        { role: "system", content: SPECIALIST_PROMPT },
        { role: "user", content: `## Bundle: ${bundleId}\n## 提取重点\n${extractionFocus}\n\n## 笔记内容\n${evidenceText.slice(0, 6000)}` },
      ],
      { temperature: 0.2, maxTokens: 12_288 },
    );

    const raw = res.content.replace(/```(?:json)?/g, "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    let parsed: unknown = null;
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; }
    }
    const out = parsed as { candidates?: Array<Record<string, unknown>>; noCandidateDecisions?: Array<Record<string, unknown>> } | null;
    if (!out || !Array.isArray(out.candidates)) {
      logger.warn({ runId: payload.generationRunId, bundleId }, "PLANNED_SPECIALIST: 产物结构非法,升级 Full");
      return await escalateToFull(job, payload, runContext);
    }

    // 写入正式候选(bundleId 归属;originAgentEventKey 含 replanVersion 幂等)
    await withWorkerWorkspaceTransaction(
      { workspaceId: job.workspaceId, userId: job.requestedBy ?? null },
      async (tx) => {
        for (const [i, c] of out.candidates!.entries()) {
          const localId = String(c.localId ?? `c${i + 1}`);
          const claim = String(c.claim ?? "");
          const sectionKey = String(c.sectionKey ?? "");
          await tx.insert(schema.cardGenerationCandidates).values({
            workspaceId: job.workspaceId,
            runId: payload.generationRunId,
            unitId: payload.agentUnitId,
            localOrdinal: i,
            localId,
            claim,
            normalizedClaimHash: createHash("sha256").update(claim, "utf8").digest("hex"),
            topic: String(c.topic ?? ""),
            sectionKey,
            cognitiveType: String(c.cognitiveType ?? "concept"),
            importance: String(c.importance ?? "medium"),
            difficulty: String(c.difficulty ?? "medium"),
            validationStatus: "accepted",
            candidateKind: "extracted",
            bundleId,
            primarySection: sectionKey,
            originAgentEventKey: `planned_specialist:${payload.agentUnitId}:rv${replanVersion}`,
          }).onConflictDoNothing();
        }
      },
    );

    logger.info(
      { runId: payload.generationRunId, bundleId, candidateCount: out.candidates.length, replanVersion },
      "PLANNED_SPECIALIST: 候选已写入",
    );
    await markFinished(job, payload, "succeeded");
    return { kind: "complete" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/429|408|50[0-9]|timeout|timed out/i.test(message)) throw err;
    logger.error({ runId: payload.generationRunId, bundleId, err: message }, "PLANNED_SPECIALIST 失败,升级 Full");
    return await escalateToFull(job, payload, runContext);
  }
}

// ─── PLANNED_COMPOSE 执行 ────────────────────────────────────────────────

const PLANNED_COMPOSE_PROMPT = `你是学习卡生成的组合子 Agent。
输入:全部候选知识点(带 id/claim/topic/section)。输出:组合后的卡片列表。
要求:每个候选只能出现在一张卡片(candidateIds 引用输入 id);卡片 1-4 个候选;
严格输出 JSON:{"cards":[{"localId":"k1","title":"...","summary":"...","candidateIds":["..."],"ordinal":0,"learningObjective":"..."}]}。不得输出其他内容。`;

export async function executePlannedComposePhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  await assertJobLease(lease);
  logger.info({ runId: payload.generationRunId, unitId: payload.agentUnitId }, "PLANNED_COMPOSE 阶段执行");

  // 幂等:已有本 compose unit 产出的 draft
  const [existingDraft] = await db
    .select({ id: schema.cardGenerationDrafts.id })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
      eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
      eq(schema.cardGenerationDrafts.producedByEventKey, `planned_compose:${payload.agentUnitId}`),
    ))
    .limit(1);
  if (existingDraft) {
    logger.info({ runId: payload.generationRunId, draftId: existingDraft.id }, "PLANNED_COMPOSE: draft 已存在(幂等复用)");
    await markFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }

  const candidates = await db
    .select({
      id: schema.cardGenerationCandidates.id,
      localId: schema.cardGenerationCandidates.localId,
      claim: schema.cardGenerationCandidates.claim,
      topic: schema.cardGenerationCandidates.topic,
      sectionKey: schema.cardGenerationCandidates.sectionKey,
      bundleId: schema.cardGenerationCandidates.bundleId,
    })
    .from(schema.cardGenerationCandidates)
    .where(and(
      eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
      eq(schema.cardGenerationCandidates.runId, payload.generationRunId),
    ));
  if (candidates.length === 0) {
    logger.warn({ runId: payload.generationRunId }, "PLANNED_COMPOSE: 无候选,升级 Full");
    return await escalateToFull(job, payload, runContext);
  }

  const [run] = await db
    .select({ titleSnapshot: schema.cardGenerationRuns.titleSnapshot })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);
  // density 存于 prepare/plan unit 的 inputManifest(runs 表无 density 列)
  const [densityRow] = await db
    .select({ inputManifest: schema.cardGenerationUnits.inputManifest })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ))
    .orderBy(schema.cardGenerationUnits.ordinal)
    .limit(1);
  const density = ((densityRow?.inputManifest as Record<string, unknown> | null)?.density as "overview" | "standard" | "complete" | undefined) ?? "standard";
  const title = run?.titleSnapshot ?? "";

  try {
    const provider = await resolveProvider(job, payload);
    const candidatesText = candidates
      .map((c) => `[${c.localId}] bundle=${c.bundleId} section=${c.sectionKey} claim=${c.claim}`)
      .join("\n");
    const res = await provider.chatCompletion(
      [
        { role: "system", content: PLANNED_COMPOSE_PROMPT },
        { role: "user", content: `## 候选列表\n${candidatesText}\n\n卡片预算参考: ${density}` },
      ],
      { temperature: 0.2, maxTokens: 16_384 },
    );

    const raw = res.content.replace(/```(?:json)?/g, "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    let parsed: unknown = null;
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; }
    }
    const schemaResult = composeArtifactSchema.safeParse(parsed);
    if (!schemaResult.success) {
      logger.warn({ runId: payload.generationRunId, issues: schemaResult.error.issues.slice(0, 5).map((i) => i.message) }, "PLANNED_COMPOSE: 组合产物未过 Schema,升级 Full");
      return await escalateToFull(job, payload, runContext);
    }
    const compose = schemaResult.data;

    // localId → 正式 candidate id(compose 引用 localId)
    const localById = new Map(candidates.map((c) => [c.localId, c.id]));
    const missing = compose.cards.flatMap((card) => card.candidateIds.filter((localId) => !localById.has(localId)));
    if (missing.length > 0) {
      logger.warn({ runId: payload.generationRunId, missing }, "PLANNED_COMPOSE: 引用未知候选,升级 Full");
      return await escalateToFull(job, payload, runContext);
    }

    const draft = await withWorkerWorkspaceTransaction(
      { workspaceId: job.workspaceId, userId: job.requestedBy ?? null },
      async (tx) => {
        const [versionResult] = await tx
          .select({ value: schema.cardGenerationDrafts.draftVersion })
          .from(schema.cardGenerationDrafts)
          .where(and(
            eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
            eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
          ));
        const draftVersion = (versionResult?.value ?? 0) + 1;
        const normalizedCards = compose.cards.map((card, index) => ({
          title: card.title,
          summary: card.summary,
          candidateIds: card.candidateIds.map((localId) => localById.get(localId) ?? localId),
          primarySupportCandidateId: card.candidateIds[0] ? localById.get(card.candidateIds[0]) ?? null : null,
          draftCardId: `planned-${payload.agentUnitId}-${index}`,
          ordinal: card.ordinal ?? index,
          primarySection: card.sectionKey ?? "",
          groupKey: undefined,
          canonicalCandidateIds: card.candidateIds.map((localId) => localById.get(localId) ?? localId),
          learningObjective: card.learningObjective,
        }));
        const cardBudget = density === "overview" ? 8 : density === "standard" ? 15 : 50;
        const contentJson = {
          deckTitle: title,
          deckSummary: `${density} 多角色协作生成`,
          density,
          cardBudget,
          cards: normalizedCards as Array<Record<string, unknown>>,
          summarySupportCandidateIds: [],
        };
        const contentHash = createHash("sha256").update(JSON.stringify(contentJson), "utf8").digest("hex");
        const [draftRow] = await tx.insert(schema.cardGenerationDrafts).values({
          workspaceId: job.workspaceId,
          runId: payload.generationRunId,
          draftVersion,
          parentDraftId: null,
          producedByUnitId: payload.agentUnitId,
          producedByEventKey: `planned_compose:${payload.agentUnitId}`,
          schemaVersion: "deck-draft-v1",
          contentJson: contentJson as never,
          contentHash,
          deckTitle: title,
          deckSummary: contentJson.deckSummary,
          density,
          cardBudget,
          baseLedgerHash: "",
          summarySupportCandidateIds: [],
        }).onConflictDoNothing({ target: [schema.cardGenerationDrafts.workspaceId, schema.cardGenerationDrafts.runId, schema.cardGenerationDrafts.producedByEventKey] }).returning();
        if (draftRow) return { id: draftRow.id, contentHash };
        // 冲突(并发重跑):回查复用
        const [existing] = await tx.select({
          id: schema.cardGenerationDrafts.id,
          contentHash: schema.cardGenerationDrafts.contentHash,
        }).from(schema.cardGenerationDrafts).where(and(
          eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
          eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
          eq(schema.cardGenerationDrafts.producedByEventKey, `planned_compose:${payload.agentUnitId}`),
        )).limit(1);
        if (!existing) throw new Error("PLANNED_COMPOSE: draft 冲突回查失败");
        return { id: existing.id, contentHash: existing.contentHash };
      },
    );

    logger.info({ runId: payload.generationRunId, draftId: draft.id, contentHash: draft.contentHash }, "PLANNED_COMPOSE: Draft 已创建/复用(自动进入 Critic 门禁)");
    await scheduleCriticForDraft({
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      agentUnitId: payload.agentUnitId,
      requestedBy: job.requestedBy ?? "",
      draftId: draft.id,
      draftHash: draft.contentHash,
      budgetTracker: new BudgetTracker({
        maxProviderCalls: 60,
        maxInputTokens: 2_000_000,
        maxOutputTokens: 500_000,
        roles: {},
        maxEmbeddingTokens: 0,
        maxParallelTasks: 0,
        runDeadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        costCap: 0,
      }),
    });
    await markFinished(job, payload, "succeeded");
    return { kind: "complete" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/429|408|50[0-9]|timeout|timed out/i.test(message)) throw err;
    logger.error({ runId: payload.generationRunId, err: message }, "PLANNED_COMPOSE 失败,升级 Full");
    return await escalateToFull(job, payload, runContext);
  }
}

// ─── 公共 ───────────────────────────────────────────────────────────────

async function escalateToFull(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
): Promise<AgentTurnExecutionResult> {
  const supervisorUnitId = await createSupervisorUnit(job, payload, runContext);
  await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
  await markFinished(job, payload, "succeeded");
  return { kind: "complete" };
}

async function markFinished(
  job: JobPayload,
  payload: AgentJobPayload,
  status: "succeeded" | "failed",
): Promise<void> {
  await db
    .update(schema.cardGenerationUnits)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
  // P3-4:specialist 完成后触发 parent(plan unit)推进:
  // autoProgressAfterChildUnit(无 draft → false)→ resumeParentSupervisorIfNeeded
  // (siblings 全终态 + parent waiting_child CAS → 创建 resume job → plan 重入)
  if (status === "succeeded") {
    const autoProgressed = await autoProgressAfterChildUnit({
      job,
      runId: payload.generationRunId,
      childUnitId: payload.agentUnitId,
    });
    if (!autoProgressed) {
      await resumeParentSupervisorIfNeeded(job.workspaceId, payload.agentUnitId, job.requestedBy ?? null);
    }
  }
}
