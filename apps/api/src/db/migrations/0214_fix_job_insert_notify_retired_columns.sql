-- 0214: 修复 jobs AFTER INSERT 通知触发器对已删除列的引用。
--
-- 0200 从 public.jobs 删除了 generation_run_id / generation_unit_id / stage 等
-- 退役列，但 0115 建立的 ailearn_job_insert_notify() 仍引用
-- NEW.generation_run_id。PL/pgSQL 在**运行时**解析 NEW.<field>，因此 0200 之后
-- 每一次 INSERT INTO jobs 都直接失败：
--   ERROR: record "new" has no field "generation_run_id"
-- 队列入队是 parse_source / card_generation_v2 / companion_agent 等全部异步链路的
-- 起点，该缺陷会让整个 worker 队列无法入队（单元测试与类型检查都发现不了）。
--
-- 修法：用当前 jobs 表真实存在的字段重建函数——runId 改从 payload->>'runId' 取
-- （现代表达式；旧列已不存在）。worker 的 LISTEN 回调只把通知当作唤醒信号、
-- 不解析 payload，因此键名保持兼容即可。函数体必须对任何 jobs 行都不抛错。
--
-- 必须放在 0200 之后（前向迁移）：全新数据库按序执行时同样会经过 0200 删列，
-- 因此只有在其后重建函数才能同时修好新库与既有库。

CREATE OR REPLACE FUNCTION public.ailearn_job_insert_notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'ailearn_job_events',
    json_build_object(
      'workspaceId', NEW.workspace_id::text,
      -- 0200 已删除 generation_run_id；队列的 run 归属现在只存在于 payload。
      'runId', COALESCE(NEW.payload->>'runId', ''),
      'jobId', NEW.id::text,
      'eventType', 'job_ready',
      'stage', NEW.type,
      'at', clock_timestamp()::text
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ailearn_jobs_insert_notify ON public.jobs;
CREATE TRIGGER ailearn_jobs_insert_notify
  AFTER INSERT ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.ailearn_job_insert_notify();

ALTER FUNCTION public.ailearn_job_insert_notify() OWNER TO ailearn_migrator;
