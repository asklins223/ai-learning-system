import { desc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { generationPlanSchema } from "@ailearn/shared";
import { cardGenerationPlans } from "../schema/index.ts";
import type { WorkerTransaction } from "../db.ts";
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
  tx: WorkerTransaction,
  input: PlanRepositoryInput,
): Promise<{ id: string; version: number; contentHash: string }> {
  // security_review MEDIUM:写入前必须经有界 Schema 校验(防超大/异常 planJson 落库)
  let plan: GenerationPlan;
  try {
    plan = generationPlanSchema.parse(input.plan);
  } catch (err) {
    // review nit:不抛裸 ZodError,带上下文包装
    throw new Error(`plan 校验失败(runId=${input.runId}): ${(err as Error).message}`);
  }

  // 并发安全:单条 INSERT...SELECT 原子语句(MAX(version)+1 在语句内计算),
  // ON CONFLICT DO NOTHING 不使事务 aborted(PG 23505 会 abort 事务,
  // 无法在事务内重试),冲突时返回空行 → 重新尝试(最多 3 次)。
  // 与 P1-6 CAS 语义一致(乐观并发 + 唯一约束兑底)。
  const contentHash = computePlanContentHash(plan);
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await tx.execute<{ id: string; version: number }>(sql`
      INSERT INTO card_generation_plans
        (workspace_id, run_id, version, schema_version, plan_json, content_hash,
         produced_by_unit_id, produced_by_event_key)
      SELECT ${input.workspaceId}, ${input.runId}, COALESCE(MAX(version), 0) + 1,
             ${plan.schemaVersion}, ${JSON.stringify(plan)}, ${contentHash},
             ${input.producedByUnitId}, ${input.producedByEventKey}
      FROM card_generation_plans
      WHERE run_id = ${input.runId}
      ON CONFLICT (run_id, version) DO NOTHING
      RETURNING id, version
    `);
    const row = rows[0];
    if (row) {
      return { id: row.id, version: Number(row.version), contentHash };
    }
    // 冲突(并发另一事务已插入同 version)→ 重试,读新快照
  }
  throw new Error("无法插入 plan 记录(并发冲突重试耗尽)");
}

/** 读取指定 run 最新版 plan(不存在返回 null) */
export async function loadLatestPlan(
  tx: WorkerTransaction,
  runId: string,
): Promise<{
  id: string;
  version: number;
  plan: GenerationPlan;
  contentHash: string;
} | null> {
  const row = await tx
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
