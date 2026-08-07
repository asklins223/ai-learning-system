-- 0072: card_generation_drafts 补 produced_by_event_key 唯一约束(security_review MEDIUM)
-- Fast/Planned 链 draft 幂等依赖 producedByEventKey check-then-act 无 DB 兜底:
-- 并发重跑时双事务可能算得同 draftVersion,后插者撞 (workspace,run,version) 唯一键
-- 整体回滚,靠 job 重试自愈。补 (workspace_id, run_id, produced_by_event_key) 唯一约束,
-- 使 draft 幂等有 DB 级兜底(onConflictDoNothing + 回查复用)。

ALTER TABLE public.card_generation_drafts
  ADD CONSTRAINT card_generation_drafts_produced_by_event_key_unique_idx
  UNIQUE (workspace_id, run_id, produced_by_event_key);
