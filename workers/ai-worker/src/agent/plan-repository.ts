import { desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { generationPlanSchema } from "@ailearn/shared";
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

/** 规范化 planJson 的 contentHash(与 B1 共享 Hash 规则:sha256(JSON.stringify()),见 service.ts hashJson) */
export function computePlanContentHash(plan: GenerationPlan): string {
  return createHash("sha256").update(JSON.stringify(plan), "utf8").digest("hex");
}

export async function insertPlanRecord(
  input: PlanRepositoryInput,
): Promise<{ id: string; version: number; contentHash: string }> {
  // security_review MEDIUM:写入前必须经有界 Schema 校验(防超大/异常 planJson 落库)
  const plan = generationPlanSchema.parse(input.plan);

  // 并发下 version 取 max+1 可能撞唯一约束:冲突时重试(最多 3 次),
  // 与 P1-6 CAS 语义一致(乐观并发 + 唯一约束兑底)。
  const contentHash = computePlanContentHash(plan);
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await db
      .select({ version: cardGenerationPlans.version })
      .from(cardGenerationPlans)
      .where(eq(cardGenerationPlans.runId, input.runId))
      .orderBy(desc(cardGenerationPlans.version))
      .limit(1);

    const version = (latest[0]?.version ?? 0) + 1;

    try {
      const [row] = await db
        .insert(cardGenerationPlans)
        .values({
          workspaceId: input.workspaceId,
          runId: input.runId,
          version,
          schemaVersion: plan.schemaVersion,
          planJson: plan as unknown as Record<string, unknown>,
          contentHash,
          producedByUnitId: input.producedByUnitId,
          producedByEventKey: input.producedByEventKey,
        })
        .returning({ id: cardGenerationPlans.id, version: cardGenerationPlans.version });

      if (row) {
        return { id: row.id, version: row.version, contentHash };
      }
    } catch (err) {
      // 唯一约束冲突(card_generation_plans_run_version_unique_idx) → 重试
      // drizzle postgres-js 会把 PG 错误包装成 DrizzleQueryError(cause 为 PostgresError),
      // 兼容 err.code 与 err.cause.code 两种形态。
      const code =
        typeof err === "object" && err !== null
          ? ((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code)
          : undefined;
      if (code === "23505" && attempt < 2) continue;
      throw err;
    }
  }
  throw new Error("无法插入 plan 记录(并发冲突重试耗尽)");
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
