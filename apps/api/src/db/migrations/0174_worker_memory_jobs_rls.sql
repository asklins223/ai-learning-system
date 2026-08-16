-- 0174: 方案 22 worker 记忆/日记功能权限补全（RLS + 函数 EXECUTE）
--
-- 背景（2026-08-16 实机验证发现，桌宠对话 write phase）：
--  1. worker 自入队 companion_memory_extract / companion_summarizer job 时
--     INSERT INTO jobs 被 RLS 拒绝（jobs 的 INSERT 仅 PERMISSIVE 允许
--     ailearn_api；worker 没有任何 PERMISSIVE INSERT 策略）→ 终态事务失败 →
--     run 标记 failed（尽管 LLM 回复已生成）。
--  2. 记忆向量检索调用 pgvector cosine_distance()，worker 无 EXECUTE 权限
--     → "permission denied for function cosine_distance" → 检索降级。
--  3. 0171/0172 声明的 SECURITY DEFINER 函数 EXECUTE（GRANT 在迁移文件中但
--     DB 未生效）→ 桌宠日记调度 worker 调用失败
--     （"companion daily summary scheduler failed"）。
--
-- 修复：
--  1. jobs 新增 PERMISSIVE INSERT 策略，仅允许 ailearn_worker 且
--     requested_by = app.user_id（由既有 sec01_v1_jobs_insert_actor_guard
--     RESTRICTIVE 再兜一层）+ 类型白名单（memory/summary/daily）→ worker
--     不能任意入队其他任务类型。
--  2. pgvector cosine_distance/l2_distance/inner_product EXECUTE 授权给
--     ailearn_worker + ailearn_api。
--  3. 补齐 0171/0172 声明但未生效的 SECURITY DEFINER 函数 EXECUTE。
-- 全部幂等。

--> statement-breakpoint

-- worker 自入队记忆/摘要/日记任务的受控 INSERT 策略。
-- 类型白名单：仅在 worker 处理管线的终态事务里由 worker 自己入队的类型。
-- requested_by 与 app.user_id 一致性由 sec01_v1_jobs_insert_actor_guard
-- （RESTRICTIVE FOR INSERT）强制，与 api 路径同一防护。
DROP POLICY IF EXISTS "sec01_v1_jobs_worker_insert_guard" ON "jobs";
CREATE POLICY "sec01_v1_jobs_worker_insert_guard"
  ON "jobs"
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK (
    CURRENT_USER = 'ailearn_worker'::name
    AND "type" IN ('companion_memory_extract', 'companion_summarizer', 'companion_daily_summary', 'companion_memory_maintenance')
  );

--> statement-breakpoint

-- pgvector 距离函数 EXECUTE（记忆向量检索由 worker 执行；vector/halfvec 签名均可）。
GRANT EXECUTE ON FUNCTION public.cosine_distance(vector, vector) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.l2_distance(vector, vector) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.inner_product(vector, vector) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.cosine_distance(vector, vector) TO ailearn_api;
GRANT EXECUTE ON FUNCTION public.l2_distance(vector, vector) TO ailearn_api;
GRANT EXECUTE ON FUNCTION public.inner_product(vector, vector) TO ailearn_api;
GRANT EXECUTE ON FUNCTION public.cosine_distance(halfvec, halfvec) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.l2_distance(halfvec, halfvec) TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.inner_product(halfvec, halfvec) TO ailearn_worker;

--> statement-breakpoint

-- 0171/0172 声明的 SECURITY DEFINER 函数 EXECUTE（GRANT 在迁移文件中但 DB 未生效）。
GRANT EXECUTE ON FUNCTION public.ailearn_enqueue_companion_daily_summaries() TO ailearn_worker;
GRANT EXECUTE ON FUNCTION public.ailearn_run_companion_memory_maintenance() TO ailearn_worker;