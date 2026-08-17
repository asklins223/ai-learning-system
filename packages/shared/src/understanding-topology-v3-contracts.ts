/**
 * Plan 23 W1-14..W1-15：Understanding Topology V3 公共合同。
 *
 * 依据 23 方案 §15：星图只展示 Source / Note / Objective / Evidence 四类节点，
 * **不包含 card / key_point 节点**（§15.1/§25.1/§25.6）。Shared topology 与
 * Personal overlay 分离：个人 mastery 只从 canonical learning event /
 * practice trail 读取，绝污染 shared topology（§15.2/§17.2）。
 *
 * 本文件不含 node: 依赖，可安全从 index 全量导出。
 */
import { z } from "zod";
import {
  objectivePersonalStateV3Schema,
  objectiveSurfaceFreshnessV3Schema,
  objectiveSurfaceLifecycleV3Schema,
  learningObjectivePrimaryActionV3Schema,
} from "./learning-objective-surface-contracts.ts";

// ─── W1-14/15: shared node kinds（无 card/key_point）──────────────────────

export const understandingNodeKindV3Schema = z.enum([
  "source",
  "note",
  "objective",
  "evidence",
]);
export type UnderstandingNodeKindV3 = z.infer<
  typeof understandingNodeKindV3Schema
>;

export const understandingEdgeKindV3Schema = z.enum([
  "sourced_from", // note/source → objective（血缘）
  "supported_by", // objective → evidence
  "relates_to", // objective ↔ objective 语义关系
  "supersedes", // old objective → new objective
]);
export type UnderstandingEdgeKindV3 = z.infer<
  typeof understandingEdgeKindV3Schema
>;

/** 端点引用：只允许四类 shared node（无 card/key_point）。 */
export const understandingNodeRefV3Schema = z.strictObject({
  kind: understandingNodeKindV3Schema,
  id: z.string().uuid(),
});
export type UnderstandingNodeRefV3 = z.infer<
  typeof understandingNodeRefV3Schema
>;

// ─── node projections ───────────────────────────────────────────────────

export const sourceNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("source"),
    sourceId: z.string().uuid(),
  }),
  label: z.string().min(1).max(500),
  modality: z.string().min(1).max(50),
  createdAt: z.string().datetime({ offset: true }),
});

export const noteNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("note"),
    noteId: z.string().uuid(),
  }),
  label: z.string().min(1).max(500),
  currentVersionId: z.string().uuid(),
  freshness: z.enum(["current", "source_outdated", "archived"]),
});

export const objectiveNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("objective"),
    objectiveId: z.string().uuid(),
  }),
  label: z.string().min(1).max(200),
  publicSummary: z.string().min(1).max(1500),
  activeCardId: z.string().uuid().nullable(),
  lifecycle: objectiveSurfaceLifecycleV3Schema,
  freshness: objectiveSurfaceFreshnessV3Schema,
  /** personal overlay：只从 canonical/practice 事件读取，不污染 shared topology。 */
  personal: z.strictObject({
    state: objectivePersonalStateV3Schema,
    activeRunId: z.string().uuid().nullable(),
    activeScheduleId: z.string().uuid().nullable(),
    nextReviewAt: z.string().datetime({ offset: true }).nullable(),
    practiceTrailCount: z.number().int().min(0),
    lastCanonicalEventId: z.string().nullable(),
    primaryAction: learningObjectivePrimaryActionV3Schema,
  }),
});

export const evidenceNodeProjectionV3Schema = z.strictObject({
  nodeRef: z.strictObject({
    kind: z.literal("evidence"),
    evidenceSnapshotId: z.string().uuid(),
  }),
  /** 只暴露 evidence metadata；权限/撤销状态不会泄露文本（§20.1）。 */
  supportSummary: z.string().min(1).max(2000),
  sourceLabel: z.string().min(1).max(300).nullable(),
  restricted: z.boolean(),
});

export const understandingNodeProjectionV3Schema = z.union([
  sourceNodeProjectionV3Schema,
  noteNodeProjectionV3Schema,
  objectiveNodeProjectionV3Schema,
  evidenceNodeProjectionV3Schema,
]);
export type UnderstandingNodeProjectionV3 = z.infer<
  typeof understandingNodeProjectionV3Schema
>;

// ─── edges ──────────────────────────────────────────────────────────────

export const understandingEdgeProjectionV3Schema = z.strictObject({
  edgeId: z.string().min(1).max(200),
  kind: understandingEdgeKindV3Schema,
  from: understandingNodeRefV3Schema,
  to: understandingNodeRefV3Schema,
  reasonCodes: z.array(z.string().min(1)).max(10).default([]),
});
export type UnderstandingEdgeProjectionV3 = z.infer<
  typeof understandingEdgeProjectionV3Schema
>;

// ─── W1-14: snapshot ────────────────────────────────────────────────────

export const understandingTopologySnapshotV3Schema = z.strictObject({
  version: z.literal(3),
  workspaceId: z.string().uuid(),
  topologyRevision: z.string().min(1).max(200),
  checkpointToken: z.string().min(1).max(200),
  nodes: z.array(understandingNodeProjectionV3Schema),
  edges: z.array(understandingEdgeProjectionV3Schema),
  continuationToken: z.string().nullable(),
  integrity: z.strictObject({
    truncated: z.boolean(),
    missingOriginObjectiveIds: z.array(z.string().uuid()),
  }),
});
export type UnderstandingTopologySnapshotV3 = z.infer<
  typeof understandingTopologySnapshotV3Schema
>;

// ─── 合同守卫：拒收 card/key_point 节点（§15.1/§25.1）──────────────────────

export function assertNoCardOrKeyPointNode(
  nodes: readonly unknown[],
): { violations: Array<{ index: number; kind: string }> } {
  const violations: Array<{ index: number; kind: string }> = [];
  nodes.forEach((node, index) => {
    if (typeof node !== "object" || node === null) return;
    const ref = (node as { nodeRef?: { kind?: unknown } }).nodeRef;
    const kind =
      ref && typeof ref === "object" && "kind" in ref
        ? String(ref.kind)
        : String((node as { kind?: unknown }).kind ?? "");
    if (kind === "card" || kind === "key_point") {
      violations.push({ index, kind });
    }
  });
  return { violations };
}
