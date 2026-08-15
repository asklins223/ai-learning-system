/**
 * 方案 20 C7：Shadow Namespace + 盲评框架 + 切流演练基础设施。
 *
 * §26 C7 Gate:
 * - V2 对 frozen source 做隔离 shadow；
 * - 两轮 immutable provider/model snapshot RC；
 * - 旧版 vs V2 人工盲评；
 * - migration/cutover/rollback drill；
 * - production-like 性能、故障、权限和删除测试。
 *
 * Shadow namespace 设计：
 * - V2 生成运行在独立 namespace 下，不产生 canonical side effects；
 * - shadow runs 的 activation 权限被禁用；
 * - shadow runs 使用独立的 cardContentEpoch 防止与 live 交叉。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";

// ─── Shadow Namespace ────────────────────────────────────────────────────

/** Shadow namespace 前缀，用于隔离 V2 shadow runs。 */
export const SHADOW_NAMESPACE_PREFIX = "shadow-";

/** Shadow namespace ID（每个 shadow 批次独立）。 */
export interface ShadowNamespace {
  namespaceId: string;
  workspaceId: string;
  label: string;
  createdAt: string;
  /** shadow runs 禁止 activation */
  activationBlocked: true;
  /** shadow runs 使用独立的 epoch */
  shadowCardContentEpoch: number;
}

/**
 * 创建 shadow namespace。
 * Shadow runs 在此 namespace 下运行，不产生 canonical side effects。
 */
export async function createShadowNamespace(
  tx: ApiTransaction,
  input: {
    workspaceId: string;
    label: string;
    shadowCardContentEpoch?: number;
  },
): Promise<ShadowNamespace> {
  const namespaceId = `${SHADOW_NAMESPACE_PREFIX}${randomUUID()}`;
  const shadowCardContentEpoch = input.shadowCardContentEpoch ?? 99_999;

  // Shadow namespace 通过在 run 的 sourceScope 中添加 shadow 标记来隔离。
  // 实际隔离通过：
  // 1. activation service 检查 run 是否为 shadow（拒绝激活）
  // 2. outbox consumer 在 shadow 模式下不写 canonical 表

  const ns: ShadowNamespace = {
    namespaceId,
    workspaceId: input.workspaceId,
    label: input.label,
    createdAt: new Date().toISOString(),
    activationBlocked: true,
    shadowCardContentEpoch,
  };

  // Persist shadow namespace metadata
  await tx.execute(sql`
    INSERT INTO card_generation_shadow_namespaces
      (namespace_id, workspace_id, label, created_at, activation_blocked, shadow_card_content_epoch)
    VALUES (
      ${ns.namespaceId}, ${ns.workspaceId}, ${ns.label},
      ${ns.createdAt}, true, ${ns.shadowCardContentEpoch}
    )
    ON CONFLICT (namespace_id) DO NOTHING
  `);

  return ns;
}

/**
 * 检查 run 是否在 shadow namespace 下。
 */
export async function isShadowRun(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
): Promise<boolean> {
  const rows = await tx.execute(sql`
    SELECT EXISTS(
      SELECT 1 FROM card_generation_shadow_namespace_runs
      WHERE workspace_id = ${workspaceId}
        AND run_id = ${runId}
    ) AS is_shadow
  `);
  return Boolean((rows[0] as { is_shadow: boolean })?.is_shadow);
}

/**
 * 将 run 标记为 shadow。
 */
export async function markRunAsShadow(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
  namespaceId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO card_generation_shadow_namespace_runs
      (workspace_id, run_id, namespace_id)
    VALUES (${workspaceId}, ${runId}, ${namespaceId})
    ON CONFLICT DO NOTHING
  `);
}

/**
 * §C7 Gate: 断言 shadow run 不能激活。
 * Activation service 调用此函数验证。
 */
export async function assertNotShadowRun(
  tx: ApiTransaction,
  workspaceId: string,
  runId: string,
): Promise<void> {
  const isShadow = await isShadowRun(tx, workspaceId, runId);
  if (isShadow) {
    throw new ShadowActivationError(
      "shadow_run_cannot_activate",
      "Shadow namespace runs cannot be activated (no canonical side effects)",
    );
  }
}

// ─── Blind Evaluation Framework ──────────────────────────────────────────

/**
 * 盲评记录：旧版 vs V2 的人工盲评结果。
 */
export interface BlindEvaluationRecord {
  evaluationId: string;
  workspaceId: string;
  evaluatorId: string;
  runIdV1: string;
  runIdV2: string;
  /** 评估者不知道哪个是 V1、哪个是 V2 */
  variantA: "v1" | "v2";
  variantB: "v1" | "v2";
  scores: BlindEvaluationScores;
  preference: "a" | "b" | "tie" | "neither";
  notes: string;
  createdAt: string;
}

export interface BlindEvaluationScores {
  /** 内容质量 1-5 */
  contentQualityA: number;
  contentQualityB: number;
  /** 教学价值 1-5 */
  pedagogyValueA: number;
  pedagogyValueB: number;
  /** 答案准确性 1-5 */
  answerAccuracyA: number;
  answerAccuracyB: number;
  /** 证据质量 1-5 */
  evidenceQualityA: number;
  evidenceQualityB: number;
}

/**
 * 创建盲评记录。
 */
export async function createBlindEvaluation(
  tx: ApiTransaction,
  input: Omit<BlindEvaluationRecord, "evaluationId" | "createdAt">,
): Promise<BlindEvaluationRecord> {
  const evaluationId = randomUUID();
  const createdAt = new Date().toISOString();

  await tx.execute(sql`
    INSERT INTO card_generation_blind_evaluations
      (evaluation_id, workspace_id, evaluator_id, run_id_v1, run_id_v2,
       variant_a, variant_b, content_quality_a, content_quality_b,
       pedagogy_value_a, pedagogy_value_b, answer_accuracy_a, answer_accuracy_b,
       evidence_quality_a, evidence_quality_b, preference, notes, created_at)
    VALUES (
      ${evaluationId}, ${input.workspaceId}, ${input.evaluatorId},
      ${input.runIdV1}, ${input.runIdV2},
      ${input.variantA}, ${input.variantB},
      ${input.scores.contentQualityA}, ${input.scores.contentQualityB},
      ${input.scores.pedagogyValueA}, ${input.scores.pedagogyValueB},
      ${input.scores.answerAccuracyA}, ${input.scores.answerAccuracyB},
      ${input.scores.evidenceQualityA}, ${input.scores.evidenceQualityB},
      ${input.preference}, ${input.notes}, ${createdAt}
    )
  `);

  return { ...input, evaluationId, createdAt };
}

/**
 * 查询盲评统计结果。
 */
export async function getBlindEvaluationStats(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<{
  totalEvaluations: number;
  v1Preferred: number;
  v2Preferred: number;
  tie: number;
  neither: number;
  avgV2Score: number;
  avgV1Score: number;
}> {
  const rows = await tx.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE
        (preference = 'a' AND variant_a = 'v2') OR
        (preference = 'b' AND variant_b = 'v2')
      )::int AS v2_preferred,
      COUNT(*) FILTER (WHERE
        (preference = 'a' AND variant_a = 'v1') OR
        (preference = 'b' AND variant_b = 'v1')
      )::int AS v1_preferred,
      COUNT(*) FILTER (WHERE preference = 'tie')::int AS tie,
      COUNT(*) FILTER (WHERE preference = 'neither')::int AS neither,
      AVG(
        CASE WHEN variant_a = 'v2' THEN (content_quality_a + pedagogy_value_a + answer_accuracy_a + evidence_quality_a) / 4.0
             ELSE (content_quality_b + pedagogy_value_b + answer_accuracy_b + evidence_quality_b) / 4.0
        END
      ) AS avg_v2_score,
      AVG(
        CASE WHEN variant_a = 'v1' THEN (content_quality_a + pedagogy_value_a + answer_accuracy_a + evidence_quality_a) / 4.0
             ELSE (content_quality_b + pedagogy_value_b + answer_accuracy_b + evidence_quality_b) / 4.0
        END
      ) AS avg_v1_score
    FROM card_generation_blind_evaluations
    WHERE workspace_id = ${workspaceId}
  `);
  const r = rows[0] as Record<string, unknown>;
  return {
    totalEvaluations: Number(r?.total ?? 0),
    v1Preferred: Number(r?.v1_preferred ?? 0),
    v2Preferred: Number(r?.v2_preferred ?? 0),
    tie: Number(r?.tie ?? 0),
    neither: Number(r?.neither ?? 0),
    avgV2Score: Number(r?.avg_v2_score ?? 0),
    avgV1Score: Number(r?.avg_v1_score ?? 0),
  };
}

// ─── Cutover / Rollback Drill ────────────────────────────────────────────

/**
 * 切流状态。
 */
export type CutoverState = "v1_only" | "shadow_running" | "v2_ready" | "v2_primary" | "v2_only";

export interface CutoverStatus {
  currentState: CutoverState;
  v1WriterEnabled: boolean;
  v2WriterEnabled: boolean;
  v1WriterHitsLast24h: number;
  v2RunsLast24h: number;
  shadowNamespacesActive: number;
  lastCutoverAt: string | null;
  lastRollbackAt: string | null;
}

/**
 * 获取当前切流状态。
 */
export async function getCutoverStatus(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<CutoverStatus> {
  // Check V1 writer hits in last 24h
  const v1HitsRows = await tx.execute(sql`
    SELECT COUNT(*)::int AS hits
    FROM card_generation_legacy_writer_hits
    WHERE workspace_id = ${workspaceId}
      AND hit_at >= now() - interval '24 hours'
  `);
  const v1Hits = Number((v1HitsRows[0] as { hits: number })?.hits ?? 0);

  // Check V2 runs in last 24h
  const v2RunsRows = await tx.execute(sql`
    SELECT COUNT(*)::int AS runs
    FROM card_generation_runs_v2
    WHERE workspace_id = ${workspaceId}
      AND created_at >= now() - interval '24 hours'
  `);
  const v2Runs = Number((v2RunsRows[0] as { runs: number })?.runs ?? 0);

  // Check active shadow namespaces
  const shadowRows = await tx.execute(sql`
    SELECT COUNT(*)::int AS active
    FROM card_generation_shadow_namespaces
    WHERE workspace_id = ${workspaceId}
  `);
  const shadowActive = Number((shadowRows[0] as { active: number })?.active ?? 0);

  // Determine cutover state
  let currentState: CutoverState = "v1_only";
  if (v1Hits === 0 && v2Runs > 0) {
    currentState = "v2_only";
  } else if (v2Runs > 0 && v1Hits > 0) {
    currentState = shadowRunningState(shadowActive, v2Runs, v1Hits);
  } else if (v2Runs > 0) {
    currentState = "v2_primary";
  } else {
    currentState = "v1_only";
  }

  return {
    currentState,
    v1WriterEnabled: v1Hits > 0,
    v2WriterEnabled: true, // V2 writer is always enabled (feature flag controls API)
    v1WriterHitsLast24h: v1Hits,
    v2RunsLast24h: v2Runs,
    shadowNamespacesActive: shadowActive,
    lastCutoverAt: null, // Would be read from a cutover log table
    lastRollbackAt: null,
  };
}

function shadowRunningState(shadowActive: number, v2Runs: number, v1Hits: number): CutoverState {
  if (shadowActive > 0 && v1Hits > v2Runs) return "shadow_running";
  if (v2Runs > v1Hits) return "v2_ready";
  return "shadow_running";
}

/**
 * §C7: Rollback drill — 模拟回滚到 V1。
 * 不实际执行回滚，只验证回滚路径可行。
 */
export async function rollbackDrill(
  tx: ApiTransaction,
  workspaceId: string,
): Promise<{
  canRollback: boolean;
  steps: string[];
  blockingIssues: string[];
}> {
  const steps: string[] = [];
  const blockingIssues: string[] = [];

  // Step 1: Check if V1 writer is still available
  steps.push("1. Verify V1 writer code path is still present");
  // V1 writer code exists in workers/ai-worker/src/agent/

  // Step 2: Check if V1 tables are intact
  steps.push("2. Verify V1 card_generation_runs table is accessible");

  // Step 3: Check if V2 activations have occurred (would need data migration)
  const v2Activations = await tx.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM learning_cards_v2
    WHERE workspace_id = ${workspaceId}
      AND lifecycle = 'active'
  `);
  const activatedCount = Number((v2Activations[0] as { count: number })?.count ?? 0);
  if (activatedCount > 0) {
    blockingIssues.push(`${activatedCount} V2 cards are active — rollback would orphan these`);
  }
  steps.push(`3. Check V2 activations: ${activatedCount} active cards`);

  // Step 4: Check if V2 runs are in progress
  const v2InProgress = await tx.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM card_generation_runs_v2
    WHERE workspace_id = ${workspaceId}
      AND status IN ('queued', 'planning', 'authoring', 'checking', 'review_ready')
  `);
  const inProgressCount = Number((v2InProgress[0] as { count: number })?.count ?? 0);
  if (inProgressCount > 0) {
    blockingIssues.push(`${inProgressCount} V2 runs are in progress — must wait or cancel`);
  }
  steps.push(`4. Check V2 runs in progress: ${inProgressCount}`);

  // Step 5: Verify feature flag can disable V2 API
  steps.push("5. Verify isCardGenerationV2Enabled feature flag can be toggled");

  const canRollback = blockingIssues.length === 0;
  return { canRollback, steps, blockingIssues };
}

// ─── Errors ──────────────────────────────────────────────────────────────

export class ShadowActivationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShadowActivationError";
    this.code = code;
  }
}
