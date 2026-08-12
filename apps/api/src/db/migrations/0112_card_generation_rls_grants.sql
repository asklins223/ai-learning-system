-- 0112_card_generation_rls_grants.sql
-- 2026-08-11（第十轮）：0052 六张表从未 GRANT 给 ailearn_api/ailearn_worker
-- （roles.sql 矩阵无这六张表，0052 也无 GRANT）——0111 补齐 RLS 后表级权限
-- 仍缺失，worker/api 读写全部 permission denied。照 0044/0100 模式补齐：
--   worker:  agent 管线读写（事件批量/证据持久化/质量报告/embedding）
--   api:     card-generation service 查询/登记
-- 幂等：roles.sql 每次部署重跑与迁移并存，双方都加（grant 重复执行无副作用）。
-- 注意：drafts 仅 worker SELECT（无写访问点），与 roles.sql 矩阵 (true,false,false,false) 一致；
-- api 侧权限会被 roles.sql 的全表 CRUD 放大（api 用 workspace RLS 收口行级），此处保持最小集。

GRANT SELECT, INSERT, UPDATE ON public.card_generation_agent_events TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.card_generation_source_bundles TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.card_generation_source_bundle_members TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.card_generation_quality_reports TO ailearn_worker;
GRANT SELECT, INSERT, UPDATE ON public.note_evidence_embeddings TO ailearn_worker;
-- drafts：worker 无直接访问点，仅保留 SELECT（agent 事件审计查询）——
-- 与 roles.sql 矩阵 (true,false,false,false) 一致。
GRANT SELECT ON public.card_generation_drafts TO ailearn_worker;

GRANT SELECT, INSERT, UPDATE ON public.card_generation_drafts TO ailearn_api;
GRANT SELECT ON public.card_generation_agent_events TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.card_generation_source_bundles TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.card_generation_source_bundle_members TO ailearn_api;
GRANT SELECT ON public.card_generation_quality_reports TO ailearn_api;
GRANT SELECT, INSERT, UPDATE ON public.note_evidence_embeddings TO ailearn_api;
