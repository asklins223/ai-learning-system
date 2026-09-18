-- 0224: 修正 assistant_deliveries.kind 白名单——补齐 memory_candidate，删除无生产者的 proactive_cue。
--
-- 背景（2026-09-16 审计，真实 Postgres 复核）：
-- 1. 0131 的 assistant_deliveries_kind_check 只允许
--    ('message','proposal','action_result','proactive_cue','system_event')，
--    但 worker 的记忆抽取 handler（companion-memory-extractor.ts）会写入
--    kind='memory_candidate'。该 INSERT 与 assistant_memory_items 的写入在同一个
--    withWorkerWorkspaceTransaction 内，CHECK 违例会中止整个事务 →
--    候选记忆与 delivery 一起回滚，即「记忆抽取在找到候选时永久失败」。
-- 2. proactive_cue 没有任何生产者（唯一写入方 proactive-hook 写的是 system_event），
--    属于死枚举值；home projection / 频率预算都把两者当同一类（kind IN (...)）读取，
--    因此把历史行归一到 system_event 是无损的。
--
-- 幂等：可重复执行。若库中不存在 proactive_cue 行，UPDATE 影响 0 行。

--> statement-breakpoint

-- 1) 历史 proactive_cue 行归一为 system_event（kind 与 payload_ref 同时归一，
--    使客户端 strict parse 不因 cueId/systemEventId 形状差异失败）。
UPDATE public.assistant_deliveries
SET kind = 'system_event',
    payload_ref = jsonb_build_object(
      'kind', 'system_event',
      'systemEventId', COALESCE(payload_ref->>'cueId', id::text)
    ) || CASE
      WHEN payload_ref ? 'text' THEN jsonb_build_object('text', payload_ref->>'text')
      ELSE '{}'::jsonb
    END
WHERE kind = 'proactive_cue';

--> statement-breakpoint

-- 2) 重建 kind 白名单：与代码实际写入的 kind 集合精确一致，并包含
--    memory_candidate。禁止再次出现「代码写得出、约束不允许」的漂移。
ALTER TABLE public.assistant_deliveries
  DROP CONSTRAINT IF EXISTS assistant_deliveries_kind_check;

ALTER TABLE public.assistant_deliveries
  ADD CONSTRAINT assistant_deliveries_kind_check CHECK (kind IN (
    'message', 'proposal', 'action_result', 'system_event', 'memory_candidate'
  ));
