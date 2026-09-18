/**
 * Plan 23 W2-19/W2-20：Objective history reader。
 *
 * - history：只返回 revision/lifecycle/可信公开摘要（publicSummary/conceptLabel），
 *   不泄漏 private assessment/rubric（§13.2）。
 */
import { and, eq, desc, lt, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
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
  // 需要 prior revision 的指纹做分类。
  // 修复（2026-09 后端审查）：分类必须看 **rows**——多取的 limit+1 行正是为判定
  // 本页最后一项准备的，此前读 page[index+1] 使每页最后一项恒为
  // presentation_only（真实语义变更被显示为「呈现更新」）。
  const items: ObjectiveHistoryItemV3[] = page.map((row, index) => {
    const prior = rows[index + 1];
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
