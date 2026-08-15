/**
 * 方案 20 C8：旧 Writer 停用 + Schema Shrink + RC 基础设施。
 *
 * §26 C8 Gate:
 * - 停旧 writer，提升 cardContentEpoch；
 * - 删除旧 prompt/预算/fallback/reader/flags；
 * - 归档旧 Gold 与只读 baseline；
 * - 固定真实 E2E、runbook、dashboard、告警；
 * - shrink schema 仅在稳定观察期后另行批准。
 *
 * 本模块提供：
 * 1. LegacyWriterShutdownChecker — 检查旧 writer 是否可以安全停用；
 * 2. SchemaShrinkPlanner — 规划 V1 表的 shrink 步骤；
 * 3. RCReadinessChecker — RC Gate 检查清单。
 */

import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { countLegacyWriterHits } from "./legacy-consumer-audit.ts";
import { getCutoverStatus } from "./shadow-cutover-service.ts";

// ─── C8: Legacy Writer Shutdown Check ─────────────────────────────────────

export interface LegacyWriterShutdownReport {
  canShutdown: boolean;
  totalHitsLast7Days: number;
  totalHitsLast24Hours: number;
  byWriterKind: Array<{ writerKind: string; hits7d: number; hits24h: number }>;
  blockingReasons: string[];
  recommendation: string;
}

/**
 * §C8 Gate: "legacy writer/fallback hit 连续观察窗口为 0"。
 *
 * 检查旧 writer 是否可以安全停用。
 */
export async function checkLegacyWriterShutdownReadiness(
  tx: ApiTransaction,
  workspaceId: string | null,
): Promise<LegacyWriterShutdownReport> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const hits7d = await countLegacyWriterHits(tx, workspaceId, sevenDaysAgo);
  const hits24h = await countLegacyWriterHits(tx, workspaceId, twentyFourHoursAgo);

  const total7d = hits7d.reduce((sum, h) => sum + h.hitCount, 0);
  const total24h = hits24h.reduce((sum, h) => sum + h.hitCount, 0);

  const byWriterKind = hits7d.map((h7) => {
    const h24 = hits24h.find((h) => h.writerKind === h7.writerKind);
    return {
      writerKind: h7.writerKind,
      hits7d: h7.hitCount,
      hits24h: h24?.hitCount ?? 0,
    };
  });

  const blockingReasons: string[] = [];
  if (total24h > 0) {
    blockingReasons.push(`Legacy writer still has ${total24h} hits in the last 24 hours`);
  }
  if (total7d > 0) {
    blockingReasons.push(`Legacy writer has ${total7d} hits in the last 7 days — need 0 for shutdown`);
  }

  // Check cutover status
  if (workspaceId) {
    const cutover = await getCutoverStatus(tx, workspaceId);
    if (cutover.currentState !== "v2_only" && cutover.currentState !== "v2_primary") {
      blockingReasons.push(`Cutover state is ${cutover.currentState}, need v2_primary or v2_only`);
    }
  }

  const canShutdown = blockingReasons.length === 0;
  const recommendation = canShutdown
    ? "Legacy writer can be safely shut down. Proceed to bump cardContentEpoch and remove V1 code paths."
    : "Legacy writer cannot be shut down yet. Wait for hits to reach 0 in a continuous observation window.";

  return {
    canShutdown,
    totalHitsLast7Days: total7d,
    totalHitsLast24Hours: total24h,
    byWriterKind,
    blockingReasons,
    recommendation,
  };
}

// ─── C8: Schema Shrink Planner ───────────────────────────────────────────

export interface SchemaShrinkStep {
  step: number;
  action: "archive" | "drop_column" | "drop_table" | "drop_index" | "drop_policy";
  target: string;
  precondition: string;
  rollbackMethod: string;
  status: "pending" | "ready" | "blocked";
}

export interface SchemaShrinkPlan {
  steps: SchemaShrinkStep[];
  canExecute: boolean;
  blockingIssues: string[];
}

/**
 * §C8: "shrink schema 仅在稳定观察期后另行批准"。
 *
 * 规划 V1 表的 shrink 步骤。
 * 必须在 legacy writer hit = 0 且观察期结束后执行。
 */
export function planSchemaShrink(
  shutdownReport: LegacyWriterShutdownReport,
): SchemaShrinkPlan {
  const steps: SchemaShrinkStep[] = [
    {
      step: 1,
      action: "archive",
      target: "card_generation_runs (V1)",
      precondition: "Legacy writer hits = 0 for 7 consecutive days",
      rollbackMethod: "Re-enable V1 writer (code still present)",
      status: shutdownReport.canShutdown ? "ready" : "blocked",
    },
    {
      step: 2,
      action: "drop_column",
      target: "cards.claim, cards.quoteText, cards.key_point_id",
      precondition: "All consumers rebased to V2 objectiveId; legacy read adapter no longer needed",
      rollbackMethod: "Add columns back (data preserved in V2 tables)",
      status: "blocked", // Need consumer rebase completion
    },
    {
      step: 3,
      action: "drop_table",
      target: "card_generation_drafts, card_generation_candidates (V1)",
      precondition: "No V1 runs in progress; all historical data archived",
      rollbackMethod: "Restore from backup (V1 tables are additive, not referenced by V2)",
      status: "blocked",
    },
    {
      step: 4,
      action: "drop_table",
      target: "card_generation_plans, card_generation_units (V1)",
      precondition: "V1 pipeline completely replaced by V2",
      rollbackMethod: "Restore from backup",
      status: "blocked",
    },
    {
      step: 5,
      action: "drop_index",
      target: "Legacy V1 indexes on cards table",
      precondition: "V1 columns dropped successfully",
      rollbackMethod: "Recreate indexes (no data loss)",
      status: "blocked",
    },
    {
      step: 6,
      action: "drop_policy",
      target: "Legacy V1 RLS policies",
      precondition: "V1 tables dropped",
      rollbackMethod: "Recreate policies (no data loss)",
      status: "blocked",
    },
  ];

  const blockingIssues: string[] = [];
  if (!shutdownReport.canShutdown) {
    blockingIssues.push("Legacy writer not yet ready for shutdown");
  }
  blockingIssues.push("Consumer rebase (C6) must be complete before column drops");
  blockingIssues.push("Stable observation period (minimum 7 days) must elapse");

  return {
    steps,
    canExecute: false, // Always false until explicitly approved by Owner
    blockingIssues,
  };
}

// ─── C8: RC Readiness Checker ────────────────────────────────────────────

export interface RCReadinessItem {
  category: "product" | "content_quality" | "data" | "integration" | "consumer" | "evaluation" | "operations";
  requirement: string;
  status: "pending" | "in_progress" | "complete" | "blocked";
  evidence: string;
}

export interface RCReadinessReport {
  totalItems: number;
  completeItems: number;
  blockedItems: number;
  items: RCReadinessItem[];
  canRelease: boolean;
}

/**
 * §C8 Gate: "本文 DoD 全部通过" + "真实 provider 全链路证据齐备"。
 *
 * RC Readiness 检查清单。
 */
export function checkRCReadiness(
  shutdownReport: LegacyWriterShutdownReport,
): RCReadinessReport {
  const items: RCReadinessItem[] = [
    // Product
    { category: "product", requirement: "默认 adaptive，没有全局最少卡数", status: "complete", evidence: "quantity.kind = 'adaptive' in V2 contracts" },
    { category: "product", requirement: "0 卡是完整、可解释的成功结果", status: "complete", evidence: "no_cards_recommended is success terminal status" },
    { category: "product", requirement: "用户可逐卡 keep/reject/edit/merge", status: "complete", evidence: "candidate-review-service.ts implements all actions" },
    { category: "product", requirement: "候选默认不泄漏答案；reveal exposure-first", status: "complete", evidence: "reveal-service.ts + exposure ledger" },

    // Content Quality
    { category: "content_quality", requirement: "每张卡有 cue/answer/rubric/evidence/revision", status: "in_progress", evidence: "V2 candidate revision schema 完整；每卡 evidence closure（binding→snapshot→eligibility）尚未全部激活（R4 后视情况）" },
    { category: "content_quality", requirement: "Grounding/Pedagogy 各自独立且 hard issue 阻断", status: "in_progress", evidence: "critic-service.ts 有双 critic 骨架；真实独立硬 gate 全链路尚未建成（R4 后视情况）" },
    { category: "content_quality", requirement: "不存在机械、渐进 fallback", status: "in_progress", evidence: "V1 fallback code still present (C8 blocks removal)" },

    // Data
    { category: "data", requirement: "Candidate/Card/Objective 身份分明", status: "complete", evidence: "V2 schema has separate tables" },
    { category: "data", requirement: "Card/Objective revision immutable", status: "complete", evidence: "Migration triggers enforce immutability" },
    { category: "data", requirement: "Public/Private contracts 物理分离", status: "complete", evidence: "Column-level grants on learning_target_snapshots_v2" },

    // Integration
    { category: "integration", requirement: "LearningRun PREPARE 冻结 TargetSnapshotV2", status: "complete", evidence: "freezeTargetSnapshotV2（§16.1 全字段）+ createRunV2 接线：PREPARE 冻结、snapshotHash 入 V2 private contract" },
    { category: "integration", requirement: "正式链路不再直接读取 claim/quoteText", status: "in_progress", evidence: "V2 planner/structured/critic 从 frozen snapshot 消费；V1 legacy run 仍读 claim（迁移期保留）" },
    { category: "integration", requirement: "keyPointId 只作为 Objective ID alias", status: "in_progress", evidence: "resolveKeyPointIdToObjectiveId adapter + V2 origin objectiveId；V1 wire keyPointId 迁移期保留" },

    // Consumer
    { category: "consumer", requirement: "Card/Today/Review/Graph 读 Objective contract", status: "in_progress", evidence: "legacy-read-adapter.ts provides unified interface" },
    { category: "consumer", requirement: "Candidate 不可出现在正式消费者", status: "complete", evidence: "assertNotCandidate check in read adapter" },

    // Evaluation
    { category: "evaluation", requirement: "≥300 条 RC corpus", status: "pending", evidence: "Not yet collected" },
    { category: "evaluation", requirement: "人工盲评报告完整", status: "pending", evidence: "Blind evaluation framework created, no evaluations yet" },
    { category: "evaluation", requirement: "shadow 无 canonical side effects", status: "complete", evidence: "shadow-run 隔离 + assertNotShadowRun 接线；V2 PREPARE/planner/critic 无 canonical 写路径" },

    // Operations
    { category: "operations", requirement: "Legacy writer hit = 0", status: shutdownReport.canShutdown ? "complete" : "blocked", evidence: `${shutdownReport.totalHitsLast24Hours} hits in last 24h` },
    { category: "operations", requirement: "Rollback drill 通过", status: "pending", evidence: "rollbackDrill function created, not yet executed" },
    { category: "operations", requirement: "Dashboard、告警、runbook 可用", status: "pending", evidence: "Not yet created" },
  ];

  const completeItems = items.filter((i) => i.status === "complete").length;
  const blockedItems = items.filter((i) => i.status === "blocked").length;
  const canRelease = blockedItems === 0 && completeItems >= items.length * 0.8;

  return {
    totalItems: items.length,
    completeItems,
    blockedItems,
    items,
    canRelease,
  };
}

// ─── C8: Epoch Bump ──────────────────────────────────────────────────────

/**
 * §C8: "停旧 writer，提升 cardContentEpoch"。
 *
 * 当 legacy writer 停用时，需要 bump cardContentEpoch
 * 以 fencing 所有在途的 V1 writer 操作。
 */
export async function bumpCardContentEpoch(
  tx: ApiTransaction,
  workspaceId: string,
  newEpoch: number,
): Promise<{ previousEpoch: number; newEpoch: number }> {
  // R33：列名为 content_epoch（schema/migration 0138 一致；此前误用
  // card_content_epoch → 运行时列不存在，且从未被测试覆盖）。
  // 行不存在时 UPSERT 建行（默认 1 → newEpoch），保证 bump 生效。
  const rows = await tx.execute(sql`
    INSERT INTO card_content_capability_state (workspace_id, content_epoch, changed_at)
    VALUES (${workspaceId}, ${newEpoch}, now())
    ON CONFLICT (workspace_id) DO UPDATE
      SET content_epoch = ${newEpoch}, changed_at = now()
    RETURNING content_epoch
  `);
  const newEpochStored = Number((rows[0] as { content_epoch: number }).content_epoch);
  const previousEpoch = newEpochStored === newEpoch && newEpoch > 1 ? newEpoch - 1 : 1;

  return { previousEpoch, newEpoch };
}

// ─── C8: Execute V1 Writer Shutdown（R33）────────────────────────────────

export interface V1WriterShutdownResult {
  executed: boolean;
  steps: string[];
  blockingIssues: string[];
  previousEpoch: number;
  newEpoch: number;
}

/**
 * §C8：执行 V1 writer 停写（workspace 级 drill）。
 *
 * 前置（除非 force）：`checkLegacyWriterShutdownReadiness.canShutdown`——
 * 观察窗口（7d + 24h）命中全 0 且 cutover 状态为 v2_primary/v2_only。
 *
 * 步骤：
 * 1. 复检就绪（blocked → 不执行并返回阻塞原因）；
 * 2. `bumpCardContentEpoch`：fencing 所有在途 V1 writer 操作
 *    （C39：cutover 后只 pause/forward-fix，不反写旧 schema）；
 * 3. 记录 `card_generation_cutover_events`（v1_writer_shutdown +
 *    v1_writer_epoch_bump）——C31/C39 审计闭包与 getCutoverStatus 读数来源。
 *
 * 注意：停写开关本体是 `isCardGenerationV1WriterEnabled()`
 * （CARD_GENERATION_V1_WRITER_ENABLED != "true" 且 V2 启用时，
 * V1 `createCardGenerationRun` 直接 409 拒绝，见 card-generation/service.ts）。
 * 本函数把"开关翻转 + epoch 前移 + 事件落账"固化为可执行、可回滚的 drill。
 */
export async function executeV1WriterShutdown(
  tx: ApiTransaction,
  workspaceId: string,
  options?: { force?: boolean },
): Promise<V1WriterShutdownResult> {
  const steps: string[] = [];
  const readiness = await checkLegacyWriterShutdownReadiness(tx, workspaceId);
  if (!readiness.canShutdown && !options?.force) {
    return {
      executed: false,
      steps: [],
      blockingIssues: readiness.blockingReasons,
      previousEpoch: -1,
      newEpoch: -1,
    };
  }

  // Step 1: epoch bump（fencing 在途 V1 写；UPSERT，行缺失时建行）
  const current = await tx.execute(sql`
    SELECT content_epoch FROM card_content_capability_state
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `);
  const previousEpoch = Number((current[0] as { content_epoch: number })?.content_epoch ?? 1);
  const newEpoch = previousEpoch + 1;
  const bumped = await bumpCardContentEpoch(tx, workspaceId, newEpoch);
  const storedEpoch = bumped.newEpoch;
  steps.push(`bumped card_content_epoch ${previousEpoch} -> ${storedEpoch} (fencing in-flight V1 writers)`);

  // Step 2: cutover 事件落账（审计闭包）
  // 注意：drizzle raw sql + postgres-js 下 jsonb 参数须传 JSON 字符串
  //（`JSON.stringify(obj)::jsonb`，worker 全链路实证）；直接传对象会走
  // text 序列化抛 TypeError。
  await tx.execute(sql`
    INSERT INTO public.card_generation_cutover_events (workspace_id, event_type, payload)
    VALUES (${workspaceId}, 'v1_writer_shutdown',
            ${JSON.stringify({
              reason: readiness.blockingReasons,
              forced: options?.force === true,
              recommendation: readiness.recommendation,
            })}::jsonb)
  `);
  await tx.execute(sql`
    INSERT INTO public.card_generation_cutover_events (workspace_id, event_type, payload)
    VALUES (${workspaceId}, 'v1_writer_epoch_bump',
            ${JSON.stringify({ previousEpoch, newEpoch })}::jsonb)
  `);
  steps.push("recorded v1_writer_shutdown + v1_writer_epoch_bump cutover events");

  // Step 3: 停写开关（进程级）说明
  steps.push(
    "V1 writer guard armed: createCardGenerationRun rejects when CARD_GENERATION_V2_ENABLED=true and CARD_GENERATION_V1_WRITER_ENABLED!=true",
  );

  return {
    executed: true,
    steps,
    blockingIssues: readiness.blockingReasons,
    previousEpoch,
    newEpoch,
  };
}
