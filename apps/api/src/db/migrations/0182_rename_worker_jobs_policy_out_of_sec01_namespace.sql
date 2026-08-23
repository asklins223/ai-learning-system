-- 0182：把 0174 引入的 worker 自入队策略移出 sec01_v1_ 保留命名空间。
--
-- 背景（2026-08-23）：0039 的策略目录守卫把 `sec01_v1_`/`sec02_v1_` 前缀视为
-- 其冻结 manifest 的托管命名空间——出现清单外的前缀策略即拒绝（check_violation）。
-- 0174 新增的 jobs worker INSERT 白名单策略沿用了该前缀，导致 0039 在任何现代
-- 库上重放（含 rls-policies 集成测试）必然失败。
--
-- 修复：同名逻辑、改名为 worker_type_allowlist_insert_guard（脱离保留前缀），
-- 语义与 0174 完全一致。幂等可重放。

DROP POLICY IF EXISTS "sec01_v1_jobs_worker_insert_guard" ON public."jobs";
DROP POLICY IF EXISTS "worker_type_allowlist_insert_guard" ON public."jobs";
CREATE POLICY "worker_type_allowlist_insert_guard"
  ON public."jobs"
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'::name
    AND "type" IN ('companion_memory_extract', 'companion_summarizer', 'companion_daily_summary', 'companion_memory_maintenance')
  );
