-- 0253: 候选的「同一版计划 / 同一理解目标 / 同一 revision」唯一索引——A1 的前置。
--
-- A1（逐候选可见）要求管道**每写完一张卡就提交一次**，而不是像现在这样整批一个事务。
-- 一旦改成逐候选提交，同一个 job 被重投时会对同一批目标再插一遍：
-- `insertAuthoredCandidatesBatched` 是裸 INSERT，既没有 ON CONFLICT 也没有先删后插。
-- 没有这条索引，幂等只能靠调用方"记得先查一次"，而重投恰好发生在没记得的时候
-- （§21 实测：worker 被杀 → 租约过期 → 另一个 worker 重投同一批）。
--
-- 键为什么带 revision：2026-09-21 对 dev 库 1600 行候选实测
--   distinct (run_id, plan_objective_local_id, revision) = 1600 —— 今天已经成立，建索引不动数据；
--   distinct (run_id, plan_objective_local_id)          = 1545 —— 同一目标**确实**可以有 revision 2
--     （regenerate_candidate 与有界修复走的就是这条路），所以 revision 不能拿掉。
-- 也没有任何目标对应过两个 candidate_id，"1 个计划目标 : 1 张候选" 是现行事实，
-- 这条索引把它从约定变成库里的约束。
--
-- 键为什么必须带 plan_version（这一版改的就是它）：replan_set 会把旧计划的候选
-- `supersede` 而**不删除**（immutable），再用 `planVersion+1` 的新计划重新 author 一批；
-- 新计划的 `objectiveLocalId` 同样由原子下标导出（`obj-atom-1`…），revision 也从 1 起。
-- 少了 plan_version，那一波就会撞在这条索引上——等于把「再生成一次候选」和整条 replan
-- 路当场打死。dev 库里 `plan_version>1` 的候选是 0 行，所以旧键也建得起来，但那是
-- "这条路还没被走过"，不是"这条键选对了"。
--
-- 尾部那条 DROP 是给**已经应用过初版**的开发库收尾的：初版键少一列、索引名也不同，
-- 留着它等于让一条错的约束继续管着这批行。两条语句都幂等（IF EXISTS / IF NOT EXISTS），
-- 因此本文件内容变了 → hash 变 → 迁移器会重跑一次，重跑是安全的。
--
-- 刻意不做的事：
-- 1. **不清理历史行**。1600/1600 已经无冲突，DELETE/UPDATE 一行都是把历史批次改写成别的样子。
-- 2. **不加外键**。这张表已经通过 `run_id` 逻辑归属 run；加外键会对 run 行取 KEY SHARE，
--    而管道事务正 `FOR UPDATE` 持有它分钟级（0249 的表就是因为同一个原因不建外键）。
-- 3. **不改任何写路径**。本迁移只把约束放到库里；逐候选提交要等 A1 那一批改完，
--    在那之前它的作用是让"重投插重复"当场失败，而不是悄悄多出几张候选卡。

--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS cg_v2_cand_plan_objective_revision_idx
  ON public.card_generation_candidates_v2 (workspace_id, run_id, plan_version, plan_objective_local_id, revision);

--> statement-breakpoint

DROP INDEX IF EXISTS public.cg_v2_cand_objective_revision_idx;
