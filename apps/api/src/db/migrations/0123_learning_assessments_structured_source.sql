-- 0123: learning_assessments.source 增加 'deterministic_structured'。
--
-- 文档 16 §7.4/§12.6：ordering/relation/repair 的 PrivateTaskSolutionV1
-- （correctTokenIds/requiredEdges/acceptedOperationSignatures）天然支持
-- 确定性评估——这是独立 Assessment 的确定性子集（与 assessment_critic、
-- deterministic_declared_unable 并列的第三来源）。§12.4 枚举遗漏，补齐。
-- P4 结构题按 §7.7 首发上限：无 qualification 数据 → practice 路径，
-- deterministic_structured 评估只产 verdicts 供学习反馈，绝不产 canonical。

--> statement-breakpoint

ALTER TABLE public.learning_assessments
  DROP CONSTRAINT learning_assessments_source_check;

--> statement-breakpoint

ALTER TABLE public.learning_assessments
  ADD CONSTRAINT learning_assessments_source_check CHECK (source IN (
    'assessment_critic', 'deterministic_declared_unable', 'deterministic_structured'
  ));
