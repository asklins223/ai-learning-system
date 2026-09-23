-- 0271（2026-09-22 性能重扫 L6）：让"重新变为可领取"的 job 也叫醒 worker。
--
-- 0115 建的 `ailearn_jobs_insert_notify` 只挂在 **AFTER INSERT** 上。重试路径
-- （`ailearn_fail_job`：status→pending 并写 `scheduled_at = failed_at + backoff`）和
-- reaper 回收（running→pending）都是 **UPDATE**，因此一条都不会发通知。worker 侧
-- 空闲轮询已经按 500ms→5s 自适应退到最慢档，于是"到点该重试的 job"平均要多等
-- 半个轮询周期（最坏 4.5 秒）才被领走——0031 那次把第一次重试的退避从 10s 降到 2s
-- 省下来的延迟，又被这里原样还回去了。
--
-- 判据只加一条，INSERT 的旧语义一字不动：
--   · INSERT     → 照旧通知（任何状态的插入都可能是待领取工作）。
--   · UPDATE     → 仅当这一行**刚变成** pending 且之前不是 pending。
--     反向（pending→running，即 claim）必须**不**通知，否则每一次领取都会叫醒所有
--     worker，把省下的延迟换成惊群。
--
-- 函数体建立在 0214 的版本上（0200 删了 `generation_run_id`，0214 改成从
-- payload->>'runId' 取；从 0115 复制会把那个修复冲掉）。worker 的 LISTEN 回调只把
-- 通知当唤醒信号、不解析 payload，所以键名保持兼容即可。
-- 不新增函数、不新增授权：`infra/postgres/roles.sql` 的 worker EXECUTE 断言不受影响。

CREATE OR REPLACE FUNCTION public.ailearn_job_insert_notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NOT (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending') THEN
    RETURN NULL;
  END IF;

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
  AFTER INSERT OR UPDATE OF status ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.ailearn_job_insert_notify();

ALTER FUNCTION public.ailearn_job_insert_notify() OWNER TO ailearn_migrator;
