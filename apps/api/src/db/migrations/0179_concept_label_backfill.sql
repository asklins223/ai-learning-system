-- Plan 23 W1-05（2026-08-22 修复）：一次性回填迁移期遗留的 NULL concept_label。
--
-- 背景：learningObjectiveDraftV2 合同此前缺 conceptLabel 字段，生成端从未写入，
-- learning_objective_revisions_v2.concept_label 恒为 NULL；前端标题回退
-- publicSummary 造成"标题=摘要"。生成端修复后，存量行用确定性派生规则回填：
--   1. 剥离命题开头的学习动词前缀（理解/掌握/说明…，可连续叠加）；
--   2. 取首个分句（按中英文常用标点切分）；
--   3. 分句不足 4 字时回退为剥离后命题前 24 字。
-- 只基于公开字段派生，不触碰 private payload。
--
-- revision 行受 lo_v2_rev_no_update 触发器保护（append-only）；本迁移临时禁用
-- 该触发器完成一次性补写后立即恢复。业务侧的修订仍必须走新增 revision。

ALTER TABLE public.learning_objective_revisions_v2 DISABLE TRIGGER lo_v2_rev_no_update;

WITH derived AS (
  SELECT
    objective_revision_id,
    regexp_replace(
      objective_statement,
      '^\s*(理解|掌握|说明|解释|描述|阐述|记住|知道|了解|熟悉|分析|判断|计算|推导|列举|区分|复述|概括|总结)+\s*[：:、，,]?\s*',
      ''
    ) AS stripped
  FROM public.learning_objective_revisions_v2
  WHERE concept_label IS NULL
),
labeled AS (
  SELECT
    objective_revision_id,
    stripped,
    btrim(regexp_replace(
      (regexp_split_to_array(stripped, '[，,。．；;：:！!？?（）()、\n]'))[1],
      '[，,。．；;：:！!？?、]+$',
      ''
    )) AS first_clause
  FROM derived
)
UPDATE public.learning_objective_revisions_v2 r
SET concept_label = CASE
  WHEN length(l.first_clause) >= 4 THEN substring(l.first_clause, 1, 60)
  ELSE btrim(left(l.stripped, 24))
END
FROM labeled l
WHERE r.objective_revision_id = l.objective_revision_id
  AND r.concept_label IS NULL;

ALTER TABLE public.learning_objective_revisions_v2 ENABLE TRIGGER lo_v2_rev_no_update;
