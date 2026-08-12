import { and, desc, eq } from "drizzle-orm";
import { generationPlanSchema, type GenerationPlan } from "@ailearn/shared";
import { db, withWorkerWorkspaceTransaction } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { AgentJobPayload, RunContext } from "./types.ts";
import { assertJobLease, type JobLeaseContext } from "../lib/job-lease.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { insertPlanRecord } from "./plan-repository.ts";
import { createNextTurnJob, createPlannedComposeUnit, createPlannedSpecialistUnit, createSupervisorUnit } from "./unit-helpers.ts";
import { buildScheduleState, scheduleWaves } from "./specialist-dag.ts";
import { detectGaps, hasEscalateGaps, affectedBundleIds, type SpecialistOutcome } from "./gap-detection.ts";
import type { AgentTurnExecutionResult } from "./types.ts";

/**
 * P3 Planned 路径接线(全量审计缺口:Planned 组件此前零生产调用点)。
 *
 * 本阶段交付**最小可信单元**:Initial Plan 生成 + 校验 + 不可变落库
 * (P3-1 的 plan-repository 此前仅测试引用)。Plan 生成后:
 * - 后续 Specialist DAG 调度 / Gap Detection / Bounded Replan(P3-2~P3-5)
 *   作为独立里程碑接线(依赖灰度数据收敛,报告中列明);
 * - 本阶段 Plan 生成失败 → 升级 Full Supervisor(计划 §7:失败 Artifact 不发布)。
 */

const PLAN_GENERATION_PROMPT = `你是学习卡生成的计划子 Agent。根据笔记标题与内容摘要，输出生成计划。
严格输出 JSON：
{"schemaVersion":"1","documentIntent":"<一句话意图>","learningFocus":["<2-6个学习重点>"],
 "bundleTasks":[{"bundleId":"b1","specialist":"text_extractor|code_extractor|vision_specialist","extractionFocus":"<提取重点>","relatedBundleIds":[],"expectedDecisionKinds":["candidate","no_candidate"]}],
 "compositionStrategy":{"density":"overview|standard|complete","cardBudget":<3-50>}}
约束:specialist 只允许 text_extractor/code_extractor/vision_specialist;bundleTasks 1-20 个。不得输出 JSON 以外的内容。`;

export async function executePlanGenerationPhase(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
  lease: JobLeaseContext,
): Promise<AgentTurnExecutionResult> {
  await assertJobLease(lease);
  logger.info({ runId: payload.generationRunId, unitId: payload.agentUnitId }, "PLAN_GENERATION 阶段执行");

  // 已存在 plan(幂等:重跑/恢复)直接进入下一步
  const [existingPlan] = await db
    .select({ id: schema.cardGenerationPlans.id })
    .from(schema.cardGenerationPlans)
    .where(and(
      eq(schema.cardGenerationPlans.runId, payload.generationRunId),
      eq(schema.cardGenerationPlans.workspaceId, job.workspaceId),
    ))
    .limit(1);
  if (existingPlan) {
    // P3-4 接线:已有 plan(plan unit 恢复重入)→ 检查 specialist children 完成度
    return await advancePlannedPipeline(job, payload, runContext);
  }

  const [run] = await db
    .select({
      titleSnapshot: schema.cardGenerationRuns.titleSnapshot,
      providerSnapshot: schema.cardGenerationRuns.providerSnapshot,
      blockManifest: schema.cardGenerationRuns.blockManifest,
    })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.generationRunId),
      eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
    ))
    .limit(1);
  if (!run) {
    await markPlanUnitFinished(job, payload, "failed");
    return { kind: "failed", error: "run 不存在" };
  }

  const snap = (run.providerSnapshot as Record<string, unknown>) ?? {};
  const providerName = (snap.providerName as string) ?? "mock";
  const config = (snap.config as Record<string, unknown>) ?? {};
  const provider = await createProvider(providerName, {
    apiKey: (config.apiKey as string) ?? null,
    baseUrl: (config.baseUrl as string) ?? null,
    model: (config.model as string) ?? null,
    visionModel: (config.visionModel as string) ?? null,
  } as never);
  if (!provider) {
    await markPlanUnitFinished(job, payload, "failed");
    return { kind: "failed", error: "provider 解析失败" };
  }

  const blockSummary = ((run.blockManifest as Array<Record<string, unknown>>) ?? [])
    .map((b) => `${String(b.type ?? "")}:${String(b.content ?? "").slice(0, 120)}`)
    .join("\n");

  try {
    const res = await provider.chatCompletion(
      [
        { role: "system", content: PLAN_GENERATION_PROMPT },
        { role: "user", content: `## 笔记标题\n${run.titleSnapshot ?? ""}\n\n## 内容摘要\n${blockSummary.slice(0, 6000)}` },
      ],
      { temperature: 0.3, maxTokens: 8_192 },
      // 2026-08-12（模型调用面审计）：透传 handler AbortSignal，超时真正中止底层请求
      lease.signal,
    );

    const raw = res.content.replace(/```(?:json)?/g, "").trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    let parsed: unknown = null;
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; }
    }
    const planResult = generationPlanSchema.safeParse(parsed);
    if (!planResult.success) {
      logger.warn(
        { runId: payload.generationRunId, issues: planResult.error.issues.slice(0, 5).map((i) => i.message) },
        "PLAN_GENERATION: plan 未通过 Schema 校验,升级 Full Supervisor",
      );
      const supervisorUnitId = await createSupervisorUnit(job, payload, runContext);
      await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
      await markPlanUnitFinished(job, payload, "succeeded");
      return { kind: "complete" };
    }

    const plan = planResult.data;
    const record = await withWorkerWorkspaceTransaction(
      { workspaceId: job.workspaceId, userId: job.requestedBy ?? null },
      (tx) => insertPlanRecord(tx, {
        workspaceId: job.workspaceId,
        runId: payload.generationRunId,
        plan,
        producedByUnitId: payload.agentUnitId,
        producedByEventKey: `plan:${payload.agentUnitId}`,
      }),
    );
    logger.info(
      { runId: payload.generationRunId, planId: record.id, version: record.version, contentHash: record.contentHash, bundleCount: plan.bundleTasks.length },
      "PLAN_GENERATION: Initial Plan 已落库(不可变)",
    );

    // P3-4 接线:Initial Plan 落库后创建 Specialist DAG units(按 wave 并行),
    // plan unit 置 waiting_child 等待全部 specialist 完成(由 resume 机制重入)
    return await launchSpecialistDag(job, payload, runContext, plan, record.version);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // review should-fix:可重试 provider 瞬时错误(429/408/5xx)re-throw 交外层重试机制,
    // 不升级 Full(校验失败升级保留)
    if (/429|408|50[0-9]|timeout|timed out/i.test(message)) {
      throw err;
    }
    logger.error({ runId: payload.generationRunId, err: message }, "PLAN_GENERATION 失败,升级 Full Supervisor");
    const supervisorUnitId = await createSupervisorUnit(job, payload, runContext);
    await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
    await markPlanUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
  }
}

async function markPlanUnitFinished(
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

// ─── P3-4:Specialist DAG 调度 ──────────────────────────────────────────

const DONE_OR_STUCK = new Set(["succeeded", "terminal_failed", "cancelled", "superseded", "retryable_failed"]);

/** 创建全部 specialist units(按 wave),plan unit 置 waiting_child 等待 */
async function launchSpecialistDag(
  job: JobPayload,
  payload: AgentJobPayload,
  _runContext: Extract<RunContext, { kind: "active" }>,
  plan: GenerationPlan,
  planVersion: number,
): Promise<AgentTurnExecutionResult> {
  const replanVersion = 1;
  const states = buildScheduleState(plan, new Set());
  const waves = scheduleWaves(states);
  const created: string[] = [];

  for (const [waveNo, wave] of waves.entries()) {
    for (const [i, bundleId] of wave.entries()) {
      const task = plan.bundleTasks.find((t) => t.bundleId === bundleId);
      if (!task) continue;
      const unitId = await createPlannedSpecialistUnit(job, payload, payload.agentUnitId, {
        planVersion,
        bundleId: task.bundleId,
        specialist: task.specialist,
        extractionFocus: task.extractionFocus,
        relatedBundleIds: task.relatedBundleIds ?? [],
        waveNo,
        bundleOrdinal: i,
        replanVersion,
      });
      created.push(unitId);
    }
  }

  if (created.length === 0) {
    logger.warn({ runId: payload.generationRunId }, "PLAN: 无 specialist 任务,直接进入 compose");
    return await launchPlannedCompose(job, payload);
  }

  for (const unitId of created) {
    await createNextTurnJob(job, payload.generationRunId, unitId, 1);
  }
  // plan unit 置 waiting_child(由 resume 机制在全部 children 终态后重入)
  await db
    .update(schema.cardGenerationUnits)
    .set({ status: "waiting_child", updatedAt: new Date() })
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
  logger.info(
    { runId: payload.generationRunId, planVersion, specialistUnits: created.length, waves: waves.length },
    "PLAN: Specialist DAG 已创建,等待子任务完成",
  );
  return { kind: "wait_for_children", childTaskIds: created };
}

/** plan unit 恢复重入:children 全终态后做 Gap Detection → Replan / Compose / 升级 */
async function advancePlannedPipeline(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
): Promise<AgentTurnExecutionResult> {
  const [planRow] = await db
    .select({ planJson: schema.cardGenerationPlans.planJson, version: schema.cardGenerationPlans.version })
    .from(schema.cardGenerationPlans)
    .where(and(
      eq(schema.cardGenerationPlans.runId, payload.generationRunId),
      eq(schema.cardGenerationPlans.workspaceId, job.workspaceId),
    ))
    .orderBy(desc(schema.cardGenerationPlans.version))
    .limit(1);
  if (!planRow) {
    logger.warn({ runId: payload.generationRunId }, "PLAN: 无 plan 记录,升级 Full");
    return await escalatePlanned(job, payload, runContext);
  }
  const plan = planRow.planJson as unknown as GenerationPlan;

  const children = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.parentUnitId, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
    ));
  const stillRunning = children.filter((c) => !DONE_OR_STUCK.has(c.status));
  if (stillRunning.length > 0) {
    logger.info(
      { runId: payload.generationRunId, stillRunning: stillRunning.length },
      "PLAN: 仍有 specialist 子任务运行中,继续等待",
    );
    return { kind: "wait_for_children", childTaskIds: stillRunning.map((c) => c.id) };
  }

  // 全部终态 → Gap Detection(§3.2):从正式候选统计各 bundle 决策
  // review 修复:先取当前 replanVersion,replan 有上限(≤2 轮),超限 escalate 防无限循环
  const [latestSpecialist] = await db
    .select({ inputManifest: schema.cardGenerationUnits.inputManifest })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.parentUnitId, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      eq(schema.cardGenerationUnits.runId, payload.generationRunId),
    ))
    .orderBy(desc(schema.cardGenerationUnits.createdAt))
    .limit(1);
  const prevManifest = (latestSpecialist?.inputManifest as Record<string, unknown>) ?? {};
  const currentReplanVersion = Number(prevManifest.replanVersion ?? 1);
  const candidateRows = await db
    .select({
      bundleId: schema.cardGenerationCandidates.bundleId,
      validationStatus: schema.cardGenerationCandidates.validationStatus,
      candidateKind: schema.cardGenerationCandidates.candidateKind,
    })
    .from(schema.cardGenerationCandidates)
    .where(and(
      eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
      eq(schema.cardGenerationCandidates.runId, payload.generationRunId),
    ));
  const countByBundle = new Map<string, number>();
  const noCandidateByBundle = new Map<string, number>();
  for (const r of candidateRows) {
    const bundleId = r.bundleId ?? "unknown";
    if (r.validationStatus === "rejected" && r.candidateKind === "no_candidate") {
      noCandidateByBundle.set(bundleId, (noCandidateByBundle.get(bundleId) ?? 0) + 1);
    } else if (r.validationStatus === "accepted") {
      countByBundle.set(bundleId, (countByBundle.get(bundleId) ?? 0) + 1);
    }
  }

  const outcomes: Record<string, SpecialistOutcome> = {};
  let decidedBundles = 0;
  for (const task of plan.bundleTasks) {
    const candidateCount = countByBundle.get(task.bundleId) ?? 0;
    const noCandidateCount = noCandidateByBundle.get(task.bundleId) ?? 0;
    // 遗留项①:明确 no_candidate 决策视为 hasDecision(不触发 bundle_no_decision replan)
    const hasDecision = candidateCount > 0 || noCandidateCount > 0;
    outcomes[task.bundleId] = {
      hasDecision,
      decisionKind: candidateCount > 0 ? "candidate" : noCandidateCount > 0 ? "no_candidate" : undefined,
      candidateCount,
      protocolErrors: [],
      evidenceRefIds: [],
      finishReason: "complete",
    };
    if (hasDecision) decidedBundles += 1;
  }
  const survivingCoverage = plan.bundleTasks.length > 0 ? decidedBundles / plan.bundleTasks.length : 1;

  const gaps = detectGaps({
    plan,
    outcomes,
    evidenceAllowlist: new Set(),
    coverageLedgerComplete: true,
    survivingCoverage,
    coverageThreshold: 0.5,
  });

  if (hasEscalateGaps(gaps)) {
    logger.warn(
      { runId: payload.generationRunId, gaps: gaps.filter((g) => g.severity === "escalate").map((g) => g.code) },
      "PLAN: Gap 需升级(escalate),升级 Full Supervisor",
    );
    return await escalatePlanned(job, payload, runContext);
  }

  const affected = affectedBundleIds(gaps, plan);
  if (affected.size > 0) {
    // Bounded Replan:仅为受影响 bundle 重跑(新 specialist units,replanVersion 递增)
    logger.warn(
      { runId: payload.generationRunId, affected: [...affected], gaps: gaps.map((g) => g.code), replanVersion: currentReplanVersion },
      "PLAN: Gap 可 Replan(仅重跑受影响 bundle)",
    );
    // review 修复:replan 上限(≤2 轮,累计 3 版),超限 escalate 防无限循环烧 provider
    if (currentReplanVersion >= 3) {
      logger.warn(
        { runId: payload.generationRunId, replanVersion: currentReplanVersion, affected: [...affected] },
        "PLAN: replan 达到上限,升级 Full Supervisor",
      );
      return await escalatePlanned(job, payload, runContext);
    }
    const replanVersion = currentReplanVersion + 1;
    const created: string[] = [];
    for (const [i, bundleId] of [...affected].sort().entries()) {
      const task = plan.bundleTasks.find((t) => t.bundleId === bundleId);
      if (!task) continue;
      const unitId = await createPlannedSpecialistUnit(job, payload, payload.agentUnitId, {
        planVersion: planRow.version,
        bundleId: task.bundleId,
        specialist: task.specialist,
        extractionFocus: task.extractionFocus,
        relatedBundleIds: task.relatedBundleIds ?? [],
        waveNo: 0,
        bundleOrdinal: i,
        replanVersion,
      });
      created.push(unitId);
    }
    for (const unitId of created) await createNextTurnJob(job, payload.generationRunId, unitId, 1);
    await db
      .update(schema.cardGenerationUnits)
      .set({ status: "waiting_child", updatedAt: new Date() })
      .where(and(
        eq(schema.cardGenerationUnits.id, payload.agentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    return { kind: "wait_for_children", childTaskIds: created };
  }

  // 无 gap → 自动 Compose
  logger.info({ runId: payload.generationRunId, bundleCount: plan.bundleTasks.length }, "PLAN: 无 Gap,自动进入 Compose");
  return await launchPlannedCompose(job, payload);
}

/** 创建 PLANNED_COMPOSE unit 并完成 plan unit */
async function launchPlannedCompose(job: JobPayload, payload: AgentJobPayload): Promise<AgentTurnExecutionResult> {
  const composeUnitId = await createPlannedComposeUnit(job, payload);
  await createNextTurnJob(job, payload.generationRunId, composeUnitId, 1);
  await markPlanUnitFinished(job, payload, "succeeded");
  return { kind: "complete" };
}

/** 升级 Full Supervisor(失败 Artifact 不发布;plan unit 置 superseded 防 resume 双轨) */
async function escalatePlanned(
  job: JobPayload,
  payload: AgentJobPayload,
  runContext: Extract<RunContext, { kind: "active" }>,
): Promise<AgentTurnExecutionResult> {
  // security MEDIUM 修复:先原子终结 plan unit(superseded)再创建 supervisor,
  // 消除 sibling 完成触发 resume CAS 与 supervisor Full 双轨的竞态窗口
  await db
    .update(schema.cardGenerationUnits)
    .set({ status: "superseded", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.agentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
    ));
  const supervisorUnitId = await createSupervisorUnit(job, payload, runContext);
  await createNextTurnJob(job, payload.generationRunId, supervisorUnitId, 1);
  return { kind: "complete" };
}
