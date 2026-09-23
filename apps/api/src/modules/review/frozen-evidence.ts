import { and, eq, inArray, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import {
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";

/**
 * 「这个目标的正式验证有没有可比的原文证据」——判据只有一处，两个消费方共用：
 * 复习队列（不该把注定判不出的卡排到用户面前）与目标简报（要指名缺了什么）。
 *
 * 结算时刻的那道闸（`run-processing-tick.ts` 的 `task rubric has no frozen
 * evidence`）本身是对的：没有冻结证据就绝不猜结果。它的问题是**上游没有任何一处
 * 阻止"评分点无证据"的目标被激活成卡并排进复习**，于是用户一路被允许走到
 * 「提交 → 判不出 → 补充 → 又判不出 → 结束但不改变复习」，队列回到原样
 * （审计 F28，实机两题各 39 毫秒空判）。
 *
 * 判据与结算闸逐字同源：`scoringRubric.units` 里每个 `required` 单元都要有一条
 * `target_unit_kind='rubric'` 且 `target_unit_id` 等于该单元 id 的冻结绑定。
 * 少一个就不是"证据不全"，而是这条目标现在无法被正式判定——两种说法在界面上
 * 必须分开，所以下面带出的不是布尔值，而是**缺哪些单元**。
 *
 * 为什么判据写成 SQL 而不是读出来在 JS 里比：队列是分页的，`total` 与
 * `nextCursor` 都要求"被挡下的行也算走过"，只有在同一个 where 里筛掉才能保证
 * 计数、翻页、投影三处口径一致。
 *
 * 兼容历史双重编码：夹具污染把 `scoring_rubric` 写成过 JSON 字符串标量
 * （审计 §7），那种行按"没有可比对的评分点"处理——JSON 数组标量的每个元素是
 * 字符串，`->> 'required'` 恒为 NULL，于是不会有单元被判成 required，这条目标
 * 不会被误挡，只是拿不到正式结论。真正的修法是夹具与写入侧同形（§7 另记）。
 */
export function reviewScheduleTargetsCompleteFrozenEvidencePredicate() {
  return sql<boolean>`(
    NOT EXISTS (
      SELECT 1
      FROM learning_objectives_v2 AS v2_evidence_obj
      JOIN learning_objective_revisions_v2 AS v2_evidence_rev
        ON v2_evidence_rev.workspace_id = v2_evidence_obj.workspace_id
       AND v2_evidence_rev.objective_revision_id = v2_evidence_obj.current_objective_revision_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(v2_evidence_rev.scoring_rubric) = 'array'
            THEN v2_evidence_rev.scoring_rubric
          WHEN jsonb_typeof(v2_evidence_rev.scoring_rubric) = 'object'
            AND jsonb_typeof(v2_evidence_rev.scoring_rubric -> 'units') = 'array'
            THEN v2_evidence_rev.scoring_rubric -> 'units'
          ELSE '[]'::jsonb
        END
      ) AS v2_evidence_unit
      WHERE v2_evidence_obj.objective_id = review_schedules.subject_id
        AND v2_evidence_obj.workspace_id = review_schedules.workspace_id
        AND v2_evidence_unit ->> 'required' = 'true'
        AND NOT EXISTS (
          SELECT 1
          FROM learning_objective_evidence_bindings_v2 AS v2_evidence_binding
          WHERE v2_evidence_binding.workspace_id = v2_evidence_obj.workspace_id
            AND v2_evidence_binding.objective_revision_id = v2_evidence_obj.current_objective_revision_id
            AND v2_evidence_binding.target_unit_kind = 'rubric'
            AND v2_evidence_binding.target_unit_id = v2_evidence_unit ->> 'rubricUnitId'
        )
    )
  )`;
}

/**
 * 与上面那条谓词同一形状，但带出具体缺了哪些单元（简报要说人话："还缺
 * 第 2、3 个要点"，而不是"证据不足"）。
 *
 * 返回的 Map 只包含**有缺口**的目标：没有缺口的目标不进 Map，调用方据此
 * 既能判"能不能正式验证"，也能说出缺什么。
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
