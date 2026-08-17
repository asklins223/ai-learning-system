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
  fields: ReadonlyArray<"claim" | "quoteText" | "keyPointId" | "schemaJson">;
  /** 处置策略 */
  action: ConsumerAction;
  /** 说明 */
  reason: string;
  /** C0 标记日期 */
  taggedAt: string;
  /** W0-02：模块 owner（负责把该模块切到 Objective Surface 的人/角色）。 */
  owner?: string;
  /** W0-02：是否正式消费者（Home/Cards/Detail/Today/Review/Search/Graph/Pet/Stats/Export/Note lifecycle）。 */
  formal?: boolean;
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
  { module: "apps/web/app/(workspace)/(default)/review/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Review 卡面切到 Objective Surface（Schedule identity 保留）", owner: "fe-review", formal: true, taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
  { module: "apps/web/app/(workspace)/(focus)/review/[scheduleId]/page.tsx", fields: ["keyPointId", "claim"], action: "rebase", reason: "Review detail 切换到 V2", taggedAt: "2026-08-14" },

  // ── Today ─────────────────────────────────────────────────────────
  { module: "apps/web/app/(workspace)/(default)/today/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Today 切到 Objective queue（action 与 Dashboard 一致）", owner: "fe-today", formal: true, taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },

  // ── Graph / Star Map ──────────────────────────────────────────────
  { module: "apps/web/app/(workspace)/(default)/graph/page.tsx", fields: ["claim", "keyPointId"], action: "rebase", reason: "Star Map 切到 Topology V3 objective-native node", owner: "fe-graph", formal: true, taggedAt: "2026-08-14" , status: "dual", statusAt: "2026-08-15" },
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
  { module: "apps/api/src/modules/stats/service.ts", fields: ["keyPointId"], action: "rebase", reason: "Stats 切到 Objective 口径（active/validated/due 与 Dashboard 对账，hidden alias=0）", owner: "api-stats", formal: true, taggedAt: "2026-08-14", status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/export/service.ts", fields: ["claim", "quoteText"], action: "rebase", reason: "Export 增加 Objective/Origin，不导出私有 rubric", owner: "api-export", formal: true, taggedAt: "2026-08-14", status: "dual", statusAt: "2026-08-15" },
  { module: "apps/api/src/modules/search/service.ts", fields: ["keyPointId"], action: "rebase", reason: "Search 建立 Objective 索引（conceptLabel/source/note 可搜；answer/rubric 不进索引）", owner: "api-search", formal: true, taggedAt: "2026-08-14", status: "dual", statusAt: "2026-08-15" },

  { module: "apps/web/app/(workspace)/(default)/cards/page.tsx", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "卡库切到 Objective list，不再做 V1/V2 数组合并与有损转换", owner: "fe-cards", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/app/(workspace)/(focus)/learning-cards/[cardId]/page.tsx", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "详情切到 Objective Surface controller，移除完整题面主视觉与伪作答", owner: "fe-detail", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/app/(workspace)/(default)/search/page.tsx", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "Search 结果切到 Objective 索引（不索引 answer/rubric）", owner: "fe-search", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  // ── Plan 23 正式消费者（W0-02；owner/formal 标记）──────────────────
  { module: "apps/web/app/(workspace)/(default)/page.tsx", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "首页切到 /v2/learning-dashboard，不再读 listCards + schemaJson.title/summary", owner: "fe-home", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/app/(workspace)/(default)/stats/page.tsx", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "Stats 页切到 Objective 口径（与 Dashboard 对账）", owner: "fe-stats", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/app/(workspace)/(default)/search/page.tsx", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "Search 页切到 Objective 索引结果（不索引 answer/rubric）", owner: "fe-search", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/api/src/modules/companion-bridge/context-hydration.ts", fields: ["claim", "schemaJson", "keyPointId"], action: "rebase", reason: "Pet 读取 Objective label/state，不再用 claim/summary 拼标题", owner: "fe-pet", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/api/src/modules/note/service.ts", fields: ["schemaJson", "keyPointId"], action: "rebase", reason: "Note archive/version update 处理 Objective Origin freshness/lifecycle", owner: "api-note", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/lib/learning-card-library.ts", fields: ["schemaJson", "claim"], action: "delete", reason: "依赖 legacy CardListItem/CardSet 的卡库辅助，切到 Objective Surface 后删除", owner: "fe-cards", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/lib/api.ts", fields: ["schemaJson"], action: "rebase", reason: "V2 列表无 total；新增 Objective API client，不复用 legacy CardListItem", owner: "fe-api", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },
  { module: "apps/web/lib/api-types.ts", fields: ["schemaJson", "claim", "quoteText"], action: "rebase", reason: "公共类型库继续承载 CardListItem/claim 类型；W3 后只保留 legacy/history 类型", owner: "fe-api", formal: true, taggedAt: "2026-08-16", status: "pending", statusAt: "2026-08-16" },

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

// ─── Plan 23 W0-02: 正式消费者 gate（§22/§30）─────────────────────────────
// 旧 C0 gate 只阻止“新增”claim 依赖；“登记为 dual”只是文档事实，不是可执行
// release gate（23 方案 §2.7）。以下 gate 把「正式消费者必须脱离 pending」变成
// 可执行条件，供 CI / 实施记录使用。

/** Plan 23 §22/§30：必须由 Objective Surface 驱动的正式消费者（官方页面/服务）。 */
export const FORMAL_CONSUMER_REQUIRED_MODULES: ReadonlyArray<string> = [
  // Home
  "apps/web/app/(workspace)/(default)/page.tsx",
  // Cards library / Detail
  "apps/web/app/(workspace)/(default)/cards/page.tsx",
  "apps/web/app/(workspace)/(focus)/learning-cards/[cardId]/page.tsx",
  // Today / Review / Search / Graph
  "apps/web/app/(workspace)/(default)/today/page.tsx",
  "apps/web/app/(workspace)/(default)/review/page.tsx",
  "apps/web/app/(workspace)/(default)/search/page.tsx",
  "apps/web/app/(workspace)/(default)/graph/page.tsx",
  // Pet / Companion Bridge
  "apps/api/src/modules/companion-bridge/context-hydration.ts",
  // Stats / Export / Note lifecycle
  "apps/api/src/modules/stats/service.ts",
  "apps/api/src/modules/export/service.ts",
  "apps/api/src/modules/note/service.ts",
];

export interface FormalConsumerGateReport {
  pass: boolean;
  /** 必需但未登记的正式消费者模块。 */
  missingModules: string[];
  /** 已登记但 status 仍为 pending 或缺失的正式消费者。 */
  pendingFormalConsumers: LegacyConsumerEntry[];
}

export function formalConsumerGateReport(
  registry: ReadonlyArray<LegacyConsumerEntry> = LEGACY_CONSUMER_REGISTRY,
): FormalConsumerGateReport {
  const registered = new Set(registry.map((e) => e.module));
  const missingModules = FORMAL_CONSUMER_REQUIRED_MODULES.filter(
    (m) => !registered.has(m),
  );
  const pendingFormalConsumers = registry.filter(
    (e) => e.formal === true && (e.status === undefined || e.status === "pending"),
  );
  return {
    pass: missingModules.length === 0 && pendingFormalConsumers.length === 0,
    missingModules,
    pendingFormalConsumers,
  };
}

/** W0-02 可执行 gate：正式消费者不允许停留在 pending（§2.7 的 release gate 落地）。 */
export function assertFormalConsumerGate(
  registry: ReadonlyArray<LegacyConsumerEntry> = LEGACY_CONSUMER_REGISTRY,
): { pass: true } {
  const report = formalConsumerGateReport(registry);
  if (!report.pass) {
    const missing = report.missingModules.join(", ") || "(none)";
    const pending = report.pendingFormalConsumers.map((e) => e.module).join(", ") || "(none)";
    throw new Error(
      "Formal consumer gate failed: missingModules=[" + missing + "] pendingFormalConsumers=[" + pending + "]",
    );
  }
  return { pass: true };
}
