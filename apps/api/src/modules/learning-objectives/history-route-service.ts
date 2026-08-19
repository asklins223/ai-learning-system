/**
 * Plan 23 W2-19/W2-20：Objective history reader + legacy route resolver。
 *
 * - history：只返回 revision/lifecycle/可信公开摘要（publicSummary/conceptLabel），
 *   不泄漏 private assessment/rubric（§13.2）。
 * - route resolver：旧 card/keyPoint URL 确定性解析——mapped / gone
 *   （§21.4），绝不返回模糊 V2 404；解析结果幂等落
 *   legacy_route_mappings_v2。
 */
import { and, eq, desc, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectiveRevisionsV2,
  legacyRouteMappingsV2,
  learningCardsV2,
  learningObjectivesV2,
} from "../../db/schema/card-generation-v2.ts";
import type { ObjectiveRevisionClassV2 } from "@ailearn/shared";

// ─── W2-19: history ──────────────────────────────────────────────────────

export interface ObjectiveHistoryItemV3 {
  objectiveRevisionId: string;
  revision: number;
  revisionClass: ObjectiveRevisionClassV2;
  conceptLabel: string | null;
  publicSummary: string;
  knowledgeForm: string;
  supersedesObjectiveRevisionId: string | null;
  publishedAt: string;
}

/**
 * 目标历史（公开摘要）；revisionClass 由指纹变化推断：
 * - 首版 → presentation_only 标记占位（实际由 equivalence report 判定）；
 * - 后续版本：semanticTargetFingerprint 变化 → semantic_change；
 *   targetRevisionHash 变化 → target_equivalent；否则 presentation_only。
 */
export async function readObjectiveHistoryV3(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveId: string,
  options: { limit?: number; cursor?: number } = {},
): Promise<{ items: ObjectiveHistoryItemV3[]; total: number; nextCursor: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const rows = await tx
    .select()
    .from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
      eq(learningObjectiveRevisionsV2.objectiveId, objectiveId),
      options.cursor !== undefined
        ? lt(learningObjectiveRevisionsV2.revision, options.cursor)
        : undefined,
    ))
    .orderBy(desc(learningObjectiveRevisionsV2.revision))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  // 需要 prior revision 的指纹做分类
  const items: ObjectiveHistoryItemV3[] = page.map((row, index) => {
    const prior = page[index + 1];
    let revisionClass: ObjectiveRevisionClassV2;
    if (!prior) {
      revisionClass = "presentation_only";
    } else if (prior.semanticTargetFingerprint !== row.semanticTargetFingerprint) {
      revisionClass = "semantic_change";
    } else if (prior.targetRevisionHash !== row.targetRevisionHash) {
      revisionClass = "target_equivalent";
    } else {
      revisionClass = "presentation_only";
    }
    return {
      objectiveRevisionId: row.objectiveRevisionId,
      revision: row.revision,
      revisionClass,
      conceptLabel: row.conceptLabel,
      publicSummary: row.publicSummary,
      knowledgeForm: row.knowledgeForm,
      supersedesObjectiveRevisionId: row.supersedesObjectiveRevisionId,
      publishedAt: row.createdAt.toISOString(),
    };
  });

  const totalRows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(learningObjectiveRevisionsV2)
    .where(and(
      eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
      eq(learningObjectiveRevisionsV2.objectiveId, objectiveId),
    ));
  const total = Number(totalRows[0]?.n ?? 0);
  const nextCursor =
    rows.length > limit && page.length > 0 ? page[page.length - 1].revision : null;
  return { items, total, nextCursor };
}

// ─── W2-20: legacy route resolver ────────────────────────────────────────

export type LegacyRouteResolutionStatus =
  | "mapped"
  | "gone"
  
  ;

export interface LegacyRouteResolutionV3 {
  legacyKind: "card" | "key_point";
  legacyId: string;
  status: LegacyRouteResolutionStatus;
  objectiveId: string | null;
  cardId: string | null;
  note: string | null;
}

/**
 * 解析旧 URL（§21.4，V1 卡退役后简化版）：
 * - keyPointId：本身就是 objectiveId（alias 规则）→ mapped；
 * - legacy card：V1 卡已退役 → 仅 V2 card 可 mapped，其余 gone；
 *   （alias/hidden 兼容行已随 0176 清空，不再需要 forbidden 分支）
 * 结果幂等落 legacy_route_mappings_v2（ON CONFLICT DO NOTHING 后读取既有行）。
 */
export async function resolveLegacyRouteV3(
  tx: ApiTransaction,
  workspaceId: string,
  input: { legacyKind: "card" | "key_point"; legacyId: string },
): Promise<LegacyRouteResolutionV3> {
  const { legacyKind, legacyId } = input;
  let resolution: LegacyRouteResolutionV3;

  if (legacyKind === "key_point") {
    // keyPointId 即 objectiveId（alias 规则）
    const objectiveRows = await tx
      .select({ objectiveId: learningObjectivesV2.objectiveId })
      .from(learningObjectivesV2)
      .where(and(
        eq(learningObjectivesV2.workspaceId, workspaceId),
        eq(learningObjectivesV2.objectiveId, legacyId),
      ))
      .limit(1);
    if (objectiveRows[0]) {
      resolution = {
        legacyKind,
        legacyId,
        status: "mapped",
        objectiveId: objectiveRows[0].objectiveId,
        cardId: null,
        note: "keyPointId 即 objectiveId（alias 规则）",
      };
    } else {
      resolution = {
        legacyKind,
        legacyId,
        status: "gone",
        objectiveId: null,
        cardId: null,
        note: "key point 无对应 Objective",
      };
    }
  } else {
    // V2 card（Plan 23 FE-19：详情页经 resolver 找 objective，避免 V2 404）
    const v2CardRows = await tx
      .select({ objectiveId: learningCardsV2.objectiveId })
      .from(learningCardsV2)
      .where(and(
        eq(learningCardsV2.workspaceId, workspaceId),
        eq(learningCardsV2.cardId, legacyId),
      ))
      .limit(1);
    if (v2CardRows[0]) {
      resolution = {
        legacyKind,
        legacyId,
        status: "mapped",
        objectiveId: v2CardRows[0].objectiveId,
        cardId: legacyId,
        note: "V2 card → objective",
      };
    } else {
      // V1 卡已退役（0176 清空）：旧 card 深链一律 gone
      resolution = {
        legacyKind,
        legacyId,
        status: "gone",
        objectiveId: null,
        cardId: null,
        note: "legacy card 已退役",
      };
    }
  }

  // 幂等落 mapping（供统计/审计；既有行不覆盖）
  await tx
    .insert(legacyRouteMappingsV2)
    .values({
      workspaceId,
      mappingId: randomUUID(),
      legacyKind,
      legacyId,
      status: resolution.status,
      objectiveId: resolution.objectiveId,
      cardId: resolution.cardId,
      resolvedAt: new Date(),
      note: resolution.note,
    })
    .onConflictDoNothing();
  return resolution;
}
