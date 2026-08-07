import { and, eq, inArray, max } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, withWorkerWorkspaceTransaction } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { AgentJobPayload, RunContext } from "./types.ts";
import { assertJobLease, type JobLeaseContext } from "../lib/job-lease.ts";import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import { buildFastExtractSystemPrompt, buildFastExtractUserMessage } from "./fast-extract-prompt.ts";
import { runFastExtract, type FastExtractProviderTurn } from "./fast-extract-executor.ts";
import type { FastExtractionEvidenceInfo } from "./fast-extraction-validator.ts";
import type { FastExtractionArtifact } from "@ailearn/shared";
import { composeArtifactSchema } from "@ailearn/shared";
import { writeProvisionalCandidates } from "./provisional-candidates.ts";
import { scheduleCriticForDraft } from "./tools/quality.ts";
import { createFastComposeUnit, createNextTurnJob, createSupervisorUnit } from "./unit-helpers.ts";
import { BudgetTracker } from "./budget.ts";
import type { AgentTurnExecutionResult } from "./types.ts";

/**
 * P2 Fast 路径接线(全量审计缺口:Fast 组件此前零生产调用点)。
 *
 * 链路(默认灰度关闭,开启才分发):
 *   FAST_EXTRACT → 中间确定性校验(runFastExtract 重试≤2/升级) →
 *   provisional_candidates 写入 → FAST_COMPOSE → composeArtifactSchema 校验 →
 *   provisional confirm 迁移为正式候选 → Draft 提交 → P1-1 自动 Critic → VERIFY → PUBLISH
 *
 * 升级(P2-6):校验 escalate → 创建 Full supervisor unit 继续(不发布失败 Artifact)。
 * 全部与既有 Evidence/Draft/VERIFY/PUBLISH 契约一致(计划 §7)。
 */

// ─── 输入加载 ───────────────────────────────────────────────────────────

interface FastInputs {
  blocks: Array<{ id: string; ordinal: number; type: string; content: string; imageAssetId: string | null }>;
  evidence: Array<{ refId: string; text: string }>;
  evidenceAllowlist: Map<string, FastExtractionEvidenceInfo>;
  evidenceBundleByRef: Map<string, string>;
  requiredBundleIds: string[];
  title: string;
  density: "overview" | "standard" | "complete";
}

async function loadFastInputs(job: JobPayload, payload: AgentJobPayload): Promise<FastInputs> {
  const [run] = await db
    .select({
      noteVersionId: schema.cardGenerationRuns.noteVersionId,
      titleSnapshot: schema.cardGenerationRuns.titleSnapshot,
    })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);
  if (!run) throw new Error("run 不存在");

  // density 存于 fast unit 的 inputManifest(prepare 分发时写入;runs 表无 density 列)
  const [unitRow] = await db
    .select({ inputManifest: schema.cardGenerationUnits.inputManifest })
    .from(schema.cardGenerationUnits)
    .where(eq(schema.cardGenerationUnits.id, payload.agentUnitId))
    .limit(1);
  const density = ((unitRow?.inputManifest as Record<string, unknown> | null)?.density as "overview" | "standard" | "complete" | undefined) ?? "standard";

  const blocks = await db
    .select({
      id: schema.noteBlocks.id,
      ordinal: schema.noteBlocks.ordinal,
      type: schema.noteBlocks.type,
      content: schema.noteBlocks.content,
      imageAssetId: schema.noteBlocks.imageAssetId,
    })
    .from(schema.noteBlocks)
    .where(eq(schema.noteBlocks.versionId, run.noteVersionId))
    .orderBy(schema.noteBlocks.ordinal);

  // Fast 为全局提取:整篇文档作为单一 required bundle("all")
  const evidence = blocks.map((b) => ({ refId: b.id, text: b.content }));
  const evidenceAllowlist = new Map<string, FastExtractionEvidenceInfo>();
  const evidenceBundleByRef = new Map<string, string>();
  for (const b of blocks) {
    evidenceAllowlist.set(b.id, {
      refId: b.id,
      blockType: b.type,
      isImage: b.type === "image",
      containsFormulaMarker: /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/.test(b.content),
    });
    evidenceBundleByRef.set(b.id, "all");
  }

  return {
    blocks,
    evidence,
    evidenceAllowlist,
    evidenceBundleByRef,
    requiredBundleIds: ["all"],
    title: run.titleSnapshot ?? "",
    density,
  };
}

async function resolveFastProvider(job: JobPayload, payload: AgentJobPayload): Promise<AIProvider> {
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
  if (!provider) throw new Error("Fast provider 解析失败");
  return provider;
}

/** Fast provider 调用适配:单次 chatCompletion 即一轮 turn */
function makeProviderTurn(provider: AIProvider): FastExtractProviderTurn {
  return {
    executeProviderTurn: async ({ systemPrompt, userMessage }) => {
      const res = await provider.chatCompletion(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        { temperature: 0.2, maxTokens: 16_384 },
      );
      // ChatResult 无 finishReason(Shared 契约),Fast 校验的截断检测
      // 由 candidate 数量/内容信号兜底(validator 的 retryable/escalate 分类)
      return { content: res.content, finishReason: "stop" };
    },
  };
}

// ─── FAST_EXTRACT 执行 ──────────────────────────────────────────────────

export async function executeFastExtractPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  _runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  await assertJobLease(lease);
  logger.info({ runId: payload.generationRunId, unitId: payload.agentUnitId }, "FAST_EXTRACT 阶段执行");

  const inputs = await loadFastInputs(job, payload);
  const provider = await resolveFastProvider(job, payload);

  const validationContext = {
    evidenceAllowlist: inputs.evidenceAllowlist,
    evidenceBundleByRef: inputs.evidenceBundleByRef,
    requiredBundleIds: inputs.requiredBundleIds,
    finishReason: "stop" as const,
  };

  const result = await runFastExtract(makeProviderTurn(provider), {
    systemPrompt: buildFastExtractSystemPrompt({
      noteTitle: inputs.title,
      evidence: inputs.evidence,
      requiredBundleIds: inputs.requiredBundleIds,
    }),
    userMessage: buildFastExtractUserMessage({
      noteTitle: inputs.title,
      evidence: inputs.evidence,
      requiredBundleIds: inputs.requiredBundleIds,
    }),
    validationContext,
  });

  if (result.action.kind === "escalate_to_full") {
    logger.warn(
      { runId: payload.generationRunId, issues: result.action.issues, attemptCount: result.action.attemptCount },
      "FAST_EXTRACT 校验升级 Full Supervisor(失败 Artifact 不发布)",
    );
    const supervisorUnitId = await createSupervisorUnit(job, payload, _runContext, inputs.density);
    await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
    await markUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }
  if (result.action.kind !== "proceed") {
    throw new Error(`FAST_EXTRACT 未知动作: ${(result.action as { kind: string }).kind}`);
  }
  const artifact = result.action.artifact as FastExtractionArtifact;

  // proceed:写入 provisional(失败 Artifact 不写入,见 provisional-candidates)
  const written = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy ?? null },
    (tx) => writeProvisionalCandidates(tx, {
      workspaceId: job.workspaceId,
      runId: payload.generationRunId,
      producedByUnitId: payload.agentUnitId,
      artifact: artifact as FastExtractionArtifact,
      sourceProviderCallId: undefined,
    }),
  );
  logger.info(
    { runId: payload.generationRunId, written, attemptCount: result.action.attemptCount },
    "FAST_EXTRACT 完成,provisional 候选已写入",
  );

  // 自动创建 FAST_COMPOSE unit + job(状态机自动推进)
  const composeUnitId = await createFastComposeUnit(job, payload);
  await createNextTurnJob(job, payload.generationRunId, composeUnitId, 1);
  await markUnitFinished(job, payload, "succeeded");
  return { kind: "complete" };
}

// ─── FAST_COMPOSE 执行 ──────────────────────────────────────────────────

const FAST_COMPOSE_PROMPT = `你是学习卡生成的快速组合子 Agent。
输入:全部候选知识点(带 id/claim/topic/section)。输出:组合后的卡片列表。
要求:
1. 每个候选只能出现在一张卡片中(candidateIds 引用输入的 id);
2. 卡片按主题分组,每张卡片 1-4 个候选;
3. 严格输出 JSON:{"cards":[{"localId":"c1","title":"...","summary":"...","candidateIds":["..."],"ordinal":0,"learningObjective":"..."}]}。
不得输出 JSON 以外的内容。`;

export async function executeFastComposePhase(
  job: JobPayload,
  payload: AgentJobPayload,
  _runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  await assertJobLease(lease);
  logger.info({ runId: payload.generationRunId, unitId: payload.agentUnitId }, "FAST_COMPOSE 阶段执行");

  const inputs = await loadFastInputs(job, payload);
  const provider = await resolveFastProvider(job, payload);

  // 读取 provisional 候选(全部 pending)
  const provisional = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    (tx) => tx
      .select({
        id: schema.provisionalCandidates.id,
        localId: schema.provisionalCandidates.localId,
        claim: schema.provisionalCandidates.claim,
        topic: schema.provisionalCandidates.topic,
        sectionKey: schema.provisionalCandidates.sectionKey,
      })
      .from(schema.provisionalCandidates)
      .where(and(
        eq(schema.provisionalCandidates.workspaceId, job.workspaceId),
        eq(schema.provisionalCandidates.runId, payload.generationRunId),
        // review should-fix:仅待确认/待修订候选进入 compose(已 confirm/reject 的不重复入)
        inArray(schema.provisionalCandidates.decision, [null, "revise", "supplement"] as never),
      )),
  );
  if (provisional.length === 0) {
    logger.warn({ runId: payload.generationRunId }, "FAST_COMPOSE: 无 provisional 候选,升级 Full");
    const supervisorUnitId = await createSupervisorUnit(job, payload, _runContext, inputs.density);
    await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
    await markUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }

  const candidatesText = provisional
    .map((c) => `[${c.localId}] topic=${c.topic} section=${c.sectionKey} claim=${c.claim}`)
    .join("\n");

  const res = await provider.chatCompletion(
    [
      { role: "system", content: FAST_COMPOSE_PROMPT },
      { role: "user", content: `## 候选列表\n${candidatesText}\n\n卡片预算参考: ${inputs.density}` },
    ],
    { temperature: 0.2, maxTokens: 16_384 },
  );

  // 容错解析 JSON + composeArtifactSchema 校验
  const raw = res.content.replace(/```(?:json)?/g, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed: unknown = null;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; }
  }
  const schemaResult = composeArtifactSchema.safeParse(parsed);
  if (!schemaResult.success) {
    logger.warn(
      { runId: payload.generationRunId, issues: schemaResult.error.issues.slice(0, 5).map((i) => i.message) },
      "FAST_COMPOSE 产物未通过 Schema 校验,升级 Full",
    );
    const supervisorUnitId = await createSupervisorUnit(job, payload, _runContext, inputs.density);
    await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
    await markUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }
  const compose = schemaResult.data;
  const usedLocalIds = new Set(compose.cards.flatMap((c) => c.candidateIds));

  // review should-fix:引用完整性——所有被引用 localId 必须存在于 provisional
  // (防孤儿引用:draft 引用不存在的候选 id)
  const knownLocalIds = new Set(provisional.map((p) => p.localId));
  const missingRefs = [...usedLocalIds].filter((id) => !knownLocalIds.has(id));
  if (missingRefs.length > 0) {
    logger.warn(
      { runId: payload.generationRunId, missingRefs },
      "FAST_COMPOSE: 引用不存在的候选 localId,升级 Full",
    );
    const supervisorUnitId = await createSupervisorUnit(job, payload, _runContext, inputs.density);
    await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
    await markUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }

  // review should-fix(Blocking):候选迁移 + confirm + draft 创建合并为**单事务**,
  // 且迁移冲突时回查正式候选 id(不再 fallback provisional id),draft 按
  // producedByEventKey 幂等(重跑不重复创建)。
  const composed = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy ?? null },
    async (tx) => {
      // 1) 候选迁移(被引用;onConflict 冲突 → 按 (run_id, local_id) 回查正式 id)
      const localToCandidateId = new Map<string, string>();
      for (const c of provisional) {
        if (!usedLocalIds.has(c.localId)) continue;
        const [inserted] = await tx
          .insert(schema.cardGenerationCandidates)
          .values({
            workspaceId: job.workspaceId,
            runId: payload.generationRunId,
            unitId: payload.agentUnitId,
            localOrdinal: 0,
            localId: c.localId,
            claim: c.claim,
            normalizedClaimHash: createHash("sha256").update(c.claim, "utf8").digest("hex"),
            topic: c.topic,
            sectionKey: c.sectionKey,
            cognitiveType: "concept",
            importance: "medium",
            validationStatus: "accepted",
            candidateKind: "extracted",
            bundleId: "all",
            primarySection: c.sectionKey,
            originAgentEventKey: `fast_compose:${payload.agentUnitId}`,
          })
          .onConflictDoNothing()
          .returning({ id: schema.cardGenerationCandidates.id });
        let candidateId = inserted?.id;
        if (!candidateId) {
          // 冲突:回查既有正式候选(重跑场景)
          const [existing] = await tx
            .select({ id: schema.cardGenerationCandidates.id })
            .from(schema.cardGenerationCandidates)
            .where(and(
              eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
              eq(schema.cardGenerationCandidates.runId, payload.generationRunId),
              eq(schema.cardGenerationCandidates.localId, c.localId),
            ))
            .limit(1);
          // security_review LOW:回查失败不再 fallback provisional id(防孤儿引用)
          if (!existing) {
            throw new Error(`FAST_COMPOSE: 候选迁移冲突且回查失败(localId=${c.localId})`);
          }
          candidateId = existing.id;
        }
        localToCandidateId.set(c.localId, candidateId);
      }

      // 2) provisional confirm
      await tx
        .update(schema.provisionalCandidates)
        .set({ decision: "confirm", decisionByUnitId: payload.agentUnitId, decisionAt: new Date() })
        .where(and(
          eq(schema.provisionalCandidates.workspaceId, job.workspaceId),
          eq(schema.provisionalCandidates.runId, payload.generationRunId),
          inArray(schema.provisionalCandidates.localId, [...usedLocalIds]),
        ));

      // 3) Draft 幂等:同 producedByEventKey 已存在则复用(重跑/恢复)
      const [existingDraft] = await tx
        .select({
          id: schema.cardGenerationDrafts.id,
          contentHash: schema.cardGenerationDrafts.contentHash,
          draftVersion: schema.cardGenerationDrafts.draftVersion,
        })
        .from(schema.cardGenerationDrafts)
        .where(and(
          eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
          eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
          eq(schema.cardGenerationDrafts.producedByEventKey, `fast_compose:${payload.agentUnitId}`),
        ))
        .limit(1);
      if (existingDraft) {
        return {
          localToCandidateId,
          draftId: existingDraft.id,
          draftVersion: existingDraft.draftVersion,
          contentHash: existingDraft.contentHash,
          reused: true,
        };
      }

      const normalizedCards = compose.cards.map((card, index) => ({
        title: card.title,
        summary: card.summary,
        candidateIds: card.candidateIds.map((localId) => localToCandidateId.get(localId) ?? localId),
        primarySupportCandidateId: card.candidateIds[0] ? localToCandidateId.get(card.candidateIds[0]) ?? null : null,
        draftCardId: `fast-${payload.agentUnitId}-${index}`,
        ordinal: card.ordinal ?? index,
        primarySection: card.sectionKey ?? "",
        groupKey: undefined,
        canonicalCandidateIds: card.candidateIds.map((localId) => localToCandidateId.get(localId) ?? localId),
        learningObjective: card.learningObjective,
      }));
      const cardBudget = inputs.density === "overview" ? 8 : inputs.density === "standard" ? 15 : 50;
      const [versionResult] = await tx
        .select({ value: max(schema.cardGenerationDrafts.draftVersion) })
        .from(schema.cardGenerationDrafts)
        .where(and(
          eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
          eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
        ));
      const draftVersion = (versionResult?.value ?? 0) + 1;
      const contentJson = {
        deckTitle: inputs.title,
        deckSummary: `${inputs.density} 快速生成`,
        density: inputs.density,
        cardBudget,
        cards: normalizedCards as Array<Record<string, unknown>>,
        summarySupportCandidateIds: [],
      };
      const contentHash = createHash("sha256").update(JSON.stringify(contentJson), "utf8").digest("hex");
      const [draft] = await tx
        .insert(schema.cardGenerationDrafts)
        .values({
          workspaceId: job.workspaceId,
          runId: payload.generationRunId,
          draftVersion,
          parentDraftId: null,
          producedByUnitId: payload.agentUnitId,
          producedByEventKey: `fast_compose:${payload.agentUnitId}`,
          schemaVersion: "deck-draft-v1",
          contentJson: contentJson as never,
          contentHash,
          deckTitle: inputs.title,
          deckSummary: contentJson.deckSummary,
          density: inputs.density,
          cardBudget,
          baseLedgerHash: "",
          summarySupportCandidateIds: [],
        })
        // security_review MEDIUM:DB 唯一约束(0072)兜底并发竞态;冲突时回查复用
        .onConflictDoNothing()
        .returning();
      if (!draft) {
        // 并发冲突(双事务穿过 check-then-act):回查既有 draft 复用
        const [conflictDraft] = await tx
          .select({
            id: schema.cardGenerationDrafts.id,
            contentHash: schema.cardGenerationDrafts.contentHash,
            draftVersion: schema.cardGenerationDrafts.draftVersion,
          })
          .from(schema.cardGenerationDrafts)
          .where(and(
            eq(schema.cardGenerationDrafts.workspaceId, job.workspaceId),
            eq(schema.cardGenerationDrafts.runId, payload.generationRunId),
            eq(schema.cardGenerationDrafts.producedByEventKey, `fast_compose:${payload.agentUnitId}`),
          ))
          .limit(1);
        if (!conflictDraft) throw new Error("FAST_COMPOSE: 无法创建 draft(冲突回查亦失败)");
        return {
          localToCandidateId,
          draftId: conflictDraft.id,
          draftVersion: conflictDraft.draftVersion,
          contentHash: conflictDraft.contentHash,
          reused: true,
        };
      }
      return { localToCandidateId, draftId: draft.id, draftVersion, contentHash, reused: false };
    },
  );

  logger.info(
    { runId: payload.generationRunId, draftId: composed.draftId, draftVersion: composed.draftVersion, contentHash: composed.contentHash, reused: composed.reused },
    "FAST_COMPOSE: Draft 已创建/复用(自动进入 Critic 门禁)",
  );

  // P1-1 复用:自动创建 Critic(同一质量门禁,计划 §7 契约一致)
  await scheduleCriticForDraft({
    workspaceId: job.workspaceId,
    runId: payload.generationRunId,
    agentUnitId: payload.agentUnitId,
    requestedBy: job.requestedBy ?? "",
    draftId: composed.draftId,
    draftHash: composed.contentHash,
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

  await markUnitFinished(job, payload, "succeeded");
  return { kind: "complete" };
}

/** 标记当前 unit 终态(succeeded),带 workspace 过滤(review nit;lease 由 handler 层保障) */
async function markUnitFinished(
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
}
