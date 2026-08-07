import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db.ts";
import { cardGenerationPlans } from "../schema/index.ts";
import type { GenerationPlan } from "@ailearn/shared";

/**
 * P3-1: card_generation_plans 不可变仓库(实施计划 §3.2/§4.1)。
 *
 * - Plan 是**不可变记录**:只插入,绝不 UPDATE 已存在行;
 *   Bounded Replan 产生新 version(新行),旧 version 保留审计。
 * - contentHash 与 B1 共享内容寻址规则(planJson 规范化 JSON 的 sha256)。
 * - Initial Plan 与 Replan 共用本模块,version 单调递增。
 */

export interface PlanRepositoryInput {
  workspaceId: string;
  runId: string;
  plan: GenerationPlan;
  producedByUnitId: string;
  producedByEventKey: string;
}

/** 规范化 planJson 的 contentHash(与 B1 共享 Hash 规则:规范化 JSON + sha256) */
export function computePlanContentHash(plan: GenerationPlan): string {
  const canonical = JSON.stringify(plan, Object.keys(plan).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export async function insertPlanRecord(
  input: PlanRepositoryInput,
): Promise<{ id: string; version: number; contentHash: string }> {
  // 下一 version = 当前最大 version + 1(并发下由唯一约束兜底,冲突即重试失败)
  const latest = await db
    .select({ version: cardGenerationPlans.version })
    .from(cardGenerationPlans)
    .where(eq(cardGenerationPlans.runId, input.runId))
    .orderBy(desc(cardGenerationPlans.version))
    .limit(1);

  const version = (latest[0]?.version ?? 0) + 1;
  const contentHash = computePlanContentHash(input.plan);

  const [row] = await db
    .insert(cardGenerationPlans)
    .values({
      workspaceId: input.workspaceId,
      runId: input.runId,
      version,
      schemaVersion: input.plan.schemaVersion,
      planJson: input.plan as unknown as Record<string, unknown>,
      contentHash,
      producedByUnitId: input.producedByUnitId,
      producedByEventKey: input.producedByEventKey,
    })
    .returning({ id: cardGenerationPlans.id, version: cardGenerationPlans.version });

  if (!row) {
    throw new Error("无法插入 plan 记录");
  }
  return { id: row.id, version: row.version, contentHash };
}

/** 读取指定 run 最新版 plan(不存在返回 null) */
export async function loadLatestPlan(runId: string): Promise<{
  id: string;
  version: number;
  plan: GenerationPlan;
  contentHash: string;
} | null> {
  const row = await db
    .select()
    .from(cardGenerationPlans)
    .where(eq(cardGenerationPlans.runId, runId))
    .orderBy(desc(cardGenerationPlans.version))
    .limit(1);

  if (!row[0]) return null;
  return {
    id: row[0].id,
    version: row[0].version,
    plan: row[0].planJson as unknown as GenerationPlan,
    contentHash: row[0].contentHash,
  };
}
