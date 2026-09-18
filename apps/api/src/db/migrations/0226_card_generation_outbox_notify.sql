-- 0226: card_generation_run_outbox_v2 AFTER INSERT 通知触发器。
--
-- 背景（2026-09-17 极限延迟改造，实测）：
-- 主队列 public.jobs 早在 0115 就通过 AFTER INSERT 触发器发
-- pg_notify('ailearn_job_events')，worker 的 LISTEN 消费者收到后立刻唤醒轮询
-- （index.ts:538 → pollWake.wake()）。但 **V2 学习卡生成的 outbox 表从未接过
-- 这条通道**：worker 只能等下一次 tick，而 worker 空闲时轮询已按自适应退避
-- （index.ts:63 POLL_MAX_MS = 5000ms）退到 5s 一次。
--
-- 后果：每一次生成在"run 已创建、job 已入队"之后，用户要多等最多 5 秒才有人
-- 开始处理它——纯固定开销，与 provider 无关。实测端到端墙钟中位数 33.5s，
-- 其中约 2–5s 属于这段空等。
--
-- 修法：与主队列同构——给 card_generation_run_outbox_v2 加 AFTER INSERT 触发器，
-- 在同一事务内 pg_notify（PostgreSQL 保证随提交发送、回滚不发送）。worker 的
-- LISTEN 回调只把通知当唤醒信号、不解析 payload，因此 payload 只需可读。
--
-- 覆盖范围：所有向该表投递 job 的路径（主管线 card_generation_plan、
-- regenerate/replan/recheck、post-activation 投影消费者），无需逐个改代码。
--
-- 注意：本迁移只加触发器，**不改任何业务语义**——通知只是"提前唤醒"，即使
-- 通知丢失（LISTEN 断线）也仍有原轮询兜底，正确性不依赖它。

CREATE OR REPLACE FUNCTION public.ailearn_card_generation_outbox_notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'ailearn_job_events',
    json_build_object(
      'workspaceId', NEW.workspace_id::text,
      'runId', NEW.run_id::text,
      'jobId', NEW.id::text,
      'eventType', 'job_ready',
      'stage', NEW.job_type,
      'source', 'card_generation_run_outbox_v2',
      'at', clock_timestamp()::text
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ailearn_card_generation_outbox_insert_notify
  ON public.card_generation_run_outbox_v2;
CREATE TRIGGER ailearn_card_generation_outbox_insert_notify
  AFTER INSERT ON public.card_generation_run_outbox_v2
  FOR EACH ROW
  EXECUTE FUNCTION public.ailearn_card_generation_outbox_notify();
