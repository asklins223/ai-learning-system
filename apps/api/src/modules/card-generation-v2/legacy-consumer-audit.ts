/**
 * 方案 20 C0：claim/quoteText/keyPointId 消费者审计 + 旧 writer 命中探针。
 *
 * §26 C0 Gate:
 * - 代码搜索全部 claim/quoteText/keyPointId 生产消费者；
 * - 给每个消费者标记 preserve/rebase/delete；
 * - 为旧 writer/fallback 增加命中探针。
 *
 * 本模块提供：
 * 1. LEGACY_CONSUMER_REGISTRY — 所有使用 claim/quoteText/keyPointId 的模块注册表；
 * 2. LegacyWriterProbe — 旧 writer 命中探针（运行时记录命中）；
 * 3. assertNoNewClaimDependencies — CI gate 阻止新增 claim 依赖。
 */

import { sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";

// ─── §26 C0: 消费者注册表 ────────────────────────────────────────────────

export type ConsumerAction = "preserve" | "rebase" | "delete";

/**
 * R35：registry 条目状态。
 * - done：rebase 已完成（模块的正式渲染/消费路径已切 V2）；
 * - dual：双轨——V1 origin 数据保留读取（合法过渡态，§21.3），
 *   V2 origin 数据已走 snapshot/objectiveId 新路径（R35 源码扫描核实）；
 * - pending：仍有 V1-only 读取且无 V2 分支（需 rebase 或 delete 处置）。
 */
export type RegistryEntryStatus = "done" | "dual" | "pending";

export interface LegacyConsumerEntry {
  /** 模块路径或文件名 */
  module: string;
  /** 消费的字段 */
  fields: ReadonlyArray<"claim" | "quoteText" | "keyPointId">;
  /** 处置策略 */
  action: ConsumerAction;
  /** 说明 */
  reason: string;
  /** C0 标记日期 */
  taggedAt: string;
  /** R35 复核状态（未标注 = 待复核） */
  status?: RegistryEntryStatus;
  /** 状态标注日期 */
  statusAt?: string;
}

/**
 * C0 §26: 全部 claim/quoteText/keyPointId 生产消费者清单。
 * 每条标记 preserve/rebase/delete。
 *
 * - preserve: 保留旧字段读取直到 C8 shrink（legacy read adapter 兜底）
 * - rebase: 切换到 V2 的 objectiveId/publicSummary/canonicalAnswer
 * - delete: 在 C8 删除旧字段及其代码路径
 */
export const LEGACY_CONSUMER_REGISTRY: ReadonlyArray<LegacyConsumerEntry> = [
  // ── Card 页面 ──────────────────────────────────────────────────────
  { module: "apps/web/app/(workspace)/(focus)/cards/[id]/page.tsx", fields: ["claim", "quoteText", "keyPointId"], action: "rebase", reason: "Card 详情页切换到 V2 objectiveId + front/reveal", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/web/app/(workspace)/(focus)/cards/[id]/validate/page.tsx", fields: ["keyPointId", "claim"], action: "rebase", reason: "验证页切换到 V2 objectiveId + rubric", taggedAt: "2026-08-14" },
  { module: "apps/web/app/(workspace)/(focus)/card-sets/[id]/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Card set 页切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Review ────────────────────────────────────────────────────────
  { module: "apps/api/src/modules/review/service.ts", fields: ["claim", "keyPointId"], action: "rebase", reason: "Review service 切换到 V2 objectiveId", taggedAt: "2026-08-14", status: "done", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/review/consumer-eligibility.ts", fields: ["keyPointId"], action: "rebase", reason: "Eligibility 切换到 V2 objective lifecycle", taggedAt: "2026-08-14", status: "done", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/review/attempt-service.ts", fields: ["claim", "quoteText"], action: "rebase", reason: "Attempt service 切换到 V2 target snapshot", taggedAt: "2026-08-14", status: "dual", statusAt: "2026-08-15" },
  { module: "apps/web/app/(workspace)/(default)/review/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Review 页面切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/web/app/(workspace)/(focus)/review/[scheduleId]/page.tsx", fields: ["keyPointId", "claim"], action: "rebase", reason: "Review detail 切换到 V2", taggedAt: "2026-08-14" },

  // ── Today ─────────────────────────────────────────────────────────
  { module: "apps/web/app/(workspace)/(default)/today/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Today 页切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Graph / Star Map ──────────────────────────────────────────────
  { module: "apps/web/app/(workspace)/(default)/graph/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Star Map 切换到 V2 objective ID", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/understanding/graph.ts", fields: ["keyPointId", "claim"], action: "rebase", reason: "Graph service 切换到 V2 objective", taggedAt: "2026-08-14" },
  { module: "apps/api/src/modules/understanding/service.ts", fields: ["keyPointId"], action: "rebase", reason: "Understanding service 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Learning Sessions ─────────────────────────────────────────────
  { module: "apps/api/src/modules/learning-sessions/session-service.ts", fields: ["claim", "keyPointId"], action: "rebase", reason: "PREPARE 切换到 TargetSnapshotV2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/handoff-adapter.ts", fields: ["claim", "quoteText", "keyPointId"], action: "rebase", reason: "Handoff adapter 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/answer-submission.ts", fields: ["claim"], action: "rebase", reason: "Answer submission 切换到 V2 rubric", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/commit-outbox.ts", fields: ["keyPointId"], action: "rebase", reason: "Commit outbox 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/episode-commit.ts", fields: ["keyPointId"], action: "rebase", reason: "Episode commit 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/route-launcher.ts", fields: ["keyPointId"], action: "rebase", reason: "Route launcher 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/tutor-detour.ts", fields: ["claim", "keyPointId"], action: "rebase", reason: "Tutor detour 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/disposition.ts", fields: ["keyPointId"], action: "rebase", reason: "Disposition 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/transfer-gate.ts", fields: ["keyPointId"], action: "rebase", reason: "Transfer gate 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/redaction-service.ts", fields: ["claim"], action: "rebase", reason: "Redaction 切换到 V2 canonical answer", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/scene-activation.ts", fields: ["keyPointId"], action: "rebase", reason: "Scene activation 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/star-map-projections.ts", fields: ["keyPointId", "claim"], action: "rebase", reason: "Star map projections 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/canonical-events.ts", fields: ["keyPointId"], action: "rebase", reason: "Canonical events 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-sessions/relation-governance.ts", fields: ["keyPointId"], action: "rebase", reason: "Relation governance 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Learning Runs ─────────────────────────────────────────────────
  { module: "apps/api/src/modules/learning-runs/run-planner.ts", fields: ["claim", "quoteText", "keyPointId"], action: "rebase", reason: "Run planner 切换到 V2 target snapshot", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-runs/run-structured.ts", fields: ["claim", "keyPointId"], action: "rebase", reason: "Structured generator 切换到 V2 rubric", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-runs/run-critic.ts", fields: ["claim"], action: "rebase", reason: "Run critic 切换到 V2 rubric", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-runs/run-view.ts", fields: ["keyPointId"], action: "rebase", reason: "Run view 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-runs/run-service.ts", fields: ["keyPointId"], action: "rebase", reason: "Run service 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-runs/run-processing-tick.ts", fields: ["keyPointId"], action: "rebase", reason: "Processing tick 切换到 V2", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/learning-runs/legacy-backfill.ts", fields: ["claim", "quoteText", "keyPointId"], action: "preserve", reason: "Backfill 脚本保留旧字段读取直到 C8", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Validation ────────────────────────────────────────────────────
  { module: "apps/api/src/modules/validation/service.ts", fields: ["claim", "keyPointId"], action: "rebase", reason: "Validation service 切换到 V2 rubric", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/validation/session-service.ts", fields: ["claim", "quoteText", "keyPointId"], action: "rebase", reason: "Validation session 切换到 V2 target snapshot", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Other ─────────────────────────────────────────────────────────
  { module: "apps/api/src/modules/stats/service.ts", fields: ["keyPointId"], action: "rebase", reason: "Stats 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/export/service.ts", fields: ["claim", "quoteText"], action: "rebase", reason: "Export 切换到 V2 canonical answer", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/search/service.ts", fields: ["keyPointId"], action: "rebase", reason: "Search 切换到 V2 objective", taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Worker (V1 pipeline) ──────────────────────────────────────────
  { module: "workers/ai-worker/src/agent/prepare.ts", fields: ["claim"], action: "delete", reason: "V1 PREPARE 被 V2 Planner 替代后删除", taggedAt: "2026-08-14" },
  { module: "workers/ai-worker/src/agent/planned-path.ts", fields: ["claim", "keyPointId"], action: "delete", reason: "V1 planned path 被 V2 Author 替代后删除", taggedAt: "2026-08-14" },
  { module: "workers/ai-worker/src/agent/publish-phase.ts", fields: ["claim"], action: "delete", reason: "V1 publish 被 V2 Activation 替代后删除", taggedAt: "2026-08-14" },
  { module: "workers/ai-worker/src/agent/plan-path.ts", fields: ["claim"], action: "delete", reason: "V1 plan path 被 V2 Planner 替代后删除", taggedAt: "2026-08-14" },
  { module: "workers/ai-worker/src/agent/fast-path.ts", fields: ["claim"], action: "delete", reason: "V1 fast path 被 V2 micro-note 轻链路替代后删除", taggedAt: "2026-08-14" },
];

// ─── §26 C0: 旧 writer 命中探针 ──────────────────────────────────────────

/**
 * 旧 writer 命中探针。
 *
 * 方案 20 §26 C0: "为旧 writer/fallback 增加命中探针"。
 * C8 Gate: "legacy writer/fallback hit 连续观察窗口为 0"。
 *
 * 探针在 `card_generation_runs` 表上记录旧的 V1 writer 是否仍在被使用。
 * 当 V2 完全切换后，V1 writer hit 应该为 0。
 */
export interface LegacyWriterProbeRecord {
  runId: string;
  workspaceId: string;
  writerKind: "v1_supervisor" | "v1_fast_path" | "v1_planned_path" | "v1_fallback";
  hitAt: string;
  note: string;
}

/**
 * 在 `card_generation_legacy_writer_hits` 表中记录旧 writer 命中。
 * 该表由 migration 创建（additive sidecar，不阻塞 V1 运行）。
 */
export async function recordLegacyWriterHit(
  tx: ApiTransaction,
  input: LegacyWriterProbeRecord,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO card_generation_legacy_writer_hits (run_id, workspace_id, writer_kind, hit_at, note)
    VALUES (${input.runId}, ${input.workspaceId}, ${input.writerKind}, ${input.hitAt}, ${input.note})
    ON CONFLICT DO NOTHING
  `);
}

/**
 * 查询旧 writer 命中计数（C8 Gate 检查用）。
 */
export async function countLegacyWriterHits(
  tx: ApiTransaction,
  workspaceId: string | null,
  sinceIso: string,
): Promise<{ writerKind: string; hitCount: number }[]> {
  const rows = workspaceId
    ? await tx.execute<{ writer_kind: string; hit_count: number }>(sql`
        SELECT writer_kind, COUNT(*)::int AS hit_count
        FROM card_generation_legacy_writer_hits
        WHERE workspace_id = ${workspaceId} AND hit_at >= ${sinceIso}
        GROUP BY writer_kind
      `)
    : await tx.execute<{ writer_kind: string; hit_count: number }>(sql`
        SELECT writer_kind, COUNT(*)::int AS hit_count
        FROM card_generation_legacy_writer_hits
        WHERE hit_at >= ${sinceIso}
        GROUP BY writer_kind
      `);
  return rows.map((r) => ({ writerKind: r.writer_kind, hitCount: r.hit_count }));
}

// ─── §26 C0: CI gate helper ──────────────────────────────────────────────

/**
 * CI gate: 确保没有新增的 claim 依赖。
 *
 * C0 Gate: "没有新功能继续依赖 claim 语义"。
 * 在 CI 中运行此函数，如果发现 registry 之外的 claim 使用则报警。
 */
export function assertNoNewClaimDependencies(
  foundModules: string[],
  registry: ReadonlyArray<LegacyConsumerEntry> = LEGACY_CONSUMER_REGISTRY,
): { newViolations: string[] } {
  const known = new Set(registry.map((e) => e.module));
  const newViolations = foundModules.filter((m) => !known.has(m));
  return { newViolations };
}

// ─── §26 C0: 审计报告生成 ─────────────────────────────────────────────────

export interface ConsumerAuditReport {
  totalConsumers: number;
  byAction: Record<ConsumerAction, number>;
  byField: Record<string, number>;
  entries: LegacyConsumerEntry[];
}

export function generateConsumerAuditReport(
  registry: ReadonlyArray<LegacyConsumerEntry> = LEGACY_CONSUMER_REGISTRY,
): ConsumerAuditReport {
  const byAction: Record<ConsumerAction, number> = { preserve: 0, rebase: 0, delete: 0 };
  const byField: Record<string, number> = { claim: 0, quoteText: 0, keyPointId: 0 };
  for (const entry of registry) {
    byAction[entry.action] += 1;
    for (const f of entry.fields) {
      byField[f] = (byField[f] ?? 0) + 1;
    }
  }
  return {
    totalConsumers: registry.length,
    byAction,
    byField,
    entries: [...registry],
  };
}
