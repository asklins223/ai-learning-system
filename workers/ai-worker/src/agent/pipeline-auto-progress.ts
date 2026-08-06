/**
 * P1-2/P1-3：子任务完成后系统自动推进（状态机正式化）。
 *
 * 现状（Phase 1 前）：Draft→Critic、Critic→VERIFY、Repair→重新Critic 三跳
 * 都依赖 Supervisor 模型在下一 turn 调用推进工具（request_grounding_review /
 * request_verification），auto-fallback 只在模型失速时注入纯调度调用。
 *
 * 本模块在「子 Agent（critic/repairer/extractor）完成」事件点按权威状态自动推进：
 *
 * 1. P1-2：最新 draft 的 Quality Report passed + deterministic passed
 *    且尚无 verify unit → 系统自动创建 deterministic_verify unit + job，
 *    parent Supervisor 直接终态（succeeded），无需恢复再走模型；
 * 2. P1-3：最新 draft 尚无对应的非终态 Critic（如 Repair 产物是
 *    persistRepairPatches 创建的新 draftVersion，未经过 submit_deck_draft，
 *    因此不会命中 P1-1 的自动创建）→ 系统自动 scheduleCriticForDraft，
 *    parent Supervisor 保持 waiting_child 继续等待；
 * 3. 其他情况 → 走原有 resumeParentSupervisorIfNeeded 恢复 parent。
 *
 * 所有分支幂等：verify unit 用 unitKey=`verify:{runId}` 唯一键，
 * critic 用 unitKey=`agent:grounding_critic:{draftId}`（scheduleCriticForDraft 内幂等）。
 */

import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { AgentUnitKind } from "@ailearn/shared";
import { db } from "../db.ts";
import * as schema from "../schema/index.ts";
import { logger } from "../lib/logger.ts";
import { scheduleCriticForDraft } from "./tools/quality.ts";
import { createNextTurnJob } from "./unit-helpers.ts";
import { BudgetTracker } from "./budget.ts";
import type { JobPayload } from "../handlers/index.ts";
import type { RunBudget } from "@ailearn/shared";

/** 判定 report 是否达到可进 VERIFY 的状态 */
function isVerifyReady(criticStatus: string | null | undefined, deterministicStatus: string | null | undefined): boolean {
  return criticStatus === "passed" && deterministicStatus === "passed";
}

/**
 * 子任务完成后系统自动推进。
 *
 * 返回 true 表示已由系统推进（parent 未走 resume 恢复）；
 * 返回 false 表示走原有 resume 路径恢复 parent。
 */
export async function autoProgressAfterChildUnit(input: {
  job: JobPayload;
  runId: string;
  childUnitId: string;
}): Promise<boolean> {
  const { job, runId, childUnitId } = input;
  const workspaceId = job.workspaceId;

  // 查 child 的 parent
  const [child] = await db
    .select({ parentUnitId: schema.cardGenerationUnits.parentUnitId })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, childUnitId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
    ))
    .limit(1);

  if (!child?.parentUnitId) {
    return false; // 无 parent，走 resume（resume 内部会跳过）
  }
  const parentUnitId = child.parentUnitId;

  // P1-2 should-fix(评审):仅当 parent 仍处于 waiting_child(等待子任务)时自动推进。
  // 任意子 agent(含 extractor/repairer)完成都会进入本函数;若 parent 已不在等待态
  // (如已 running 或 supervisor 正处理其他子任务),跳过自动推进,避免误判提前
  // 终结 supervisor。加审计日志观察非预期路径。
  const [parentRow] = await db
    .select({ status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, parentUnitId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
    ))
    .limit(1);
  if (!parentRow || parentRow.status !== "waiting_child") {
    logger.warn(
      { runId, childUnitId, parentUnitId, parentStatus: parentRow?.status ?? "missing" },
      "autoProgressAfterChildUnit: parent 不在 waiting_child，跳过系统自动推进，走 resume",
    );
    return false;
  }

  // 查最新 draft（按 draftVersion 降序）
  const [latestDraft] = await db
    .select({
      id: schema.cardGenerationDrafts.id,
      contentHash: schema.cardGenerationDrafts.contentHash,
    })
    .from(schema.cardGenerationDrafts)
    .where(and(
      eq(schema.cardGenerationDrafts.runId, runId),
      eq(schema.cardGenerationDrafts.workspaceId, workspaceId),
    ))
    .orderBy(desc(schema.cardGenerationDrafts.draftVersion))
    .limit(1);

  if (!latestDraft) {
    return false; // 无 draft，走 resume
  }

  // 最新 draft 的 Quality Report
  const [report] = await db
    .select({
      criticStatus: schema.cardGenerationQualityReports.criticStatus,
      deterministicStatus: schema.cardGenerationQualityReports.deterministicStatus,
    })
    .from(schema.cardGenerationQualityReports)
    .where(and(
      eq(schema.cardGenerationQualityReports.runId, runId),
      eq(schema.cardGenerationQualityReports.workspaceId, workspaceId),
      eq(schema.cardGenerationQualityReports.draftId, latestDraft.id),
    ))
    .limit(1);

  // 是否已有 verify unit
  const [verifyUnit] = await db
    .select({ id: schema.cardGenerationUnits.id })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, runId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      eq(schema.cardGenerationUnits.unitKey, `verify:${runId}`),
    ))
    .limit(1);

  // 最新 draft 是否有对应的非终态 Critic
  const [pendingCritic] = await db
    .select({ id: schema.cardGenerationUnits.id, status: schema.cardGenerationUnits.status })
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.runId, runId),
      eq(schema.cardGenerationUnits.workspaceId, workspaceId),
      eq(schema.cardGenerationUnits.unitKey, `agent:grounding_critic:${latestDraft.id}`),
    ))
    .limit(1);
  const hasPendingCritic = !!pendingCritic && !["succeeded", "terminal_failed", "cancelled", "superseded"].includes(pendingCritic.status);

  // ─── P1-2：Critic Passed → 自动创建 VERIFY Unit ───────────────────────
  const reportReady = isVerifyReady(report?.criticStatus, report?.deterministicStatus);
  if (reportReady && !verifyUnit) {
    const now = new Date();
    const [unit] = await db
      .insert(schema.cardGenerationUnits)
      .values({
        workspaceId,
        runId,
        kind: AgentUnitKind.DETERMINISTIC_VERIFY,
        level: 0,
        ordinal: 98,
        unitKey: `verify:${runId}`,
        required: true,
        inputManifest: {},
        inputHash: createHash("sha256")
          .update(JSON.stringify({ runId, unitId: "verify", turnNo: 1 }))
          .digest("hex"),
        tokenEstimate: 0,
        status: "pending",
        scheduledAt: now,
      })
      .onConflictDoNothing()
      .returning();

    if (!unit) {
      // 并发下已存在 verify unit(幂等命中)。
      // P1-2 should-fix(评审):幂等命中分支也必须补建 job——若创建方在 insert 后、
      // 插 job 前崩溃,verify unit 会悬挂无 job(死锁)。createNextTurnJob 本身幂等。
      logger.info({ runId }, "P1-2: verify unit 已存在(并发幂等)，补建/确认 job");
      const [existingVerify] = await db
        .select({ id: schema.cardGenerationUnits.id })
        .from(schema.cardGenerationUnits)
        .where(and(
          eq(schema.cardGenerationUnits.runId, runId),
          eq(schema.cardGenerationUnits.workspaceId, workspaceId),
          eq(schema.cardGenerationUnits.unitKey, `verify:${runId}`),
        ))
        .limit(1);
      if (existingVerify) {
        await createNextTurnJob(job, runId, existingVerify.id, 1);
      }
    } else {
      await createNextTurnJob(job, runId, unit.id, 1);
      logger.info(
        { runId, verifyUnitId: unit.id, parentUnitId },
        "P1-2: Critic 通过，系统自动创建 VERIFY unit",
      );
    }

    // parent Supervisor 直接终态（管道进入 VERIFY，无需恢复）。
    // 复核 should-fix:update 加 status='waiting_child' CAS 条件——防止 check-then-act
    // 窗口内 resume 已把 parent 置 running 时被误终结;rowCount=0 则视为未推进,
    // 交由 resume 恢复 parent。
    const parentUpdate = await db
      .update(schema.cardGenerationUnits)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.cardGenerationUnits.id, parentUnitId),
        eq(schema.cardGenerationUnits.workspaceId, workspaceId),
        eq(schema.cardGenerationUnits.status, "waiting_child"),
      ))
      .returning({ id: schema.cardGenerationUnits.id });

    if (parentUpdate.length === 0) {
      logger.warn(
        { runId, parentUnitId },
        "P1-2: parent 已被并发恢复(running)，不再终结；交由 resume 流程",
      );
      return false;
    }

    return true;
  }

  // ─── P1-3：最新 draft 无评审 → 自动重新创建 Critic（如 Repair 产物） ───
  if (!hasPendingCritic && !reportReady) {
    // 从 run budgetSnapshot 重建 BudgetTracker（并行任务计数反映真实状态）
    const [runDetail] = await db
      .select({ budgetSnapshot: schema.cardGenerationRuns.budgetSnapshot })
      .from(schema.cardGenerationRuns)
      .where(eq(schema.cardGenerationRuns.id, runId))
      .limit(1);
    const budgetTracker = new BudgetTracker(
      (runDetail?.budgetSnapshot as RunBudget | null) ?? undefined,
    );

    const scheduled = await scheduleCriticForDraft({
      workspaceId,
      runId,
      agentUnitId: parentUnitId,
      requestedBy: job.requestedBy ?? "system",
      draftId: latestDraft.id,
      draftHash: latestDraft.contentHash,
      budgetTracker,
    });

    if (scheduled && !scheduled.alreadyCompleted) {
      logger.info(
        { runId, draftId: latestDraft.id, criticTaskId: scheduled.criticTaskId, parentUnitId },
        "P1-3: 最新 draft 未评审，系统自动重新创建 Critic（parent 保持等待）",
      );
      return true; // parent 保持 waiting_child，Critic 完成后 resume 正常恢复
    }
    // scheduled=null（预算/DB 失败）或 alreadyCompleted → 走 resume 恢复 parent，
    // 让 Supervisor 决定后续（模型可重试请求）。
    return false;
  }

  // ─── 默认：恢复 parent Supervisor ─────────────────────────────────────
  return false;
}
