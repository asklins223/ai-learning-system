import { and, eq } from "drizzle-orm";
import { generationPlanSchema } from "@ailearn/shared";
import { db, withWorkerWorkspaceTransaction } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { AgentJobPayload, RunContext } from "./types.ts";
import { assertJobLease, type JobLeaseContext } from "../lib/job-lease.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { insertPlanRecord } from "./plan-repository.ts";
import { createNextTurnJob, createSupervisorUnit } from "./unit-helpers.ts";
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
    logger.info({ runId: payload.generationRunId, planId: existingPlan.id }, "PLAN_GENERATION: 已有 plan(幂等复用)");
    await markPlanUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
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

    // 后续:Specialist DAG 调度(P3-4)作为独立里程碑;当前完成 plan 生成即结束本 unit
    await markPlanUnitFinished(job, payload, "succeeded");
    return { kind: "complete" };
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
