import { and, eq, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";

/**
 * 「这个目标的正式验证有没有可比的原文证据」——判据只有一处：复习队列。
 * 队列拿它给每条到期项带上"这次判不出结论、原因不在你"的那一句。
 *
 * 结算时刻的那道闸（`run-processing-tick.ts` 的 `task rubric has no frozen
 * evidence`）本身是对的：没有冻结证据就绝不猜结果。它的问题是**上游没有任何一处
 * 阻止"评分点无证据"的目标被激活成卡并排进复习**，于是用户一路被允许走到
 * 「提交 → 判不出 → 补充 → 又判不出 → 结束但不改变复习」，队列回到原样
 * （审计 F28，实机两题各 39 毫秒空判）。
 *
 * 落地时的取舍（与审计方案 ① 的差异，已写进审计文档）：这类到期项**留在队列里**并
 * 说明原因，而不是静默藏掉。藏掉会让用户以为排程丢了，而且它确实到期了；队列与
 * 卡面要说的是"做这张只能当练习，不会改变复习安排"，并把主操作让给能正式结算的那条。
 * 目标简报那一侧的缺口提示与"激活前拦下"的上游闸门仍未做，记在文档里。
 *
 * 判据与结算闸逐字同源：`scoringRubric.units` 里每个 `required` 单元都要有一条
 * `target_unit_kind='rubric'` 且 `target_unit_id` 等于该单元 id 的冻结绑定。
 * 少一个就不是"证据不全"，而是这条目标现在无法被正式判定——两种说法在界面上
 * 必须分开，所以带出的不是布尔值，而是**缺哪些单元**。
 *
 * 兼容历史双重编码：夹具污染把 `scoring_rubric` 写成过 JSON 字符串标量
 * （审计 §7），那种行按"没有可比对的评分点"处理——JSON 数组标量的每个元素是
 * 字符串，`->> 'required'` 恒为 NULL，于是不会有单元被判成 required，这条目标
 * 不会被误判，只是拿不到正式结论。真正的修法是夹具与写入侧同形（§7 另记）。
 */
export async function loadMissingFrozenRubricUnits(
  tx: ApiTransaction,
  workspaceId: string,
  objectiveIds: string[],
): Promise<Map<string, string[]>> {
  const missing = new Map<string, string[]>();
  if (objectiveIds.length === 0) return missing;

  const rows = await tx
    .select({
      objectiveId: learningObjectivesV2.objectiveId,
      missingRubricUnitIds: sql<string[]>`COALESCE((
        SELECT jsonb_agg(DISTINCT v2_missing_unit ->> 'rubricUnitId')
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(${learningObjectiveRevisionsV2.scoringRubric}) = 'array'
              THEN ${learningObjectiveRevisionsV2.scoringRubric}
            WHEN jsonb_typeof(${learningObjectiveRevisionsV2.scoringRubric}) = 'object'
              AND jsonb_typeof(${learningObjectiveRevisionsV2.scoringRubric} -> 'units') = 'array'
              THEN ${learningObjectiveRevisionsV2.scoringRubric} -> 'units'
            ELSE '[]'::jsonb
          END
        ) AS v2_missing_unit
        WHERE v2_missing_unit ->> 'required' = 'true'
          AND NOT EXISTS (
            SELECT 1
            FROM learning_objective_evidence_bindings_v2 AS v2_missing_binding
            WHERE v2_missing_binding.workspace_id = ${learningObjectivesV2.workspaceId}
              AND v2_missing_binding.objective_revision_id = ${learningObjectiveRevisionsV2.objectiveRevisionId}
              AND v2_missing_binding.target_unit_kind = 'rubric'
              AND v2_missing_binding.target_unit_id = v2_missing_unit ->> 'rubricUnitId'
          )
      ), '[]'::jsonb)`,
    })
    .from(learningObjectivesV2)
    .innerJoin(
      learningObjectiveRevisionsV2,
      and(
        eq(learningObjectiveRevisionsV2.workspaceId, learningObjectivesV2.workspaceId),
        eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
      ),
    )
    .where(and(
      eq(learningObjectivesV2.workspaceId, workspaceId),
      inArray(learningObjectivesV2.objectiveId, objectiveIds),
    ));

  for (const row of rows) {
    const unitIds = (row.missingRubricUnitIds ?? [])
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (unitIds.length > 0) missing.set(row.objectiveId, [...new Set(unitIds)].sort());
  }
  return missing;
}
