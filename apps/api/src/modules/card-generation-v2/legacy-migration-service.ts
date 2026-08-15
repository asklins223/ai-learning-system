/**
 * 方案 20 §21.4 / C34 — legacy multi-keypoint Card 迁移服务（R35）。
 *
 * 语义（§21.4 忠实子集 + 结构性约束）：
 * - **保留 key point UUID 作为 stable objective ID**（§21.4 #1 / §29.4 alias）；
 * - **不伪造 V2 canonical answer**：Objective Rubric 必须引用真实 sealed
 *   evidence（schema 强制 rubric units.evidenceRefIds ≥ 1），迁移阶段没有
 *   V2 evidence——因此迁移只做"alias 就绪 + 审计"，V2 Objective/Revision
 *   必须由真实生成链路（create_new / semantic_replace）创建（§21.4 #3/#4/#10；
 *   "未通过 upgrade 的 Card 不静默参与可信 Run"由 rubric-evidence 结构强制）；
 * - 迁移记录可重复执行（§21.4 #9）：写 `card_generation_cutover_events`
 *   （event_type='legacy_card_migration'，0165 扩展 CHECK），重放幂等；
 * - 原 Card ID 经 `semantic_identity_class_id` 保留（`legacy-migration:<cardId>`，
 *   由后续生成链路引用），§21.4 #5 的 lineage 在激活时经
 *   learning_objective_lineage_v2 记录。
 */

import { and, eq, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { cardKeyPoints, learningCards } from "../../db/schema/card.ts";
import { learningObjectivesV2 } from "../../db/schema/card-generation-v2.ts";
import { CardGenerationV2ServiceError, type RunContext } from "./helpers.ts";

export type LegacyKeyPointMigrationStatusV2 =
  | "alias_ready"          // kp.id 即 stable objective ID；V2 目标待生成
  | "v2_active"            // 已有 active V2 objective（同一 objective_id）
  | "v2_inactive"          // 已有 V2 objective 但非 active（需重新生成）
  | "card_not_active";     // 旧卡非 active（不迁移）

export interface LegacyKeyPointMigrationEntryV2 {
  keyPointId: string;
  objectiveId: string;
  status: LegacyKeyPointMigrationStatusV2;
  action: "needs_regeneration" | "noop";
}

export interface LegacyCardMigrationResultV2 {
  cardId: string;
  cardStatus: string;
  keyPoints: LegacyKeyPointMigrationEntryV2[];
  replayed: boolean;
}

export async function migrateLegacyMultiKeypointCardV2(
  tx: ApiTransaction,
  ctx: RunContext,
  legacyCardId: string,
): Promise<LegacyCardMigrationResultV2> {
  const cardRows = await tx.select({ id: learningCards.id, status: learningCards.status })
    .from(learningCards)
    .where(and(eq(learningCards.id, legacyCardId), eq(learningCards.workspaceId, ctx.workspaceId)))
    .limit(1);
  if (cardRows.length === 0) {
    throw new CardGenerationV2ServiceError("legacy_card_not_found", 404, "旧卡片不存在");
  }
  const cardStatus = String(cardRows[0].status);

  const kpRows = await tx.select({ id: cardKeyPoints.id, ordinal: cardKeyPoints.ordinal })
    .from(cardKeyPoints)
    .where(and(eq(cardKeyPoints.cardId, legacyCardId), eq(cardKeyPoints.workspaceId, ctx.workspaceId)))
    .orderBy(cardKeyPoints.ordinal);

  // 幂等：同卡已迁移（cutover 事件存在）→ 重放（重算决策，不重复写事件）
  const priorEvents = await tx.execute(sql`
    SELECT payload FROM public.card_generation_cutover_events
    WHERE workspace_id = ${ctx.workspaceId} AND event_type = 'legacy_card_migration'
      AND payload->>'cardId' = ${legacyCardId}
    ORDER BY created_at DESC LIMIT 1
  `);
  const replayed = priorEvents.length > 0;

  // V2 objective 现状（objective_id = kp.id alias）
  const kpIds = kpRows.map((k) => String(k.id));
  const v2Rows = kpIds.length > 0
    ? await tx.select({ objectiveId: learningObjectivesV2.objectiveId, lifecycle: learningObjectivesV2.lifecycle })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          sql`${learningObjectivesV2.objectiveId} = ANY(${sql.raw(`'{${kpIds.join(",")}}'::uuid[]`)})`,
        ))
    : [];
  const v2ByObj = new Map(v2Rows.map((r) => [String(r.objectiveId), String(r.lifecycle)]));

  const keyPoints: LegacyKeyPointMigrationEntryV2[] = kpRows.map((k) => {
    const objectiveId = String(k.id);
    const lifecycle = v2ByObj.get(objectiveId);
    if (cardStatus !== "active") {
      return { keyPointId: objectiveId, objectiveId, status: "card_not_active", action: "needs_regeneration" };
    }
    if (lifecycle === "active") {
      return { keyPointId: objectiveId, objectiveId, status: "v2_active", action: "noop" };
    }
    if (lifecycle !== undefined) {
      return { keyPointId: objectiveId, objectiveId, status: "v2_inactive", action: "needs_regeneration" };
    }
    return { keyPointId: objectiveId, objectiveId, status: "alias_ready", action: "needs_regeneration" };
  });

  if (!replayed) {
    await tx.execute(sql`
      INSERT INTO public.card_generation_cutover_events (workspace_id, event_type, payload)
      VALUES (${ctx.workspaceId}, 'legacy_card_migration',
              ${JSON.stringify({
                cardId: legacyCardId,
                cardStatus,
                keyPointCount: keyPoints.length,
                statuses: keyPoints.map((k) => k.status),
              })}::jsonb)
    `);
  }

  return { cardId: legacyCardId, cardStatus, keyPoints, replayed };
}
