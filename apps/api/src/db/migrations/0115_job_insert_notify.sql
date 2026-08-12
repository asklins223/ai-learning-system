-- 0115: P4-6 NOTIFY 快速唤醒接线（第十三轮 worker 队列面审计 P1-1）。
--
-- 此前 job-notify.ts 的 notifyJobEvent* 全仓库零调用方（死代码）：worker
-- 的 pgListen LISTEN 回调永远不触发，空闲队列后新 job 最坏 5s 才被 claim
-- （与注释宣称的 500ms 级唤醒不符）。入队点分散在 worker 与 API 各处
-- （schema.jobs insert、SECURITY DEFINER 函数、outbox 分支），逐个接线
-- 成本高且易漏——改为 jobs 表 AFTER INSERT 触发器统一发 pg_notify：
-- 单点覆盖全部入队路径，pg_notify 随事务提交发送（回滚则不通知），
-- 与 LISTEN 侧 parseNotifyPayload 的 payload 结构兼容。

CREATE OR REPLACE FUNCTION public.ailearn_job_insert_notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'ailearn_job_events',
    json_build_object(
      'workspaceId', NEW.workspace_id::text,
      'runId', COALESCE(NEW.generation_run_id::text, ''),
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

-- 触发器函数仅 migrator 可见即可（worker/api 不需要直接调用）。
ALTER FUNCTION public.ailearn_job_insert_notify() OWNER TO ailearn_migrator;
